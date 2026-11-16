#!/usr/bin/env bun
/**
 * hook.ts: the one entry point Claude Code calls for every hook event (hooks/hooks.json).
 *
 *   session events (Notification, PostToolUse, PostToolUseFailure, Stop, UserPromptSubmit, SessionEnd)
 *       -> one projected line in <dir>/events.jsonl: session_id, cwd, hook_event_name,
 *          notification_type, message (cut to 500 characters), ts. Nothing else from the payload.
 *   AskUserQuestion, PreToolUse  -> one ASKED observation per question in <dir>/outcomes.jsonl,
 *          carrying who asked: the agent, and the skill and model when known (attrs.ts)
 *   skill, command, model and turn-end events -> what attrs.ts needs to know who is asking
 *   AskUserQuestion, PostToolUse -> one classified observation per question (outcomes.ts decides
 *          what a line may hold: never option text, never the answer)
 *   SessionStart -> make sure the local server is running and current (see onSessionStart)
 *   Stop -> also the plain-text check (see noteTurn): the agent's final message is matched against a
 *          fixed phrase list in memory and one line, "1" or "0", goes to <dir>/turns/<day>. On by
 *          default, off with "count_plain_text": false, and never before the one-time notice.
 *
 * Called by Codex (second argument "codex", hooks/codex-hooks.json): only the question tool's
 * two events arrive, and only question observations are written (codex.ts). No session event,
 * no attrs state and no server start: those belong to Claude Code sessions.
 *
 * Contract: always exit 0, so a session is never blocked. Nothing is printed on stdout, with two
 * exceptions, both at SessionStart only: a line shown to the user (the address on first run, that
 * the dashboard did not start, or the one-time notice of the plain-text check), and, only when the user turned it on in settings.json, one
 * fixed sentence added to the agent's context (settings.ts QUESTION_TOOL_NUDGE). Without that
 * setting nothing the agent reads is changed.
 * Problems append one line to <dir>/hook-errors.log. Files are 0600, the directory 0700.
 * `readHookPayload` is the only place that knows the payload shape (measured on Claude Code
 * 2.1.325: tool_response = {questions, answers, annotations}, answers keyed by question text;
 * a dismissed question fires PreToolUse and nothing after it).
 */
import { spawn } from 'node:child_process';
import { at as whoAt, getSessionValue, note as noteAttrs, putSessionValue, type AttrEvent } from './attrs';
import { CODEX_ARG, codexObservations } from './codex';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  APP_NAME,
  APP_TITLE,
  boardUrl,
  candidatePorts,
  clearStartPending,
  explicitPort,
  instanceId,
  knownPort,
  markAddressShown,
  markCaptureStart,
  markStartPending,
  pluginVersion,
  shownAddress,
  startPendingSince,
  writeWantedVersion,
} from './inbox';
import { classify, titleOf, toQuestions, type CallResult, type QuestionDef } from './judgment';
import { noteStart, projectAt } from './project';
import { NOTICE_LINE, noticeLine, TURN_ASKED, TURN_CLEAR, TURN_STATE, hasRecommendation, markNoticeShown, noteTurnEnd, noticeShownAt } from './plaintext';
import { ASK_THROUGH_QUESTION_TOOL, plainTextSetting, sessionStartOutput, settingState, settingsFileShown } from './settings';
import { ASKED, FORMAT_VERSION, appendObservation, type Observation } from './outcomes';

