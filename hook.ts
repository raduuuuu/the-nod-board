#!/usr/bin/env bun
/**
 * hook.ts: the one entry point Claude Code calls for every hook event (hooks/hooks.json).
 *
 *   session events (Notification, PostToolUse, PostToolUseFailure, Stop, UserPromptSubmit, SessionEnd)
 *       -> one projected line in <dir>/events.jsonl: session_id, cwd, hook_event_name,
 *          notification_type, message (cut to 500 characters), ts. Nothing else from the payload.
 *   AskUserQuestion, PreToolUse  -> one ASKED observation per question in <dir>/outcomes.jsonl
 *   AskUserQuestion, PostToolUse -> one classified observation per question (outcomes.ts decides
 *          what a line may hold: never option text, never the answer)
 *   SessionStart -> make sure the local server is running and current (see onSessionStart)
 *
 * Contract: always exit 0 and print nothing on stdout, so a session is never blocked or altered.
 * Problems append one line to <dir>/hook-errors.log. Files are 0600, the directory 0700.
 * `readHookPayload` is the only place that knows the payload shape (measured on Claude Code
 * 2.1.325: tool_response = {questions, answers, annotations}, answers keyed by question text;
 * a dismissed question fires PreToolUse and nothing after it).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APP_NAME, APP_TITLE, markCaptureStart, pluginVersion, portFromEnv, writeWantedVersion } from './inbox';
import { classify, projectOfCwd, titleOf, toQuestions, type CallResult, type QuestionDef } from './judgment';
import { ASKED, FORMAT_VERSION, appendObservation, type Observation } from './outcomes';

export const QUESTION_TOOL = 'AskUserQuestion';
export const SESSION_EVENTS: ReadonlySet<string> = new Set([
  'Notification',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'UserPromptSubmit',
  'SessionEnd',
]);
const MESSAGE_MAX = 500;

export interface HookPayload {
  event: string;
  sessionId: string;
  cwd: string | null;
  notificationType: string | null;
  message: string | null;
  toolName: string | null;
  toolUseId: string | null;
  /** Questions of an AskUserQuestion call; null for any other payload or an unreadable one. */
  questions: QuestionDef[] | null;
  /** The call's result on PostToolUse; null before the answer. */
  result: CallResult | null;
}

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parsed stdin -> the fields this tool uses, or null when it is not a hook payload with a session. */
export function readHookPayload(v: unknown): HookPayload | null {
  if (!isObject(v)) return null;
  const sessionId = str(v.session_id);
  const event = str(v.hook_event_name);
  if (!sessionId || !event) return null;
  const toolName = str(v.tool_name);
  let questions: QuestionDef[] | null = null;
  let result: CallResult | null = null;
  if (toolName === QUESTION_TOOL) {
    const response = v.tool_response;
    const input = isObject(v.tool_input) ? v.tool_input : {};
    questions = toQuestions(input.questions) ?? (isObject(response) ? toQuestions(response.questions) : null);
    if (event === 'PostToolUse') {
      if (isObject(response) && isObject(response.answers)) {
        const answers: Record<string, string> = {};
        for (const [k, a] of Object.entries(response.answers)) if (typeof a === 'string') answers[k] = a;
        result = { kind: 'answers', answers };
      } else result = { kind: 'undecoded' };
    }
  }
  return {
    event,
    sessionId,
    cwd: str(v.cwd),
    notificationType: str(v.notification_type),
    message: str(v.message),
    toolName,
    toolUseId: str(v.tool_use_id),
    questions,
    result,
  };
}

/** The projected session-event line, or null when the event is not one the inbox folds. */
export function sessionEventLine(p: HookPayload, now: number): string | null {
  if (!SESSION_EVENTS.has(p.event)) return null;
  return JSON.stringify({
    session_id: p.sessionId,
    cwd: p.cwd,
    hook_event_name: p.event,
    notification_type: p.notificationType,
    message: p.message === null ? null : p.message.slice(0, MESSAGE_MAX),
    ts: now,
  });
}

/** What a question hook stores: ASKED before the answer, the classified outcome after it. */
export function questionObservations(p: HookPayload, now: number, home: string): Observation[] {
  if (p.toolName !== QUESTION_TOOL || !p.toolUseId) return [];
  if (p.event !== 'PreToolUse' && p.event !== 'PostToolUse') return [];
  const base = {
    v: FORMAT_VERSION,
    source: 'hook' as const,
    call: p.toolUseId,
    session: p.sessionId,
    project: projectOfCwd(p.cwd, home) ?? '(unknown)',
  };
  // A payload whose questions cannot be read still leaves a trace, so the app can say so.
  if (!p.questions) {
    if (p.event !== 'PostToolUse') return [];
    return [{ ...base, pos: 0, kind: 'UNDECODED', chip: '', title: '', askTs: null, answerTs: now }];
  }
  return p.questions.map((q, pos) => ({
    ...base,
    pos,
    kind: p.event === 'PreToolUse' ? ASKED : classify(q, p.result),
    chip: q.header,
    title: titleOf(q.question),
    askTs: p.event === 'PreToolUse' ? now : null,
    answerTs: p.event === 'PostToolUse' ? now : null,
  }));
}

