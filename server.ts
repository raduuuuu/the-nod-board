/**
 * server.ts: the local, read-only server behind The Nod Board.
 *
 *   GET /                the dashboard app's page (dist/index.html, built by scripts/build.ts)
 *   GET /app.js, /app.css, /fonts/<file>   the app's own files, from a fixed list
 *   GET /api/inbox       the sessions that need attention, as JSON
 *   GET /api/judgment    totals, splits and the weekly trend from the outcome store, as JSON
 *   GET /health          {app, version, stale, ok, last_event_ts, sources}; ok means the data
 *                        directory is readable (no events yet is ok)
 *
 * Bound to 127.0.0.1. Every request whose Host header is not exactly 127.0.0.1:<port> or
 * localhost:<port> gets 403 (DNS-rebinding guard). GET and HEAD only: there is no route that
 * changes anything. The page may load scripts, styles, fonts and data from this server only
 * (CSP), with no inline script; all session text is rendered as text by the app.
 *
 * Env: AGENT_INBOX_PORT (default 4777), plus the paths read by inbox.ts configFromEnv.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APP_NAME,
  DEFAULT_PORT,
  Inbox,
  captureSince,
  configFromEnv,
  maybeCompact,
  pluginVersion,
  portFromEnv,
  readWantedVersion,
  recoverLeftovers,
  type InboxModel,
  type ShownSession,
} from './inbox';
import { FAST_ANSWER_MS, MIN_N } from './judgment';
import { boardData } from './outcomes';

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
  let staleReported = false;
  return async (req: Request): Promise<Response> => {
    const plain = (status: number, body: string) =>
      new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' } });
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
        });
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
  port?: number;
  inbox?: Inbox;
  compact?: { thresholdBytes?: number; graceMs?: number; everyMs?: number } | false;
}

export function start(opts: StartOptions = {}) {
  const cfg = configFromEnv();
  const inbox = opts.inbox ?? new Inbox(cfg);
  const port = opts.port ?? portFromEnv();
  let actualPort = port;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: makeHandler(inbox, () => actualPort, opts),
  });
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

if (import.meta.main) {
  // Leave the reply time to flush, then exit; the hook's starter is waiting for the port.
  const s = start({ version: pluginVersion(), onStale: () => setTimeout(() => process.exit(0), 100) });
  console.log(`The Nod Board is listening on http://127.0.0.1:${s.port}/`);
}
