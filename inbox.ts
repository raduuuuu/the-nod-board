/**
 * inbox.ts: every "what needs me" rule lives here.
 *
 *   fold(events, now)       pure session state machine (no fs, no clock)
 *   readEventLog / compact  events.jsonl + state-snapshot.jsonl + rotated files (R7)
 *   projects                named after the folder the session started in, by repository (project.ts)
 *   readTodos               optional gstack integration: <state root>/projects/*\/<project>-TODOS.md, shown only
 *                           when a gstack state directory exists
 *   buildModel              everything above, assembled for server.ts to render
 * (The Judgment page has its own module, judgment.ts; only its config path lives here.)
 *
 * Session states (per session_id, derived from events only, never stored):
 *   Notification idle_prompt | elicitation_dialog  → WAITING (firm: Claude stopped and needs input)
 *   Notification permission_prompt                  → PERMISSION_ASKED ("may be approved"; no hook fires on approval)
 *   PostToolUse | PostToolUseFailure | UserPromptSubmit while WAITING/PERMISSION_ASKED → RUNNING
 *   UserPromptSubmit (any state)                     → RUNNING (clears DONE_UNREAD)
 *   Stop                                             → DONE_UNREAD
 *   SessionEnd                                       → ENDED (hidden; a later event starts a new lifecycle)
 *   WAITING/PERMISSION_ASKED with no event for 12h   → STALE (shown greyed)
 *   WAITING/PERMISSION_ASKED with no event for 7 days → hidden, pruned at compaction (a closed
 *                                                      session never says so when SessionEnd is not registered)
 *   DONE_UNREAD older than 12h                       → hidden (no page-view clearing, R9)
 * Events are ordered by ts (file order breaks ties), so out-of-order lines are tolerated.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gstackStateRoot, projectOfSession, readAliases, shownName } from './project';

export const HOUR = 3_600_000;
export const STALE_AFTER_MS = 12 * HOUR;
export const DONE_UNREAD_TTL_MS = 12 * HOUR;
export const UNASSIGNED = 'Unassigned';

// ---------------------------------------------------------------- events

export interface InboxEvent {
  session_id: string;
  cwd: string | null;
  hook_event_name: string | null;
  notification_type: string | null;
  message: string | null;
  ts: number; // epoch ms (hook.ts writes epoch ms; ISO strings are accepted too)
}

/** Normalise one parsed JSON value into an event, or null when it is not one. */
export function toEvent(v: unknown): InboxEvent | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.session_id !== 'string' || !o.session_id) return null;
  let ts: number;
  if (typeof o.ts === 'number' && Number.isFinite(o.ts)) ts = o.ts;
  else if (typeof o.ts === 'string' && !Number.isNaN(Date.parse(o.ts))) ts = Date.parse(o.ts);
  else return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  return {
    session_id: o.session_id,
    cwd: str(o.cwd),
    hook_event_name: str(o.hook_event_name),
    notification_type: str(o.notification_type),
    message: str(o.message),
    ts,
  };
}

// ---------------------------------------------------------------- fold

export type SessionState = 'WAITING' | 'PERMISSION_ASKED' | 'RUNNING' | 'DONE_UNREAD' | 'ENDED';
export type DisplayState = 'WAITING' | 'PERMISSION_ASKED' | 'DONE_UNREAD' | 'STALE' | 'HIDDEN';

export interface Session {
  session_id: string;
  cwd: string | null;
  state: SessionState;
  /** What the page shows. STALE keeps `state` (WAITING or PERMISSION_ASKED) for the label. */
  display: DisplayState;
  /** ts of the event that put the session in `state`. */
  since: number;
  /** ts of the newest event for this session. */
  last_ts: number;
  message: string | null;
  /** The event that defines `state`; compaction keeps it. */
  stateEvent: InboxEvent;
  /** The newest event; compaction keeps it too when it is not `stateEvent`, so `last_ts` survives. */
  lastEvent: InboxEvent;
}

/** Map a Notification to a state, or null when it does not ask anything of the user. */
export function notificationState(e: InboxEvent): 'WAITING' | 'PERMISSION_ASKED' | null {
  const t = e.notification_type;
  if (t === 'permission_prompt') return 'PERMISSION_ASKED';
  if (t === 'idle_prompt' || t === 'elicitation_dialog') return 'WAITING';
  if (t) return null; // auth_success and future informational types
  // Older Claude Code builds send no notification_type: infer from the fixed message text.
  const m = (e.message ?? '').toLowerCase();
  if (m.includes('permission')) return 'PERMISSION_ASKED';
  return 'WAITING';
}

