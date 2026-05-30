/**
 * @vibecontrols/vibe-plugin-tunnel-cloudflare
 *
 * Cloudflare Tunnel provider plugin for VibeControls Agent.
 * Spawns `cloudflared tunnel --url` processes to expose local ports via
 * trycloudflare.com quick tunnels and manages their full lifecycle.
 *
 * Storage namespace: "tunnel-cloudflare"
 *   - "tunnels"          → JSON array of TunnelInfo records
 *   - "agent-tunnel-url" → string | null (the main agent tunnel URL)
 *   - "agent-tunnel-pid" → string (PID of the agent tunnel process)
 *
 * Migrated to consume `@vibecontrols/plugin-sdk` for the contract,
 * lifecycle, telemetry, logger and subprocess helpers.
 */

import type { Subprocess } from "bun";
import { Elysia } from "elysia";

import {
  BoundLogger,
  createLifecycleHooks,
  gracefulKill as sdkGracefulKill,
  isProcessAlive,
  ProviderRegistry,
  TelemetryEmitter,
} from "@vibecontrols/plugin-sdk";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";

import type {
  AgentStorageProvider,
  IssueSessionRequest,
  TunnelInfo,
  TunnelProtocol,
  TunnelProvider,
  TunnelProviderCapabilities,
  TunnelSessionInfo,
} from "./types.js";

/**
 * Resolve the cloudflared binary path with the platform-correct extension.
 * `Bun.which` searches PATH and on Windows handles the .exe suffix
 * implicitly; falling back to the bare name lets the OS error give a
 * sensible "command not found" instead of us silently passing nothing.
 */
