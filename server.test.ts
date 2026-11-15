import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { APP_NAME, Inbox, SINCE_FILE, WANTED_FILE, markCaptureStart, pluginVersion, writeWantedVersion, type InboxEvent } from './inbox';
import { MIN_N } from './judgment';
import { ASKED, FORMAT_VERSION, appendObservation, type Observation, type ObservedKind } from './outcomes';
import { CSP, allowedHost, makeHandler, start, staticFile } from './server';

const XSS = '<script>alert(1)</script>';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-server-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A stand-in for the built app: the real build is exercised in app.test.ts. */
const DIST = path.join(root, 'dist');
fs.mkdirSync(path.join(DIST, 'fonts'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>The Nod Board</title><div id="app"></div>');
fs.writeFileSync(path.join(DIST, 'app.js'), 'console.log("app")');
fs.writeFileSync(path.join(DIST, 'app.css'), 'body{margin:0}');
fs.writeFileSync(path.join(DIST, 'fonts', 'face.woff2'), 'font-bytes');
fs.writeFileSync(path.join(DIST, 'fonts', 'LICENSE.txt'), 'SIL Open Font License');
fs.writeFileSync(path.join(DIST, 'secret.env'), 'TOKEN=1'); // a type the server does not serve
fs.writeFileSync(path.join(root, 'outside.txt'), 'outside the dist directory');

function inboxWith(name: string, events: InboxEvent[], gstack = true) {
  const dir = path.join(root, name);
  const state = path.join(dir, 'gstack');
  fs.mkdirSync(gstack ? path.join(state, 'projects') : dir, { recursive: true });
  if (events.length) fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
  return new Inbox({ dir, home: root, stateRoot: state, transcriptsDir: path.join(dir, 'transcripts') });
}

const now = Date.now();
const ev = (name: string, extra: Partial<InboxEvent>): InboxEvent => ({
  session_id: 'sess-xss',
  cwd: root,
  hook_event_name: name,
  notification_type: null,
  message: null,
  ts: now - 120_000,
  ...extra,
});

const PORT = 4777;
const req = (host: string | null, p = '/') => {
  const r = new Request(`http://127.0.0.1:${PORT}${p}`);
  if (host === null) r.headers.delete('host');
  else r.headers.set('host', host);
  return r;
};
const handlerFor = (inbox: Inbox, opts: Parameters<typeof makeHandler>[2] = {}) => makeHandler(inbox, () => PORT, { distDir: DIST, version: '1.2.3', ...opts });
const ALL_ROUTES = ['/', '/app.js', '/app.css', '/fonts/face.woff2', '/api/inbox', '/api/judgment', '/health'];

describe('Host allowlist', () => {
  const handler = handlerFor(inboxWith('hosts', []));

  test('pure check', () => {
    expect(allowedHost(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(allowedHost(`localhost:${PORT}`, PORT)).toBe(true);
    for (const bad of [null, '', 'evil.com', `evil.com:${PORT}`, '127.0.0.1', 'localhost', `127.0.0.1:${PORT + 1}`, `LOCALHOST:${PORT}`, `127.0.0.1:${PORT}.evil.com`]) {
      expect(allowedHost(bad, PORT)).toBe(false);
    }
  });

  test('127.0.0.1:port and localhost:port → 200 on every route', async () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      for (const p of ALL_ROUTES) expect([p, (await handler(req(host, p))).status]).toEqual([p, 200]);
    }
  });

  test('another host, a wrong port or no Host → 403 on every route', async () => {
    for (const p of ALL_ROUTES) {
      expect((await handler(req('evil.com', p))).status).toBe(403);
      expect((await handler(req(`evil.com:${PORT}`, p))).status).toBe(403);
      expect((await handler(req(`127.0.0.1:${PORT + 1}`, p))).status).toBe(403);
    }
    const r = req(null);
    expect(r.headers.get('host')).toBeNull();
    expect((await handler(r)).status).toBe(403);
  });

  test('anything but GET or HEAD → 405 on every route (no write endpoints)', async () => {
    for (const p of ALL_ROUTES) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = new Request(`http://127.0.0.1:${PORT}${p}`, { method, headers: { host: `127.0.0.1:${PORT}` } });
        expect((await handler(r)).status).toBe(405);
      }
    }
  });
});

