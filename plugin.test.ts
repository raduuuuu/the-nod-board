import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ATTR_EVENTS,
  FIRST_RUN_WAIT_MS,
  PROBE_TIMEOUT_MS,
  QUESTION_TOOL,
  SESSION_EVENTS,
  SKILL_TOOL,
  START_GRACE_MS,
  firstRunLine,
  onSessionStart,
  probeServer,
  questionObservations,
  readHookPayload,
  runStarter,
  type ServerState,
  type StartDeps,
} from './hook';
import {
  APP_NAME,
  SINCE_FILE,
  WANTED_FILE,
  boardUrl,
  captureSince,
  fold,
  markAddressShown,
  markCaptureStart,
  markStartPending,
  parseLines,
  pluginVersion,
  readWantedVersion,
  shownAddress,
  startPendingSince,
} from './inbox';
import { aggregate } from './judgment';
import { ASKED, ATTRIBUTES, ATTRIBUTE_MAX, FORMAT_VERSION, OUTCOMES_FILE, appendObservation, readObservations, readQuestions } from './outcomes';
import { openBoard, statusLines, type BoardIo } from './scripts/board';

const REPO = import.meta.dir;
const HOOK = path.join(REPO, 'hook.ts');
const RUN = path.join(REPO, 'hooks', 'run.sh');
const FIX = path.join(REPO, 'test', 'fixtures');
const tmps: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-plugin-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** Payloads recorded from Claude Code 2.1.325 for made-up questions, with machine details replaced. */
const recorded: Record<string, unknown>[] = fs
  .readFileSync(path.join(FIX, 'hook-payloads.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function runHook(stdin: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const root = tmp();
  const dir = path.join(root, 'inbox');
  const r = Bun.spawnSync([process.execPath, HOOK, ...args], {
    stdin: Buffer.from(stdin),
    env: { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: dir, ...extraEnv },
  });
  const read = (n: string) => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : '');
  return { code: r.exitCode, stdout: r.stdout.toString(), dir, events: read('events.jsonl'), outcomes: read(OUTCOMES_FILE), errors: read('hook-errors.log') };
}

