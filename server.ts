/**
 * server.ts: the local, read-only server behind The Nod Board.
 *
 *   GET /                the dashboard app's page (dist/index.html, built by scripts/build.ts)
 *   GET /app.js, /app.css, /fonts/<file>   the app's own files, from a fixed list
 *   GET /api/inbox       the sessions that need attention, as JSON
 *   GET /api/judgment    totals, answer-time buckets, the profile per model, sessions, splits and
 *                        the weekly trend from the outcome store, as JSON
 *   GET /health          {app, version, stale, ok, last_event_ts, sources}; ok means the data
 *                        directory is readable (no events yet is ok)
 *
 * Bound to 127.0.0.1. Every request whose Host header is not exactly 127.0.0.1:<port> or
 * localhost:<port> gets 403 (DNS-rebinding guard). GET and HEAD only: there is no route that
 * changes anything. The page may load scripts, styles, fonts and data from this server only
 * (CSP), with no inline script; all session text is rendered as text by the app.
 *
 * Env: AGENT_INBOX_PORT (one fixed port; without it 4777 or the next free one up to 4786), plus
 * the paths read by inbox.ts configFromEnv.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APP_NAME,
  DEFAULT_PORT,
  Inbox,
  candidatePorts,
  captureSince,
  clearAddressPort,
  configFromEnv,
  instanceId,
  maybeCompact,
  pluginVersion,
  portFromEnv,
  readWantedVersion,
  recoverLeftovers,
  writeAddressPort,
  type InboxModel,
  type ShownSession,
} from './inbox';
import { FAST_ANSWER_MS, MIN_N, TIME_BUCKET_MS } from './judgment';
import { boardData } from './outcomes';
import { INSTANCE_HEADER, STARTER_STEP_MS, STARTER_WAIT_MS, probeServer, type ServerState } from './hook';

export { DEFAULT_PORT };
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function allowedHost(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// ---------------------------------------------------------------- JSON for the dashboard app

/** A session as the app needs it: no raw events, only what is shown. */
export function sessionJson(s: ShownSession) {
  return {
    session_id: s.session_id,
    project: s.project,
    cwd: s.cwd,
    state: s.state,
    display: s.display,
    since: s.since,
    last_ts: s.last_ts,
    message: s.message,
  };
}

export function inboxJson(m: InboxModel) {
  return {
    now: m.now,
    waiting: m.waiting.map(sessionJson),
    permission: m.permission.map(sessionJson),
    done_unread: m.doneUnread.map(sessionJson),
    stale: m.stale.map(sessionJson),
    /** null when gstack is not present: the app then shows no TODOS block at all. */
    todos: m.todos === null ? null : m.todos.map((t) => ({ project: t.project, file: path.basename(t.file), items: t.items })),
    health: {
      events: m.health.events,
      unreadable_lines: m.health.unreadable + m.health.partial,
      hook_errors: m.health.hookErrors,
      sessions_running: m.health.sessionsRunning,
      last_event_ts: m.health.lastEventTs,
    },
  };
}

export function judgmentJson(inbox: Inbox, version: string, now: number) {
  const movedOn = inbox.movedOn();
  const board = boardData(inbox.cfg.dir, { now, movedOnAt: (session) => movedOn.get(session) ?? null });
  return {
    now,
    version,
    /** Below this many answered questions a share is not shown ("too few"). */
    min_n: MIN_N,
    /** An answer faster than this counts as fast (timing.fast). */
    fast_ms: FAST_ANSWER_MS,
    live_since: captureSince(inbox.cfg.dir),
    ...board.totals,
    inferred_dismissed: board.inferredDismissed,
    /** Questions whose model or skill another import could fill; 0 hides the hint. */
    needs_import: board.needsImport,
    weekly: board.weekly,
    weekly_time: board.weeklyTime,
    /** Width of one answer-time bucket in timeBuckets. */
    time_bucket_ms: TIME_BUCKET_MS,
    capture: { unreadable_lines: board.unreadable, sources: board.sources },
  };
}

export type SessionPayload = ReturnType<typeof sessionJson>;
export type InboxPayload = ReturnType<typeof inboxJson>;
export type JudgmentPayload = ReturnType<typeof judgmentJson>;

// ---------------------------------------------------------------- the app's files