function transition(cur: SessionState | null, e: InboxEvent): SessionState | null {
  const asking = cur === 'WAITING' || cur === 'PERMISSION_ASKED';
  switch (e.hook_event_name) {
    case 'Notification':
      return notificationState(e) ?? (cur === 'ENDED' ? null : cur);
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (asking) return 'RUNNING';
      if (cur === null || cur === 'ENDED') return 'RUNNING';
      return cur; // RUNNING stays RUNNING; DONE_UNREAD only clears on prompt/end/12h
    case 'UserPromptSubmit':
      return 'RUNNING';
    case 'Stop':
      return 'DONE_UNREAD';
    case 'SessionEnd':
      return 'ENDED';
    default:
      return cur === 'ENDED' ? null : cur;
  }
}

/** Pure fold: events (any order) → sessions keyed by session_id. */
export function fold(events: readonly InboxEvent[], now: number): Map<string, Session> {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i);
  const out = new Map<string, Session>();
  for (const { e } of ordered) {
    const prev = out.get(e.session_id);
    const cur = prev ? prev.state : null;
    const next = transition(cur, e);
    if (next === null) {
      if (prev) touch(prev, e);
      continue;
    }
    // A repeated ask or Stop restarts the clock; informational notifications never do.
    const reasserted =
      (e.hook_event_name === 'Notification' && notificationState(e) !== null) || e.hook_event_name === 'Stop';
    const changed = !prev || next !== cur || reasserted;
    if (changed) {
      out.set(e.session_id, {
        session_id: e.session_id,
        cwd: e.cwd ?? prev?.cwd ?? null,
        state: next,
        display: 'HIDDEN',
        since: e.ts,
        last_ts: Math.max(prev?.last_ts ?? e.ts, e.ts),
        message: e.hook_event_name === 'Notification' ? e.message : null,
        stateEvent: e,
        lastEvent: e, // events arrive sorted by ts, so e is the newest so far
      });
    } else {
      touch(prev, e);
      if (!prev.cwd && e.cwd) prev.cwd = e.cwd;
    }
  }
  for (const s of out.values()) s.display = displayOf(s, now);
  return out;
}

/** A later event that does not change the state still counts as activity. */
function touch(s: Session, e: InboxEvent) {
  if (e.ts >= s.last_ts) {
    s.last_ts = e.ts;
    s.lastEvent = e;
  }
}

function displayOf(s: Session, now: number): DisplayState {
  switch (s.state) {
    case 'WAITING':
    case 'PERMISSION_ASKED':
      if (now - s.last_ts > SNAPSHOT_PRUNE_MS) return 'HIDDEN';
      return now - s.last_ts > STALE_AFTER_MS ? 'STALE' : s.state;
    case 'DONE_UNREAD':
      return now - s.since > DONE_UNREAD_TTL_MS ? 'HIDDEN' : 'DONE_UNREAD';
    default:
      return 'HIDDEN';
  }
}

// ---------------------------------------------------------------- event log files

export interface ReadStats {
  /** Lines that were not JSON or not an event. */
  unreadable: number;
  /** Unterminated last lines (an append in flight, or a crash mid-write). */
  partial: number;
}

/** Parse a JSONL text; an unterminated last line is skipped and counted. */
export function parseLines(text: string): { events: InboxEvent[]; stats: ReadStats } {
  const stats: ReadStats = { unreadable: 0, partial: 0 };
  const events: InboxEvent[] = [];
  if (!text) return { events, stats };
  const lines = text.split('\n');
  const last = lines.pop() as string; // '' when the text ends with a newline
  if (last.trim()) stats.partial++;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: InboxEvent | null = null;
    try {
      ev = toEvent(JSON.parse(line));
    } catch {
      ev = null;
    }
    if (ev) events.push(ev);
    else stats.unreadable++;
  }
  return { events, stats };
}

export const LIVE = 'events.jsonl';
export const SNAPSHOT = 'state-snapshot.jsonl';
const ROTATED_RE = /^events\.(\d+)(?:-\d+)?\.jsonl$/;

