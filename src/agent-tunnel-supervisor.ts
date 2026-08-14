/**
 * Agent-tunnel supervisor.
 *
 * A trycloudflare quick tunnel only resolves while the `cloudflared` process
 * that created it is alive — once that process exits (crash, OOM, network
 * flap, Cloudflare dropping the tunnel) the random `*.trycloudflare.com`
 * hostname goes NXDOMAIN immediately.
 *
 * Before this supervisor existed nothing noticed: the provider kept the dead
 * URL in storage, `getActiveTunnelUrl()` kept handing it out, the agent's
 * periodic tunnel-sync saw "URL unchanged" and stayed quiet, and the control
 * plane kept probing a hostname that no longer existed — the agent showed up
 * as *Degraded* until a human hit "Edit Tunnel" or restarted the daemon.
 *
 * This module owns the "is the agent tunnel actually up, and if not bring it
 * back" decision. It is deliberately dependency-injected and free of any
 * process/storage imports so the whole restart policy is unit-testable without
 * spawning `cloudflared`.
 *
 * Liveness is polled by PID rather than driven purely by a `proc.exited`
 * handler because the agent tunnel is frequently a process this plugin did
 * *not* spawn: the daemon's pre-config bootstrap starts `cloudflared` before
 * finalize and the provider merely **adopts** its PID, so there is no
 * `Subprocess` handle to await. Polling covers spawned and adopted tunnels
 * with one code path; the spawn path additionally nudges the supervisor on
 * exit so recovery starts in milliseconds instead of at the next tick.
 */

/** How often to check that the agent tunnel's process is still alive. */
export const DEFAULT_SUPERVISOR_INTERVAL_MS = 15_000;

/** First restart delay after a failed restart attempt. */
export const RESTART_BASE_DELAY_MS = 2_000;

/** Ceiling for the exponential restart backoff. */
export const RESTART_MAX_DELAY_MS = 60_000;

/**
 * Delay before restart attempt `attempt` (1-based), exponential and capped.
 * Attempt 1 is immediate — the first restart after a crash should not wait.
 */
export function restartBackoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  const delay = RESTART_BASE_DELAY_MS * 2 ** (attempt - 2);
  return Math.min(RESTART_MAX_DELAY_MS, delay);
}

/** Outcome of a single supervisor tick — returned for tests and telemetry. */
export type SupervisorTickResult =
  | "paused" // supervision suspended (shutdown / intentional stop in flight)
  | "alive" // tunnel process is up, nothing to do
  | "backoff" // tunnel is down but the next attempt isn't due yet
  | "restarted" // tunnel was down and a fresh tunnel is up
  | "failed"; // restart attempted and did not produce a tunnel

export interface AgentTunnelSupervisorDeps {
  /** PID of the process currently believed to own the agent tunnel. */
  getAgentTunnelPid(): Promise<number | null>;
  /** True when `pid` is still running. */
  isAlive(pid: number): boolean;
  /**
   * Drop the persisted agent-tunnel URL + PID. Called as soon as the tunnel is
   * found dead so nothing (health checks, tunnel-sync, the control plane) can
   * keep handing out a hostname that no longer resolves.
   */
  clearAgentTunnel(): Promise<void>;
  /** Bring a fresh agent tunnel up. Resolves to the new public URL, or null. */
  restartAgentTunnel(): Promise<string | null>;
  /** True while supervision must not act (shutdown, nuke, deliberate stop). */
  isPaused(): boolean;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?(): number;
}

/**
 * Polls agent-tunnel liveness and restarts it with a capped exponential
 * backoff. Ticks never overlap and never reject — a supervisor that throws
 * would take the daemon's whole self-healing story down with it.
 */
export class AgentTunnelSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private attempts = 0;
  private nextAttemptAt = 0;

  constructor(
    private readonly deps: AgentTunnelSupervisorDeps,
    private readonly intervalMs: number = DEFAULT_SUPERVISOR_INTERVAL_MS,
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // `tick()` converts dependency failures into a `failed` result, but a
      // rejection here would surface as an unhandled rejection and could take
      // the daemon down — the opposite of self-healing. Belt and braces.
      void this.tick().catch(() => {
        /* next tick retries */
      });
    }, this.intervalMs);
    // Never hold the event loop open just to supervise a tunnel.
    this.timer.unref?.();
  }

  /** Stop polling and reset the backoff. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.attempts = 0;
    this.nextAttemptAt = 0;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Run one liveness check (+ restart if needed). Exposed so the spawn-side
   * `exited` handler can trigger immediate recovery, and so tests can drive
   * the policy deterministically.
   */
  async tick(): Promise<SupervisorTickResult> {
    if (this.ticking) return "backoff";
    this.ticking = true;
    try {
      if (this.deps.isPaused()) return "paused";

      let pid: number | null;
      try {
        pid = await this.deps.getAgentTunnelPid();
        if (pid !== null && this.deps.isAlive(pid)) {
          this.attempts = 0;
          this.nextAttemptAt = 0;
          return "alive";
        }

        // Dead (or unknown) — retract the stale URL before anything else so no
        // consumer can publish a hostname that stopped resolving.
        await this.deps.clearAgentTunnel();
      } catch (err) {
        // Storage can be mid-rotation or briefly unavailable. Report the
        // failure and try again on the next tick rather than letting the
        // rejection escape into the interval and kill supervision. No backoff
        // is armed: probing storage is cheap, and we must NOT restart on top
        // of a URL we failed to retract — the dead hostname could still be
        // published.
        this.deps.log.warn("Agent tunnel liveness check failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return "failed";
      }

      const now = this.now();
      if (now < this.nextAttemptAt) return "backoff";

      this.attempts += 1;
      this.deps.log.warn("Agent tunnel is down — restarting", {
        pid,
        attempt: this.attempts,
      });

      let url: string | null = null;
      try {
        url = await this.deps.restartAgentTunnel();
      } catch (err) {
        this.deps.log.warn("Agent tunnel restart threw", {
          attempt: this.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Building a tunnel takes seconds; a teardown can have started in that
      // window. Report it as paused rather than as a recovery, and drop the
      // backoff so a later legitimate start isn't held off.
      if (this.deps.isPaused()) {
        this.attempts = 0;
        this.nextAttemptAt = 0;
        return "paused";
      }

      if (url) {
        this.attempts = 0;
        this.nextAttemptAt = 0;
        this.deps.log.info("Agent tunnel restored", { url });
        return "restarted";
      }

      this.armBackoff();
      this.deps.log.warn("Agent tunnel restart did not yield a URL", {
        attempt: this.attempts,
        retryInMs: restartBackoffMs(this.attempts + 1),
      });
      return "failed";
    } finally {
      this.ticking = false;
    }
  }

  /** Hold off the next restart for the current attempt's backoff window. */
  private armBackoff(): void {
    this.nextAttemptAt = this.now() + restartBackoffMs(this.attempts + 1);
  }
}
