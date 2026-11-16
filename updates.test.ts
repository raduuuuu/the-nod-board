import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Inbox } from './inbox';
import { makeHandler } from './server';
import { ASK_THROUGH_QUESTION_TOOL, QUESTION_TOOL_NUDGE, sessionStartOutput, settingState } from './updates';
import { CHECK_EVERY_MS, RELEASE_MANIFEST_URL, RETRY_AFTER_MS, SETTINGS_FILE, UpdateCheck, isNewer, manifestVersion, updateSetting } from './updates';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-updates-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function dataDir(settings?: string): string {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(dir, SETTINGS_FILE), settings);
  return dir;
}
const ON = '{"check_for_updates": true}';
const manifest = (version: unknown) => JSON.stringify({ name: 'nod-board', version });

/** A fetch that records what was asked and answers from a list; never the network. */
function fake(answers: (string | Error)[]) {
  const asked: string[] = [];
  const fetchText = async (url: string) => {
    asked.push(url);
    const a = answers.shift() ?? new Error('no answer left');
    if (a instanceof Error) throw a;
    return a;
  };
  return { asked, fetchText };
}

describe('the setting', () => {
  test('off without a file, and off unless the value is the literal true', () => {
    expect(updateSetting(dataDir())).toBe('off');
    expect(updateSetting(dataDir('{}'))).toBe('off');
    expect(updateSetting(dataDir('{"check_for_updates": "true"}'))).toBe('off');
    expect(updateSetting(dataDir('{"check_for_updates": 1}'))).toBe('off');
    expect(updateSetting(dataDir(ON))).toBe('on');
  });

  test('a file that is not one JSON object is unreadable, which is not on', () => {
    expect(updateSetting(dataDir('{check'))).toBe('unreadable');
    expect(updateSetting(dataDir('[true]'))).toBe('unreadable');
    expect(updateSetting(dataDir('null'))).toBe('unreadable');
  });
});