export function rotatedFiles(dir: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => ROTATED_RE.test(n)).sort().map((n) => path.join(dir, n));
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface EventLog {
  events: InboxEvent[];
  stats: ReadStats;
  /** True when no events file, snapshot or rotated file exists yet. */
  missing: boolean;
}

/** Snapshot + any rotated files still waiting for compaction + live file. */
export function readEventLog(dir: string): EventLog {
  const files = [path.join(dir, SNAPSHOT), ...rotatedFiles(dir), path.join(dir, LIVE)];
  const events: InboxEvent[] = [];
  const stats: ReadStats = { unreadable: 0, partial: 0 };
  let found = 0;
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    found++;
    const r = parseLines(text);
    events.push(...r.events);
    stats.unreadable += r.stats.unreadable;
    stats.partial += r.stats.partial;
  }
  return { events, stats, missing: found === 0 };
}

// ---------------------------------------------------------------- compaction (R7)

export interface CompactOptions {
  /** Rotate when the live file is at least this many bytes. Default 5MB. */
  thresholdBytes?: number;
  /** Wait after the rename so in-flight hook appends land in the rotated file. Default 2000ms. */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam: runs after the snapshot is written and before the rotated file is deleted. */
  beforeDelete?: (rotated: string) => void;
}

/** Sessions with no event this long are hidden and dropped from the snapshot, asking or not. */
export const SNAPSHOT_PRUNE_MS = 7 * 24 * HOUR;

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Fold the snapshot plus `rotated` into a new snapshot: the state-defining event of
 * every non-ENDED session with an event in the last 7 days, plus its newest event when
 * that is a different one (so the inactivity clocks read the same after compaction). Idempotent,
 * so a crash between the snapshot write and the delete is repaired by running it again.
 */
export function foldIntoSnapshot(dir: string, rotated: string, now: number) {
  const snapFile = path.join(dir, SNAPSHOT);
  const snap = parseLines(readText(snapFile) ?? '').events;
  const rot = parseLines(readText(rotated) ?? '').events;
  const sessions = fold([...snap, ...rot], now);
  const keep: InboxEvent[] = [];
  for (const s of sessions.values()) {
    if (s.state === 'ENDED') continue;
    if (now - s.last_ts > SNAPSHOT_PRUNE_MS) continue;
    keep.push(s.stateEvent);
    if (s.lastEvent !== s.stateEvent) keep.push(s.lastEvent);
  }
  keep.sort((a, b) => a.ts - b.ts);
  writeAtomic(snapFile, keep.map((e) => JSON.stringify(e) + '\n').join(''));
}

function compactRotated(dir: string, rotated: string, opts: CompactOptions) {
  foldIntoSnapshot(dir, rotated, (opts.now ?? Date.now)());
  opts.beforeDelete?.(rotated);
  fs.rmSync(rotated, { force: true });
}

/** Startup recovery: compact rotated files a crash left behind. Returns how many. */
export function recoverLeftovers(dir: string, opts: CompactOptions = {}): number {
  const left = rotatedFiles(dir);
  for (const f of left) compactRotated(dir, f, opts);
  return left.length;
}