export function dataDir(env: Record<string, string | undefined>): string {
  return env.AGENT_INBOX_DIR || path.join(env.HOME || os.homedir(), '.agent-inbox');
}

function logError(dir: string, message: string) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'), `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${message}\n`, { mode: 0o600 });
  } catch {
    // Nothing more can be done from a hook; never let logging break the session.
  }
}

/** Handle one hook invocation. Never throws. Returns the parsed payload for the caller's own dispatch. */
export function handle(raw: string, env: Record<string, string | undefined>, now: number): HookPayload | null {
  const dir = dataDir(env);
  let payload: HookPayload | null = null;
  try {
    payload = readHookPayload(JSON.parse(raw));
  } catch {
    payload = null;
  }
  if (!payload) {
    logError(dir, 'unparsable hook payload (bad JSON or missing session_id)');
    return null;
  }
  try {
    const line = sessionEventLine(payload, now);
    if (line) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n', { mode: 0o600 });
    }
    for (const obs of questionObservations(payload, now, env.HOME || os.homedir())) appendObservation(dir, obs);
  } catch (err) {
    // Path and error class only: nothing from the payload reaches the log.
    logError(dir, `could not write to ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  return payload;
}

// ---------------------------------------------------------------- server start
//
//   SessionStart (must return at once)             detached starter (hook.ts --start-server)
//   ----------------------------------             -----------------------------------------
//   record the wanted version                      every 200 ms, for at most 5 s:
//   GET /health, 250 ms limit                        current -> done
//     current  -> nothing                            foreign -> done (never touch another program)
//     foreign  -> one line to the user               stale   -> wait (the old server exits by itself
//     silent   -> launch the starter                            after telling us it is stale)
//     stale    -> launch the starter                 silent  -> start `bun server.ts`, done
//
// No process is ever killed and the server gains no write route: an older server learns from the
// wanted-version file that it should leave, says so on /health and exits.

export type ServerState = 'current' | 'stale' | 'silent' | 'foreign';
export const PROBE_TIMEOUT_MS = 250;
export const STARTER_WAIT_MS = 5_000;
export const STARTER_STEP_MS = 200;

export async function probeServer(port: number, version: string, fetchImpl: typeof fetch = fetch): Promise<ServerState> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return 'silent';
  }
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (body.app !== APP_NAME) return 'foreign';
    return body.version === version && body.stale !== true ? 'current' : 'stale';
  } catch {
    return 'foreign';
  }
}

export interface StartDeps {
  root: string;
  version: string;
  probe: (port: number, version: string) => Promise<ServerState>;
  /** Launch a process that outlives the hook. */
  launch: (args: string[], logFile: string | null) => void;
  sleep: (ms: number) => Promise<void>;
}

function launchDetached(args: string[], logFile: string | null) {
  const out = logFile ? fs.openSync(logFile, 'a', 0o600) : 'ignore';
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
}

export function realDeps(root: string = import.meta.dir): StartDeps {
  const version = pluginVersion(root);
  return { root, version, probe: probeServer, launch: launchDetached, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

/** Returns a line for the user, or null. Never waits for a server to start. */
export async function onSessionStart(env: Record<string, string | undefined>, deps: StartDeps): Promise<string | null> {
  const dir = dataDir(env);
  const port = portFromEnv(env);
  try {
    writeWantedVersion(dir, deps.version, deps.root);
    markCaptureStart(dir, Date.now());
  } catch (err) {
    logError(dir, `could not record the wanted server version: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  const state = await deps.probe(port, deps.version);
  if (state === 'current') return null;
  if (state === 'foreign')
    return `${APP_TITLE}: port ${port} is used by another program, so the dashboard was not started. Set AGENT_INBOX_PORT to a free port.`;
  deps.launch([path.join(deps.root, 'hook.ts'), '--start-server'], null);
  return null;
}

/** The detached starter: wait for a stale server to leave, then start the current one. */
export async function runStarter(env: Record<string, string | undefined>, deps: StartDeps): Promise<ServerState | 'started'> {
  const dir = dataDir(env);
  const port = portFromEnv(env);
  let state: ServerState = 'silent';
  for (let waited = 0; waited <= STARTER_WAIT_MS; waited += STARTER_STEP_MS) {
    state = await deps.probe(port, deps.version);
    if (state === 'current' || state === 'foreign') return state;
    if (state === 'silent') {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      deps.launch([path.join(deps.root, 'server.ts')], path.join(dir, 'server.log'));
      return 'started';
    }
    await deps.sleep(STARTER_STEP_MS);
  }
  logError(dir, `an older agent-inbox server did not leave port ${port} within ${STARTER_WAIT_MS} ms`);
  return state;
}

if (import.meta.main) {
  if (process.argv[2] === '--start-server') {
    await runStarter(process.env, realDeps());
    process.exit(0);
  }
  const raw = await Bun.stdin.text();
  const payload = handle(raw, process.env, Date.now());
  if (payload?.event === 'SessionStart') {
    try {
      const line = await onSessionStart(process.env, realDeps());
      // SessionStart stdout would be added to the model's context; a systemMessage is shown to the user instead.
      if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');
    } catch (err) {
      logError(dataDir(process.env), `session start failed: ${(err as Error).name}`);
    }
  }
  process.exit(0);
}