describe('real socket', () => {
  let s: ReturnType<typeof start>;
  beforeAll(() => {
    s = start({ port: 0, inbox: inboxWith('socket', []), compact: false, distDir: DIST });
  });
  afterAll(() => s.stop());

  function raw(hostLine: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(s.port, '127.0.0.1');
      let data = '';
      sock.on('data', (d) => (data += d.toString()));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
      sock.write(`GET / HTTP/1.1\r\n${hostLine === null ? '' : `Host: ${hostLine}\r\n`}Connection: close\r\n\r\n`);
    });
  }

  test('binds 127.0.0.1; forged and missing Host → 403; real Host → 200', async () => {
    expect(s.server.hostname).toBe('127.0.0.1');
    expect(await raw(`127.0.0.1:${s.port}`)).toStartWith('HTTP/1.1 200');
    expect(await raw(`localhost:${s.port}`)).toStartWith('HTTP/1.1 200');
    expect(await raw('evil.com')).toStartWith('HTTP/1.1 403');
    const missing = await raw(null);
    expect(missing).toMatch(/^HTTP\/1\.1 (400|403)/); // Bun answers 400 to a Host-less HTTP/1.1 request before the handler runs (measured)
  });
});

describe('the app and its files', () => {
  const handler = handlerFor(inboxWith('files', []));
  const get = (p: string) => handler(req(`127.0.0.1:${PORT}`, p));

  test('the policy lets the page load scripts, styles, fonts and data from this server only', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    for (const never of ['unsafe-inline', 'unsafe-eval', 'http:', 'https:', '*']) expect(CSP).not.toContain(never);
  });

  test('/ is the page; each file has its type; every response carries the policy and is never cached', async () => {
    const types: Record<string, string> = {
      '/': 'text/html; charset=utf-8',
      '/app.js': 'text/javascript; charset=utf-8',
      '/app.css': 'text/css; charset=utf-8',
      '/fonts/face.woff2': 'font/woff2',
      '/fonts/LICENSE.txt': 'text/plain; charset=utf-8',
    };
    for (const [p, type] of Object.entries(types)) {
      const res = await get(p);
      expect([p, res.status, res.headers.get('content-type')]).toEqual([p, 200, type]);
      expect(res.headers.get('content-security-policy')).toBe(CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(await (await get('/')).text()).toContain('<div id="app">');
    expect(await (await get('/index.html')).text()).toContain('The Nod Board');
  });

  test('nothing outside the built files can be reached', async () => {
    for (const p of ['/secret.env', '/nope.js', '/fonts/', '/fonts', '/fonts/nope.woff2', '/judgment', '/app.js/', '/index.html/x']) {
      expect([p, (await get(p)).status]).toEqual([p, 404]);
    }
    // Names come from listing the directory, so a path that climbs out of it matches nothing.
    for (const p of ['/../outside.txt', '/fonts/../../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '//outside.txt']) {
      expect(staticFile(DIST, p)).toBeNull();
    }
    expect(staticFile(DIST, '/fonts/face.woff2')).toEqual({ file: path.join(DIST, 'fonts', 'face.woff2'), type: 'font/woff2' });
  });

  test('a checkout that was never built says how to build it; the data routes still work', async () => {
    const unbuilt = makeHandler(inboxWith('unbuilt', []), () => PORT, { distDir: path.join(root, 'no-dist') });
    const page = await unbuilt(req(`127.0.0.1:${PORT}`));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('bun run build');
    expect((await unbuilt(req(`127.0.0.1:${PORT}`, '/app.js'))).status).toBe(404);
    expect((await unbuilt(req(`127.0.0.1:${PORT}`, '/api/judgment'))).status).toBe(200);
  });
});

describe('/health', () => {
  const get = async (inbox: Inbox) => (await handlerFor(inbox)(req(`127.0.0.1:${PORT}`, '/health'))).json();

  test('shape', async () => {
    const body = await get(inboxWith('shape', []));
    expect(Object.keys(body).sort()).toEqual(['app', 'last_event_ts', 'ok', 'sources', 'stale', 'version']);
    expect(Object.keys(body.sources).sort()).toEqual(['events', 'hook_errors', 'todos', 'unreadable_lines']);
  });

  test('fresh install (data dir exists, no event yet) → ok with events "none yet"', async () => {
    const body = await get(inboxWith('fresh', []));
    expect(body.ok).toBe(true);
    expect(body.sources.events).toBe('none yet');
    expect(body.last_event_ts).toBeNull();
  });

  test('with events → ok, last_event_ts set', async () => {
    const body = await get(inboxWith('seen', [ev('Stop', {})]));
    expect(body.ok).toBe(true);
    expect(body.sources.events).toBe('ok');
    expect(body.last_event_ts).toBe(now - 120_000);
  });

  test('unreadable event log → ok false', async () => {
    const inbox = inboxWith('broken', []);
    fs.mkdirSync(path.join(inbox.cfg.dir, 'events.jsonl')); // a directory where the file should be: EISDIR
    const errors = console.error;
    console.error = () => {};
    let body: { ok: boolean; sources: { events: string } };
    try {
      body = await get(inbox);
    } finally {
      console.error = errors;
    }
    expect(body.ok).toBe(false);
    expect(body.sources.events).toBe('unreadable');
  });

  test('gstack is optional: its TODOS are "ok" when present and "absent" otherwise, never an error', async () => {
    expect((await get(inboxWith('with-gstack', []))).sources.todos).toBe('ok');
    const without = await get(inboxWith('without-gstack', [], false));
    expect([without.ok, without.sources.todos]).toEqual([true, 'absent']);
  });
});

describe('server identity', () => {
  const health = async (inbox: Inbox, identity: { version: string; onStale?: () => void }) => (await handlerFor(inbox, identity)(req(`127.0.0.1:${PORT}`, '/health'))).json();

  test('/health names the app and the version in the plugin manifest', async () => {
    const body = await (await makeHandler(inboxWith('id-default', []), () => PORT)(req(`127.0.0.1:${PORT}`, '/health'))).json();
    expect(body.app).toBe(APP_NAME);
    expect(body.version).toBe(pluginVersion());
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.stale).toBe(false);
  });

  test('no recorded wish, or a wish for this version: not stale, nothing happens', async () => {
    const inbox = inboxWith('id-current', []);
    let stale = 0;
    expect((await health(inbox, { version: '1.2.3', onStale: () => stale++ })).stale).toBe(false);
    writeWantedVersion(inbox.cfg.dir, '1.2.3', '/plugin/root');
    expect((await health(inbox, { version: '1.2.3', onStale: () => stale++ })).stale).toBe(false);
    expect(stale).toBe(0);
    expect(fs.statSync(path.join(inbox.cfg.dir, WANTED_FILE)).mode & 0o777).toBe(0o600);
  });

  test('a session start that wants another version: the server says stale and steps aside once', async () => {
    const inbox = inboxWith('id-stale', []);
    writeWantedVersion(inbox.cfg.dir, '2.0.0', '/plugin/root');
    let stale = 0;
    const handler = handlerFor(inbox, { version: '1.2.3', onStale: () => stale++ });
    const first = await (await handler(req(`127.0.0.1:${PORT}`, '/health'))).json();
    expect([first.stale, first.version]).toEqual([true, '1.2.3']);
    await handler(req(`127.0.0.1:${PORT}`, '/health'));
    expect(stale).toBe(1); // the reply is sent before the process leaves, and only one exit is scheduled
  });
});

describe('JSON routes for the dashboard app', () => {
  const get = async (inbox: Inbox, p: string) => {
    const res = await handlerFor(inbox)(req(`127.0.0.1:${PORT}`, p));
    return { res, body: await res.json() };
  };
  const obs = (kind: ObservedKind, extra: Partial<Observation> = {}): Observation => ({
    v: FORMAT_VERSION,
    source: 'hook',
    call: 'toolu_1',
    pos: 0,
    kind,
    chip: 'Approach',
    title: 'Ship it?',
    session: 'sess-q',
    project: 'app',
    askTs: null,
    answerTs: null,
    ...extra,
  });

  test('both are JSON, carry the policy and are never cached', async () => {
    for (const p of ['/api/inbox', '/api/judgment']) {
      const { res } = await get(inboxWith(`api-headers${p.replace(/\W/g, '-')}`, []), p);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('content-security-policy')).toBe(CSP);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('/api/inbox: sessions by state with only the shown fields, named after their working directory', async () => {
    const mk = (sid: string, name: string, extra: Partial<InboxEvent> = {}) => ({ ...ev(name, extra), session_id: sid, cwd: '/Users/someone/Developer/thing' });
    const inbox = inboxWith('api-inbox', [
      mk('w', 'Notification', { notification_type: 'idle_prompt', message: `waiting ${XSS}` }),
      mk('p', 'Notification', { notification_type: 'permission_prompt' }),
      mk('d', 'Stop'),
    ]);
    const { body } = await get(inbox, '/api/inbox');
    expect(Object.keys(body).sort()).toEqual(['done_unread', 'health', 'now', 'permission', 'stale', 'todos', 'waiting']);
    expect(body.waiting).toEqual([
      { session_id: 'w', project: 'thing', cwd: '/Users/someone/Developer/thing', state: 'WAITING', display: 'WAITING', since: now - 120_000, last_ts: now - 120_000, message: `waiting ${XSS}` },
    ]);
    expect(body.permission.map((s: { session_id: string }) => s.session_id)).toEqual(['p']);
    expect(body.done_unread.map((s: { session_id: string }) => s.session_id)).toEqual(['d']);
    expect(body.health).toEqual({ events: 'ok', unreadable_lines: 0, hook_errors: 0, sessions_running: 0, last_event_ts: now - 120_000 });
    expect(JSON.stringify(body)).not.toContain('stateEvent'); // raw events stay on the server
  });

  test('TODOS belong to gstack: a list when it is present, null when it is not', async () => {
    const withGstack = inboxWith('api-todos', []);
    fs.mkdirSync(path.join(withGstack.cfg.stateRoot, 'projects', 'owner-repo'), { recursive: true });
    fs.writeFileSync(path.join(withGstack.cfg.stateRoot, 'projects', 'owner-repo', 'owner-repo-TODOS.md'), '## a deferred thing\n');
    expect((await get(withGstack, '/api/inbox')).body.todos).toEqual([{ project: 'owner-repo', file: 'owner-repo-TODOS.md', items: ['a deferred thing'] }]);
    expect((await get(inboxWith('api-no-gstack', [], false), '/api/inbox')).body.todos).toBeNull();
  });

  test('/api/judgment: an empty store is zeros, twelve empty weeks and no sources', async () => {
    const { body } = await get(inboxWith('api-empty', []), '/api/judgment');
    expect(body.overall).toEqual({ agreed: 0, answered: 0 });
    expect(body.questions).toBe(0);
    expect(body.weekly).toHaveLength(12);
    expect(body.weekly.every((w: { answered: number }) => w.answered === 0)).toBe(true);
    expect(body.capture).toEqual({ unreadable_lines: 0, sources: { hook: false, import: false } });
    expect([body.min_n, body.version, body.inferred_dismissed]).toEqual([MIN_N, '1.2.3', 0]);
  });

  test('/api/judgment reads the outcome store and reports when capture began', async () => {
    const inbox = inboxWith('api-store', []);
    const dir = inbox.cfg.dir;
    markCaptureStart(dir, now - 3_600_000);
    markCaptureStart(dir, now); // only the first start is kept
    expect(fs.readFileSync(path.join(dir, SINCE_FILE), 'utf8').trim()).toBe(String(now - 3_600_000));
    const kinds: ObservedKind[] = ['AGREED', 'AGREED', 'OVERRODE_OPTION'];
    kinds.forEach((kind, i) => {
      appendObservation(dir, obs(ASKED, { call: `c${i}`, askTs: now - 60_000 + i }));
      appendObservation(dir, obs(kind, { call: `c${i}`, answerTs: now - 40_000 + i, title: `Q${i} ${XSS}` }));
    });
    const { body } = await get(inbox, '/api/judgment');
    expect(body.overall).toEqual({ agreed: 2, answered: 3 });
    expect(body.live_since).toBe(now - 3_600_000);
    expect(body.capture.sources).toEqual({ hook: true, import: false });
    expect(body.weekly[11]).toMatchObject({ agreed: 2, answered: 3 });
    expect(body.timing).toMatchObject({ n: 3, medianMs: 20_000 });
    // Titles are data here; the app, not this route, is responsible for showing them as text.
    expect(body.overrides).toEqual([{ ts: now - 60_000 + 2, project: 'app', title: `Q2 ${XSS}`, typed: false }]);
  });

  test('/api/judgment: a question with no answer is dismissed once its session moved on, and a notification does not count', async () => {
    const asked = (session: string) => obs(ASKED, { call: `call-${session}`, session, askTs: now - 100_000 });
    const sessionEvent = (session_id: string, name: string, ts: number, extra: Partial<InboxEvent> = {}) => ({ ...ev(name, extra), session_id, ts });
    const inbox = inboxWith('api-moved', [
      sessionEvent('s-notified', 'Notification', now - 94_000, { notification_type: 'permission_prompt' }), // fires ~6 s after every question
      sessionEvent('s-prompted', 'Notification', now - 94_000, { notification_type: 'permission_prompt' }),
      sessionEvent('s-prompted', 'UserPromptSubmit', now - 80_000),
      sessionEvent('s-earlier', 'Stop', now - 200_000), // before the question
    ]);
    for (const s of ['s-notified', 's-prompted', 's-earlier']) appendObservation(inbox.cfg.dir, asked(s));
    const { body } = await get(inbox, '/api/judgment');
    expect(body.counts).toMatchObject({ DISMISSED: 1, UNANSWERED: 2 });
    expect(body.inferred_dismissed).toBe(1);
  });

  test('the server has no code path that reads transcripts', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'server.ts'), 'utf8');
    for (const reader of ['scanChunks', 'listTranscripts', 'importHistory', 'transcriptsDir']) expect(source).not.toContain(reader);
  });
});
