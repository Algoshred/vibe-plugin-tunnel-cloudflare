import { describe, expect, it } from "bun:test";

import {
  AgentTunnelSupervisor,
  RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS,
  restartBackoffMs,
  type AgentTunnelSupervisorDeps,
} from "../src/agent-tunnel-supervisor";

/**
 * Regression coverage for BOFF-6340 — "agent shows Degraded after its quick
 * tunnel rotated".
 *
 * A trycloudflare hostname dies with the `cloudflared` process that minted it.
 * Nothing used to notice: the dead URL stayed in storage, the agent kept
 * reporting it, and the control plane probed an NXDOMAIN host until a human
 * pressed "Edit Tunnel". These tests pin the recovery policy — detect death,
 * retract the dead URL, rebuild, back off on failure — without spawning a
 * single process.
 */

interface Harness {
  deps: AgentTunnelSupervisorDeps;
  state: {
    pid: number | null;
    alivePids: Set<number>;
    cleared: number;
    restarts: number;
    now: number;
    paused: boolean;
    restartResult: () => Promise<string | null>;
  };
}

function makeHarness(overrides: Partial<Harness["state"]> = {}): Harness {
  const state: Harness["state"] = {
    pid: 1234,
    alivePids: new Set([1234]),
    cleared: 0,
    restarts: 0,
    now: 1_000_000,
    paused: false,
    restartResult: async () => "https://fresh.trycloudflare.com",
    ...overrides,
  };

  const deps: AgentTunnelSupervisorDeps = {
    getAgentTunnelPid: async () => state.pid,
    isAlive: (pid) => state.alivePids.has(pid),
    clearAgentTunnel: async () => {
      state.cleared += 1;
      state.pid = null;
    },
    restartAgentTunnel: async () => {
      state.restarts += 1;
      return state.restartResult();
    },
    isPaused: () => state.paused,
    log: { info: () => {}, warn: () => {} },
    now: () => state.now,
  };

  return { deps, state };
}

describe("restartBackoffMs", () => {
  it("restarts the first time immediately", () => {
    expect(restartBackoffMs(1)).toBe(0);
  });

  it("grows exponentially from the base delay", () => {
    expect(restartBackoffMs(2)).toBe(RESTART_BASE_DELAY_MS);
    expect(restartBackoffMs(3)).toBe(RESTART_BASE_DELAY_MS * 2);
    expect(restartBackoffMs(4)).toBe(RESTART_BASE_DELAY_MS * 4);
  });

  it("never exceeds the ceiling, however long the outage runs", () => {
    expect(restartBackoffMs(50)).toBe(RESTART_MAX_DELAY_MS);
  });
});

