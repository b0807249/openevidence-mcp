/**
 * Self-reaping policy for the standalone relay daemon.
 *
 * A daemon that has bound the relay port otherwise lives forever: nothing sends
 * it SIGTERM and only the *initial* bind race makes it exit. Over days of
 * sleep/wake cycles, port changes, and respawns that leaves a pile of orphaned
 * daemons (PPID 1, alive, holding nothing) — there is no garbage collection.
 *
 * This module is the GC. The daemon ticks {@link evaluateReap} on a watchdog and
 * voluntarily exits when it is no longer the daemon anyone should use:
 *
 *  - **superseded** — the pidfile names a *different, live* process. A newer
 *    daemon took over (e.g. it bound the canonical port after this one drifted to
 *    an alternate port, or respawned after this one's listener died on wake).
 *  - **idle** — no extension has polled and no request is in flight for longer
 *    than the idle TTL. The browser tab is gone, so this daemon is dead weight;
 *    the next request respawns a fresh one via the client's self-healing path.
 *
 * Pure and synchronous so the timing-sensitive policy is unit-testable without
 * spawning real processes. The daemon supplies the live I/O (pidfile read,
 * `process.kill(pid, 0)` liveness probe, connection state).
 */

export interface ReapInputs {
  /** Is the extension actively long-polling (recently seen)? */
  connected: boolean;
  /** In-flight requests waiting on the extension. */
  pending: number;
  /** Current wall-clock (ms). */
  now: number;
  /** When the daemon first went idle, or null if it is currently active. */
  idleSince: number | null;
  /** Idle grace before reaping; <= 0 disables idle reaping (outlive forever). */
  idleTtlMs: number;
  /** Pid currently recorded in the pidfile, or null if absent/unparseable. */
  pidfilePid: number | null;
  /** Whether {@link pidfilePid} refers to a live process other than us. */
  pidfileAlive: boolean;
  /** This daemon's own pid. */
  myPid: number;
}

export type ReapReason = "superseded" | "idle";

export interface ReapDecision {
  reap: boolean;
  reason: ReapReason | null;
  /** Idle marker to carry into the next tick (reset to null while active). */
  idleSince: number | null;
}

export function evaluateReap(input: ReapInputs): ReapDecision {
  // Superseded: a different, live daemon owns the pidfile — step aside at once.
  if (
    input.pidfilePid !== null &&
    input.pidfilePid !== input.myPid &&
    input.pidfileAlive
  ) {
    return { reap: true, reason: "superseded", idleSince: input.idleSince };
  }

  // Track idleness. Any extension connection or in-flight request counts as use.
  const active = input.connected || input.pending > 0;
  const idleSince = active ? null : (input.idleSince ?? input.now);

  if (input.idleTtlMs > 0 && idleSince !== null && input.now - idleSince >= input.idleTtlMs) {
    return { reap: true, reason: "idle", idleSince };
  }

  return { reap: false, reason: null, idleSince };
}
