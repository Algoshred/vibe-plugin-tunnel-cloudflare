import { afterEach, describe, expect, it } from "bun:test";

import { isProcessAlive } from "@vibecontrols/plugin-sdk";
import type { HostServices } from "@vibecontrols/plugin-sdk/contract";

import { CloudflareTunnelProvider } from "../src/index";

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
