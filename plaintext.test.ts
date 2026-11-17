import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handle, sessionStartPlan } from './hook';
import { Inbox } from './inbox';
import {
  NOTICE_FILE,
  NOTICE_LINE,
  OFFERS_DIR,
  OFFERS_NOTICE_FILE,
  OFFER_QUESTIONS,
  OFFER_REQUESTS,
  OFFER_TAIL,
  PHRASES,
  TEXT_MAX,
  TURNS_DIR,
  dayKey,
  hasOffer,
  hasRecommendation,
  markNoticeShown,
  noteTurnEnd,
  noticeLine,
  noticeShownAt,
  offersNoticeLine,
  turnWindows,
} from './plaintext';
import { plainTextStatus } from './scripts/board';
import { judgmentJson, plainTextJson } from './server';
import { COUNT_PLAIN_TEXT, DEFAULT_SETTINGS_SHOWN, SETTINGS_FILE, plainTextSetting, settingState, settingValue, settingsFileShown } from './settings';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-plain-'));
afterAll(() => {
  try {
    fs.chmodSync(path.join(root, 'locked'), 0o700);
  } catch {
    // only present when the write-failure test ran
  }
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
const T = Date.UTC(2026, 10, 16, 12, 0); // Monday 16 November 2026, 12:00 UTC
const DAY = 24 * 3_600_000;
function dataDir(opts: { settings?: string; noticeAt?: number | null } = {}): string {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.settings !== undefined) fs.writeFileSync(path.join(dir, SETTINGS_FILE), opts.settings);
  if (opts.noticeAt !== null) markNoticeShown(dir, opts.noticeAt ?? T - 30 * DAY);
  return dir;
}
const dayFile = (dir: string, ts: number) => path.join(dir, TURNS_DIR, dayKey(ts));
/** The offers store's lines for a day; [] when there is no file. */
const offerLines = (dir: string, ts: number): string[] => {
  try {
    return fs.readFileSync(path.join(dir, OFFERS_DIR, dayKey(ts)), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
/** A data folder whose user has seen both notices. */
const offersDir = (at = T - 30 * DAY): string => {
  const dir = dataDir();
  markNoticeShown(dir, at, OFFERS_NOTICE_FILE);
  return dir;
};
const OFFERS_LINE = offersNoticeLine('~/.agent-inbox/settings.json');
const lines = (dir: string, ts: number): string[] => {
  try {
    return fs.readFileSync(dayFile(dir, ts), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const envOf = (dir: string) => ({ AGENT_INBOX_DIR: dir, HOME: root });
const send = (dir: string, payload: Record<string, unknown>, now = T) => handle(JSON.stringify({ session_id: 'sess-1', cwd: '/w', ...payload }), envOf(dir), now);
const prompt = (dir: string, extra: Record<string, unknown> = {}) => send(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'SECRET-PROMPT-TEXT', ...extra });
const stop = (dir: string, message: unknown, extra: Record<string, unknown> = {}) => send(dir, { hook_event_name: 'Stop', last_assistant_message: message, ...extra });
const ask = (dir: string, extra: Record<string, unknown> = {}) =>
  send(dir, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: [] }, ...extra });
/** A background task as Claude Code lists it on Stop and SubagentStop. Its description and command must never be kept. */
const task = (id: string, type = 'subagent') => ({ id, type, status: 'running', description: 'SECRET-TASK-DESCRIPTION', command: 'SECRET-TASK-COMMAND' });
const subagentStop = (dir: string, agentId: string, tasks: unknown[], extra: Record<string, unknown> = {}) =>
  send(dir, { hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: 'general-purpose', last_assistant_message: 'SECRET-SUBAGENT-TEXT', background_tasks: tasks, ...extra });
const RECAP = "You picked B. I'd recommend running the tests next.";
/** Every file under a folder, as one string: what a search for leaked text looks through. */
const everything = (dir: string): string =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');

describe('the phrase check', () => {
  test('every phrase matches as whole words, in any case and with a curly apostrophe', () => {
    for (const p of PHRASES) {
      expect(hasRecommendation(`Two ways to do this. ${p[0].toUpperCase()}${p.slice(1)} the first.`)).toBe(true);
      expect(hasRecommendation(`so ${p.replace(/'/g, '’')} that`)).toBe(true);
    }
  });

  test('near-misses and ordinary replies do not match', () => {
    for (const t of ['', 'Done. All 404 tests pass.', 'The recommendations table is updated.', 'Kid would recommend it', "I'd double-check that", 'my picks are in', 'This is the recommendation engine']) {
      expect(hasRecommendation(t)).toBe(false);
    }
  });

  test('a phrase only inside a code fence or a quoted line is not a match', () => {
    expect(hasRecommendation("Here is the file:\n```\n// I'd recommend option A\n```\nDone.")).toBe(false);
    expect(hasRecommendation("> I'd recommend option A\nThat was the earlier note.")).toBe(false);
    expect(hasRecommendation("```\ncode\n```\nI'd recommend option A.")).toBe(true);
  });

  test('only the first 20,000 characters are looked at, and a long hostile text is quick', () => {
    expect(hasRecommendation('x'.repeat(TEXT_MAX) + " I'd recommend A")).toBe(false);
    const hostile = ("i'd recommen " + '```' + ' i would recomm ').repeat(2_000);
    const start = performance.now();
    expect(hasRecommendation(hostile)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('the offer check', () => {
  test('a question phrase needs its question mark on the same line; any case, curly apostrophes and quotes', () => {
    for (const p of OFFER_QUESTIONS) {
      expect(hasOffer(`The fix is ready. ${p[0].toUpperCase()}${p.slice(1)} open a pull request?`)).toBe(true);
      expect(hasOffer(`The fix is ready, and you ${p} open a pull request.`)).toBe(false);
      expect(hasOffer(`${p} open it\nIs that right?`)).toBe(false);
    }
    expect(hasOffer('Next is the import. Shall I go ahead?')).toBe(true);
    expect(hasOffer('Want me to commit, or draft the claims first?')).toBe(true);
  });

  test('a request for a go-ahead matches, with the words to say in straight or curly quotes', () => {
    for (const p of OFFER_REQUESTS) expect(hasOffer(`All tests pass. ${p[0].toUpperCase()}${p.slice(1)} want it and I'll start.`)).toBe(true);
    expect(hasOffer('CI is green. Say "merge when green" and I\'ll merge it.')).toBe(true);
    expect(hasOffer('CI is green. Say “merge” and I’ll merge it.')).toBe(true);
    expect(hasOffer('Which do you prefer? And say "merge when green" for the other one.')).toBe(true);
    expect(hasOffer('When you are happy, say "commit and push".')).toBe(true);
    expect(hasOffer('Attach it to a new chat and say "follow this brief".')).toBe(false); // an instruction for elsewhere, mid-sentence
  });

  test('near-misses and ordinary replies do not match', () => {
    for (const t of [
      '',
      'Done. All 404 tests pass.',
      'The layout list says "turning right" when it should say "turning left".',
      'No GitHub repo until you say so.',
      "I'd rather say so than let it pass silently.",
      'Should it fail, the log names the port.',
      'What should improve is the wording?',
      'They want me too.',
      'Why did the essay "' + 'x'.repeat(60) + '" fail?',
    ]) {
      expect(hasOffer(t)).toBe(false);
    }
  });

  test('only the end of the reply counts, and code and quoted lines never do', () => {
    expect(hasOffer('Want me to start?' + ' More detail follows.'.repeat(30))).toBe(false);
    expect(hasOffer('x'.repeat(2_000) + ' Want me to start?')).toBe(true);
    expect(hasOffer('Here is the script:\n```\necho "Shall I go ahead?"\n```\nDone.')).toBe(false);
    expect(hasOffer('> Want me to start?\nThat was the earlier question; it is done now.')).toBe(false);
    expect(hasOffer('Want me to start?' + ' '.repeat(OFFER_TAIL * 2))).toBe(true); // trailing blanks are not the end
  });

  test('a long hostile text is quick', () => {
    const hostile = ('want me to ' + 'should i shall i say " '.repeat(8)).repeat(2_000);
    const start = performance.now();
    hasOffer(hostile);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('the store', () => {
  test('one line per checked turn end, in the file of its UTC day, with private modes', () => {
    const dir = dataDir();
    noteTurnEnd(dir, T, true);
    noteTurnEnd(dir, T, false);
    noteTurnEnd(dir, T + DAY, false);
    expect(fs.readFileSync(dayFile(dir, T), 'utf8')).toBe('1\n0\n');
    expect(path.basename(dayFile(dir, T))).toBe('2026-11-16');
    expect(lines(dir, T + DAY)).toEqual(['0']);
    expect(fs.statSync(path.join(dir, TURNS_DIR)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dayFile(dir, T)).mode & 0o777).toBe(0o600);
  });

  test('windows: the last 7 days and the 7 before, missing days as nothing, junk lines ignored', () => {
    const dir = dataDir({ noticeAt: T - 30 * DAY });
    for (let i = 0; i < 3; i++) noteTurnEnd(dir, T, i === 0);
    noteTurnEnd(dir, T - 6 * DAY, true);
    noteTurnEnd(dir, T - 7 * DAY, true);
    noteTurnEnd(dir, T - 13 * DAY, false);
    noteTurnEnd(dir, T - 14 * DAY, true); // outside both windows
    fs.appendFileSync(dayFile(dir, T), 'junk\n11\n\n 1\n');
    expect(turnWindows(dir, T)).toEqual({ since: T - 30 * DAY, last: { checked: 4, matched: 2 }, before: { checked: 2, matched: 1 } });
  });

  test('no comparison while checking began inside the earlier window; nothing at all before the notice', () => {
    const dir = dataDir({ noticeAt: T - 9 * DAY });
    noteTurnEnd(dir, T, true);
    expect(turnWindows(dir, T)).toEqual({ since: T - 9 * DAY, last: { checked: 1, matched: 1 }, before: null });
    expect(turnWindows(dataDir({ noticeAt: T - 13 * DAY }), T)?.before).toEqual({ checked: 0, matched: 0 });
    expect(turnWindows(dataDir({ noticeAt: null }), T)).toBeNull();
  });

  test('a day file that cannot be read throws, so the caller can say so', () => {
    const dir = dataDir();
    fs.mkdirSync(dayFile(dir, T), { recursive: true }); // a folder where a file should be
    expect(() => turnWindows(dir, T)).toThrow();
  });

  test('the notice marker holds when it was shown; a broken marker is not shown', () => {
    const dir = dataDir({ noticeAt: null });
    expect(noticeShownAt(dir)).toBeNull();
    markNoticeShown(dir, T);
    expect(noticeShownAt(dir)).toBe(T);
    fs.writeFileSync(path.join(dir, NOTICE_FILE), 'soon');
    expect(noticeShownAt(dir)).toBeNull();
  });
});

describe('the setting', () => {
  test('on unless turned off; a settings file that cannot be read means off', () => {
    expect(plainTextSetting(dataDir())).toBe('on');
    expect(plainTextSetting(dataDir({ settings: '{}' }))).toBe('on');
    expect(plainTextSetting(dataDir({ settings: '{"count_plain_text": true}' }))).toBe('on');
    expect(plainTextSetting(dataDir({ settings: '{"count_plain_text": "no"}' }))).toBe('on');
    expect(plainTextSetting(dataDir({ settings: '{"count_plain_text": false}' }))).toBe('off');
    expect(plainTextSetting(dataDir({ settings: '{broken' }))).toBe('unreadable');
  });

  test('one reader tells true, false, absent and unreadable apart; opt-in settings read as before', () => {
    const dir = dataDir({ settings: '{"a": true, "b": false, "c": "true"}' });
    expect([settingValue(dir, 'a'), settingValue(dir, 'b'), settingValue(dir, 'c'), settingValue(dir, 'd')]).toEqual([true, false, 'absent', 'absent']);
    expect(settingValue(dataDir({ settings: '[1]' }), 'a')).toBe('unreadable');
    expect(settingValue(dataDir(), 'a')).toBe('absent');
    expect([settingState(dir, 'a'), settingState(dir, 'b'), settingState(dir, 'c'), settingState(dir, COUNT_PLAIN_TEXT)]).toEqual(['on', 'off', 'off', 'off']);
  });
});

describe('the hook at a turn end', () => {
  test('after a prompt, a reply with a phrase stores 1 and an ordinary reply stores 0', () => {
    const dir = dataDir();
    prompt(dir);
    stop(dir, "Two options. I'd recommend the first.");
    prompt(dir);
    stop(dir, 'Done, all tests pass.');
    expect(lines(dir, T)).toEqual(['1', '0']);
  });

  test('a turn that asked through the question tool is not checked, and the next prompt clears that', () => {
    const dir = dataDir();
    prompt(dir);
    ask(dir);
    stop(dir, "You picked B. I'd recommend running the tests next.");
    expect(lines(dir, T)).toEqual([]);
    prompt(dir);
    stop(dir, 'Done.');
    expect(lines(dir, T)).toEqual(['0']);
  });

  // Claude Code also fires UserPromptSubmit for a prompt nobody typed: the notice that a background
  // task finished. Each case below is an order of events recorded from Claude Code 2.1.325.
  test('a notice delivered inside the turn that asked does not clear it: same prompt id', () => {
    const dir = dataDir();
    prompt(dir, { prompt_id: 'p1' });
    ask(dir, { prompt_id: 'p1' });
    subagentStop(dir, 'agentA', [task('agentA')], { prompt_id: 'p1' });
    prompt(dir, { prompt_id: 'p1' }); // the notice, between two tool calls
    stop(dir, RECAP, { prompt_id: 'p1', background_tasks: [] });
    expect(lines(dir, T)).toEqual([]);
    prompt(dir, { prompt_id: 'p2' }); // the notice was used up: this one is the user's
    stop(dir, 'Done.', { prompt_id: 'p2', background_tasks: [] });
    expect(lines(dir, T)).toEqual(['0']);
  });

  test('a background subagent that ended before the turn did: its notice starts a turn that is not checked', () => {
    const dir = dataDir();
    prompt(dir, { prompt_id: 'p1' });
    ask(dir, { prompt_id: 'p1' });
    subagentStop(dir, 'agentA', [task('agentA')], { prompt_id: 'p1' });
    stop(dir, 'Started.', { prompt_id: 'p1', background_tasks: [] }); // no longer listed here
    prompt(dir, { prompt_id: 'p2' }); // the notice
    stop(dir, RECAP, { prompt_id: 'p2', background_tasks: [] });
    expect(lines(dir, T)).toEqual([]);
    prompt(dir, { prompt_id: 'p3' });
    stop(dir, 'Done.', { prompt_id: 'p3', background_tasks: [] });
    expect(lines(dir, T)).toEqual(['0']);
  });

  test('a background task still running when the turn ended is expected once, whether or not its end is also seen', () => {
    for (const type of ['subagent', 'shell']) {
      const dir = dataDir();
      prompt(dir, { prompt_id: 'p1' });
      ask(dir, { prompt_id: 'p1' });
      stop(dir, 'Started.', { prompt_id: 'p1', background_tasks: [task('taskA', type)] });
      if (type === 'subagent') subagentStop(dir, 'taskA', [task('taskA')], { prompt_id: 'p1' }); // the same task: counted once
      prompt(dir, { prompt_id: 'p2' }); // the notice
      stop(dir, RECAP, { prompt_id: 'p2', background_tasks: [] });
      expect(lines(dir, T)).toEqual([]);
      prompt(dir, { prompt_id: 'p3' });
      stop(dir, 'Done.', { prompt_id: 'p3', background_tasks: [] });
      expect(lines(dir, T)).toEqual(['0']);
    }
  });

  test('a task that never ends costs one turn after a question, not every turn after it', () => {
    const dir = dataDir();
    const server = [task('devserver', 'shell')];
    prompt(dir, { prompt_id: 'p1' });
    ask(dir, { prompt_id: 'p1' });
    stop(dir, 'Answered.', { prompt_id: 'p1', background_tasks: server });
    prompt(dir, { prompt_id: 'p2' }); // typed, but it cannot be told from a notice: skipped
    stop(dir, "I'd recommend A.", { prompt_id: 'p2', background_tasks: server });
    expect(lines(dir, T)).toEqual([]);
    prompt(dir, { prompt_id: 'p3' });
    stop(dir, "I'd recommend A.", { prompt_id: 'p3', background_tasks: server });
    expect(lines(dir, T)).toEqual(['1']);
  });

  test('a subagent that ran in the foreground, and background work in a turn that asked nothing, cost nothing', () => {
    const dir = dataDir();
    prompt(dir, { prompt_id: 'p1' });
    ask(dir, { prompt_id: 'p1' });
    subagentStop(dir, 'agentF', [], { prompt_id: 'p1' }); // foreground: not in the list
    stop(dir, 'Answered.', { prompt_id: 'p1', background_tasks: [] });
    prompt(dir, { prompt_id: 'p2' });
    stop(dir, 'Done.', { prompt_id: 'p2', background_tasks: [task('agentB')] });
    subagentStop(dir, 'agentB', [task('agentB')], { prompt_id: 'p2' });
    prompt(dir, { prompt_id: 'p3' }); // the notice, after a turn with no question: its reply is checked like any other
    stop(dir, "It finished. I'd recommend merging.", { prompt_id: 'p3', background_tasks: [] });
    expect(lines(dir, T)).toEqual(['0', '1']);
  });

  test('of a background task only its id is kept, and ids that are not plain are ignored', () => {
    const dir = dataDir();
    prompt(dir, { prompt_id: 'p1' });
    ask(dir, { prompt_id: 'p1' });
    subagentStop(dir, 'agentA', [task('agentA')], { prompt_id: 'p1' });
    stop(dir, 'Started.', { prompt_id: 'p1', background_tasks: [task('taskB', 'shell'), task('../../etc,passwd'), { id: 7 }, 'junk', null] });
    const kept = everything(dir);
    for (const secret of ['SECRET-TASK-DESCRIPTION', 'SECRET-TASK-COMMAND', 'SECRET-SUBAGENT-TEXT', 'SECRET-PROMPT-TEXT', 'passwd']) expect(kept).not.toContain(secret);
    expect(fs.readFileSync(path.join(dir, 'attrs', 'sess-1', 'turn-due'), 'utf8')).toBe('agentA,taskB');
  });

  test('offers are noted beside recommendations, each on its own, and only once their notice was shown', () => {
    const before = dataDir(); // the first notice was shown, the offers notice was not
    prompt(before);
    stop(before, 'The fix is ready. Want me to open a pull request?');
    expect(lines(before, T)).toEqual(['0']);
    expect(fs.existsSync(path.join(before, OFFERS_DIR))).toBe(false);

    const dir = offersDir();
    for (const reply of ['The fix is ready. Want me to open a pull request?', "Two ways. I'd recommend the first.", "I'd do the first. Say the word and I'll start.", 'Done.']) {
      prompt(dir);
      stop(dir, reply);
    }
    expect(lines(dir, T)).toEqual(['0', '1', '1', '0']);
    expect(offerLines(dir, T)).toEqual(['1', '0', '1', '0']);
  });

  test('a turn that asked through the question tool notes no offer either, and nothing but 1 and 0 is kept', () => {
    const dir = offersDir();
    prompt(dir);
    ask(dir);
    stop(dir, 'You picked B. Want me to start on it? SECRET-REPLY-TEXT');
    expect(offerLines(dir, T)).toEqual([]);
    prompt(dir);
    stop(dir, 'SECRET-REPLY-TEXT Want me to start?');
    expect(offerLines(dir, T)).toEqual(['1']);
    expect(everything(dir)).not.toContain('SECRET-REPLY-TEXT');
    expect(fs.statSync(path.join(dir, OFFERS_DIR)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, OFFERS_DIR, dayKey(T))).mode & 0o777).toBe(0o600);
  });

  test('with the check turned off no offer is noted', () => {
    const dir = dataDir({ settings: '{"count_plain_text": false}' });
    markNoticeShown(dir, T - DAY, OFFERS_NOTICE_FILE);
    prompt(dir);
    stop(dir, 'Want me to start?');
    expect(offerLines(dir, T)).toEqual([]);
  });

  test('a session that has seen no prompt under this code is skipped, and so is one whose state cannot be read', () => {
    const dir = dataDir();
    stop(dir, "I'd recommend A."); // a session already running when the plugin was updated
    expect(lines(dir, T)).toEqual([]);
    prompt(dir);
    fs.rmSync(path.join(dir, 'attrs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'attrs'), 'not a folder'); // the state can no longer be read
    stop(dir, "I'd recommend A.");
    expect(lines(dir, T)).toEqual([]);
  });

  test('nothing is checked before the notice, with the setting off, or with a broken settings file', () => {
    for (const dir of [dataDir({ noticeAt: null }), dataDir({ settings: '{"count_plain_text": false}' }), dataDir({ settings: '{nope' })]) {
      prompt(dir);
      stop(dir, "I'd recommend A.");
      expect(fs.existsSync(path.join(dir, TURNS_DIR))).toBe(false);
    }
  });

  test('a payload without the final message (an older Claude Code) stores nothing; other events never carry it', () => {
    const dir = dataDir();
    prompt(dir);
    expect(stop(dir, undefined)?.lastMessage).toBeNull();
    expect(stop(dir, 42)?.lastMessage).toBeNull();
    expect(lines(dir, T)).toEqual([]);
    expect(send(dir, { hook_event_name: 'Notification', last_assistant_message: "I'd recommend A." })?.lastMessage).toBeNull();
    expect(prompt(dir, { last_assistant_message: "I'd recommend A." })?.lastMessage).toBeNull();
    expect(lines(dir, T)).toEqual([]);
  });

  test('no text from the reply or the prompt is left anywhere under the data folder', () => {
    const dir = dataDir();
    prompt(dir);
    stop(dir, "I'd recommend rotating SECRET-REPLY-TOKEN-8842 today.");
    expect(lines(dir, T)).toEqual(['1']);
    const stored = everything(dir);
    expect(stored).not.toContain('SECRET-REPLY-TOKEN-8842');
    expect(stored).not.toContain('SECRET-PROMPT-TEXT');
    expect(stored).not.toContain('rotating');
  });

  test('a failed write is one error line that names no text, and the event line is still written', () => {
    const dir = dataDir();
    prompt(dir);
    fs.writeFileSync(path.join(dir, TURNS_DIR), 'a file where the folder should be');
    expect(stop(dir, "I'd recommend SECRET-REPLY-TOKEN-8842.")).not.toBeNull();
    const log = fs.readFileSync(path.join(dir, 'hook-errors.log'), 'utf8');
    expect(log).toMatch(/could not record a turn end: (EEXIST|ENOTDIR)\n$/);
    expect(log).not.toContain('SECRET');
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toContain('"hook_event_name":"Stop"');
  });

  test('the event line for a turn end is what it was before: six fields and nothing from the reply', () => {
    const dir = dataDir();
    stop(dir, "I'd recommend A.");
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).toBe(
      JSON.stringify({ session_id: 'sess-1', cwd: '/w', hook_event_name: 'Stop', notification_type: null, message: null, ts: T }) + '\n',
    );
  });
});

describe('the one-time notice', () => {
  const shownTo = (out: string | null): string | undefined => (out === null ? undefined : (JSON.parse(out) as { systemMessage?: string }).systemMessage);

  test('due once: the line goes to the user, never into the agent\'s context, and is not due again once marked', () => {
    const dir = dataDir({ noticeAt: null });
    const plan = sessionStartPlan(dir, null, false);
    expect(plan.notice).toBe(true);
    expect(JSON.parse(plan.output!)).toEqual({ systemMessage: NOTICE_LINE });
    expect(sessionStartPlan(dir, null, false).notice).toBe(true); // not marked yet: shown again, check still off
    markNoticeShown(dir, T);
    expect(sessionStartPlan(dir, null, false)).toEqual({ output: null, notice: false });
  });

  test('it follows the first-run line in the same message, and the agent still gets only its own sentence', () => {
    const dir = dataDir({ noticeAt: null });
    const both = sessionStartPlan(dir, 'The board is running.', true);
    expect(shownTo(both.output)).toBe(`The board is running.\n${NOTICE_LINE}`);
    expect(JSON.stringify(JSON.parse(both.output!).hookSpecificOutput)).not.toContain('last message');
  });

  test('not shown when the check is off or the settings file cannot be read', () => {
    for (const settings of ['{"count_plain_text": false}', '{nope']) {
      expect(sessionStartPlan(dataDir({ settings, noticeAt: null }), 'Line.', false)).toEqual({ output: JSON.stringify({ systemMessage: 'Line.' }), notice: false });
    }
  });

  test('the offers notice comes at a later session start than the first notice, once, and only then are offers noted', () => {
    const dir = dataDir({ noticeAt: null });
    const first = sessionStartPlan(dir, null, false, NOTICE_LINE, OFFERS_LINE);
    expect(first).toEqual({ output: JSON.stringify({ systemMessage: NOTICE_LINE }), notice: true }); // one notice per start
    markNoticeShown(dir, T);
    const second = sessionStartPlan(dir, 'Line.', true, NOTICE_LINE, OFFERS_LINE);
    expect(second.notice).toBe(false);
    expect(second.offersNotice).toBe(true);
    expect(shownTo(second.output)).toBe(`Line.\n${OFFERS_LINE}`);
    expect(JSON.stringify(JSON.parse(second.output!).hookSpecificOutput)).not.toContain('Want me to start');
    expect(sessionStartPlan(dir, null, false, NOTICE_LINE, OFFERS_LINE).offersNotice).toBe(true); // not marked yet: shown again
    markNoticeShown(dir, T, OFFERS_NOTICE_FILE);
    expect(sessionStartPlan(dir, null, false, NOTICE_LINE, OFFERS_LINE)).toEqual({ output: null, notice: false });
    expect(noticeShownAt(dir)).toBe(T); // the first notice's time is its own
  });

  test('the offers notice is not shown when the check is off, and says what is added and how to turn both off', () => {
    for (const settings of ['{"count_plain_text": false}', '{nope']) {
      const dir = dataDir({ settings });
      expect(sessionStartPlan(dir, null, false, NOTICE_LINE, OFFERS_LINE)).toEqual({ output: null, notice: false });
    }
    expect(offersNoticeLine('/srv/board/settings.json')).toBe(
      'The Nod Board now also checks the end of the agent\'s last message of each turn for an offer, such as "Want me to start?" or "Say the word and I\'ll start". It stores one more 1 or 0 per reply, never the text, and still does not read what you type. To turn both checks off, add "count_plain_text": false to /srv/board/settings.json.',
    );
  });

  test('with a moved data directory the line names the settings file there, and nothing else changes', () => {
    const moved = noticeLine('/srv/board/settings.json');
    expect(moved).toBe(NOTICE_LINE.replace('~/.agent-inbox/settings.json', '/srv/board/settings.json'));
    expect(noticeLine('~/.agent-inbox/settings.json')).toBe(NOTICE_LINE);
    const plan = sessionStartPlan(dataDir({ noticeAt: null }), 'Line.', false, moved);
    expect(shownTo(plan.output)).toBe(`Line.\n${moved}`);
  });

  test('the line says what is read, what is kept and how to turn it off', () => {
    expect(NOTICE_LINE).toBe(
      'The Nod Board now checks the agent\'s last message of each turn for recommendation phrases, to estimate how many choices are made in plain text. It stores a 1 or a 0 per reply, never the text, and does not read what you type. To turn it off, add "count_plain_text": false to ~/.agent-inbox/settings.json.',
    );
  });
});

describe('what the board and the status command are given', () => {
  const inboxOf = (dir: string) => new Inbox({ dir, home: root, stateRoot: path.join(dir, 'none'), transcriptsDir: path.join(dir, 'none') });

  test('nothing until checking has begun, then the windows and whether the agent is already asked to use the tool', () => {
    expect(plainTextJson(dataDir({ noticeAt: null }), T)).toBeNull();
    expect(plainTextJson(dataDir({ settings: '{"count_plain_text": false}' }), T)).toBeNull();
    const dir = dataDir({ settings: '{"ask_through_question_tool": true}', noticeAt: T - 2 * DAY });
    noteTurnEnd(dir, T, true);
    noteTurnEnd(dir, T, false);
    expect(plainTextJson(dir, T)).toEqual({ unreadable: false, since: T - 2 * DAY, last: { checked: 2, matched: 1 }, before: null, asking: true });
    expect(plainTextJson(dataDir(), T)).toMatchObject({ asking: false, last: { checked: 0, matched: 0 } });
  });

  test('the judgment payload names the settings file only when it is not the default one', () => {
    const dir = dataDir();
    const shown = settingsFileShown(dir, process.env.HOME || os.homedir());
    expect(shown).not.toBe(DEFAULT_SETTINGS_SHOWN);
    expect(judgmentJson(inboxOf(dir), '1.2.3', T).settings_file).toBe(shown);
  });

  test('the judgment payload carries it only then, and an unreadable day never costs the exact numbers', () => {
    const fresh = dataDir({ noticeAt: null });
    expect('plain_text' in judgmentJson(inboxOf(fresh), '1.2.3', T)).toBe(false);
    const broken = dataDir();
    fs.mkdirSync(dayFile(broken, T), { recursive: true });
    const j = judgmentJson(inboxOf(broken), '1.2.3', T);
    expect(j.plain_text).toEqual({ unreadable: true });
    expect(j.questions).toBe(0);
    expect(j.version).toBe('1.2.3');
  });

  test('offers reach the board and the status line with their own counts, and only after their notice', () => {
    const dir = dataDir({ noticeAt: T - 20 * DAY });
    noteTurnEnd(dir, T, true);
    noteTurnEnd(dir, T - 9 * DAY, false);
    expect('offers' in plainTextJson(dir, T)!).toBe(false);
    expect(plainTextStatus(dir, T)).toBe('plain-text check: on since 2026-10-27; about 1 of 1 replies in the last 7 days');
    markNoticeShown(dir, T - 2 * DAY, OFFERS_NOTICE_FILE);
    expect(plainTextStatus(dir, T)).toBe('plain-text check: on since 2026-10-27; about 1 of 1 replies in the last 7 days; offers: none checked yet');
    noteTurnEnd(dir, T, true, OFFERS_DIR);
    noteTurnEnd(dir, T, false, OFFERS_DIR);
    noteTurnEnd(dir, T - DAY, true, OFFERS_DIR);
    expect(plainTextJson(dir, T)).toMatchObject({
      last: { checked: 1, matched: 1 },
      before: { checked: 1, matched: 0 },
      offers: { since: T - 2 * DAY, last: { checked: 3, matched: 2 }, before: null },
    });
    expect(turnWindows(dir, T)).toEqual({ since: T - 20 * DAY, last: { checked: 1, matched: 1 }, before: { checked: 1, matched: 0 } }); // the first store is untouched
    expect(plainTextStatus(dir, T)).toBe('plain-text check: on since 2026-10-27; about 1 of 1 replies in the last 7 days; offers: about 2 of 3');
    expect(judgmentJson(inboxOf(dir), '1.2.3', T).plain_text).toMatchObject({ offers: { last: { checked: 3, matched: 2 } } });
  });

  test('the status line names each state', () => {
    expect(plainTextStatus(dataDir({ settings: '{"count_plain_text": false}' }), T)).toBe('plain-text check: off');
    const unreadable = dataDir({ settings: '{nope' });
    expect(plainTextStatus(unreadable, T)).toBe(`plain-text check: off; ${path.join(unreadable, SETTINGS_FILE)} could not be read`);
    expect(plainTextStatus(dataDir({ noticeAt: null }), T)).toBe('plain-text check: starts after the notice at the next session start');
    const dir = dataDir({ noticeAt: T - 2 * DAY });
    expect(plainTextStatus(dir, T)).toBe('plain-text check: on since 2026-11-14; no replies checked in the last 7 days');
    noteTurnEnd(dir, T, true);
    noteTurnEnd(dir, T, false);
    expect(plainTextStatus(dir, T)).toBe('plain-text check: on since 2026-11-14; about 1 of 2 replies in the last 7 days');
    fs.rmSync(dayFile(dir, T));
    fs.mkdirSync(dayFile(dir, T));
    expect(plainTextStatus(dir, T)).toBe('plain-text check: could not be read');
  });
});

describe('the real hook process at a turn end', () => {
  test('a 5,000-character reply is checked within the hook\'s usual time (reported; loose bound)', () => {
    const dir = dataDir();
    const env = { PATH: '/usr/bin:/bin', HOME: root, AGENT_INBOX_DIR: dir };
    const HOOK = path.join(import.meta.dir, 'hook.ts');
    const run = (payload: Record<string, unknown>) => Bun.spawnSync([process.execPath, HOOK], { stdin: Buffer.from(JSON.stringify({ session_id: 'sess-timing', cwd: '/w', ...payload })), env });
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    const reply = 'All done. '.repeat(499) + "I'd recommend merging.";
    const N = 20;
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = Bun.nanoseconds();
      run({ hook_event_name: 'Stop', last_assistant_message: reply });
      times.push((Bun.nanoseconds() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(N / 2)];
    console.log(`hook.ts turn end over ${N} runs: median ${median.toFixed(1)}ms, p90 ${times[Math.floor(N * 0.9)].toFixed(1)}ms`);
    expect(fs.readFileSync(path.join(dir, TURNS_DIR, dayKey(Date.now())), 'utf8')).toBe('1\n'.repeat(N));
    expect(median).toBeLessThan(200);
  });
});
