#!/usr/bin/env bun
/**
 * board.ts: the two commands that bring a user back to the board.
 *
 *   bun scripts/board.ts open     /nod-board:open    start the server when it is not running, open the
 *                                                    address in the browser, print the address
 *   bun scripts/board.ts status   /nod-board:status  say whether it runs and where, and what capture has
 *                                                    recorded so far
 *
 * Both print a few plain lines and nothing from any question: counts, times and paths only. They
 * reuse the hook's own probe and starter (hook.ts), so "is our server running" is decided in one
 * place. No process is killed and nothing is changed except starting the server.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STARTER_STEP_MS, STARTER_WAIT_MS, dataDir, realDeps, runStarter, type ServerState, type StartDeps } from '../hook';
import { APP_TITLE, boardUrl, captureSince, explicitPort, knownPort, lastHookErrorTs, writeWantedVersion } from '../inbox';
import { readObservations } from '../outcomes';
import { ALIASES_FILE, readAliases } from '../project';
import { OFFERS_DIR, OFFERS_NOTICE_FILE, noticeShownAt, turnWindows } from '../plaintext';
import { ASK_THROUGH_QUESTION_TOOL, SETTINGS_FILE, plainTextSetting, settingState, updateSetting } from '../settings';

type Env = Record<string, string | undefined>;

export interface BoardIo {
  /** Open an address in the user's browser. Returns false when this system has no way to do that. */
  openInBrowser: (url: string) => boolean;
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
}

const OPENERS: Record<string, string> = { darwin: 'open', linux: 'xdg-open' };

