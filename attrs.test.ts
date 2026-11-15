import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAIN_AGENT, NO_SKILL, STATE_DIR, STATE_MAX_AGE_MS, at, fromTranscript, note, skillName, type AttrEvent } from './attrs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-attrs-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const freshDir = () => path.join(tmp, `d${seq++}`);

const ev = (event: string, extra: Partial<AttrEvent> = {}): AttrEvent => ({
  event,
  sessionId: 'sess-1',
  agentId: null,
  agentType: null,
  toolName: null,
  skill: null,
  commandName: null,
  model: null,
  ...extra,
});
const skillCall = (skill: string, extra: Partial<AttrEvent> = {}) => ev('PreToolUse', { toolName: 'Skill', skill, ...extra });
const typed = (commandName: string, extra: Partial<AttrEvent> = {}) => ev('UserPromptExpansion', { commandName, ...extra });
const ask = (extra: Partial<AttrEvent> = {}) => ev('PreToolUse', { toolName: 'AskUserQuestion', ...extra });

describe('names', () => {
  test('a plugin prefix and a leading slash are dropped, as transcripts write the name', () => {
    expect(['probe:probe-skill', '/plan-review', 'qa', '  a:b:c  '].map(skillName)).toEqual(['probe-skill', 'plan-review', 'qa', 'c']);
    expect([skillName(''), skillName('plugin:')]).toEqual([null, null]);
    expect(skillName('x'.repeat(200))).toHaveLength(80);
  });
});