export const QUESTION_TOOL = 'AskUserQuestion';
export const SKILL_TOOL = 'Skill';
/** Events registered only so attrs.ts learns who is asking; they leave no line in events.jsonl. */
export const ATTR_EVENTS: readonly string[] = ['UserPromptExpansion', 'PostModelSwitch', 'SubagentStop'];
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
  /** The agent's final message of the turn, on Stop only; null on every other event. Never stored. */
  lastMessage: string | null;
  /** The fields that say who is acting; attrs.ts decides what they mean. */
  who: AttrEvent;
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
  const who: AttrEvent = {
    event,
    sessionId,
    agentId: str(v.agent_id),
    agentType: str(v.agent_type),
    toolName,
    skill: isObject(v.tool_input) ? str(v.tool_input.skill) : null,
    commandName: str(v.command_name),
    model: str(event === 'PostModelSwitch' ? v.to_model : v.model),
  };
  return {
    who,
    event,
    sessionId,
    cwd: str(v.cwd),
    notificationType: str(v.notification_type),
    message: str(v.message),
    toolName,
    toolUseId: str(v.tool_use_id),
    // Read for one event only, so no other event's text can reach the phrase check (plaintext.ts).
    lastMessage: event === 'Stop' ? str(v.last_assistant_message) : null,
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
export function questionObservations(p: HookPayload, now: number, home: string, dir?: string): Observation[] {
  if (p.toolName !== QUESTION_TOOL || !p.toolUseId) return [];
  if (p.event !== 'PreToolUse' && p.event !== 'PostToolUse') return [];
  const base = {
    v: FORMAT_VERSION,
    source: 'hook' as const,
    call: p.toolUseId,
    session: p.sessionId,
    project: projectAt(dir, p.sessionId, p.cwd, home) ?? '(unknown)',
  };
  // A payload whose questions cannot be read still leaves a trace, so the app can say so.
  if (!p.questions) {
    if (p.event !== 'PostToolUse') return [];
    return [{ ...base, pos: 0, kind: 'UNDECODED', chip: '', title: '', askTs: null, answerTs: now }];
  }
  // Who asked is fixed when the question is asked; the answer's observation carries none of it.
  const who = p.event === 'PreToolUse' && dir ? whoAt(dir, p.who) : {};
  return p.questions.map((q, pos) => ({
    ...base,
    ...who,
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
    // First, so a skill started in this very event is known to a question that follows.
    noteAttrs(dir, payload.who, now);
  } catch (err) {
    logError(dir, `could not record who is asking: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  try {
    // After the attributes: a session that ended took its state with it, and this start begins anew.
    if (payload.event === 'SessionStart') noteStart(dir, payload.sessionId, payload.cwd, env.HOME || os.homedir());
  } catch (err) {
    logError(dir, `could not record the session's project: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  try {
    const line = sessionEventLine(payload, now);
    if (line) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n', { mode: 0o600 });
    }
    for (const obs of questionObservations(payload, now, env.HOME || os.homedir(), dir)) appendObservation(dir, obs);
  } catch (err) {
    // Path and error class only: nothing from the payload reaches the log.
    logError(dir, `could not write to ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  try {
    noteTurn(dir, payload, now);
  } catch (err) {
    // Error class only: nothing from the message reaches the log.
    logError(dir, `could not record a turn end: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  return payload;
}

/**
 * The plain-text check (plaintext.ts), per event:
 *
 *   UserPromptSubmit ............. this session's turn is "clear"
 *   AskUserQuestion, PreToolUse .. this session's turn is "asked": the exact share has this choice
 *   Stop ......................... checked only when every line below holds, else nothing happens:
 *                                    the user has not turned the check off (settings.ts)
 *                                    the one-time notice has been shown on this machine
 *                                    the turn is exactly "clear" (an unknown or unreadable state
 *                                    skips: a session that began before this code has no history)
 *                                    the payload carries the final message
 *                                  then one line, "1" or "0", is appended to today's file.
 *
 * Throws on a failed write; handle() logs it. Nothing from the message is written or logged.
 */
function noteTurn(dir: string, p: HookPayload, now: number): void {
  if (p.event === 'UserPromptSubmit') return putSessionValue(dir, p.sessionId, TURN_STATE, TURN_CLEAR);
  if (p.event === 'PreToolUse' && p.toolName === QUESTION_TOOL) return putSessionValue(dir, p.sessionId, TURN_STATE, TURN_ASKED);
  if (p.event !== 'Stop' || p.lastMessage === null) return;
  if (plainTextSetting(dir) !== 'on' || noticeShownAt(dir) === null) return;
  if (getSessionValue(dir, p.sessionId, TURN_STATE) !== TURN_CLEAR) return;
  noteTurnEnd(dir, now, hasRecommendation(p.lastMessage));
}

/**
 * What a session start prints, and whether the notice is part of it. The notice is due when the
 * plain-text check is on and this machine's user has not been shown it; the caller marks it shown
 * only after the output has been written.
 */
export function sessionStartPlan(dir: string, line: string | null, nudge: boolean, noticeText: string = NOTICE_LINE): { output: string | null; notice: boolean } {
  const notice = plainTextSetting(dir) === 'on' && noticeShownAt(dir) === null;
  const shown = [line, notice ? noticeText : null].filter((x): x is string => !!x).join('\n') || null;
  return { output: sessionStartOutput(shown, nudge), notice };
}

/** Handle one hook invocation from Codex. Never throws. Writes question observations and nothing else. */
export function handleCodex(raw: string, env: Record<string, string | undefined>, now: number): void {
  const dir = dataDir(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logError(dir, 'unparsable Codex hook payload (bad JSON)');
    return;
  }
  try {
    for (const obs of codexObservations(parsed, now, env.HOME || os.homedir())) appendObservation(dir, obs);
  } catch (err) {
    logError(dir, `could not write to ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
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
// wanted-version file that it should leave and exits by itself (server.ts), on whatever port it holds.
//
// Which port: the hook looks where the server said it is (server-address.json, or the fixed
// AGENT_INBOX_PORT) and nowhere else. The starter looks at every port the server may choose,
// because it must not start a second server beside one that is running or leaving. Another
// program on a port matters only when the user fixed that port; otherwise the server simply
// takes the next one.
//
// What the user is told at session start, each at most once:
//
//   the address was never shown (or has changed)        a start was launched earlier and the
//   ---------------------------------------------       server still does not answer
//   server current -> the first-run line                ----------------------------------
//   server silent  -> launch, then wait up to 2 s        (the pending mark is older than 15 s)
//                     for it to answer:                  -> one line naming server.log, and a
//                       answers -> the first-run line       fresh start is launched
//                       not yet -> nothing now; the
//                                  line comes at the
//                                  next session start
//
// The first-run line never shows an address that has not answered /health. Only that first-run
// case waits; every other session start returns at once. A reboot or a stopped server leaves no
// pending mark, so it is relaunched silently.

export type ServerState = 'current' | 'stale' | 'silent' | 'foreign';
export const PROBE_TIMEOUT_MS = 250;
/** On /health: which data directory the server serves (inbox.ts instanceId). */
export const INSTANCE_HEADER = 'X-Nod-Board-Instance';
export const STARTER_WAIT_MS = 5_000;
export const STARTER_STEP_MS = 200;
/** How long the first session start waits for the server it launched, so it can show a working address. */
export const FIRST_RUN_WAIT_MS = 2_000;
/** A launched start that still does not answer after this long has failed. The starter gives up after STARTER_WAIT_MS. */
export const START_GRACE_MS = 15_000;

export function firstRunLine(url: string): string {
  return `${APP_TITLE} is running at ${url} and keeps everything on this machine. Open it with /nod-board:open; load your past sessions with /nod-board:import.`;
}
export function failedStartLine(dir: string): string {
  return `${APP_TITLE}: the dashboard did not start. The log is ${path.join(dir, 'server.log')}.`;
}

/**
 * What answers on a port. `instance` names this data directory (inbox.ts instanceId): a server of
 * this program that serves other data, another user's or another checkout's, is not ours. A
 * server too old to say which data it serves is taken as ours, so an update can replace it.
 */
export async function probeServer(port: number, version: string, fetchImpl: typeof fetch = fetch, instance?: string): Promise<ServerState> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return 'silent';
  }
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (body.app !== APP_NAME) return 'foreign';
    const theirs = res.headers?.get(INSTANCE_HEADER) ?? null;
    if (instance !== undefined && theirs !== null && theirs !== instance) return 'foreign';
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

export function realDeps(root: string = import.meta.dir, env: Record<string, string | undefined> = process.env): StartDeps {
  const version = pluginVersion(root);
  const instance = instanceId(dataDir(env));
  return {
    root,
    version,
    probe: (port, wanted) => probeServer(port, wanted, fetch, instance),
    launch: launchDetached,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Returns a line for the user, or null. Waits (at most FIRST_RUN_WAIT_MS) only when the address
 * was never shown and this call launched the server; see the table above.
 */
export async function onSessionStart(env: Record<string, string | undefined>, deps: StartDeps): Promise<string | null> {
  const dir = dataDir(env);
  let port = knownPort(env, dir);
  try {
    writeWantedVersion(dir, deps.version, deps.root);
    markCaptureStart(dir, Date.now());
  } catch (err) {
    logError(dir, `could not record the wanted server version: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
  }
  // Marker files are a convenience: when one cannot be read or written the line may repeat, never mislead.
  const quietly = <T>(what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      logError(dir, `could not ${what}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
      return fallback;
    }
  };
  const shown = quietly('read the shown address', () => shownAddress(dir), null);
  // The address was never shown, or the board is no longer expected where the user was told.
  const firstRun = shown !== boardUrl(port);

  let state = await deps.probe(port, deps.version);
  // Another program matters only on a port the user fixed; otherwise the server takes the next free one.
  if (state === 'foreign' && explicitPort(env) !== null)
    return `${APP_TITLE}: port ${port} is used by another program, so the dashboard was not started. Set AGENT_INBOX_PORT to a free port.`;
  if (state !== 'current') {
    const now = Date.now();
    const pending = quietly('read the pending start', () => startPendingSince(dir), null);
    const failed = pending !== null && now - pending > START_GRACE_MS;
    // A start another session launched moments ago keeps its own time, so its failure is still noticed.
    // Marked before the launch: the server clears the mark once it serves, and must not get there first.
    if (pending === null || failed) quietly('record the pending start', () => markStartPending(dir, now), undefined);
    deps.launch([path.join(deps.root, 'hook.ts'), '--start-server'], null);
    if (failed) return failedStartLine(dir);
    if (!firstRun) return null;
    const began = performance.now();
    for (let waited = 0; waited < FIRST_RUN_WAIT_MS && performance.now() - began < FIRST_RUN_WAIT_MS; waited += STARTER_STEP_MS) {
      await deps.sleep(STARTER_STEP_MS);
      port = knownPort(env, dir); // the server says which port it took
      state = await deps.probe(port, deps.version);
      if (state === 'current') break;
    }
    if (state !== 'current') return null;
  }
  quietly('clear the pending start', () => clearStartPending(dir), undefined);
  const url = boardUrl(port);
  if (shown === url) return null;
  quietly('record the shown address', () => markAddressShown(dir, url), undefined);
  return firstRunLine(url);
}

/**
 * The detached starter: wait for a stale server to leave, then start the current one.
 *
 *   on any port the server may choose:   a current server of ours  -> done, nothing to start
 *                                        an older server of ours   -> wait for it to leave
 *   on the port the user fixed:          another program           -> done, never touch it
 *   otherwise                                                      -> start the server; it picks its port
 */
export async function runStarter(env: Record<string, string | undefined>, deps: StartDeps): Promise<ServerState | 'started'> {
  const dir = dataDir(env);
  const ports = candidatePorts(env);
  const fixed = explicitPort(env) !== null;
  let leaving = ports[0];
  for (let waited = 0; waited <= STARTER_WAIT_MS; waited += STARTER_STEP_MS) {
    let stale = false;
    for (const port of ports) {
      const state = await deps.probe(port, deps.version);
      if (state === 'current') return state;
      if (state === 'foreign' && fixed) return state;
      if (state === 'stale') {
        stale = true;
        leaving = port;
        break; // nothing may start while an older server of ours is still up
      }
    }
    if (!stale) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      deps.launch([path.join(deps.root, 'server.ts')], path.join(dir, 'server.log'));
      return 'started';
    }
    await deps.sleep(STARTER_STEP_MS);
  }
  logError(dir, `an older agent-inbox server did not leave port ${leaving} within ${STARTER_WAIT_MS} ms`);
  return 'stale';
}

if (import.meta.main) {
  if (process.argv[2] === '--start-server') {
    await runStarter(process.env, realDeps());
    process.exit(0);
  }
  const raw = await Bun.stdin.text();
  if (process.argv[3] === CODEX_ARG) {
    handleCodex(raw, process.env, Date.now());
    process.exit(0);
  }
  const payload = handle(raw, process.env, Date.now());
  if (payload?.event === 'SessionStart') {
    let line: string | null = null;
    try {
      line = await onSessionStart(process.env, realDeps());
    } catch (err) {
      logError(dataDir(process.env), `session start failed: ${(err as Error).name}`);
    }
    // A systemMessage is shown to the user and stays out of the model's context. The one thing
    // added to that context is a fixed sentence, and only when the user turned it on (settings.ts).
    const dir = dataDir(process.env);
    // The notice names the settings file where it is on this machine (AGENT_INBOX_DIR may move it).
    const notice = noticeLine(settingsFileShown(dir, process.env.HOME || os.homedir()));
    const plan = sessionStartPlan(dir, line, settingState(dir, ASK_THROUGH_QUESTION_TOOL) === 'on', notice);
    if (plan.output) process.stdout.write(plan.output + '\n');
    if (plan.notice) {
      // Only now, after the line went out: a failure before this point shows the notice again
      // next time and leaves the check off, never the other way round.
      try {
        markNoticeShown(dir, Date.now());
      } catch (err) {
        logError(dir, `could not record that the plain-text notice was shown: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
      }
    }
  }
  process.exit(0);
}
