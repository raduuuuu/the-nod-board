/** Text formatting for the dashboard. Pure, so every label can be tested without a browser. */

export const count = (n: number): string => n.toLocaleString('en-US');

export const percent = (part: number, whole: number): string => `${Math.round((100 * part) / whole)}%`;

/** A share is never shown without enough answers behind it: null means "too few". */
export function share(rate: { agreed: number; answered: number }, minN: number): string | null {
  return rate.answered < minN ? null : percent(rate.agreed, rate.answered);
}

export function duration(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** How long ago, in the coarsest unit that is still informative. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** How long something has lasted, to follow a verb: "waiting for 4 min", "waiting just now". */
export function lasting(ms: number): string {
  const text = ago(ms);
  return text.endsWith(' ago') ? `for ${text.slice(0, -4)}` : text;
}

export function day(ts: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(ts);
}

export function clock(ts: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(ts);
}

/** "Nov 12, 14:02": built from the two parts so the wording does not depend on the locale data's joining word. */
export function dayTime(ts: number | null, timeZone?: string): string {
  if (ts === null) return 'unknown';
  return `${day(ts, timeZone)}, ${clock(ts, timeZone)}`;
}