describe('versions', () => {
  test('compared as numbers, part by part', () => {
    expect(isNewer('0.3.7', '0.3.6')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.3.6', '0.3.6')).toBe(false);
    expect(isNewer('0.3.5', '0.3.6')).toBe(false);
  });

  test('anything that is not n.n.n is never newer', () => {
    expect(isNewer('9.9', '0.3.6')).toBe(false);
    expect(isNewer('9.9.9-beta', '0.3.6')).toBe(false);
    expect(isNewer('9.9.9', 'dev')).toBe(false);
  });

  test('a manifest gives its version; other text gives nothing', () => {
    expect(manifestVersion(manifest('0.3.7'))).toBe('0.3.7');
    expect(manifestVersion(manifest('<b>9.9.9</b>'))).toBeNull();
    expect(manifestVersion(manifest(937))).toBeNull();
    expect(manifestVersion('<html>not found</html>')).toBeNull();
    expect(manifestVersion('null')).toBeNull();
    expect(manifestVersion(JSON.stringify({ version: '9.9.9', pad: 'x'.repeat(20_000) }))).toBeNull();
  });
});

describe('the check', () => {
  const T = 1_800_000_000_000;

  test('off: no request is made, whatever is asked', async () => {
    for (const settings of [undefined, '{}', '{broken']) {
      const f = fake([manifest('9.9.9')]);
      const check = new UpdateCheck(dataDir(settings), '0.3.6', f.fetchText);
      expect(check.latest(T)).toBeNull();
      await check.settled();
      expect(check.latest(T + CHECK_EVERY_MS)).toBeNull();
      expect(f.asked).toEqual([]);
    }
  });

  test('on: one request to the fixed address, and the newer version shows on the next read', async () => {
    const f = fake([manifest('0.3.7')]);
    const check = new UpdateCheck(dataDir(ON), '0.3.6', f.fetchText);
    expect(check.latest(T)).toBeNull();
    await check.settled();
    expect(check.latest(T + 5_000)).toBe('0.3.7');
    expect(f.asked).toEqual([RELEASE_MANIFEST_URL]);
  });

  test('at most once a day, however often the board is read', async () => {
    const f = fake([manifest('0.3.6'), manifest('0.3.7')]);
    const check = new UpdateCheck(dataDir(ON), '0.3.6', f.fetchText);
    check.latest(T);
    await check.settled();
    for (let t = T; t < T + CHECK_EVERY_MS; t += 3600_000) expect(check.latest(t)).toBeNull();
    expect(f.asked.length).toBe(1);
    check.latest(T + CHECK_EVERY_MS);
    await check.settled();
    expect(f.asked.length).toBe(2);
    expect(check.latest(T + CHECK_EVERY_MS + 1)).toBe('0.3.7');
  });

  test('the same or an older release is not an update', async () => {
    for (const v of ['0.3.6', '0.3.5']) {
      const check = new UpdateCheck(dataDir(ON), '0.3.6', fake([manifest(v)]).fetchText);
      check.latest(T);
      await check.settled();
      expect(check.latest(T + 1)).toBeNull();
    }
  });

  test('a failed or unusable answer is silent and tried again after an hour, not sooner', async () => {
    const f = fake([new Error('offline'), '<html>', manifest('0.3.7')]);
    const check = new UpdateCheck(dataDir(ON), '0.3.6', f.fetchText);
    check.latest(T);
    await check.settled();
    expect(check.latest(T + RETRY_AFTER_MS - 1)).toBeNull();
    expect(f.asked.length).toBe(1);
    check.latest(T + RETRY_AFTER_MS);
    await check.settled();
    check.latest(T + 2 * RETRY_AFTER_MS);
    await check.settled();
    expect(f.asked.length).toBe(3);
    expect(check.latest(T + 2 * RETRY_AFTER_MS + 1)).toBe('0.3.7');
  });

  test('turning it off forgets what was found and stops the requests', async () => {
    const dir = dataDir(ON);
    const f = fake([manifest('0.3.7')]);
    const check = new UpdateCheck(dir, '0.3.6', f.fetchText);
    check.latest(T);
    await check.settled();
    expect(check.latest(T + 1)).toBe('0.3.7');
    fs.rmSync(path.join(dir, SETTINGS_FILE));
    expect(check.latest(T + 2)).toBeNull();
    expect(check.latest(T + 2 * CHECK_EVERY_MS)).toBeNull();
    await check.settled();
    expect(f.asked.length).toBe(1);
  });
});

describe('/api/judgment', () => {
  const PORT = 4777;
  const judgment = async (dir: string, updates: UpdateCheck) => {
    const inbox = new Inbox({ dir, home: root, stateRoot: path.join(dir, 'none'), transcriptsDir: path.join(dir, 'none') });
    const handler = makeHandler(inbox, () => PORT, { version: '0.3.6', updates });
    const get = async () => (await handler(new Request(`http://127.0.0.1:${PORT}/api/judgment`, { headers: { host: `127.0.0.1:${PORT}` } }))).json() as Promise<Record<string, unknown>>;
    return get;
  };

  test('names the newer version only once it is known, and not at all when the check is off', async () => {
    const dir = dataDir(ON);
    const check = new UpdateCheck(dir, '0.3.6', fake([manifest('0.3.7')]).fetchText);
    const get = await judgment(dir, check);
    expect('latest_version' in (await get())).toBe(false);
    await check.settled();
    expect((await get()).latest_version).toBe('0.3.7');

    const offDir = dataDir();
    const off = fake([manifest('0.3.7')]);
    const getOff = await judgment(offDir, new UpdateCheck(offDir, '0.3.6', off.fetchText));
    expect('latest_version' in (await getOff())).toBe(false);
    expect(off.asked).toEqual([]);
  });
});

describe('asking the agent to use the question tool', () => {
  test('its own setting, off until the literal true, and independent of the update check', () => {
    expect(settingState(dataDir(), ASK_THROUGH_QUESTION_TOOL)).toBe('off');
    expect(settingState(dataDir(ON), ASK_THROUGH_QUESTION_TOOL)).toBe('off');
    expect(settingState(dataDir('{"ask_through_question_tool": "yes"}'), ASK_THROUGH_QUESTION_TOOL)).toBe('off');
    expect(settingState(dataDir('{broken'), ASK_THROUGH_QUESTION_TOOL)).toBe('unreadable');
    const dir = dataDir('{"ask_through_question_tool": true}');
    expect(settingState(dir, ASK_THROUGH_QUESTION_TOOL)).toBe('on');
    expect(updateSetting(dir)).toBe('off');
  });

  test('off: session start prints what it printed before, a line for the user or nothing', () => {
    expect(sessionStartOutput(null, false)).toBeNull();
    expect(JSON.parse(sessionStartOutput('The board is running', false)!)).toEqual({ systemMessage: 'The board is running' });
  });

  test('on: one fixed sentence goes to the agent, beside the line for the user when there is one', () => {
    const context = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: QUESTION_TOOL_NUDGE } };
    expect(JSON.parse(sessionStartOutput(null, true)!)).toEqual(context);
    expect(JSON.parse(sessionStartOutput('The board is running', true)!)).toEqual({ systemMessage: 'The board is running', ...context });
    expect(QUESTION_TOOL_NUDGE).toContain('AskUserQuestion');
    expect(QUESTION_TOOL_NUDGE).toContain('(Recommended)');
  });
});