describe('hook.ts session events', () => {
  test('a valid payload leaves exactly one projected line, with no tool data or prompt', () => {
    const r = runHook(fs.readFileSync(path.join(FIX, 'post-tool-use.json'), 'utf8'));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    const lines = r.events.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]);
    expect(Object.keys(ev).sort()).toEqual(['cwd', 'hook_event_name', 'message', 'notification_type', 'session_id', 'ts']);
    expect(ev.session_id).toBe('8f1c2a4e-0000-4000-8000-000000000001');
    expect(ev.hook_event_name).toBe('PostToolUse');
    expect(Math.abs(ev.ts - Date.now())).toBeLessThan(60_000);
    for (const leak of ['SECRET_TOOL_INPUT', 'SECRET_TOOL_RESPONSE', 'tool_input', 'transcript_path']) expect(r.events).not.toContain(leak);
    expect(r.outcomes).toBe(''); // not a question
    expect(r.errors).toBe('');
  });

  test('a notification keeps its type and message; prompt text is never stored', () => {
    const n = runHook(fs.readFileSync(path.join(FIX, 'notification-permission.json'), 'utf8'));
    const ev = JSON.parse(n.events);
    expect(ev.notification_type).toBe('permission_prompt');
    expect(ev.message).toBe('Claude needs your permission to use Bash');
    const p = runHook(fs.readFileSync(path.join(FIX, 'user-prompt-submit.json'), 'utf8'));
    expect(p.events).not.toContain('SECRET_PROMPT_TEXT');
  });

  test('the lines it writes are the ones the inbox folds', () => {
    const r = runHook(JSON.stringify({ session_id: 's', cwd: '/x', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' }));
    const { events, stats } = parseLines(r.events);
    expect(stats).toEqual({ unreadable: 0, partial: 0 });
    expect(fold(events, Date.now()).get('s')?.state).toBe('WAITING');
  });

  test('bad stdin: exit 0, an error line, nothing appended, nothing printed', () => {
    for (const input of ['not json', '', '{"cwd":"/x"}', '[1,2]', '{"session_id": 5}', '{"session_id":"a"}', '{"session_id":"a","hook_event_name":"Stop"}\n{"session_id":"b"}']) {
      const r = runHook(input);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.events).toBe('');
      expect(r.errors).toContain('unparsable hook payload');
    }
  });

  test('an event the inbox does not fold leaves no line and no error', () => {
    const r = runHook(JSON.stringify({ session_id: 's', hook_event_name: 'PreCompact' }));
    expect([r.code, r.events, r.errors]).toEqual([0, '', '']);
    expect(SESSION_EVENTS.has('PreToolUse')).toBe(false);
  });

  test('a 10 KB message is cut to 500 characters', () => {
    const r = runHook(JSON.stringify({ session_id: 's', hook_event_name: 'Notification', message: 'é'.repeat(10_240) }));
    expect(JSON.parse(r.events).message).toBe('é'.repeat(500));
  });

  test('files are 0600 and the directory 0700', () => {
    const r = runHook('{"session_id":"s","hook_event_name":"Stop"}');
    expect(fs.statSync(path.join(r.dir, 'events.jsonl')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(r.dir).mode & 0o777).toBe(0o700);
    const e = runHook('garbage');
    expect(fs.statSync(path.join(e.dir, 'hook-errors.log')).mode & 0o777).toBe(0o600);
  });

  test('an unwritable directory still exits 0', () => {
    const root = tmp();
    const dir = path.join(root, 'ro');
    fs.mkdirSync(dir, { mode: 0o500 });
    const r = Bun.spawnSync([process.execPath, HOOK], {
      stdin: Buffer.from('{"session_id":"s","hook_event_name":"Stop"}'),
      env: { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: dir },
    });
    expect(r.exitCode).toBe(0);
    fs.chmodSync(dir, 0o700);
  });

  test('runtime over 30 runs (reported; loose bound)', () => {
    const payload = fs.readFileSync(path.join(FIX, 'post-tool-use.json'));
    const root = tmp();
    const env = { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: path.join(root, 'inbox') };
    const N = 30;
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = Bun.nanoseconds();
      Bun.spawnSync([process.execPath, HOOK], { stdin: payload, env });
      times.push((Bun.nanoseconds() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(N / 2)];
    console.log(`hook.ts runtime over ${N} runs: median ${median.toFixed(1)}ms, p90 ${times[Math.floor(N * 0.9)].toFixed(1)}ms`);
    expect(fs.readFileSync(path.join(root, 'inbox', 'events.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(N);
    expect(median).toBeLessThan(200);
  });
});

describe('hook.ts questions, from recorded payloads', () => {
  const HOME = '/home/user';
  const parsed = recorded.map((p) => readHookPayload(p)!);

  test('the recorded set is what the probe saw: five asks, four answers, one dismissal', () => {
    expect(parsed.every((p) => p.toolName === QUESTION_TOOL)).toBe(true);
    expect(parsed.filter((p) => p.event === 'PreToolUse')).toHaveLength(5);
    expect(parsed.filter((p) => p.event === 'PostToolUse')).toHaveLength(4);
  });

  test('each answered case is classified as it was answered', () => {
    const outcomes = parsed.filter((p) => p.event === 'PostToolUse').map((p) => questionObservations(p, 1000, HOME).map((o) => o.kind));
    expect(outcomes).toEqual([
      ['AGREED'], // picked the recommended option
      ['OVERRODE_TYPED'], // typed through Other
      ['OVERRODE_OPTION', 'AGREED'], // two questions in one call
      ['EXCLUDED_MULTI'], // multi-select
    ]);
  });

  test('replaying all nine payloads through the real hook gives the index 2 of 4, one dismissal inferred', () => {
    const root = tmp();
    const dir = path.join(root, 'inbox');
    const env = { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: dir };
    for (const p of recorded) expect(Bun.spawnSync([process.execPath, HOOK], { stdin: Buffer.from(JSON.stringify(p)), env }).exitCode).toBe(0);
    const stored = readObservations(dir);
    expect(stored.unreadable).toBe(0);
    expect(stored.observations).toHaveLength(6 + 5); // six questions asked, five of them answered
    const movedOn = Date.now() + 1;
    const { rows } = readQuestions(dir, { now: movedOn, movedOnAt: () => movedOn });
    const totals = aggregate(rows);
    expect(totals.overall).toEqual({ agreed: 2, answered: 4 });
    expect(totals.counts).toMatchObject({ OVERRODE_OPTION: 1, OVERRODE_TYPED: 1, EXCLUDED_MULTI: 1, DISMISSED: 1, UNANSWERED: 0, UNDECODED: 0 });
    expect(rows.filter((r) => r.inferred).map((r) => r.outcome)).toEqual(['DISMISSED']);
    expect(totals.calls).toBe(5);
    expect(totals.timing.n).toBe(4); // measured between the two hook events, once per call
    expect(rows.every((r) => r.project === 'project' && r.session === 'sess-probe')).toBe(true);
  });

  test('nothing but the stored fields reaches the file: no option text, no typed answer', () => {
    const root = tmp();
    const dir = path.join(root, 'inbox');
    const env = { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: dir };
    for (const p of recorded) Bun.spawnSync([process.execPath, HOOK], { stdin: Buffer.from(JSON.stringify(p)), env });
    const text = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8');
    // Option labels, option descriptions and the multi-select answer appear nowhere. (The typed answer and the
    // word "Green" also occur in these made-up questions' own first lines, so they are checked by field below.)
    for (const leak of ['Blue (recommended)', 'Circle (recommended)', 'Square', 'Purple', 'Yellow, Red', 'Do not pick', 'description', 'transcript_path', 'tool_response']) {
      expect(text).not.toContain(leak);
    }
    for (const line of text.split('\n').filter(Boolean)) {
      const o = JSON.parse(line);
      const keys = Object.keys(o);
      expect(keys.slice(0, 11)).toEqual(['v', 'source', 'call', 'pos', 'kind', 'chip', 'title', 'session', 'project', 'askTs', 'answerTs']);
      // After those, only the attributes saying who asked, in their fixed order, and only short names.
      expect(keys.slice(11)).toEqual(ATTRIBUTES.filter((k) => k in o));
      for (const k of keys.slice(11)) expect(typeof o[k] === 'string' && o[k].length <= ATTRIBUTE_MAX).toBe(true);
      expect(Object.values(o)).not.toContain('my own answer');
      expect(Object.values(o)).not.toContain('Green');
    }
    expect(text).toContain('Probe 1 of 5: please pick the option marked recommended.'); // the first line is kept
    // A PostToolUse for a question is also a session event, and that line carries no tool data either.
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    expect(events.split('\n').filter(Boolean)).toHaveLength(4);
    expect(events).not.toContain('Probe');
  });

  test('a question payload this parser cannot read leaves an UNDECODED trace, never an override', () => {
    const odd = { session_id: 's', cwd: '/home/user/p', hook_event_name: 'PostToolUse', tool_name: QUESTION_TOOL, tool_use_id: 'toolu_x', tool_input: { prompts: [] }, tool_response: 'text' };
    expect(questionObservations(readHookPayload(odd)!, 5, HOME).map((o) => [o.kind, o.title])).toEqual([['UNDECODED', '']]);
    const noAnswers = { ...recorded[1], tool_response: { questions: (recorded[1].tool_response as { questions: unknown }).questions } };
    expect(questionObservations(readHookPayload(noAnswers)!, 5, HOME).map((o) => o.kind)).toEqual(['UNDECODED']);
  });

  test('other tools and a missing call id produce no observation', () => {
    const bash = { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'ls' }, tool_response: {} };
    expect(questionObservations(readHookPayload(bash)!, 5, HOME)).toEqual([]);
    const { tool_use_id: _dropped, ...noId } = recorded[0];
    expect(questionObservations(readHookPayload(noId)!, 5, HOME)).toEqual([]);
  });
});

describe('plugin files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8')).hooks as Record<
    string,
    { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]
  >;

  test('the manifest names the plugin and carries the one version', () => {
    expect(manifest.name).toBe(APP_NAME);
    expect(manifest.license).toBe('MIT');
    expect(pluginVersion()).toBe(manifest.version);
    const market = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
    // Users get the release branch, which only the release workflow writes; never main, which has no build.
    expect(market.plugins.map((p: { name: string; source: unknown }) => [p.name, p.source])).toEqual([
      // An HTTPS URL, not the `github` shorthand: Claude Code's update path clones that shorthand over SSH,
      // which fails for anyone without a GitHub SSH key (observed updating 0.1.0 to 0.1.1).
      [APP_NAME, { source: 'url', url: 'https://github.com/raduuuuu/the-nod-board.git', ref: 'release' }],
    ]);
    expect(market.plugins[0].version).toBeUndefined(); // the version lives in plugin.json only
  });

  test('every event the hook handles is registered, and nothing else', () => {
    expect(Object.keys(hooks).sort()).toEqual([...SESSION_EVENTS, ...ATTR_EVENTS, 'PreToolUse', 'SessionStart'].sort());
    for (const [event, entries] of Object.entries(hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0].hooks).toEqual([{ type: 'command', command: `"\${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" ${event}`, timeout: 5 }]);
      // Only the before-tool hook is narrowed, to the two tools it acts on; session events must fire for every tool.
      expect(entries[0].matcher).toBe(event === 'PreToolUse' ? `${QUESTION_TOOL}|${SKILL_TOOL}` : undefined);
    }
  });

  test('the launcher hands the payload to hook.ts', () => {
    const root = tmp();
    const dir = path.join(root, 'inbox');
    const r = Bun.spawnSync(['/bin/sh', RUN, 'Stop'], {
      stdin: Buffer.from('{"session_id":"s","hook_event_name":"Stop"}'),
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENT_INBOX_DIR: dir },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe('');
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  test('without Bun: session start tells the user once; every other event is silent; always exit 0', () => {
    const root = tmp();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const tool of ['cat', 'dirname']) fs.symlinkSync(fs.existsSync(`/bin/${tool}`) ? `/bin/${tool}` : `/usr/bin/${tool}`, path.join(bin, tool));
    const run = (event: string) =>
      Bun.spawnSync(['/bin/sh', RUN, event], { stdin: Buffer.from('{"session_id":"s"}'), env: { PATH: bin, HOME: root, AGENT_INBOX_DIR: path.join(root, 'inbox') } });
    const start = run('SessionStart');
    expect(start.exitCode).toBe(0);
    expect(JSON.parse(start.stdout.toString()).systemMessage).toContain('Bun is not installed');
    for (const event of ['Stop', 'PostToolUse', 'PreToolUse']) {
      const r = run(event);
      expect([r.exitCode, r.stdout.toString()]).toEqual([0, '']);
    }
    expect(fs.existsSync(path.join(root, 'inbox'))).toBe(false);
  });
});

describe('server start from the hook', () => {
  const deps = (states: ServerState[], over: Partial<StartDeps> = {}) => {
    const launched: { args: string[]; logFile: string | null }[] = [];
    let probes = 0;
    let slept = 0;
    const d: StartDeps = {
      root: '/plugin',
      version: '1.2.3',
      probe: async () => states[Math.min(probes++, states.length - 1)],
      launch: (args, logFile) => void launched.push({ args, logFile }),
      sleep: async (ms) => void (slept += ms),
      ...over,
    };
    return { d, launched, probes: () => probes, slept: () => slept };
  };
  const envFor = () => {
    const root = tmp();
    return { HOME: root, AGENT_INBOX_DIR: path.join(root, 'inbox'), AGENT_INBOX_PORT: '4999' };
  };
  /** An environment whose user has already been told the address: every session start but the first. */
  const toldEnv = () => {
    const env = envFor();
    markAddressShown(env.AGENT_INBOX_DIR, boardUrl(4999));
    return env;
  };

  test('probe: ours and current, ours but older, ours but stale, another program, nothing listening', async () => {
    const answering = (body: unknown, status = 200) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await probeServer(1, '1.2.3', answering({ app: APP_NAME, version: '1.2.3', stale: false }))).toBe('current');
    expect(await probeServer(1, '1.2.3', answering({ app: APP_NAME, version: '1.0.0', stale: false }))).toBe('stale');
    expect(await probeServer(1, '1.2.3', answering({ app: APP_NAME, version: '1.2.3', stale: true }))).toBe('stale');
    expect(await probeServer(1, '1.2.3', answering({ ok: true }))).toBe('foreign');
    expect(await probeServer(1, '1.2.3', answering('<html>hello</html>'))).toBe('foreign');
    const refusing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await probeServer(1, '1.2.3', refusing)).toBe('silent');
  });

  test('probe gives up quickly on a port that accepts and never answers', async () => {
    const hanging = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const t = performance.now();
    expect(await probeServer(1, '1.2.3', hanging)).toBe('silent');
    expect(performance.now() - t).toBeLessThan(PROBE_TIMEOUT_MS + 500);
  });

  test('session start with a current server: records the wanted version and launches nothing', async () => {
    const env = toldEnv();
    const { d, launched } = deps(['current']);
    expect(await onSessionStart(env, d)).toBeNull();
    expect(launched).toEqual([]);
    expect(readWantedVersion(env.AGENT_INBOX_DIR)).toBe('1.2.3');
    expect(JSON.parse(fs.readFileSync(path.join(env.AGENT_INBOX_DIR, WANTED_FILE), 'utf8')).root).toBe('/plugin');
    // The first session start also marks when capture began; later ones leave the mark alone.
    const since = captureSince(env.AGENT_INBOX_DIR);
    expect(Math.abs(since! - Date.now())).toBeLessThan(60_000);
    await onSessionStart(env, d);
    expect(captureSince(env.AGENT_INBOX_DIR)).toBe(since);
    expect(fs.existsSync(path.join(env.AGENT_INBOX_DIR, SINCE_FILE))).toBe(true);
  });

  test('session start with nothing listening, or an older server: launches the starter and returns without waiting', async () => {
    for (const state of ['silent', 'stale'] as ServerState[]) {
      const { d, launched, probes, slept } = deps([state]);
      expect(await onSessionStart(toldEnv(), d)).toBeNull();
      expect(launched).toEqual([{ args: ['/plugin/hook.ts', '--start-server'], logFile: null }]);
      expect([probes(), slept()]).toEqual([1, 0]);
    }
  });

  test('session start with another program on the port: one line for the user, nothing launched', async () => {
    const { d, launched } = deps(['foreign']);
    const line = await onSessionStart(envFor(), d);
    expect(line).toContain('port 4999 is used by another program');
    expect(launched).toEqual([]);
  });

  test('starter with nothing listening: starts the server with its log file', async () => {
    const env = envFor();
    const { d, launched } = deps(['silent']);
    expect(await runStarter(env, d)).toBe('started');
    expect(launched).toEqual([{ args: ['/plugin/server.ts'], logFile: path.join(env.AGENT_INBOX_DIR, 'server.log') }]);
  });

  test('starter after an update: waits for the older server to leave, then starts the new one', async () => {
    const { d, launched, probes, slept } = deps(['stale', 'stale', 'silent']);
    expect(await runStarter(envFor(), d)).toBe('started');
    expect(launched.map((l) => l.args)).toEqual([['/plugin/server.ts']]);
    expect([probes(), slept()]).toEqual([3, 400]);
  });

  test('starter never starts a second server or touches another program', async () => {
    for (const state of ['current', 'foreign'] as ServerState[]) {
      const { d, launched } = deps([state]);
      expect(await runStarter(envFor(), d)).toBe(state);
      expect(launched).toEqual([]);
    }
  });

  test('starter gives up after 5 s when the older server will not leave, and says so in the error log', async () => {
    const env = envFor();
    const { d, launched, slept } = deps(['stale']);
    expect(await runStarter(env, d)).toBe('stale');
    expect(launched).toEqual([]);
    expect(slept()).toBeGreaterThanOrEqual(5_000);
    expect(fs.readFileSync(path.join(env.AGENT_INBOX_DIR, 'hook-errors.log'), 'utf8')).toContain('did not leave port 4999');
  });
});