describe("AgentTunnelSupervisor.tick", () => {
  it("does nothing while the tunnel process is alive", async () => {
    const { deps, state } = makeHarness();
    const supervisor = new AgentTunnelSupervisor(deps);

    expect(await supervisor.tick()).toBe("alive");
    expect(state.cleared).toBe(0);
    expect(state.restarts).toBe(0);
  });

  it("retracts the dead URL and rebuilds the tunnel when the process is gone", async () => {
    const { deps, state } = makeHarness({ alivePids: new Set<number>() });
    const supervisor = new AgentTunnelSupervisor(deps);

    expect(await supervisor.tick()).toBe("restarted");
    // The stale hostname is dropped BEFORE the rebuild, so nothing can publish
    // a URL that no longer resolves during the gap.
    expect(state.cleared).toBe(1);
    expect(state.restarts).toBe(1);
  });

  it("treats a missing PID as a dead tunnel", async () => {
    const { deps, state } = makeHarness({ pid: null });
    const supervisor = new AgentTunnelSupervisor(deps);

    expect(await supervisor.tick()).toBe("restarted");
    expect(state.restarts).toBe(1);
  });

  it("stays out of the way while supervision is paused", async () => {
    const { deps, state } = makeHarness({
      paused: true,
      alivePids: new Set<number>(),
    });
    const supervisor = new AgentTunnelSupervisor(deps);

    expect(await supervisor.tick()).toBe("paused");
    expect(state.cleared).toBe(0);
    expect(state.restarts).toBe(0);
  });

  it("backs off instead of hammering cloudflared when a restart yields nothing", async () => {
    const { deps, state } = makeHarness({
      alivePids: new Set<number>(),
      restartResult: async () => null,
    });
    const supervisor = new AgentTunnelSupervisor(deps);

    expect(await supervisor.tick()).toBe("failed");
    expect(state.restarts).toBe(1);

    // Next tick is inside the backoff window — no second spawn.
    expect(await supervisor.tick()).toBe("backoff");
    expect(state.restarts).toBe(1);

    // Once the window elapses it tries again.
    state.now += RESTART_BASE_DELAY_MS;
    expect(await supervisor.tick()).toBe("failed");
    expect(state.restarts).toBe(2);
  });

  it("survives a restart that throws and retries after the backoff", async () => {
    const { deps, state } = makeHarness({
      alivePids: new Set<number>(),
      restartResult: async () => {
        throw new Error("cloudflared not installed");
      },
    });
    const supervisor = new AgentTunnelSupervisor(deps);

    expect(await supervisor.tick()).toBe("failed");
    state.now += RESTART_MAX_DELAY_MS;
    expect(await supervisor.tick()).toBe("failed");
    expect(state.restarts).toBe(2);
  });

  it("resets the backoff once the tunnel comes back", async () => {
    const { deps, state } = makeHarness({
      alivePids: new Set<number>(),
      restartResult: async () => null,
    });
    const supervisor = new AgentTunnelSupervisor(deps);

    await supervisor.tick(); // failed → backoff armed
    state.restartResult = async () => "https://recovered.trycloudflare.com";
    state.now += RESTART_BASE_DELAY_MS;
    expect(await supervisor.tick()).toBe("restarted");

    // A later crash restarts immediately rather than inheriting the old delay.
    state.pid = 4321;
    state.alivePids = new Set<number>();
    expect(await supervisor.tick()).toBe("restarted");
    expect(state.restarts).toBe(3);
  });

  it("never runs two ticks concurrently", async () => {
    const { deps, state } = makeHarness({ alivePids: new Set<number>() });
    let release!: (url: string | null) => void;
    const inFlight = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    state.restartResult = () => inFlight;
    const supervisor = new AgentTunnelSupervisor(deps);

    const first = supervisor.tick();
    // The exit handler nudges a tick while the periodic one is mid-restart.
    const second = await supervisor.tick();
    expect(second).toBe("backoff");
    release("https://slow.trycloudflare.com");
    expect(await first).toBe("restarted");
    expect(state.restarts).toBe(1);
  });
});

describe("AgentTunnelSupervisor lifecycle", () => {
  it("start is idempotent and stop halts polling", () => {
    const { deps } = makeHarness();
    const supervisor = new AgentTunnelSupervisor(deps, 60_000);

    supervisor.start();
    supervisor.start();
    expect(supervisor.isRunning).toBe(true);

    supervisor.stop();
    expect(supervisor.isRunning).toBe(false);
    // Stopping twice is safe (shutdown can race a nuke).
    supervisor.stop();
    expect(supervisor.isRunning).toBe(false);
  });

  it("clears the armed backoff on stop so a restarted agent recovers at once", async () => {
    const { deps, state } = makeHarness({
      alivePids: new Set<number>(),
      restartResult: async () => null,
    });
    const supervisor = new AgentTunnelSupervisor(deps);

    await supervisor.tick();
    expect(await supervisor.tick()).toBe("backoff");

    supervisor.stop();
    expect(await supervisor.tick()).toBe("failed");
    expect(state.restarts).toBe(2);
  });
});