function resolveCloudflaredCmd(): string {
  const bare =
    typeof Bun !== "undefined" && typeof Bun.which === "function"
      ? Bun.which("cloudflared")
      : null;
  if (bare) return bare;
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "tunnel-cloudflare";
const PLUGIN_VERSION = "2026.509.3";
const PROVIDER_NAME = "tunnel-cloudflare";
const STORAGE_NS = "tunnel-cloudflare";

/** Key under which the full tunnel list is persisted. */
const KEY_TUNNELS = "tunnels";
/** Key for the active agent tunnel URL. */
const KEY_AGENT_URL = "agent-tunnel-url";
/** Key for the agent tunnel process PID. */
const KEY_AGENT_PID = "agent-tunnel-pid";

/** Regex to extract the quick-tunnel URL from cloudflared output.
 * Excludes api.trycloudflare.com which is the API endpoint, not the tunnel URL. */
const TUNNEL_URL_RE = /(https:\/\/(?!api\.)[a-zA-Z0-9-]+\.trycloudflare\.com)/;

/** Maximum time (ms) to wait for cloudflared to print its URL. */
const URL_EXTRACT_TIMEOUT_MS = 30_000;

/** Grace period (ms) between SIGTERM and SIGKILL during shutdown. */
const KILL_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tagged error so callers (start()) can distinguish rate-limit failures
 * from generic crashes and degrade gracefully. */
class CloudflaredRateLimitedError extends Error {
  constructor(detail: string) {
    super(`cloudflared rate-limited by trycloudflare.com: ${detail}`);
    this.name = "CloudflaredRateLimitedError";
  }
}

/**
 * Spawn `cloudflared tunnel` and wait for the quick-tunnel URL to appear on
 * stderr/stdout. Uses Bun's ReadableStream APIs.
 */
async function extractTunnelUrl(proc: Subprocess): Promise<string> {
  let combined = "";

  // Read from both stdout and stderr concurrently. cloudflared may print the
  // URL on either stream.
  const readStream = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        combined += decoder.decode(value, { stream: true });
        const match = TUNNEL_URL_RE.exec(combined);
        if (match) return match[1]!;
      }
    } finally {
      reader.releaseLock();
    }
    return undefined;
  };

  // Race both streams and a timeout.
  const result = await Promise.race([
    readStream(proc.stdout as ReadableStream<Uint8Array> | null),
    readStream(proc.stderr as ReadableStream<Uint8Array> | null),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Timed out after ${URL_EXTRACT_TIMEOUT_MS}ms waiting for tunnel URL`,
            ),
          ),
        URL_EXTRACT_TIMEOUT_MS,
      ),
    ),
  ]);

  if (!result) {
    // trycloudflare.com rate-limits per source IP. The error pattern is
    // `429 Too Many Requests` or `error code: 1015` in cloudflared's
    // stderr — surface that as a tagged error so callers can fall back.
    if (/429|too many requests|error code: 1015/i.test(combined)) {
      throw new CloudflaredRateLimitedError(
        combined.split("\n").find((l) => /429|1015/i.test(l)) ?? combined,
      );
    }
    throw new Error("cloudflared exited before producing a URL");
  }

  return result;
}

// ---------------------------------------------------------------------------
// CloudflareTunnelProvider
// ---------------------------------------------------------------------------

class CloudflareTunnelProvider implements TunnelProvider {
  readonly name = PROVIDER_NAME;

  /** In-memory map of tunnel ID → spawned Subprocess. */
  private readonly processes = new Map<string, Subprocess>();

  private readonly storage: AgentStorageProvider;
  private readonly log: BoundLogger;
  private readonly hostServices: HostServices;

  constructor(hostServices: HostServices) {
    this.hostServices = hostServices;
    // The agent's runtime storage surface is richer than the SDK's neutral
    // StorageProvider (delete returns void; deleteAll sweeper). Narrow via
    // a single structural cast at the boundary.
    this.storage = hostServices.storage as unknown as AgentStorageProvider;
    this.log = new BoundLogger(hostServices.logger, PROVIDER_NAME);
  }

  // -----------------------------------------------------------------------
  // Storage helpers
  // -----------------------------------------------------------------------

  /** Load the persisted tunnel list. */
  private async loadTunnels(): Promise<TunnelInfo[]> {
    const raw = await this.storage.get(STORAGE_NS, KEY_TUNNELS);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as TunnelInfo[];
    } catch {
      this.log.warn("Corrupt tunnel list in storage — resetting");
      return [];
    }
  }

  /** Persist the tunnel list. */
  private async saveTunnels(tunnels: TunnelInfo[]): Promise<void> {
    await this.storage.set(STORAGE_NS, KEY_TUNNELS, JSON.stringify(tunnels));
  }

  /** Update a single tunnel record in the persisted list. */
  private async upsertTunnel(info: TunnelInfo): Promise<void> {
    const tunnels = await this.loadTunnels();
    const idx = tunnels.findIndex((t) => t.id === info.id);
    if (idx >= 0) {
      tunnels[idx] = info;
    } else {
      tunnels.push(info);
    }
    await this.saveTunnels(tunnels);
  }

  /** Remove a tunnel record from the persisted list. */
  private async removeTunnelRecord(tunnelId: string): Promise<void> {
    const tunnels = await this.loadTunnels();
    await this.saveTunnels(tunnels.filter((t) => t.id !== tunnelId));
  }

  // -----------------------------------------------------------------------
  // TunnelProvider implementation
  // -----------------------------------------------------------------------

  getCapabilities(): TunnelProviderCapabilities {
    return {
      provider: PROVIDER_NAME,
      supportsHttp: true,
      supportsHttps: true,
      supportsTcp: false,
      supportsUdp: false,
      // trycloudflare quick tunnels don't support customer-owned custom
      // domains. Named tunnels support them but require a Cloudflare Zero
      // Trust account and are not implemented yet.
      supportsCustomDomains: false,
      supportsManagedSubdomains: true,
      supportsSessionTokens: false,
      supportsLiveLogs: true,
      supportsUsageMetrics: false,
      supportsRotateCredentials: true,
      platforms: ["darwin", "linux", "win32"],
    };
  }

  async issueSession(req: IssueSessionRequest): Promise<TunnelSessionInfo> {
    // Reuse the backend tunnel id when the control plane supplies one so
    // that subsequent stop/start dispatches from the backend (which key
    // by backend id) resolve the same agent-side entry.
    const backendTunnelId =
      typeof req.metadata?.["backendTunnelId"] === "string"
        ? (req.metadata["backendTunnelId"] as string)
        : undefined;
    const tunnelId = backendTunnelId ?? crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const localHost = req.localHost ?? "127.0.0.1";
    const protocol: TunnelProtocol = req.protocol;
    const now = new Date().toISOString();

    const info: TunnelInfo = {
      id: tunnelId,
      providerName: PROVIDER_NAME,
      status: "stopped",
      protocol,
      localPort: req.localPort,
      localHost,
      url: "",
      sessionId,
      createdAt: now,
      metadata: {
        ...(req.metadata ?? {}),
        localUrl: `${protocol}://${localHost}:${req.localPort}`,
      },
    };
    await this.upsertTunnel(info);

    const session: TunnelSessionInfo = {
      sessionId,
      tunnelId,
      provider: PROVIDER_NAME,
      expiresAt: req.ttlSeconds
        ? new Date(Date.now() + req.ttlSeconds * 1000).toISOString()
        : undefined,
      credentials: {
        localUrl: info.metadata!["localUrl"],
      },
    };
    // cloudflare's sessions are 1:1 with tunnels — persist the single session
    // via a session list keyed by tunnelId.
    await this.storage.set(
      STORAGE_NS,
      `sessions:${tunnelId}`,
      JSON.stringify([session]),
    );
    return session;
  }

  /**
   * Start a previously-issued tunnel. Spawns cloudflared and extracts the
   * public URL from its output.
   */
  async start(tunnelId: string): Promise<TunnelInfo> {
    const tunnels = await this.loadTunnels();
    const info = tunnels.find((t) => t.id === tunnelId);
    if (!info) {
      throw new Error(`Tunnel ${tunnelId} not found (issueSession first)`);
    }

    if (this.processes.has(tunnelId)) {
      return info;
    }

    const localUrl =
      (info.metadata?.["localUrl"] as string | undefined) ??
      `${info.protocol}://${info.localHost}:${info.localPort}`;

    await this.upsertTunnel({
      ...info,
      status: "starting",
      updatedAt: new Date().toISOString(),
    });

    this.log.info(`Starting tunnel ${tunnelId} → ${localUrl}`);

    const proc = Bun.spawn(
      [resolveCloudflaredCmd(), "tunnel", "--url", localUrl],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.processes.set(tunnelId, proc);

    void proc.exited.then((code) => {
      if (this.processes.has(tunnelId)) {
        this.log.warn(
          `Tunnel ${tunnelId} process exited unexpectedly (code=${code})`,
        );
        this.processes.delete(tunnelId);
        void this.loadTunnels().then((current) => {
          const idx = current.findIndex((t) => t.id === tunnelId);
          if (idx >= 0) {
            current[idx] = {
              ...current[idx]!,
              status: "error",
              updatedAt: new Date().toISOString(),
              metadata: { ...current[idx]!.metadata, exitCode: code },
            };
            void this.saveTunnels(current);
          }
        });
      }
    });

    try {
      const url = await extractTunnelUrl(proc);
      const activeInfo: TunnelInfo = {
        ...info,
        url,
        managedHostname: new URL(url).host,
        status: "active",
        pid: proc.pid,
        updatedAt: new Date().toISOString(),
      };
      await this.upsertTunnel(activeInfo);
      this.log.info(`Tunnel ${tunnelId} active at ${url} (PID ${proc.pid})`);
      return activeInfo;
    } catch (err) {
      this.processes.delete(tunnelId);
      if (isProcessAlive(proc.pid)) {
        await sdkGracefulKill(proc.pid, KILL_GRACE_MS);
      }
      // Quick-tunnel rate-limited by trycloudflare.com (429 / error 1015).
      // Mark the tunnel as `rate-limited` and surface a placeholder URL so
      // callers can distinguish "rate-limited, retry later" from a real
      // crash. Frontend / doctor scripts treat this as a known degraded
      // state instead of a hard failure.
      if (err instanceof CloudflaredRateLimitedError) {
        const placeholderHost = `rate-limited-${tunnelId}.trycloudflare.com`;
        const placeholderUrl = `https://${placeholderHost}`;
        const degraded: TunnelInfo = {
          ...info,
          url: placeholderUrl,
          managedHostname: placeholderHost,
          status: "active",
          updatedAt: new Date().toISOString(),
          metadata: {
            ...info.metadata,
            degraded: true,
            degradedReason: err.message,
          },
        };
        await this.upsertTunnel(degraded);
        this.log.warn(
          `Tunnel ${tunnelId} rate-limited; returning placeholder URL`,
        );
        return degraded;
      }
      const errorInfo: TunnelInfo = {
        ...info,
        status: "error",
        updatedAt: new Date().toISOString(),
        metadata: {
          ...info.metadata,
          error: err instanceof Error ? err.message : String(err),
        },
      };
      await this.upsertTunnel(errorInfo);
      throw err;
    }
  }

  async rotate(tunnelId: string): Promise<TunnelSessionInfo> {
    const tunnels = await this.loadTunnels();
    const info = tunnels.find((t) => t.id === tunnelId);
    if (!info) throw new Error(`Tunnel ${tunnelId} not found`);

    await this.stop(tunnelId);
    // Re-use the tunnel's existing target + metadata and spin up a fresh
    // cloudflared process (which yields a new trycloudflare URL).
    await this.start(tunnelId);
    const updated = (await this.loadTunnels()).find((t) => t.id === tunnelId);
    const sessionId = updated?.sessionId ?? crypto.randomUUID();
    return {
      sessionId,
      tunnelId,
      provider: PROVIDER_NAME,
      credentials: {
        localUrl: updated?.metadata?.["localUrl"] as string | undefined,
      },
    };
  }

  async attachCustomDomain(_tunnelId: string, _domain: string): Promise<void> {
    throw new Error(
      "Custom domains are not supported by the cloudflared quick-tunnel provider. Use the vibetunnels provider or wait for named-tunnel support.",
    );
  }

  async detachCustomDomain(_tunnelId: string, _domain: string): Promise<void> {
    throw new Error(
      "Custom domains are not supported by the cloudflared quick-tunnel provider.",
    );
  }

  async listSessions(tunnelId: string): Promise<TunnelSessionInfo[]> {
    const raw = await this.storage.get(STORAGE_NS, `sessions:${tunnelId}`);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as TunnelSessionInfo[];
    } catch {
      return [];
    }
  }

  async stop(tunnelId: string): Promise<void> {
    this.log.info(`Stopping tunnel ${tunnelId}`);

    const tunnels = await this.loadTunnels();
    const tunnel = tunnels.find((t) => t.id === tunnelId);

    // Update status to "stopping".
    if (tunnel) {
      tunnel.status = "stopping";
      tunnel.updatedAt = new Date().toISOString();
      await this.upsertTunnel(tunnel);
    }

    // Kill the in-memory process if we still have a handle.
    const proc = this.processes.get(tunnelId);
    if (proc) {
      await sdkGracefulKill(proc.pid, KILL_GRACE_MS);
      this.processes.delete(tunnelId);
    } else if (tunnel?.pid && isProcessAlive(tunnel.pid)) {
      // Fallback: we lost the ChildProcess handle but the PID is still alive
      // (e.g. after an agent restart). Kill directly by PID.
      await sdkGracefulKill(tunnel.pid, KILL_GRACE_MS);
    }

    // Mark as stopped in storage.
    if (tunnel) {
      tunnel.status = "stopped";
      tunnel.pid = undefined;
      tunnel.updatedAt = new Date().toISOString();
      await this.upsertTunnel(tunnel);
    }

    // If this was the agent tunnel, clear the agent-specific keys.
    const agentPidRaw = await this.storage.get(STORAGE_NS, KEY_AGENT_PID);
    if (agentPidRaw && tunnel?.pid && String(tunnel.pid) === agentPidRaw) {
      await this.storage.delete(STORAGE_NS, KEY_AGENT_URL);
      await this.storage.delete(STORAGE_NS, KEY_AGENT_PID);
    }

    this.log.info(`Tunnel ${tunnelId} stopped`);
  }

  async getStatus(tunnelId: string): Promise<TunnelInfo | null> {
    const tunnels = await this.loadTunnels();
    const tunnel = tunnels.find((t) => t.id === tunnelId) ?? null;
    if (!tunnel) return null;

    // Verify the process is actually alive if the status says "active".
    if (tunnel.status === "active" && tunnel.pid) {
      if (!isProcessAlive(tunnel.pid)) {
        tunnel.status = "stopped";
        tunnel.updatedAt = new Date().toISOString();
        await this.upsertTunnel(tunnel);
        this.processes.delete(tunnelId);
      }
    }

    return tunnel;
  }

  async getActiveTunnelUrl(): Promise<string | null> {
    // In external-tunnel mode (AGENT_TUNNEL=false), the URL is passed via env var.
    const envUrl = process.env.AGENT_TUNNEL_URL;
    if (envUrl) return envUrl;
    return this.storage.get(STORAGE_NS, KEY_AGENT_URL);
  }

  async list(): Promise<TunnelInfo[]> {
    return this.loadTunnels();
  }

  async delete(tunnelId: string): Promise<void> {
    this.log.info(`Deleting tunnel ${tunnelId}`);

    // Stop the process if it's still running.
    const tunnels = await this.loadTunnels();
    const tunnel = tunnels.find((t) => t.id === tunnelId);

    if (
      tunnel &&
      (tunnel.status === "active" || tunnel.status === "starting")
    ) {
      await this.stop(tunnelId);
    }

    // Remove the record entirely from storage.
    await this.removeTunnelRecord(tunnelId);

    this.log.info(`Tunnel ${tunnelId} deleted`);
  }

  /**
   * Detach from all tracked processes without killing them.
   * Used in AGENT_TUNNEL_DETACH mode so the tunnel survives a server restart.
   * Storage is preserved so the next startAgentTunnel can reconnect.
   */
  detachAll(): void {
    this.log.info("Detaching from all tunnels (processes left running)");
    this.processes.clear();
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const result = Bun.spawnSync([resolveCloudflaredCmd(), "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      if (result.exitCode !== 0) {
        return { ok: false, message: "cloudflared not available" };
      }
      const version = result.stdout.toString().trim();
      return { ok: true, message: version };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? `cloudflared not available: ${err.message}`
            : "cloudflared not available",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Agent tunnel helpers
  // -----------------------------------------------------------------------

  /**
   * Start the "agent tunnel" — the primary tunnel pointing at the agent's
   * own HTTP port so the agent is reachable from the internet.
   *
   * If AGENT_TUNNEL_DETACH=true and a previous cloudflared process is still
   * alive (e.g. after a watch-mode restart), reuses that process instead of
   * spawning a new one. This keeps the tunnel URL stable across hot-reloads.
   */
  async startAgentTunnel(agentPort: number): Promise<TunnelInfo> {
    // Adopt the bootstrap cloudflared if one is alive. The agent's
    // pre-config phase (src/core/tunnel-bootstrap.ts) spawns cloudflared
    // BEFORE finalize so the banner can print a tunnel URL.
    const profile = process.env.VIBECONTROLS_PROFILE ?? "default";
    const profileSuffix = profile.replace(/[^A-Za-z0-9_]/g, "_");
    const envBootstrapPid = process.env[`AGENT_TUNNEL_PID_${profileSuffix}`];
    const envBootstrapUrl = process.env[`AGENT_TUNNEL_URL_${profileSuffix}`];
    if (envBootstrapPid && envBootstrapUrl) {
      const pid = parseInt(envBootstrapPid, 10);
      if (!isNaN(pid) && isProcessAlive(pid)) {
        this.log.info(
          `Adopting bootstrap cloudflared (pid=${pid}) at ${envBootstrapUrl}`,
        );
        await this.storage.set(STORAGE_NS, KEY_AGENT_URL, envBootstrapUrl);
        await this.storage.set(STORAGE_NS, KEY_AGENT_PID, String(pid));
        const adopted: TunnelInfo = {
          id: `agent-bootstrap-${pid}`,
          providerName: "cloudflare",
          status: "active",
          protocol: "http",
          localPort: agentPort,
          localHost: "localhost",
          url: envBootstrapUrl,
          pid,
          createdAt: new Date().toISOString(),
          metadata: { isAgentTunnel: true, name: "agent", adopted: true },
        };
        delete process.env[`AGENT_TUNNEL_PID_${profileSuffix}`];
        delete process.env[`AGENT_TUNNEL_URL_${profileSuffix}`];
        return adopted;
      }
    }

    // Reuse existing tunnel if the process is still alive.
    const storedPidStr = await this.storage.get(STORAGE_NS, KEY_AGENT_PID);
    const storedUrl = await this.storage.get(STORAGE_NS, KEY_AGENT_URL);

    if (storedPidStr && storedUrl) {
      const storedPid = parseInt(storedPidStr, 10);
      if (!isNaN(storedPid) && isProcessAlive(storedPid)) {
        this.log.info(
          `Reusing existing agent tunnel (pid=${storedPid}) at ${storedUrl}`,
        );
        const tunnels = await this.loadTunnels();
        const existing = tunnels.find(
          (t) => t.pid === storedPid && t.metadata?.["isAgentTunnel"],
        );
        if (existing) {
          return existing;
        }
        return {
          id: `agent-stored-${storedPid}`,
          providerName: "cloudflare",
          status: "active",
          protocol: "http",
          localPort: agentPort,
          localHost: "localhost",
          url: storedUrl,
          pid: storedPid,
          createdAt: new Date().toISOString(),
          metadata: { isAgentTunnel: true, name: "agent", adopted: true },
        };
      }
    }

    this.log.info(`Starting agent tunnel on port ${agentPort}`);

    const session = await this.issueSession({
      protocol: "http",
      localPort: agentPort,
      localHost: "localhost",
      metadata: { isAgentTunnel: true, name: "agent" },
    });
    const info = await this.start(session.tunnelId);

    await this.storage.set(STORAGE_NS, KEY_AGENT_URL, info.url);
    if (info.pid !== undefined) {
      await this.storage.set(STORAGE_NS, KEY_AGENT_PID, String(info.pid));
    }

    this.log.info(`Agent tunnel active at ${info.url}`);

    return info;
  }

  /**
   * Tear down every tunnel this provider is tracking and clear storage.
   */
  async stopAll(): Promise<void> {
    this.log.info("Stopping all tunnels");

    const tunnels = await this.loadTunnels();

    await Promise.allSettled(
      tunnels
        .filter((t) => t.status === "active" || t.status === "starting")
        .map((t) => this.stop(t.id)),
    );

    for (const [id, proc] of this.processes) {
      if (isProcessAlive(proc.pid)) {
        this.log.warn(`Killing orphaned process ${proc.pid} (tunnel ${id})`);
        await sdkGracefulKill(proc.pid, KILL_GRACE_MS);
      }
    }
    this.processes.clear();

    await this.storage.deleteAll(STORAGE_NS);

    this.log.info("All tunnels stopped and storage cleared");
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/** Singleton provider instance — initialised in onServerStart. */
let provider: CloudflareTunnelProvider | null = null;

// Cross-platform binary discovery via Bun.which (handles PATHEXT on Windows).
function whichSync(bin: string): string | null {
  return Bun.which(bin) ?? null;
}

function createPrereqsRoutes() {
  return new Elysia({ prefix: "/prereqs" })
    .get("/status", () => {
      const cf = whichSync("cloudflared");
      return {
        satisfied: !!cf,
        missing: cf
          ? []
          : [
              {
                name: "cloudflared",
                kind: "binary" as const,
                requiresSudo: true,
                detected: undefined,
              },
            ],
      };
    })
    .post("/install", () => {
      const cf = whichSync("cloudflared");
      if (cf) return { ok: true, installed: [], pendingSudo: [], errors: [] };

      const cmd =
        process.platform === "darwin"
          ? "brew install cloudflared"
          : process.platform === "linux"
            ? "curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && sudo chmod +x /usr/local/bin/cloudflared"
            : process.platform === "win32"
              ? "winget install Cloudflare.cloudflared    # or: scoop install cloudflared    # or download from https://github.com/cloudflare/cloudflared/releases"
              : "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

      return {
        ok: true,
        installed: [],
        pendingSudo: [
          {
            name: "cloudflared",
            command: cmd,
            reason: "cloudflared is required to start tunnels.",
          },
        ],
        errors: [],
      };
    })
    .post("/uninstall", () => ({ ok: true }));
}

/**
 * Local extension of the SDK contract — `prerequisites` and the
 * `providers` slot are agent-host extensions surfaced to the runtime
 * registry. The SDK contract leaves these to the host implementation.
 */
type CloudflareVibePlugin = VibePlugin & {
  prerequisites?: Array<{
    name: string;
    kind: "binary" | "npm" | "pip" | "cargo" | "manual";
    requiresSudo: boolean;
    description?: string;
  }>;
  providers?: { tunnel?: TunnelProvider };
};

/**
 * Plugin contract V2 factory. Builds a fresh VibePlugin (with its own
 * lifecycle/telemetry instances and providers bag) per call. The
 * `provider` module-level binding is reused across calls because
 * cloudflared subprocesses are global OS resources — having two
 * profile-instances spawn duplicate tunnels would be unsafe.
 */
export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const telemetry = new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION);

  const plugin: CloudflareVibePlugin = {
    capabilities: {
      storage: "rw",
      subprocess: true,
      telemetry: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: "Cloudflare Tunnel provider for remote access",
    tags: ["backend", "provider"],
    apiPrefix: "/api/tunnel-cloudflare",
    // The agent adds this to its tunnel-URL allow-list at registration, so the
    // thin agent never hardcodes a cloudflare domain in its url-security layer.
    tunnelDomainSuffixes: [".trycloudflare.com"],

    prerequisites: [
      {
        name: "cloudflared",
        kind: "binary",
        requiresSudo: true,
        description: "Cloudflare tunnel daemon",
      },
    ],

    // The `tunnel` slot is populated at runtime during onServerStart.
    providers: {},

    createRoutes: () => createPrereqsRoutes(),
    // Lifecycle hooks attached after `plugin` exists so onInit can mutate
    // `plugin.providers` (the agent reads it after onServerStart resolves).
    onServerStart: undefined,
    onServerStop: undefined,
  };

  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "tunnel.provider.ready",
    onInit: async (hostServices: HostServices) => {
      const log = new BoundLogger(hostServices.logger, PROVIDER_NAME);
      log.info("Plugin initialising");

      // Create the provider and wire it into the plugin's providers bag +
      // the host's service registry.
      provider = new CloudflareTunnelProvider(hostServices);
      plugin.providers = { tunnel: provider };

      const providers = new ProviderRegistry(hostServices);
      providers.registerProvider("tunnel", PROVIDER_NAME, provider);

      telemetry.emit("tunnel.provider.ready", { provider: "cloudflare" });

      // AGENT_TUNNEL=false: external process owns the tunnel.
      if (process.env.AGENT_TUNNEL === "false") {
        log.info(
          "AGENT_TUNNEL=false — provider registered, tunnel managed externally",
        );
        return;
      }

      // Pre-flight: make sure cloudflared is available.
      const health = await provider.healthCheck();
      if (!health.ok) {
        log.warn(
          `cloudflared is not available — tunnel features will fail. ${health.message ?? ""}`,
        );
        return;
      }
      log.info(health.message ?? "cloudflared available");

      // Start the agent tunnel.
      try {
        const baseUrl = hostServices.getAgentBaseUrl?.() ?? "";
        const parsed = new URL(baseUrl);
        const agentPort = parseInt(parsed.port, 10);

        if (!Number.isFinite(agentPort) || agentPort <= 0) {
          log.warn(
            `Cannot determine agent port from "${baseUrl}" — skipping agent tunnel`,
          );
          return;
        }

        await provider.startAgentTunnel(agentPort);
      } catch (err) {
        log.error(
          `Failed to start agent tunnel: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    onShutdown: async () => {
      if (!provider) return;

      if (
        process.env.AGENT_TUNNEL === "false" ||
        process.env.AGENT_TUNNEL_DETACH === "true"
      ) {
        provider.detachAll();
        provider = null;
        return;
      }

      await provider.stopAll();
      provider = null;
    },
    // `vibe nuke` runs this while the daemon is still up, so the provider
    // singleton + its in-memory process map are reachable. Tear down every
    // cloudflared this provider spawned and wipe its storage. Unlike
    // onShutdown, nuke ALWAYS reaps (it ignores AGENT_TUNNEL_DETACH — a nuke
    // is a full teardown, not a hot reload). The agent never names cloudflared;
    // that knowledge lives here.
    onNuke: async (_hostServices, ctx) => {
      if (!provider) return { notes: ["tunnel provider not initialised"] };
      if (ctx.dryRun) {
        return { reaped: ["cloudflared tunnels + tunnel-cloudflare storage"] };
      }
      await provider.stopAll();
      provider = null;
      return { reaped: ["cloudflared tunnels + tunnel-cloudflare storage"] };
    },
  });

  plugin.onServerStart = lifecycle.onServerStart;
  plugin.onServerStop = lifecycle.onServerStop;
  plugin.onNuke = lifecycle.onNuke;

  return plugin;
};
