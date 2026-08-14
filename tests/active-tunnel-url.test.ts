import { afterEach, describe, expect, it } from "bun:test";

import { isProcessAlive } from "@vibecontrols/plugin-sdk";
import type { HostServices } from "@vibecontrols/plugin-sdk/contract";

import {
  CloudflareTunnelProvider,
  isAgentSupervisionPaused,
  isUsableAgentTunnel,
  withoutDegradedMarkers,
} from "../src/index";
import type { TunnelInfo } from "../src/types";

/**
 * `getActiveTunnelUrl()` is what the agent's tunnel-sync publishes to the
 * control plane. Handing back the URL of a `cloudflared` that has already
 * exited is what made an agent sit on an NXDOMAIN hostname and report
 * "Degraded" until someone edited the tunnel by hand (BOFF-6340), so the
 * liveness gate below is the contract worth pinning.
 */

const STORAGE_NS = "tunnel-cloudflare";
const KEY_AGENT_URL = "agent-tunnel-url";
const KEY_AGENT_PID = "agent-tunnel-pid";

/** A PID that cannot be running (above Linux's default pid_max). */
const DEAD_PID = 2_147_483_646;

function makeProvider(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const storage = {
    get: async (ns: string, key: string) => store.get(`${ns}:${key}`) ?? null,
    set: async (ns: string, key: string, value: string) => {
      store.set(`${ns}:${key}`, value);
    },
    delete: async (ns: string, key: string) => {
      store.delete(`${ns}:${key}`);
    },
    list: async () => [...store.keys()],
    deleteAll: async () => store.clear(),
  };
  const hostServices = {
    storage,
    logger: undefined,
  } as unknown as HostServices;
  return { provider: new CloudflareTunnelProvider(hostServices), store };
}

afterEach(() => {
  delete process.env.AGENT_TUNNEL_URL;
});

describe("getActiveTunnelUrl", () => {
  it("returns the stored URL while the owning cloudflared is alive", async () => {
    const { provider } = makeProvider({
      [`${STORAGE_NS}:${KEY_AGENT_URL}`]: "https://live.trycloudflare.com",
      [`${STORAGE_NS}:${KEY_AGENT_PID}`]: String(process.pid),
    });

    expect(await provider.getActiveTunnelUrl()).toBe(
      "https://live.trycloudflare.com",
    );
  });

  it("withholds the URL once the owning process is dead", async () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);

    const { provider } = makeProvider({
      [`${STORAGE_NS}:${KEY_AGENT_URL}`]: "https://stale.trycloudflare.com",
      [`${STORAGE_NS}:${KEY_AGENT_PID}`]: String(DEAD_PID),
    });

    expect(await provider.getActiveTunnelUrl()).toBeNull();
  });

  it("keeps serving a URL that has no PID — the tunnel is managed elsewhere", async () => {
    const { provider } = makeProvider({
      [`${STORAGE_NS}:${KEY_AGENT_URL}`]: "https://external.example.com",
    });

    expect(await provider.getActiveTunnelUrl()).toBe(
      "https://external.example.com",
    );
  });

  it("ignores a corrupt PID rather than withholding a working tunnel", async () => {
    const { provider } = makeProvider({
      [`${STORAGE_NS}:${KEY_AGENT_URL}`]: "https://live.trycloudflare.com",
      [`${STORAGE_NS}:${KEY_AGENT_PID}`]: "not-a-pid",
    });

    expect(await provider.getActiveTunnelUrl()).toBe(
      "https://live.trycloudflare.com",
    );
  });

  it("returns null when nothing is stored", async () => {
    const { provider } = makeProvider();
    expect(await provider.getActiveTunnelUrl()).toBeNull();
  });

  it("lets an externally-pinned AGENT_TUNNEL_URL win", async () => {
    process.env.AGENT_TUNNEL_URL = "https://pinned.example.com";
    const { provider } = makeProvider({
      [`${STORAGE_NS}:${KEY_AGENT_URL}`]: "https://stale.trycloudflare.com",
      [`${STORAGE_NS}:${KEY_AGENT_PID}`]: String(DEAD_PID),
    });

    expect(await provider.getActiveTunnelUrl()).toBe(
      "https://pinned.example.com",
    );
  });
});