describe('the skill: set by a skill call or a typed command, cleared when the turn ends', () => {
  test('a skill the agent started owns the questions that follow in the turn', () => {
    const dir = freshDir();
    note(dir, typed('warm-up')); // typed commands are known to reach this hook
    note(dir, ev('Stop'));
    note(dir, skillCall('probe:plan-review'));
    expect(at(dir, ask()).skill).toBe('plan-review');
    expect(at(dir, ask()).skill).toBe('plan-review'); // asking does not use it up
  });

  test('a typed command owns them too, and a later one replaces an earlier one', () => {
    const dir = freshDir();
    note(dir, typed('gstack:qa'));
    expect(at(dir, ask()).skill).toBe('qa');
    note(dir, skillCall('review'));
    expect(at(dir, ask()).skill).toBe('review');
  });

  test('the end of the turn ends the skill; a prompt does not', () => {
    const dir = freshDir();
    note(dir, typed('qa'));
    note(dir, ev('UserPromptSubmit')); // a prompt, typed or not, changes nothing
    expect(at(dir, ask()).skill).toBe('qa');
    note(dir, ev('Stop'));
    expect(at(dir, ask()).skill).toBe(NO_SKILL);
  });

  test('"no skill" is claimed only once typed commands are known to reach the hook', () => {
    const dir = freshDir();
    expect(at(dir, ask()).skill).toBeUndefined(); // a typed command could have been missed: not known
    note(dir, typed('qa', { sessionId: 'another-session' }));
    expect(at(dir, ask()).skill).toBe(NO_SKILL);
  });

  test('two agents of one session keep their own skill, and one stopping leaves the other', () => {
    const dir = freshDir();
    note(dir, typed('main-skill'));
    note(dir, skillCall('sub-skill', { agentId: 'agent-a', agentType: 'Explore' }));
    expect(at(dir, ask()).skill).toBe('main-skill');
    expect(at(dir, ask({ agentId: 'agent-a', agentType: 'Explore' }))).toEqual({ agent: 'Explore', skill: 'sub-skill' });
    note(dir, ev('SubagentStop', { agentId: 'agent-a', agentType: 'Explore' }));
    expect(at(dir, ask({ agentId: 'agent-a', agentType: 'Explore' })).skill).toBe(NO_SKILL);
    expect(at(dir, ask()).skill).toBe('main-skill');
    note(dir, ev('Stop'));
    expect(at(dir, ask()).skill).toBe(NO_SKILL);
  });

  test('two sessions never see each other', () => {
    const dir = freshDir();
    note(dir, typed('qa', { sessionId: 's1' }));
    expect(at(dir, ask({ sessionId: 's2' })).skill).toBe(NO_SKILL);
  });

  test('two processes writing for two agents of one session at once: both values survive', async () => {
    const dir = freshDir();
    const script = `import { note } from ${JSON.stringify(path.join(import.meta.dir, 'attrs.ts'))};
      const [dir, agent, skill] = process.argv.slice(2);
      for (let i = 0; i < 200; i++) note(dir, { event: 'PreToolUse', sessionId: 's', agentId: agent === 'main' ? null : agent, agentType: null, toolName: 'Skill', skill, commandName: null, model: null });`;
    const file = path.join(tmp, `writer-${seq++}.ts`);
    fs.writeFileSync(file, script);
    const run = (agent: string, skill: string) => Bun.spawn([process.execPath, file, dir, agent, skill], { stdout: 'ignore', stderr: 'pipe' });
    const procs = [run('main', 'one'), run('agent-b', 'two'), run('main', 'one'), run('agent-b', 'two')];
    for (const p of procs) expect(await p.exited).toBe(0);
    expect(at(dir, ask({ sessionId: 's' })).skill).toBe('one');
    expect(at(dir, ask({ sessionId: 's', agentId: 'agent-b' })).skill).toBe('two');
    expect(fs.readdirSync(path.join(dir, STATE_DIR, 's')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('the model: per session, kept until it changes', () => {
  test('from the session start when it says so, then from a switch; the end of a turn does not clear it', () => {
    const dir = freshDir();
    expect(at(dir, ask()).model).toBeUndefined();
    note(dir, ev('SessionStart', { model: 'claude-test-1' }));
    note(dir, ev('Stop'));
    expect(at(dir, ask()).model).toBe('claude-test-1');
    note(dir, ev('PostModelSwitch', { model: 'claude-test-2' }));
    expect(at(dir, ask()).model).toBe('claude-test-2');
    expect(at(dir, ask({ agentId: 'agent-a' })).model).toBe('claude-test-2'); // read for a subagent too; the import corrects it
  });

  test('a session start that does not name the model leaves it unknown', () => {
    const dir = freshDir();
    note(dir, ev('SessionStart'));
    expect(at(dir, ask()).model).toBeUndefined();
  });
});

describe('the agent', () => {
  test('the subagent type when a subagent asks, "main agent" otherwise', () => {
    const dir = freshDir();
    expect(at(dir, ask()).agent).toBe(MAIN_AGENT);
    expect(at(dir, ask({ agentId: 'a1', agentType: 'Explore' })).agent).toBe('Explore');
  });
});

describe('state on disk', () => {
  test('the session end removes the session state; other sessions stay', () => {
    const dir = freshDir();
    note(dir, typed('qa', { sessionId: 's1' }));
    note(dir, typed('qa', { sessionId: 's2' }));
    note(dir, ev('SessionEnd', { sessionId: 's1' }));
    expect(fs.readdirSync(path.join(dir, STATE_DIR)).filter((n) => !n.startsWith('.')).sort()).toEqual(['s2']);
  });

  test('a session that never ended is removed after 7 days, at a later session start', () => {
    const dir = freshDir();
    const now = Date.now();
    note(dir, typed('qa', { sessionId: 'old' }), now);
    const old = new Date(now - STATE_MAX_AGE_MS - 60_000);
    fs.utimesSync(path.join(dir, STATE_DIR, 'old'), old, old);
    note(dir, typed('qa', { sessionId: 'new' }), now);
    note(dir, ev('SessionStart', { sessionId: 'new' }), now);
    expect(fs.readdirSync(path.join(dir, STATE_DIR)).filter((n) => !n.startsWith('.')).sort()).toEqual(['new']);
  });

  test('an id that is not a plain name gets no state and no file outside the folder', () => {
    const dir = freshDir();
    note(dir, typed('qa', { sessionId: '../../escape' }));
    note(dir, skillCall('qa', { agentId: '../x' }));
    expect(fs.existsSync(path.join(dir, STATE_DIR, 'sess-1'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '..', 'escape'))).toBe(false);
    expect(at(dir, ask({ sessionId: '../../escape' }))).toEqual({ agent: MAIN_AGENT });
  });

  test('files are private, and an event that says nothing writes nothing', () => {
    const dir = freshDir();
    for (const e of ['Notification', 'PostToolUse', 'UserPromptSubmit', 'SomethingNew']) note(dir, ev(e));
    expect(fs.existsSync(path.join(dir, STATE_DIR))).toBe(false);
    note(dir, typed('qa'));
    expect(fs.statSync(path.join(dir, STATE_DIR, 'sess-1', 'main.skill')).mode & 0o777).toBe(0o600);
  });

  test('a long value is cut', () => {
    const dir = freshDir();
    note(dir, ev('SessionStart', { model: 'm'.repeat(300) }));
    expect(at(dir, ask()).model).toHaveLength(80);
  });
});

describe('from a transcript line', () => {
  const line = (extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { model: 'claude-test-1', content: [] }, ...extra });

  test('the model, the attributed skill without its prefix, and the main agent', () => {
    expect(fromTranscript(line({ attributionSkill: 'gstack:plan-review' }))).toEqual({ model: 'claude-test-1', skill: 'plan-review', agent: MAIN_AGENT });
  });

  test('an assistant line with no attribution is Claude Code saying "no skill"', () => {
    expect(fromTranscript(line()).skill).toBe(NO_SKILL);
  });

  test("a subagent's line does not name the agent", () => {
    expect(fromTranscript(line({ isSidechain: true })).agent).toBeUndefined();
  });

  test('any other line shape says nothing at all', () => {
    expect(fromTranscript({ type: 'api-request-blob', message: { content: [] } })).toEqual({});
    expect(fromTranscript({ type: 'user', message: { content: [] } })).toEqual({});
    expect(fromTranscript(null)).toEqual({});
  });
});