describe('update with a real older server', () => {
  test('a session start for a newer version ends with the newer server answering /health', async () => {
    const root = tmp();
    const dir = path.join(root, 'inbox');
    fs.mkdirSync(path.join(root, 'gstack', 'projects'), { recursive: true });
    const { start } = await import('./server');
    const { Inbox } = await import('./inbox');
    const mk = (version: string, port: number, onStale?: () => void) =>
      start({
        port,
        compact: false,
        version,
        onStale,
        inbox: new Inbox({ dir, stateRoot: path.join(root, 'gstack'), home: root, transcriptsDir: path.join(root, 'none') }),
      });
    let current = mk('1.0.0', 0, () => setTimeout(() => current.stop(), 20));
    const port = current.port;
    const env = { HOME: root, AGENT_INBOX_DIR: dir, AGENT_INBOX_PORT: String(port) };
    const realProbe = (p: number, v: string) => probeServer(p, v);
    let starter: Promise<unknown> | null = null;
    const d: StartDeps = {
      root: REPO,
      version: '2.0.0',
      probe: realProbe,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
      launch: (args) => {
        // Stand-ins for the two detached processes: the starter, then the new server.
        if (args[1] === '--start-server') starter = runStarter(env, d);
        else current = mk('2.0.0', port);
      },
    };
    expect(await probeServer(port, '1.0.0')).toBe('current');
    markAddressShown(dir, boardUrl(port)); // an update, not a first run: the user already knows the address
    expect(await onSessionStart(env, d)).toBeNull();
    expect(starter).not.toBeNull();
    expect(await starter!).toBe('started');
    try {
      expect(await probeServer(port, '2.0.0')).toBe('current');
      const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect([body.version, body.stale]).toEqual(['2.0.0', false]);
    } finally {
      current.stop();
    }
  });
});

