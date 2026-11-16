/**
 * settings.ts: what a user can turn on in settings.json. Chiefly the one outside request The Nod
 * Board can make, the update check; also the sentence that asks the agent to use the question tool.
 *
 * Off unless <data dir>/settings.json says {"check_for_updates": true}. That file is the user's:
 * the board reads it and never writes it. When it is on, the server (never the page) fetches one
 * fixed address at most once a day, and only while somebody has the board open: the plugin manifest on
 * the release branch, which is the version an update would install. The request has no query,
 * no body and a fixed User-Agent without a version, so it carries nothing from this machine.
 * The answer is kept in memory; nothing is written.
 *
 *   settings say on?  --no-->  nothing, and a version found earlier is forgotten
 *        | yes
 *   last try under a day ago (an hour after a failure)?  --yes-->  nothing
 *        | no
 *   fetch, 5 s at most  -->  a version like 1.2.3  -->  remembered
 *                       -->  anything else         -->  ignored, tried again in an hour
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SETTINGS_FILE = 'settings.json';
export const RELEASE_MANIFEST_URL = 'https://raw.githubusercontent.com/raduuuuu/the-nod-board/release/.claude-plugin/plugin.json';
export const UPDATE_COMMAND = 'claude plugin update nod-board@nod-board';
export const CHECK_EVERY_MS = 24 * 3600_000;
export const RETRY_AFTER_MS = 3600_000;
export const CHECK_TIMEOUT_MS = 5_000;
/** A manifest is a few hundred bytes; anything much larger is not one. */
const MANIFEST_MAX = 16_384;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export type Setting = 'on' | 'off' | 'unreadable';
export type UpdateSetting = Setting;
/** The settings a user can turn on. Each is off until the file gives it the literal true. */
export const CHECK_FOR_UPDATES = 'check_for_updates';
export const ASK_THROUGH_QUESTION_TOOL = 'ask_through_question_tool';

export type SettingValue = true | false | 'absent' | 'unreadable';

/**
 * One key of the user's settings file, as written: the literal true or false, 'absent' when the
 * file or the key is missing or the value is neither, 'unreadable' when the file is not one JSON
 * object. The one place the file is parsed.
 */
export function settingValue(dir: string, key: string): SettingValue {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const value = (parsed as Record<string, unknown>)[key];
    return value === true || value === false ? value : 'absent';
  } catch {
    return 'unreadable';
  }
}

/** A setting that is off until asked for: only the literal true turns it on. */
export function settingState(dir: string, key: string): Setting {
  const value = settingValue(dir, key);
  return value === true ? 'on' : value === 'unreadable' ? 'unreadable' : 'off';
}

export const COUNT_PLAIN_TEXT = 'count_plain_text';

/**
 * The plain-text check (plaintext.ts) is on unless the user turns it off: on when the key is
 * missing or true, off when it is false. A settings file that cannot be read means off, since
 * whoever wrote it may have meant to turn the check off.
 */
export function plainTextSetting(dir: string): Setting {
  const value = settingValue(dir, COUNT_PLAIN_TEXT);
  return value === false ? 'off' : value === 'unreadable' ? 'unreadable' : 'on';
}

export const updateSetting = (dir: string): Setting => settingState(dir, CHECK_FOR_UPDATES);

/**
 * The one sentence the session-start hook adds to the agent's context, and only for a user who
 * turned it on. The board counts a choice only when it is asked through the question tool; a
 * recommendation made in plain text is never seen. This asks the agent to use the tool. It is
 * fixed text: nothing from the user's data is in it.
 */
export const QUESTION_TOOL_NUDGE =
  'The user has asked for this through The Nod Board: when you offer the user a choice between options and you recommend one of them, ask with the AskUserQuestion tool instead of plain text, and end the label of the option you recommend with "(Recommended)".';

/** What the SessionStart hook prints: a line for the user, a sentence for the agent, both or nothing. */
export function sessionStartOutput(line: string | null, nudge: boolean): string | null {
  if (!line && !nudge) return null;
  return JSON.stringify({
    ...(line ? { systemMessage: line } : {}),
    ...(nudge ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: QUESTION_TOOL_NUDGE } } : {}),
  });
}

/** True when `candidate` is a later release than `current`. Anything that is not n.n.n is never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = VERSION.exec(candidate);
  const b = VERSION.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The version in a plugin manifest, or null when the text is not one. */
export function manifestVersion(text: string): string | null {
  if (text.length > MANIFEST_MAX) return null;
  try {
    const v = (JSON.parse(text) as { version?: unknown } | null)?.version;
    return typeof v === 'string' && VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

export type FetchText = (url: string) => Promise<string>;

export const fetchManifest: FetchText = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    redirect: 'error',
    headers: { 'User-Agent': 'the-nod-board', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.text();
};

export class UpdateCheck {
  private found: string | null = null;
  private nextTry = 0;
  private busy: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly current: string,
    private readonly fetchText: FetchText = fetchManifest,
  ) {}

  /**
   * Called when the board is read. Returns at once with what is known: a newer version, or null.
   * A check that is due starts in the background and shows up on a later read.
   */
  latest(now: number): string | null {
    if (updateSetting(this.dir) !== 'on') {
      this.found = null;
      this.nextTry = 0;
      return null;
    }
    if (!this.busy && now >= this.nextTry) {
      this.nextTry = now + RETRY_AFTER_MS;
      this.busy = this.fetchText(RELEASE_MANIFEST_URL)
        .then((text) => {
          const v = manifestVersion(text);
          if (v === null) return;
          this.found = v;
          this.nextTry = now + CHECK_EVERY_MS;
        })
        .catch(() => {
          // Offline, blocked or changed upstream: not an error of this tool. Tried again in an hour.
        })
        .finally(() => {
          this.busy = null;
        });
    }
    return this.found !== null && isNewer(this.found, this.current) ? this.found : null;
  }

  /** For tests: resolves when no check is running. */
  async settled(): Promise<void> {
    await this.busy;
  }
}