export const DIST_DIR = path.join(import.meta.dir, 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Map a request path to a built file. The names come from listing the dist directory, never
 * from the request, so no path outside it can be reached.
 */
export function staticFile(distDir: string, pathname: string): { file: string; type: string } | null {
  const wanted = pathname === '/' ? '/index.html' : pathname;
  const list = (dir: string, prefix: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && TYPES[path.extname(e.name)])
        .map((e) => `${prefix}${e.name}`);
    } catch {
      return [];
    }
  };
  const known = [...list(distDir, '/'), ...list(path.join(distDir, 'fonts'), '/fonts/')];
  if (!known.includes(wanted)) return null;
  return { file: path.join(distDir, wanted), type: TYPES[path.extname(wanted)] };
}

// ---------------------------------------------------------------- HTTP

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export interface ServerOptions {
  /** Version this process was started from. */
  version?: string;
  /** Called once, after a /health reply that reported the server stale. */
  onStale?: () => void;
  /** Where the built app lives. */
  distDir?: string;
}

export function makeHandler(inbox: Inbox, getPort: () => number, opts: ServerOptions = {}) {
  const version = opts.version ?? pluginVersion();
  const distDir = opts.distDir ?? DIST_DIR;
  const instance = instanceId(inbox.cfg.dir);
  let staleReported = false;
  return async (req: Request): Promise<Response> => {
    const plain = (status: number, body: string) =>
      new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    const json = (body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', ...extra } });
    if (!allowedHost(req.headers.get('host'), getPort())) return plain(403, 'forbidden host\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'read-only\n');
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/inbox') return json(inboxJson(await inbox.model()));
      if (url.pathname === '/api/judgment') return json(judgmentJson(inbox, version, Date.now()));
      if (url.pathname === '/health') {
        // Bounded path: file reads only (the hook's probe polls this).
        const hl = inbox.health();
        // A session start records the plugin version it wants serving. An older server says it is
        // stale and steps aside, so the hook's starter can bring up the new one (no kill, no write route).
        const wanted = readWantedVersion(inbox.cfg.dir);
        const stale = wanted !== null && wanted !== version;
        if (stale && !staleReported) {
          staleReported = true;
          opts.onStale?.();
        }
        return json({
          app: APP_NAME,
          version,
          stale,
          ok: hl.ok,
          last_event_ts: hl.lastEventTs,
          sources: { events: hl.events, todos: hl.todos, unreadable_lines: hl.unreadable + hl.partial, hook_errors: hl.hookErrors },
        }, { [INSTANCE_HEADER]: instance }); // which data directory this server serves; the body keeps its 0.1.1 shape
      }
      const found = staticFile(distDir, url.pathname);
      if (found) return new Response(Bun.file(found.file), { headers: { ...SECURITY_HEADERS, 'Content-Type': found.type } });
      if (url.pathname === '/') return plain(503, 'The dashboard has not been built in this checkout. Run: bun run build\n');
      return plain(404, 'not found\n');
    } catch (err) {
      console.error('nod-board: request failed:', (err as Error).name, (err as Error).message);
      return plain(500, 'request failed (see server log)\n');
    }
  };
}

export interface StartOptions extends ServerOptions {
  /** Listen on exactly this port (0 for any). Without it, the first free port of `ports` is taken. */
  port?: number;
  /** The ports to choose from, lowest first; defaults to candidatePorts() from the environment. */
  ports?: readonly number[];
  inbox?: Inbox;
  compact?: { thresholdBytes?: number; graceMs?: number; everyMs?: number } | false;
}

export function start(opts: StartOptions = {}) {
  const cfg = configFromEnv();
  const inbox = opts.inbox ?? new Inbox(cfg);
  let actualPort = 0;
  const handler = makeHandler(inbox, () => actualPort, opts);
  // The operating system arbitrates: binding either succeeds or the port is somebody else's.
  const ports = opts.port !== undefined ? [opts.port] : (opts.ports ?? candidatePorts());
  let server: ReturnType<typeof Bun.serve> | null = null;
  let lastError: unknown = null;
  for (const port of ports) {
    try {
      server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!server) throw new Error(`no free port among ${ports.join(', ')}: ${(lastError as Error)?.message ?? 'unknown error'}`);
  actualPort = server.port;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.compact !== false) {
    const c = opts.compact ?? {};
    recoverLeftovers(inbox.cfg.dir);
    let busy = false;
    timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await maybeCompact(inbox.cfg.dir, c);
      } catch (err) {
        console.error('nod-board: compaction failed', err);
      } finally {
        busy = false;
      }
    }, c.everyMs ?? 60_000);
  }
  return {
    server,
    port: actualPort,
    stop() {
      if (timer) clearInterval(timer);
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------- one server per data directory
//
//   bind the first free port of the range            (start, above)
//   then ask every LOWER port of the range:
//       a current server of ours answers  -> leave: it was there first. It holds the lower port,
//                                            which is why this start could only get a higher one,
//                                            and a bound server answers /health at once.
//       an older server of ours answers   -> wait for it to leave (it exits by itself, below)
//       another program, or nobody        -> not our concern
//   then record the port in server-address.json and serve.
//
//   Every WANTED_CHECK_MS: the plugin version a session start asked for differs from mine
//       -> remove my address entry and exit. No probe is needed for that, so an older hook that
//          looks only at its own port (a rollback) still gets a free field.
//
// No lock file: nothing can be left behind by a crash, and two starts cannot both stay.

export const WANTED_CHECK_MS = 2_000;

export interface SettleDeps {
  version: string;
  probe: (port: number, version: string) => Promise<ServerState>;
  sleep: (ms: number) => Promise<void>;
}

/** After binding `port`: 'stay', or 'leave' because a current server of ours holds a lower port. */
export async function settle(port: number, ports: readonly number[], deps: SettleDeps): Promise<'stay' | 'leave'> {
  for (const lower of ports.filter((p) => p < port)) {
    for (let waited = 0; ; waited += STARTER_STEP_MS) {
      const state = await deps.probe(lower, deps.version);
      if (state === 'current') return 'leave';
      if (state !== 'stale' || waited >= STARTER_WAIT_MS) break;
      await deps.sleep(STARTER_STEP_MS);
    }
  }
  return 'stay';
}

export interface ServeOptions extends StartOptions {
  /** Called instead of process.exit, with the reason; tests use it. */
  onLeave?: (reason: 'another-server' | 'not-wanted' | 'stale') => void;
  settle?: Partial<SettleDeps>;
}

/**
 * Start the board the way the installed plugin does: take a port, make sure no other server of
 * ours for this data is running, publish the address, and leave when another version is wanted.
 * Returns null when it left at once.
 */
export async function serve(opts: ServeOptions = {}) {
  const version = opts.version ?? pluginVersion();
  const cfg = configFromEnv();
  const inbox = opts.inbox ?? new Inbox(cfg);
  const dir = inbox.cfg.dir;
  const ports = opts.port !== undefined ? [opts.port] : (opts.ports ?? candidatePorts());
  let watch: ReturnType<typeof setInterval> | null = null;
  let left = false;
  const leave = (reason: 'another-server' | 'not-wanted' | 'stale') => {
    if (left) return;
    left = true;
    if (watch) clearInterval(watch);
    try {
      clearAddressPort(dir, started.port);
    } catch {
      // the file is a hint; a reader checks /health before it believes it
    }
    started.stop();
    if (opts.onLeave) opts.onLeave(reason);
    else process.exit(0);
  };
  // Leave the reply time to flush, then go; the hook's starter is waiting for this server to leave.
  const started = start({ ...opts, inbox, version, ports, onStale: () => setTimeout(() => leave('stale'), 100) });
  const instance = instanceId(dir);
  const decision = await settle(started.port, ports, {
    version,
    probe: (port, wanted) => probeServer(port, wanted, fetch, instance),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...opts.settle,
  });
  if (decision === 'leave') {
    leave('another-server');
    return null;
  }
  writeAddressPort(dir, started.port);
  watch = setInterval(() => {
    const wanted = readWantedVersion(dir);
    if (wanted !== null && wanted !== version) leave('not-wanted');
  }, WANTED_CHECK_MS);
  return { ...started, leave };
}

if (import.meta.main) {
  try {
    const s = await serve({ version: pluginVersion() });
    if (s) console.log(`The Nod Board is listening on http://127.0.0.1:${s.port}/`);
    else console.log('The Nod Board is already running for this data folder; this start left.');
  } catch (err) {
    console.error(`nod-board: could not start: ${(err as Error).message}`);
    process.exit(1);
  }
}
