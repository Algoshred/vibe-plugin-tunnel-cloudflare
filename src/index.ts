/**
 * @burdenoff/vibe-plugin-tunnel-cloudflare
 *
 * Cloudflare Tunnel provider plugin for VibeControls Agent.
 * Spawns `cloudflared tunnel --url` processes to expose local ports via
 * trycloudflare.com quick tunnels and manages their full lifecycle.
 *
 * Storage namespace: "tunnel-cloudflare"
 *   - "tunnels"          → JSON array of TunnelInfo records
 *   - "agent-tunnel-url" → string | null (the main agent tunnel URL)
 *   - "agent-tunnel-pid" → string (PID of the agent tunnel process)
 */

import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Types — locally defined to avoid hard dependency on @vibecontrols/agent.
// These mirror the canonical interfaces from the core agent package.
// ---------------------------------------------------------------------------

type TunnelStatus = "starting" | "active" | "stopping" | "stopped" | "error";

interface TunnelConfig {
  port: number;
  hostname?: string;
  protocol?: "http" | "https";
  name?: string;
  metadata?: Record<string, unknown>;
}

interface TunnelInfo {
  id: string;
  url: string;
  port: number;
  status: TunnelStatus;
  provider: string;
  pid?: number;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

interface TunnelProvider {
  readonly name: string;
  start(config: TunnelConfig): Promise<TunnelInfo>;
  stop(tunnelId: string): Promise<void>;
  getStatus(tunnelId: string): Promise<TunnelInfo | null>;
  getActiveTunnelUrl(): Promise<string | null>;
  list(): Promise<TunnelInfo[]>;
  delete(tunnelId: string): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

interface StorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<string[]>;
  deleteAll(namespace: string): Promise<void>;
}

interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface ServiceRegistry {
  [key: string]: unknown;
}

interface HostServices {
  storage: StorageProvider;
  logger: Logger;
  serviceRegistry: ServiceRegistry;
  getProvider<T>(type: "tunnel" | "session"): T | undefined;
  getAgentBaseUrl(): string;
  getAgentVersion(): string;
}

// Elysia and Command are opaque — we only need them for callback signatures.
type Elysia = unknown;
type Command = unknown;

interface SessionProvider {
  [key: string]: unknown;
}

interface VibePlugin {
  name: string;
  version: string;
  description?: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  cliCommand?: string;
  apiPrefix?: string;
  dependencies?: string[];
  providers?: { tunnel?: TunnelProvider; session?: SessionProvider };
  onCliSetup?: (
    program: Command,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerStart?: (
    app: Elysia,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerReady?: (
    app: Elysia,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerStop?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/**
 * Returns `true` if a process with the given PID is still running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process — it just checks existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully terminate a process: SIGTERM first, then SIGKILL after a timeout.
 */
async function gracefulKill(_proc: Subprocess, pid: number): Promise<void> {
  // Already dead — nothing to do.
  if (!isProcessAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!isProcessAlive(pid)) return;
  }

  // Force kill if still alive.
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone — ignore.
    }
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

  private readonly storage: StorageProvider;
  private readonly log: Logger;

  constructor(private readonly hostServices: HostServices) {
    this.storage = hostServices.storage;
    this.log = hostServices.logger;
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
      this.log.warn(
        "[tunnel-cloudflare] Corrupt tunnel list in storage — resetting",
      );
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

  async start(config: TunnelConfig): Promise<TunnelInfo> {
    const id = crypto.randomUUID();
    const protocol = config.protocol ?? "http";
    const localUrl = `${protocol}://${config.hostname ?? "localhost"}:${config.port}`;
    const now = new Date().toISOString();

    const info: TunnelInfo = {
      id,
      url: "", // Populated after URL extraction.
      port: config.port,
      status: "starting",
      provider: PROVIDER_NAME,
      createdAt: now,
      metadata: {
        ...(config.metadata ?? {}),
        ...(config.name ? { name: config.name } : {}),
        localUrl,
      },
    };

    // Persist the "starting" record immediately so callers can track it.
    await this.upsertTunnel(info);

    this.log.info(`[tunnel-cloudflare] Starting tunnel ${id} → ${localUrl}`);

    // Spawn cloudflared. stdio is piped so we can capture the URL.
    const proc = Bun.spawn(["cloudflared", "tunnel", "--url", localUrl], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Track the process in-memory.
    this.processes.set(id, proc);

    // Monitor for unexpected early death in the background.
    void proc.exited.then((code) => {
      // Only act if the tunnel wasn't intentionally stopped (still in map).
      if (this.processes.has(id)) {
        this.log.warn(
          `[tunnel-cloudflare] Tunnel ${id} process exited unexpectedly (code=${code})`,
        );
        this.processes.delete(id);
        // Fire-and-forget status update.
        const errorInfo: TunnelInfo = {
          ...info,
          status: "error",
          updatedAt: new Date().toISOString(),
          metadata: {
            ...info.metadata,
            exitCode: code,
          },
        };
        void this.upsertTunnel(errorInfo);
      }
    });

    try {
      const url = await extractTunnelUrl(proc);

      const activeInfo: TunnelInfo = {
        ...info,
        url,
        status: "active",
        pid: proc.pid,
        updatedAt: new Date().toISOString(),
      };

      await this.upsertTunnel(activeInfo);

      this.log.info(
        `[tunnel-cloudflare] Tunnel ${id} active at ${url} (PID ${proc.pid})`,
      );

      return activeInfo;
    } catch (err) {
      // URL extraction failed — kill the process and record error state.
      this.processes.delete(id);
      if (isProcessAlive(proc.pid)) {
        await gracefulKill(proc, proc.pid);
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

  async stop(tunnelId: string): Promise<void> {
    this.log.info(`[tunnel-cloudflare] Stopping tunnel ${tunnelId}`);

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
      await gracefulKill(proc, proc.pid);
      this.processes.delete(tunnelId);
    } else if (tunnel?.pid && isProcessAlive(tunnel.pid)) {
      // Fallback: we lost the ChildProcess handle but the PID is still alive
      // (e.g. after an agent restart). Kill directly by PID.
      try {
        process.kill(tunnel.pid, "SIGTERM");
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            if (tunnel.pid && isProcessAlive(tunnel.pid)) {
              try {
                process.kill(tunnel.pid, "SIGKILL");
              } catch {
                // Already gone.
              }
            }
            resolve();
          }, KILL_GRACE_MS);
        });
      } catch {
        // Process already gone — no action needed.
      }
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

    this.log.info(`[tunnel-cloudflare] Tunnel ${tunnelId} stopped`);
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
    this.log.info(`[tunnel-cloudflare] Deleting tunnel ${tunnelId}`);

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

    this.log.info(`[tunnel-cloudflare] Tunnel ${tunnelId} deleted`);
  }

  /**
   * Detach from all tracked processes without killing them.
   * Used in AGENT_TUNNEL_DETACH mode so the tunnel survives a server restart.
   * Storage is preserved so the next startAgentTunnel can reconnect.
   */
  detachAll(): void {
    this.log.info(
      "[tunnel-cloudflare] Detaching from all tunnels (processes left running)",
    );
    this.processes.clear();
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const result = Bun.spawnSync(["cloudflared", "--version"], {
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
    // Reuse existing tunnel if the process is still alive.
    const storedPidStr = await this.storage.get(STORAGE_NS, KEY_AGENT_PID);
    const storedUrl = await this.storage.get(STORAGE_NS, KEY_AGENT_URL);

    if (storedPidStr && storedUrl) {
      const storedPid = parseInt(storedPidStr, 10);
      if (!isNaN(storedPid) && isProcessAlive(storedPid)) {
        this.log.info(
          `[tunnel-cloudflare] Reusing existing agent tunnel (pid=${storedPid}) at ${storedUrl}`,
        );
        // Reconstruct a TunnelInfo so callers get consistent data.
        const tunnels = await this.loadTunnels();
        const existing = tunnels.find(
          (t) => t.pid === storedPid && t.metadata?.isAgentTunnel,
        );
        if (existing) {
          // Re-register in-memory so stop()/list() work correctly.
          // We don't have the Subprocess handle, but PID-based kill still works.
          return existing;
        }
      }
    }

    this.log.info(
      `[tunnel-cloudflare] Starting agent tunnel on port ${agentPort}`,
    );

    const info = await this.start({
      port: agentPort,
      name: "agent",
      metadata: { isAgentTunnel: true },
    });

    // Persist agent-specific keys for quick lookup.
    await this.storage.set(STORAGE_NS, KEY_AGENT_URL, info.url);
    if (info.pid !== undefined) {
      await this.storage.set(STORAGE_NS, KEY_AGENT_PID, String(info.pid));
    }

    this.log.info(`[tunnel-cloudflare] Agent tunnel active at ${info.url}`);

    return info;
  }

  /**
   * Tear down every tunnel this provider is tracking and clear storage.
   */
  async stopAll(): Promise<void> {
    this.log.info("[tunnel-cloudflare] Stopping all tunnels");

    const tunnels = await this.loadTunnels();

    // Stop all active/starting tunnels in parallel.
    await Promise.allSettled(
      tunnels
        .filter((t) => t.status === "active" || t.status === "starting")
        .map((t) => this.stop(t.id)),
    );

    // Kill any lingering in-memory processes that weren't in the persisted
    // list (defensive — shouldn't normally happen).
    for (const [id, proc] of this.processes) {
      if (isProcessAlive(proc.pid)) {
        this.log.warn(
          `[tunnel-cloudflare] Killing orphaned process ${proc.pid} (tunnel ${id})`,
        );
        await gracefulKill(proc, proc.pid);
      }
    }
    this.processes.clear();

    // Wipe all storage keys for a clean slate.
    await this.storage.deleteAll(STORAGE_NS);

    this.log.info(
      "[tunnel-cloudflare] All tunnels stopped and storage cleared",
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/** Singleton provider instance — initialised in onServerStart. */
let provider: CloudflareTunnelProvider | null = null;

export const vibePlugin: VibePlugin = {
  name: "tunnel-cloudflare",
  version: "1.0.0",
  description: "Cloudflare Tunnel provider for remote access",
  tags: ["backend", "provider"],

  // The `tunnel` slot is populated at runtime during onServerStart.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providers: { tunnel: undefined as any },

  async onServerStart(_app: Elysia, hostServices: HostServices): Promise<void> {
    const log = hostServices.logger;

    log.info("[tunnel-cloudflare] Plugin initialising");

    // Create the provider and wire it into the plugin's providers bag.
    provider = new CloudflareTunnelProvider(hostServices);
    vibePlugin.providers!.tunnel = provider;

    // AGENT_TUNNEL=false: external process owns the tunnel (e.g. dev-reload.sh).
    // Register the provider so manual API calls work, but skip spawning cloudflared.
    // The tunnel URL is provided via AGENT_TUNNEL_URL env var and read by
    // getActiveTunnelUrl() so auto-report still works correctly.
    if (process.env.AGENT_TUNNEL === "false") {
      log.info(
        "[tunnel-cloudflare] AGENT_TUNNEL=false — provider registered, tunnel managed externally",
      );
      return;
    }

    // Pre-flight: make sure cloudflared is available.
    const health = await provider.healthCheck();
    if (!health.ok) {
      log.warn(
        `[tunnel-cloudflare] cloudflared is not available — tunnel features will fail. ${health.message ?? ""}`,
      );
      // We don't throw here; the plugin still loads so other features work.
      // Individual start() calls will fail with a clear error.
      return;
    }
    log.info(`[tunnel-cloudflare] ${health.message}`);

    // Start the agent tunnel. Parse the port from the agent's own base URL
    // (e.g. "http://localhost:4100" → 4100).
    try {
      const baseUrl = hostServices.getAgentBaseUrl();
      const parsed = new URL(baseUrl);
      const agentPort = parseInt(parsed.port, 10);

      if (!Number.isFinite(agentPort) || agentPort <= 0) {
        log.warn(
          `[tunnel-cloudflare] Cannot determine agent port from "${baseUrl}" — skipping agent tunnel`,
        );
        return;
      }

      await provider.startAgentTunnel(agentPort);
    } catch (err) {
      // Non-fatal: the agent continues to work on localhost even if the
      // tunnel couldn't be established.
      log.error(
        `[tunnel-cloudflare] Failed to start agent tunnel: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  async onServerStop(): Promise<void> {
    if (!provider) return;

    // AGENT_TUNNEL=false: external process owns the tunnel, nothing to kill here.
    // AGENT_TUNNEL_DETACH=true: leave cloudflared running so the tunnel URL
    // survives a watch-mode restart (storage preserved for next boot to reconnect).
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
};
