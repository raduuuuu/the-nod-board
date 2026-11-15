/**
 * The page's connection to the local server, as a small state machine.
 *
 *   loading --first success--> ok --3 failures in a row--> unreachable --success--> ok
 *   loading --3 failures in a row--> unreachable
 * A failure never clears the numbers already shown: the page keeps them and says how old they are.
 */
export const POLL_MS = 5_000;
export const FAILURES_BEFORE_UNREACHABLE = 3;
/** After this long without a first answer, the health line says the page is waiting. */
export const SLOW_FIRST_MS = 2_000;

export interface Link {
  state: 'loading' | 'ok' | 'unreachable';
  failures: number;
  startedAt: number;
  lastOkAt: number | null;
  unreachableSince: number | null;
}

export const initialLink = (now: number): Link => ({ state: 'loading', failures: 0, startedAt: now, lastOkAt: null, unreachableSince: null });

export function onSuccess(link: Link, now: number): Link {
  return { ...link, state: 'ok', failures: 0, lastOkAt: now, unreachableSince: null };
}

export function onFailure(link: Link, now: number): Link {
  const failures = link.failures + 1;
  if (failures < FAILURES_BEFORE_UNREACHABLE) return { ...link, failures };
  return { ...link, failures, state: 'unreachable', unreachableSince: link.unreachableSince ?? now };
}

/** The one line that says how fresh the page is. */
export function freshness(link: Link, now: number, clock: (ts: number) => string, ago: (ms: number) => string): string {
  if (link.state === 'unreachable') return `server not reachable since ${clock(link.unreachableSince ?? now)}`;
  if (link.state === 'loading') return now - link.startedAt > SLOW_FIRST_MS ? 'waiting for the local server' : '';
  return `updated ${ago(now - (link.lastOkAt ?? now))}`;
}