describe('what a session start tells the user', () => {
  const tmpEnv = () => {
    const root = tmp();
    return { HOME: root, AGENT_INBOX_DIR: path.join(root, 'inbox'), AGENT_INBOX_PORT: '4999' };
  };
  const URL_4999 = 'http://127.0.0.1:4999/';
  const deps = (states: ServerState[]) => {
    const launched: string[][] = [];
    let probes = 0;
    let slept = 0;
    const d: StartDeps = {
      root: '/plugin',
      version: '1.2.3',
      probe: async () => states[Math.min(probes++, states.length - 1)],
      launch: (args) => void launched.push(args),
      sleep: async (ms) => void (slept += ms),
    };
    return { d, launched, probes: () => probes, slept: () => slept };
  };

  test('first session with the server answering: one line with the address, the promise and both commands, then never again', async () => {
    const env = tmpEnv();
    const { d, launched } = deps(['current']);
    expect(await onSessionStart(env, d)).toBe(
      `The Nod Board is running at ${URL_4999} and keeps everything on this machine. Open it with /nod-board:open; load your past sessions with /nod-board:import.`,
    );
    expect(shownAddress(env.AGENT_INBOX_DIR)).toBe(URL_4999);
    expect(await onSessionStart(env, d)).toBeNull();
    expect(launched).toEqual([]);
  });

  test('first session with nothing running: launches the server, waits for it to answer, then shows the line', async () => {
    const env = tmpEnv();
    const { d, launched, probes, slept } = deps(['silent', 'silent', 'silent', 'current']);
    expect(await onSessionStart(env, d)).toBe(firstRunLine(URL_4999));
    expect(launched).toEqual([['/plugin/hook.ts', '--start-server']]);
    expect([probes(), slept()]).toEqual([4, 600]);
    expect(startPendingSince(env.AGENT_INBOX_DIR)).toBeNull(); // the start was seen to succeed
  });

  test('first session and the server is slower than 2 s: nothing is shown yet, and never an address that did not answer', async () => {
    const env = tmpEnv();
    const slow = deps(['silent']);
    expect(await onSessionStart(env, slow.d)).toBeNull();
    expect(slow.slept()).toBe(FIRST_RUN_WAIT_MS);
    expect(shownAddress(env.AGENT_INBOX_DIR)).toBeNull();
    expect(startPendingSince(env.AGENT_INBOX_DIR)).not.toBeNull();
    // The next session start finds it answering and shows the line then.
    expect(await onSessionStart(env, deps(['current']).d)).toBe(firstRunLine(URL_4999));
  });

  test('the address changes: the line is shown again, once, with the new address', async () => {
    const env = tmpEnv();
    await onSessionStart(env, deps(['current']).d);
    const moved = { ...env, AGENT_INBOX_PORT: '5001' };
    expect(await onSessionStart(moved, deps(['current']).d)).toBe(firstRunLine('http://127.0.0.1:5001/'));
    expect(await onSessionStart(moved, deps(['current']).d)).toBeNull();
  });

  test('a start that never came up: the next session says so once, with the log, and launches a fresh start', async () => {
    const env = tmpEnv();
    markAddressShown(env.AGENT_INBOX_DIR, URL_4999);
    markStartPending(env.AGENT_INBOX_DIR, Date.now() - START_GRACE_MS - 1_000);
    const { d, launched, slept } = deps(['silent']);
    expect(await onSessionStart(env, d)).toBe(`The Nod Board: the dashboard did not start. The log is ${path.join(env.AGENT_INBOX_DIR, 'server.log')}.`);
    expect(launched).toEqual([['/plugin/hook.ts', '--start-server']]);
    expect(slept()).toBe(0);
    // The fresh start has its own grace period: a session starting right after stays quiet.
    expect(await onSessionStart(env, deps(['silent']).d)).toBeNull();
  });

  test('a start launched moments ago by another session is not a failure, and keeps its own time', async () => {
    const env = tmpEnv();
    markAddressShown(env.AGENT_INBOX_DIR, URL_4999);
    const launchedAt = Date.now() - 1_000;
    markStartPending(env.AGENT_INBOX_DIR, launchedAt);
    expect(await onSessionStart(env, deps(['silent']).d)).toBeNull();
    expect(startPendingSince(env.AGENT_INBOX_DIR)).toBe(launchedAt);
  });

  test('after a reboot the server is simply started again: no line, no wait', async () => {
    const env = tmpEnv();
    markAddressShown(env.AGENT_INBOX_DIR, URL_4999);
    const { d, launched, slept } = deps(['silent']);
    expect(await onSessionStart(env, d)).toBeNull();
    expect([launched.length, slept()]).toEqual([1, 0]);
  });

  test('another program on the port is still reported, first run or not, and nothing is recorded as shown', async () => {
    const env = tmpEnv();
    expect(await onSessionStart(env, deps(['foreign']).d)).toContain('port 4999 is used by another program');
    expect(shownAddress(env.AGENT_INBOX_DIR)).toBeNull();
  });
});