export function realIo(): BoardIo {
  return {
    openInBrowser: (url) => {
      const opener = OPENERS[process.platform];
      const bin = opener ? Bun.which(opener) : null;
      if (!bin) return false;
      // The address is built from a number (boardUrl); it is passed as one argument, never through a shell.
      spawn(bin, [url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    },
    fetchJson: async (url) => (await fetch(url, { signal: AbortSignal.timeout(1_000) })).json(),
    now: () => Date.now(),
  };
}

/** Make sure the current server answers, starting it when needed. Never waits longer than the starter does. */
async function ensureRunning(env: Env, deps: StartDeps): Promise<ServerState> {
  const dir = dataDir(env);
  const fixed = explicitPort(env) !== null;
  // Say which version is wanted, as a session start does. Without this an older server that is
  // still running is never told to leave, and the starter waits for it in vain.
  try {
    writeWantedVersion(dir, deps.version, deps.root);
  } catch {
    // Not fatal: with nothing running the server can still be started.
  }
  let state = await deps.probe(knownPort(env, dir), deps.version);
  if (state === 'current' || (state === 'foreign' && fixed)) return state;
  await runStarter(env, deps);
  for (let waited = 0; waited < STARTER_WAIT_MS; waited += STARTER_STEP_MS) {
    // The server records the port it took; look there each time.
    state = await deps.probe(knownPort(env, dir), deps.version);
    if (state === 'current') return state;
    await deps.sleep(STARTER_STEP_MS);
  }
  return state === 'foreign' && !fixed ? 'silent' : state;
}

export async function openBoard(env: Env, deps: StartDeps, io: BoardIo): Promise<string[]> {
  const state = await ensureRunning(env, deps);
  const port = knownPort(env, dataDir(env));
  const url = boardUrl(port);
  if (state === 'foreign') return [`${APP_TITLE}: port ${port} is used by another program, so the dashboard is not running. Set AGENT_INBOX_PORT to a free port.`];
  if (state !== 'current') return [`${APP_TITLE}: the dashboard did not start. The log is ${path.join(dataDir(env), 'server.log')}.`];
  return io.openInBrowser(url) ? [`${APP_TITLE}: opened ${url}`] : [`${APP_TITLE} is running at ${url}`, 'Open that address in your browser.'];
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** "2026-11-14 09:30 UTC": a terminal has no time zone of its own to show. */
const utcMinute = (ts: number): string => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function errorLines(dir: string): number {
  try {
    return fs.readFileSync(path.join(dir, 'hook-errors.log'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** The plain-text check in one line, in the same states the board shows (plaintext.ts). */
export function plainTextStatus(dir: string, now: number): string {
  const setting = plainTextSetting(dir);
  if (setting === 'off') return 'plain-text check: off';
  if (setting === 'unreadable') return `plain-text check: off; ${path.join(dir, SETTINGS_FILE)} could not be read`;
  if (noticeShownAt(dir) === null) return 'plain-text check: starts after the notice at the next session start';
  try {
    const w = turnWindows(dir, now)!;
    const since = new Date(w.since).toISOString().slice(0, 10);
    const n = (x: number) => x.toLocaleString('en-US');
    const o = turnWindows(dir, now, OFFERS_DIR, OFFERS_NOTICE_FILE);
    // Offers are counted apart, since their own notice; before it the line reads as it always did.
    const offers = o === null ? '' : o.last.checked === 0 ? '; offers: none checked yet' : `; offers: about ${n(o.last.matched)} of ${n(o.last.checked)}`;
    return w.last.checked === 0
      ? `plain-text check: on since ${since}; no replies checked in the last 7 days${offers}`
      : `plain-text check: on since ${since}; about ${n(w.last.matched)} of ${n(w.last.checked)} replies in the last 7 days${offers}`;
  } catch {
    return 'plain-text check: could not be read';
  }
}

/** What a user needs to tell whether capture works, and what to paste into a bug report. Counts only. */
export async function statusLines(env: Env, deps: StartDeps, io: BoardIo): Promise<string[]> {
  const dir = dataDir(env);
  const port = knownPort(env, dir);
  const url = boardUrl(port);
  const probed = await deps.probe(port, deps.version);
  // Another program on a port the user did not fix is not in the way: the server takes the next one.
  const state: ServerState = probed === 'foreign' && explicitPort(env) === null ? 'silent' : probed;
  const running: Record<ServerState, string> = {
    current: `yes, at ${url}`,
    stale: `an older version is answering at ${url}; it is replaced at the next session start or by /nod-board:open`,
    silent: 'no. Start it with /nod-board:open',
    foreign: `no: port ${port} is used by another program. Set AGENT_INBOX_PORT to a free port`,
  };
  const lines = [`${APP_TITLE} ${deps.version}`, `running: ${running[state]}`];
  if (state === 'current') {
    try {
      const health = (await io.fetchJson(`${url}health`)) as { last_event_ts?: unknown };
      const ts = typeof health.last_event_ts === 'number' ? health.last_event_ts : null;
      lines.push(`last event: ${ts === null ? 'none yet' : ago(io.now() - ts)}`);
    } catch {
      lines.push('last event: could not be read');
    }
  }
  const since = captureSince(dir);
  const lastError = lastHookErrorTs(dir);
  const stored = readObservations(dir);
  lines.push(
    `capturing since: ${since === null ? 'not started' : utcMinute(since)}`,
    `questions stored: ${new Set(stored.observations.map((o) => `${o.call}/${o.pos}`)).size.toLocaleString('en-US')}`,
    `past sessions: ${stored.observations.some((o) => o.source === 'import') ? 'imported' : 'not imported (run /nod-board:import)'}`,
    `hook errors: ${errorLines(dir).toLocaleString('en-US')}${lastError === null ? '' : `, last ${utcMinute(lastError)}`}`,
    plainTextStatus(dir, io.now()),
    `data folder: ${dir}`,
  );
  // Said only when the user keeps an alias file, so a board without one reads as before.
  const aliases = readAliases(dir);
  if (aliases.state === 'ok') lines.push(`project aliases: ${aliases.names.size.toLocaleString('en-US')}`);
  if (aliases.state === 'unreadable') lines.push(`project aliases: ${path.join(dir, ALIASES_FILE)} could not be read; it must be one JSON object of "old name": "new name"`);
  // Said only when the user wrote a settings file that turns it on, or one that cannot be read.
  const updates = updateSetting(dir);
  if (updates === 'on') lines.push('update check: on, once a day while the board is open; a newer version is named on the board');
  if (updates === 'unreadable') lines.push(`update check: off; ${path.join(dir, SETTINGS_FILE)} could not be read; it must be one JSON object, for example {"check_for_updates": true}`);
  if (settingState(dir, ASK_THROUGH_QUESTION_TOOL) === 'on') lines.push('question tool: new sessions ask the agent to put choices through it');
  return lines;
}

if (import.meta.main) {
  const command = process.argv[2];
  const run = command === 'open' ? openBoard : command === 'status' ? statusLines : null;
  if (!run) {
    console.log('usage: bun scripts/board.ts open|status');
    process.exit(2);
  }
  console.log((await run(process.env, realDeps(path.join(import.meta.dir, '..'), process.env), realIo())).join('\n'));
}