/**
 * A rate-limited quick tunnel is recorded as `active` with a placeholder
 * hostname and no PID, so "did the restart work?" cannot be answered by the
 * record we started from — only by the one we got back.
 */
function makeInfo(over: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: "t-1",
    providerName: "cloudflare",
    status: "active",
    protocol: "http",
    localPort: 3005,
    localHost: "127.0.0.1",
    url: "https://abc.trycloudflare.com",
    pid: 4242,
    createdAt: new Date(0).toISOString(),
    metadata: { isAgentTunnel: true },
    ...over,
  };
}

describe("withoutDegradedMarkers", () => {
  it("drops the failed-attempt markers and keeps everything else", () => {
    expect(
      withoutDegradedMarkers({
        isAgentTunnel: true,
        degraded: true,
        degradedReason: "rate limited",
      }),
    ).toEqual({ isAgentTunnel: true });
  });

  it("passes through metadata that carries no markers", () => {
    expect(withoutDegradedMarkers({ name: "agent" })).toEqual({
      name: "agent",
    });
    expect(withoutDegradedMarkers(undefined)).toBeUndefined();
  });
});

describe("isUsableAgentTunnel", () => {
  it("accepts a live tunnel with a URL and an owning process", () => {
    expect(isUsableAgentTunnel(makeInfo())).toBe(true);
  });

  it("rejects the rate-limited placeholder", () => {
    expect(
      isUsableAgentTunnel(
        makeInfo({
          url: "https://rate-limited-t-1.trycloudflare.com",
          pid: undefined,
          metadata: { isAgentTunnel: true, degraded: true },
        }),
      ),
    ).toBe(false);
  });

  it("rejects a record with no owning process or no URL", () => {
    expect(isUsableAgentTunnel(makeInfo({ pid: undefined }))).toBe(false);
    expect(isUsableAgentTunnel(makeInfo({ url: "" }))).toBe(false);
  });

  it("accepts a record whose stale degraded markers were cleared", () => {
    // The exact recovery path: a retry after a rate-limit reuses the record.
    const retried = makeInfo({
      metadata: withoutDegradedMarkers({
        isAgentTunnel: true,
        degraded: true,
        degradedReason: "rate limited",
      }),
    });
    expect(isUsableAgentTunnel(retried)).toBe(true);
  });
});

describe("isAgentSupervisionPaused", () => {
  const base = {
    shuttingDown: false,
    agentTunnelDisabled: false,
    agentTunnelId: "agent-1",
    intentionalStops: new Set<string>(),
  };

  it("lets supervision run in the normal case", () => {
    expect(isAgentSupervisionPaused(base)).toBe(false);
  });

  it("pauses during a teardown", () => {
    expect(isAgentSupervisionPaused({ ...base, shuttingDown: true })).toBe(
      true,
    );
  });

  it("pauses while the agent tunnel is being stopped", () => {
    expect(
      isAgentSupervisionPaused({
        ...base,
        intentionalStops: new Set(["agent-1"]),
      }),
    ).toBe(true);
  });

  it("ignores a deliberate stop of some OTHER tunnel", () => {
    expect(
      isAgentSupervisionPaused({
        ...base,
        intentionalStops: new Set(["some-other-tunnel"]),
      }),
    ).toBe(false);
  });

  it("stays paused after the stop marker is gone, until a start re-enables it", () => {
    // The race this latch exists for: `stop()` clears its transient marker as
    // soon as it returns, but a restart already in flight must not resume and
    // re-create the tunnel the caller just took down.
    expect(
      isAgentSupervisionPaused({ ...base, agentTunnelDisabled: true }),
    ).toBe(true);
  });
});