describe('/nod-board:open and /nod-board:status', () => {
  const tmpEnv = () => {
    const root = tmp();
    return { HOME: root, AGENT_INBOX_DIR: path.join(root, 'inbox'), AGENT_INBOX_PORT: '4999' };
  };
  const deps = (states: ServerState[]) => {
    const launched: string[][] = [];
    let probes = 0;
    const d: StartDeps = {
      root: '/plugin',
      version: '1.2.3',
      probe: async () => states[Math.min(probes++, states.length - 1)],
      launch: (args) => void launched.push(args),
      sleep: async () => {},
    };
    return { d, launched };
  };
  const io = (over: Partial<BoardIo> = {}) => {
    const opened: string[] = [];
    const real: BoardIo = { openInBrowser: (url) => (opened.push(url), true), fetchJson: async () => ({ last_event_ts: NOW - 90_000 }), now: () => NOW, ...over };
    return { io: real, opened };
  };
  const NOW = Date.parse('2026-11-15T12:00:00.000Z');

  test('open with the server running: opens the address and prints it; nothing is launched', async () => {
    const { d, launched } = deps(['current']);
    const { io: i, opened } = io();
    expect(await openBoard(tmpEnv(), d, i)).toEqual(['The Nod Board: opened http://127.0.0.1:4999/']);
    expect(opened).toEqual(['http://127.0.0.1:4999/']);
    expect(launched).toEqual([]);
  });

  test('open with the server stopped: starts it through the starter, then opens', async () => {
    const { d, launched } = deps(['silent', 'silent', 'current']);
    const { io: i, opened } = io();
    expect(await openBoard(tmpEnv(), d, i)).toEqual(['The Nod Board: opened http://127.0.0.1:4999/']);
    expect(launched.map((a) => a[0])).toEqual(['/plugin/server.ts']);
    expect(opened).toHaveLength(1);
  });

  test('open where nothing can open a browser: prints the address to open by hand', async () => {
    const { io: i } = io({ openInBrowser: () => false });
    expect(await openBoard(tmpEnv(), deps(['current']).d, i)).toEqual(['The Nod Board is running at http://127.0.0.1:4999/', 'Open that address in your browser.']);
  });

  test('open when the server will not start, or another program holds the port: says so and opens nothing', async () => {
    const env = tmpEnv();
    const dead = io();
    expect(await openBoard(env, deps(['silent']).d, dead.io)).toEqual([`The Nod Board: the dashboard did not start. The log is ${path.join(env.AGENT_INBOX_DIR, 'server.log')}.`]);
    const taken = io();
    expect((await openBoard(env, deps(['foreign']).d, taken.io))[0]).toContain('port 4999 is used by another program');
    expect([...dead.opened, ...taken.opened]).toEqual([]);
  });

  test('status with the server running: where, version, last event, and counts from the store, never question text', async () => {
    const env = tmpEnv();
    const dir = env.AGENT_INBOX_DIR;
    markCaptureStart(dir, Date.parse('2026-11-14T09:30:00.000Z'));
    const base = { v: FORMAT_VERSION, call: 'c1', pos: 0, chip: 'Scope', title: 'A SECRET QUESTION TITLE', session: 's', project: 'p' } as const;
    appendObservation(dir, { ...base, source: 'hook', kind: ASKED, askTs: NOW, answerTs: null });
    appendObservation(dir, { ...base, source: 'hook', kind: 'AGREED', askTs: null, answerTs: NOW + 5 });
    appendObservation(dir, { ...base, call: 'c2', source: 'import', kind: 'AGREED', askTs: NOW, answerTs: NOW + 5 });
    fs.writeFileSync(path.join(dir, 'hook-errors.log'), 'one\ntwo\n');
    const lines = await statusLines(env, deps(['current']).d, io().io);
    expect(lines).toEqual([
      'The Nod Board 1.2.3',
      'running: yes, at http://127.0.0.1:4999/',
      'last event: 1 min ago',
      'capturing since: 2026-11-14 09:30 UTC',
      'questions stored: 2',
      'past sessions: imported',
      'hook errors: 2',
      `data folder: ${dir}`,
    ]);
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  test('status says when the latest hook error happened, so an old one reads as old', async () => {
    const env = tmpEnv();
    fs.mkdirSync(env.AGENT_INBOX_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.AGENT_INBOX_DIR, 'hook-errors.log'), '2026-11-13T08:00:00Z first\n2026-11-14T09:30:00Z an older server did not leave\n');
    const lines = await statusLines(env, deps(['current']).d, io().io);
    expect(lines).toContain('hook errors: 2, last 2026-11-14 09:30 UTC');
  });

  test('status with nothing running and nothing stored: says how to start it and what to run', async () => {
    const lines = await statusLines(tmpEnv(), deps(['silent']).d, io().io);
    expect(lines[1]).toBe('running: no. Start it with /nod-board:open');
    expect(lines.join('\n')).not.toContain('last event');
    expect(lines).toContain('questions stored: 0');
    expect(lines).toContain('past sessions: not imported (run /nod-board:import)');
  });

  test('both commands exist as command files that run the one script and add nothing', () => {
    for (const name of ['open', 'status']) {
      const text = fs.readFileSync(path.join(import.meta.dir, 'commands', `${name}.md`), 'utf8');
      expect(text).toContain(`!\`bun "\${CLAUDE_PLUGIN_ROOT}/scripts/board.ts" ${name}\``);
      expect(text).toContain('disable-model-invocation: true');
    }
  });
});

/**
 * Payloads in the shapes a probe measured on Claude Code 2.1.325 (field names and nesting), with
 * made-up questions. PostModelSwitch is from the documentation: the probe could not trigger it.
 */
describe('who asked, through the real hook', () => {
  const lines: Record<string, unknown>[] = fs
    .readFileSync(path.join(FIX, 'hook-attr-payloads.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const replay = () => {
    const root = tmp();
    const dir = path.join(root, 'inbox');
    const env = { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: dir, AGENT_INBOX_PORT: '4998' };
    const out: string[] = [];
    for (const l of lines) {
      // A session start through the real hook starts a real, detached server: never replay one here.
      // What a session start means for who is asking is covered in attrs.test.ts.
      if (l.hook_event_name === 'SessionStart') continue;
      const r = Bun.spawnSync([process.execPath, HOOK], { stdin: Buffer.from(JSON.stringify(l)), env });
      expect(r.exitCode).toBe(0);
      out.push(r.stdout.toString());
    }
    return { dir, stdout: out.join('') };
  };

  test('each question is stored with the skill, agent and model that were current when it was asked', () => {
    const { dir } = replay();
    const asked = readObservations(dir).observations.filter((o) => o.kind === ASKED);
    expect(asked.map((o) => [o.call, o.skill, o.agent, o.model])).toEqual([
      ['toolu_attr_1', 'hello', 'main agent', undefined], // inside a typed command
      ['toolu_attr_2', 'no skill', 'main agent', undefined], // the turn ended, so the command no longer owns it
      ['toolu_attr_3', 'probe-skill', 'main agent', undefined], // after the agent started a skill
      ['toolu_attr_4', 'no skill', 'Explore', undefined], // a subagent has its own skill, here none
      ['toolu_attr_5', 'probe-skill', 'main agent', 'claude-test-2'], // after a model switch
    ]);
  });

  test('the answer carries none of it, and the row keeps what was known at the moment of asking', () => {
    const { dir } = replay();
    const answer = readObservations(dir).observations.find((o) => o.call === 'toolu_attr_1' && o.kind === 'AGREED')!;
    expect(ATTRIBUTES.filter((k) => k in answer)).toEqual([]);
    const row = readQuestions(dir, { now: Date.now() }).rows.find((r) => r.call === 'toolu_attr_1')!;
    expect([row.outcome, row.skill, row.agent]).toEqual(['AGREED', 'hello', 'main agent']);
  });

  test('the new events print nothing, leave no session-event line, and the session end removes the state', () => {
    const { dir, stdout } = replay();
    expect(stdout).toBe('');
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).hook_event_name);
    for (const e of ATTR_EVENTS) expect(events).not.toContain(e);
    expect(fs.existsSync(path.join(dir, 'attrs', 'sess-attr'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'hook-errors.log'))).toBe(false);
  });

  test('an event name this version has never heard of is ignored: exit 0, nothing printed, nothing stored', () => {
    const r = runHook(JSON.stringify({ session_id: 's', hook_event_name: 'SomethingFromTheFuture', cwd: '/tmp', surprise: { nested: true } }));
    expect([r.code, r.stdout, r.events, r.outcomes, r.errors]).toEqual([0, '', '', '', '']);
  });

  test('every registered event is one the hook has a use for', () => {
    const registered = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8')).hooks);
    const handled = new Set([...SESSION_EVENTS, ...ATTR_EVENTS, 'PreToolUse', 'SessionStart']);
    expect(registered.filter((e) => !handled.has(e))).toEqual([]);
    expect([...handled].filter((e) => !registered.includes(e))).toEqual([]);
  });
});