/** Rotate + compact when the live file crossed the threshold. Returns true when it rotated. */
export async function maybeCompact(dir: string, opts: CompactOptions = {}): Promise<boolean> {
  const threshold = opts.thresholdBytes ?? 5 * 1024 * 1024;
  const live = path.join(dir, LIVE);
  let size = 0;
  try {
    size = fs.statSync(live).size;
  } catch {
    return false;
  }
  if (size < threshold) return false;
  const now = (opts.now ?? Date.now)();
  let rotated = path.join(dir, `events.${now}.jsonl`);
  for (let n = 1; fs.existsSync(rotated); n++) rotated = path.join(dir, `events.${now}-${n}.jsonl`);
  fs.renameSync(live, rotated); // new hook runs open the path fresh → a new live file
  await (opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(opts.graceMs ?? 2000);
  compactRotated(dir, rotated, opts);
  return true;
}

// ---------------------------------------------------------------- TODOS

export interface TodoFile {
  /** The gstack project the file belongs to, else the name the file itself carries. Never empty. */
  project: string;
  file: string;
  items: string[];
}

/** `<project>` maps to a slug only when it is the slug or the slug's repo-name part, and unambiguous. */
export function mapTodoProject(project: string, knownSlugs: Iterable<string>): string {
  const hits = new Set<string>();
  for (const slug of knownSlugs) {
    if (slug === UNASSIGNED) continue;
    const dash = slug.indexOf('-');
    if (slug === project || (dash > 0 && slug.slice(dash + 1) === project)) hits.add(slug);
  }
  if (hits.has(project)) return project;
  return hits.size === 1 ? [...hits][0] : UNASSIGNED;
}

export function todoHeadings(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * The project a `<name>-TODOS.md` file is shown under: the gstack project it maps to
 * (mapTodoProject); else the one project whose name begins with "<name>-" (a file named after
 * the first word of its project); else the name the file carries. A list is never shown under
 * "Unassigned" when its own file says what it is for.
 */
export function todoProject(name: string, knownSlugs: readonly string[]): string {
  const mapped = mapTodoProject(name, knownSlugs);
  if (mapped !== UNASSIGNED) return mapped;
  const starts = knownSlugs.filter((slug) => slug !== UNASSIGNED && slug.startsWith(`${name}-`));
  return starts.length === 1 ? starts[0] : name;
}

/** Returns null when the projects root is missing. */
export function readTodos(stateRoot: string, knownSlugs: Iterable<string>): TodoFile[] | null {
  const projectsDir = path.join(stateRoot, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  const known = [...knownSlugs];
  const out: TodoFile[] = [];
  for (const d of dirs.sort()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const m = /^(.+)-TODOS\.md$/.exec(n);
      if (!m) continue;
      const file = path.join(projectsDir, d, n);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      out.push({ project: todoProject(m[1], known), file, items: todoHeadings(text) });
    }
  }
  return out;
}

export function knownProjectDirs(stateRoot: string): string[] {
  try {
    return fs
      .readdirSync(path.join(stateRoot, 'projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- what the outcome store needs from session events

/** Events that show a session went on after a question: a new prompt, a finished turn, the end. Notifications do not. */
const MOVED_ON: ReadonlySet<string> = new Set(['UserPromptSubmit', 'Stop', 'SessionEnd']);

/** Latest moved-on event per session. */
export function movedOnIndex(events: readonly InboxEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (!e.hook_event_name || !MOVED_ON.has(e.hook_event_name)) continue;
    if (e.ts > (out.get(e.session_id) ?? -Infinity)) out.set(e.session_id, e.ts);
  }
  return out;
}

export const SINCE_FILE = 'capture-since';

/** Record once when capture began on this machine. */
export function markCaptureStart(dir: string, now: number): void {
  const file = path.join(dir, SINCE_FILE);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${now}\n`, { mode: 0o600, flag: 'wx' });
}

/** When capture began: the recorded start, else when the data directory was created, else unknown. */
export function captureSince(dir: string): number | null {
  try {
    const n = Number(fs.readFileSync(path.join(dir, SINCE_FILE), 'utf8').trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall through to the directory's creation time
  }
  try {
    const born = fs.statSync(dir).birthtimeMs;
    return born > 0 ? Math.floor(born) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- server identity

/** Plugin id (kebab-case, as Claude Code requires) and the name people see. */
export const APP_NAME = 'nod-board';
export const APP_TITLE = 'The Nod Board';
export const DEFAULT_PORT = 4777;
/** Written by the SessionStart hook: the plugin version that should be serving. */
export const WANTED_FILE = 'server-wanted.json';

export function portFromEnv(env: Record<string, string | undefined> = process.env): number {
  return Number(env.AGENT_INBOX_PORT) || DEFAULT_PORT;
}

// ---------------------------------------------------------------- which port
//
//   AGENT_INBOX_PORT set   -> that port and no other (the user chose it)
//   not set                -> the first free port of 4777..4786, taken by the server when it starts
//
// The server writes the port it took to server-address.json. The hook and the commands read that
// file to know where the board is; they never scan. A file that names a port nobody answers on
// is harmless: the reader checks /health before it believes it.

/** How many ports, counting up from DEFAULT_PORT, the server may choose from. */
export const PORT_RANGE = 10;
export const ADDRESS_FILE = 'server-address.json';

/** The port the user fixed with AGENT_INBOX_PORT, or null when the server may choose. */
export function explicitPort(env: Record<string, string | undefined> = process.env): number | null {
  const n = Number(env.AGENT_INBOX_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** The ports the server may listen on, lowest first. */
export function candidatePorts(env: Record<string, string | undefined> = process.env): number[] {
  const fixed = explicitPort(env);
  return fixed !== null ? [fixed] : Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i);
}

/** The port the running server said it took, or null. Only a port number is ever read from the file. */
export function readAddressPort(dir: string): number | null {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(dir, ADDRESS_FILE), 'utf8')).port;
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

export function writeAddressPort(dir: string, port: number): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${ADDRESS_FILE}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify({ port }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, ADDRESS_FILE));
}

/** Remove the address file when it still names `port`: a server leaving must not erase its successor's entry. */
export function clearAddressPort(dir: string, port: number): void {
  if (readAddressPort(dir) === port) fs.rmSync(path.join(dir, ADDRESS_FILE), { force: true });
}

/**
 * Where to look for the board: the fixed port, else the one the server recorded (when it is a
 * port the server could have chosen), else the first of the range.
 */
export function knownPort(env: Record<string, string | undefined>, dir: string): number {
  const ports = candidatePorts(env);
  if (ports.length === 1) return ports[0];
  const recorded = readAddressPort(dir);
  return recorded !== null && ports.includes(recorded) ? recorded : ports[0];
}

/**
 * Names this data directory in /health, so that a server for another user's or another
 * checkout's data is not mistaken for this one. Not a secret: a short hash of the path.
 */
export function instanceId(dir: string): string {
  return new Bun.CryptoHasher('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

/** The board's address, the one place it is spelled out. Always this machine. */
export function boardUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** Holds the address the first-run line last showed, so the line appears once per address. */
export const SHOWN_FILE = 'address-shown';
/** Holds the time a server start was launched; removed by the first session start that finds the server answering. */
export const PENDING_FILE = 'server-start-pending';

function readSmall(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
function writeSmall(dir: string, name: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), `${text}\n`, { mode: 0o600 });
}

/** The address the user was last told about, or null when they were never told. */
export function shownAddress(dir: string): string | null {
  return readSmall(path.join(dir, SHOWN_FILE));
}
export function markAddressShown(dir: string, url: string): void {
  writeSmall(dir, SHOWN_FILE, url);
}

/** When a server start was launched that no session start has yet seen succeed, or null. */
export function startPendingSince(dir: string): number | null {
  const n = Number(readSmall(path.join(dir, PENDING_FILE)));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function markStartPending(dir: string, now: number): void {
  writeSmall(dir, PENDING_FILE, String(now));
}
export function clearStartPending(dir: string): void {
  fs.rmSync(path.join(dir, PENDING_FILE), { force: true });
}

/** The version in this checkout's plugin manifest, the one place it is written. */
export function pluginVersion(root: string = import.meta.dir): string {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The version the latest session start asked for, or null when none was recorded. */
export function readWantedVersion(dir: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, WANTED_FILE), 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

export function writeWantedVersion(dir: string, version: string, root: string): void {
  if (readWantedVersion(dir) === version) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${WANTED_FILE}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify({ version, root }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, WANTED_FILE));
}

// ---------------------------------------------------------------- config + model

export interface InboxConfig {
  dir: string;
  /** The user's home directory; a session running there is shown as "no project". */
  home: string;
  stateRoot: string;
  /** Claude Code transcripts, read by judgment.ts. */
  transcriptsDir: string;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): InboxConfig {
  const home = env.HOME || os.homedir();
  return {
    dir: env.AGENT_INBOX_DIR || path.join(home, '.agent-inbox'),
    home,
    stateRoot: gstackStateRoot(env, home),
    transcriptsDir: env.AGENT_INBOX_TRANSCRIPTS || path.join(home, '.claude', 'projects'),
  };
}

export interface ShownSession extends Session {
  project: string;
}

export interface InboxModel {
  now: number;
  waiting: ShownSession[];
  permission: ShownSession[];
  doneUnread: ShownSession[];
  stale: ShownSession[];
  todos: TodoFile[] | null;
  health: {
    /** "none yet": no event file exists (a fresh install before the first hook fires). */
    events: 'ok' | 'none yet';
    unreadable: number;
    partial: number;
    hookErrors: number;
    /** When the latest of them happened; null with none, or when its line has no time. */
    lastHookErrorTs: number | null;
    lastEventTs: number | null;
    sessionsRunning: number;
  };
}

/** What GET /health reports. Built without any awaited child process. */
export interface InboxHealth {
  ok: boolean;
  events: 'ok' | 'none yet' | 'unreadable';
  unreadable: number;
  partial: number;
  hookErrors: number;
  lastEventTs: number | null;
  /** The optional gstack integration: present or not. Never an error. */
  todos: 'ok' | 'absent';
}

function newestTs(events: readonly InboxEvent[]): number | null {
  let last: number | null = null;
  for (const e of events) if (last === null || e.ts > last) last = e.ts;
  return last;
}

function countLines(file: string): number {
  const t = readText(file);
  return t ? t.split('\n').filter((l) => l.trim()).length : 0;
}

/** The file hook.ts appends one line to per problem, each beginning with the time it happened. */
export const HOOK_ERRORS_FILE = 'hook-errors.log';

/**
 * When the latest hook problem was recorded, or null when there is none or its line carries no time.
 * A count alone cannot tell a problem from last month from one a minute ago; the page shows both.
 */
export function lastHookErrorTs(dir: string): number | null {
  const lines = (readText(path.join(dir, HOOK_ERRORS_FILE)) ?? '').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const ts = Date.parse(lines[lines.length - 1].trim().split(' ')[0]);
  return Number.isFinite(ts) ? ts : null;
}

export class Inbox {
  constructor(readonly cfg: InboxConfig) {}

  /** Bounded: file reads only. Never throws. */
  health(): InboxHealth {
    const todos = fs.existsSync(path.join(this.cfg.stateRoot, 'projects')) ? 'ok' : 'absent';
    try {
      const log = readEventLog(this.cfg.dir);
      return {
        ok: true,
        events: log.missing ? 'none yet' : 'ok',
        unreadable: log.stats.unreadable,
        partial: log.stats.partial,
        hookErrors: countLines(path.join(this.cfg.dir, HOOK_ERRORS_FILE)),
        lastEventTs: newestTs(log.events),
        todos,
      };
    } catch (err) {
      console.error(`agent-inbox: cannot read ${this.cfg.dir}:`, (err as Error).message);
      return { ok: false, events: 'unreadable', unreadable: 0, partial: 0, hookErrors: 0, lastEventTs: null, todos };
    }
  }

  /** For each session, when it last moved on past a question (see movedOnIndex). */
  movedOn(): Map<string, number> {
    return movedOnIndex(readEventLog(this.cfg.dir).events);
  }

  async model(now = Date.now()): Promise<InboxModel> {
    const log = readEventLog(this.cfg.dir);
    const sessions = fold(log.events, now);
    const shown: ShownSession[] = [];
    let running = 0;
    // A session is named as its questions are (project.ts): after the folder it started in.
    const startCwd = new Map<string, string>();
    for (const e of [...log.events].sort((a, b) => a.ts - b.ts)) if (e.cwd && !startCwd.has(e.session_id)) startCwd.set(e.session_id, e.cwd);
    const aliases = readAliases(this.cfg.dir);
    for (const s of sessions.values()) {
      if (s.state === 'RUNNING') running++;
      if (s.display === 'HIDDEN') continue;
      const name = projectOfSession(startCwd.get(s.session_id), s.cwd, this.cfg.home);
      shown.push({ ...s, project: name === null ? UNASSIGNED : shownName(aliases, name) });
    }
    const newest = (a: ShownSession, b: ShownSession) => b.since - a.since;
    const by = (d: DisplayState) => shown.filter((s) => s.display === d).sort(newest);

    // TODO files belong to gstack projects; they are grouped by gstack's own project names.
    const known = new Set<string>(knownProjectDirs(this.cfg.stateRoot));

    return {
      now,
      waiting: by('WAITING'),
      permission: by('PERMISSION_ASKED'),
      doneUnread: by('DONE_UNREAD'),
      stale: by('STALE'),
      // Named like every other project on the page: the user's aliases apply.
      todos: readTodos(this.cfg.stateRoot, known)?.map((t) => ({ ...t, project: shownName(aliases, t.project) })) ?? null,
      health: {
        events: log.missing ? 'none yet' : 'ok',
        unreadable: log.stats.unreadable,
        partial: log.stats.partial,
        hookErrors: countLines(path.join(this.cfg.dir, HOOK_ERRORS_FILE)),
        lastHookErrorTs: lastHookErrorTs(this.cfg.dir),
        lastEventTs: newestTs(log.events),
        sessionsRunning: running,
      },
    };
  }
}
