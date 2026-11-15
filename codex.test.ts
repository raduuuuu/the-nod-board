import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAIN_AGENT } from './attrs';
import { CODEX, CODEX_ARG, CODEX_QUESTION_TOOL, codexObservations, codexResult } from './codex';
import { APP_NAME } from './inbox';
import { ASKED, ATTRIBUTES, OUTCOMES_FILE, boardData, readObservations, readQuestions } from './outcomes';

const REPO = import.meta.dir;
const HOOK = path.join(REPO, 'hook.ts');
const RUN = path.join(REPO, 'hooks', 'run.sh');
const HOME = '/home/user';
const NOW = Date.parse('2026-11-15T19:26:00.000Z');
const tmps: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-codex-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/**
 * The payload shapes measured on Codex CLI 0.163.0, with made-up content. `answered()` is NOT
 * measured: it follows other tools' notes on the answered shape (see codex.ts).
 */
const questions = [
  {
    id: 'colour',
    header: 'Colour',
    question: 'Which colour should we use for this made-up design?',
    options: [
      { label: 'Blue (Recommended)', description: 'SECRET_OPTION_TEXT calm' },
      { label: 'Orange', description: 'SECRET_OPTION_TEXT energetic' },
    ],
  },
];
const common = { session_id: 'codex-sess-1', transcript_path: '/home/user/.codex/sessions/rollout.jsonl', cwd: '/home/user/project', model: 'gpt-test-1', permission_mode: 'plan', turn_id: 'turn-1' };
const pre = (id = 'call_1', qs: unknown = questions) => ({ ...common, hook_event_name: 'PreToolUse', tool_name: CODEX_QUESTION_TOOL, tool_use_id: id, tool_input: { questions: qs } });
const post = (response: unknown, id = 'call_1', qs: unknown = questions) => ({ ...pre(id, qs), hook_event_name: 'PostToolUse', tool_response: response });
const answered = (label: string) => JSON.stringify({ answers: { colour: { answers: [label] } } });
const kinds = (v: unknown) => codexObservations(v, NOW, HOME).map((o) => o.kind);

describe('a question asked by Codex', () => {
  test('is stored when asked, with the product, the model from the payload and the main agent', () => {
    expect(codexObservations(pre(), NOW, HOME)).toEqual([
      {
        v: 1,
        source: 'hook',
        call: 'call_1',
        pos: 0,
        kind: ASKED,
        chip: 'Colour',
        title: 'Which colour should we use for this made-up design?',
        session: 'codex-sess-1',
        project: 'project',
        askTs: NOW,
        answerTs: null,
        product: CODEX,
        agent: MAIN_AGENT,
        model: 'gpt-test-1',
      },
    ]);
  });

  test('the measured unanswered result, an empty answers object in a JSON string, is a dismissal and never an override', () => {
    expect(kinds(post('{"answers":{}}'))).toEqual(['DISMISSED']);
    expect(kinds(post({ answers: {} }))).toEqual(['DISMISSED']);
  });

  test('an answered question is classified by its label: recommended, another option, or typed text', () => {
    expect(kinds(post(answered('Blue (Recommended)')))).toEqual(['AGREED']);
    expect(kinds(post(answered('Orange')))).toEqual(['OVERRODE_OPTION']);
    expect(kinds(post(answered('something I typed')))).toEqual(['OVERRODE_TYPED']);
  });

  test('the plainer answer shapes are read too, keyed by id or by the question text', () => {
    expect(kinds(post(JSON.stringify({ answers: { colour: 'Blue (Recommended)' } })))).toEqual(['AGREED']);
    expect(kinds(post({ answers: { colour: ['Orange'] } }))).toEqual(['OVERRODE_OPTION']);
    expect(kinds(post({ answers: { [questions[0].question]: 'Blue (Recommended)' } }))).toEqual(['AGREED']);
  });

  test('a result this reader cannot read is "could not be read", never a guess', () => {
    for (const odd of ['not json', '{"result":"ok"}', 42, null, '{"answers":{"colour":{"picked":3}}}', '{"answers":{"other-id":"Blue (Recommended)"}}']) {
      expect(kinds(post(odd))).toEqual(['UNDECODED']);
    }
  });

  test('the answer line carries no attribute, no option text and no answer', () => {
    const [line] = codexObservations(post(answered('Orange')), NOW, HOME);
    expect(ATTRIBUTES.filter((k) => k in line)).toEqual([]);
    expect(JSON.stringify(line)).not.toContain('SECRET_OPTION_TEXT');
    expect(Object.values(line)).not.toContain('Orange');
    expect([line.askTs, line.answerTs]).toEqual([null, NOW]);
  });

  test('two questions in one call keep their own outcome; a question with no marked recommendation is excluded', () => {
    const two = [
      questions[0],
      { id: 'size', header: 'Size', question: 'Which size?', options: [{ label: 'Small', description: 'd' }, { label: 'Large', description: 'd' }] },
    ];
    const response = JSON.stringify({ answers: { colour: { answers: ['Orange'] }, size: { answers: ['Large'] } } });
    expect(codexObservations(post(response, 'call_2', two), NOW, HOME).map((o) => [o.pos, o.kind])).toEqual([
      [0, 'OVERRODE_OPTION'],
      [1, 'EXCLUDED_NO_REC'],
    ]);
  });

  test('questions that cannot be read leave a trace once the tool returns; anything that is not the question tool leaves nothing', () => {
    expect(kinds(pre('c', 'not a list'))).toEqual([]);
    expect(kinds(post('{"answers":{}}', 'c', 'not a list'))).toEqual(['UNDECODED']);
    expect(kinds({ ...pre(), tool_name: 'Bash' })).toEqual([]);
    expect(kinds({ ...pre(), hook_event_name: 'Stop' })).toEqual([]);
    expect(kinds({ ...pre(), tool_use_id: undefined })).toEqual([]);
    expect(kinds('nonsense')).toEqual([]);
  });

  test('the answer reader on its own: empty is "nobody answered", a missing answer leaves the question out', () => {
    const qs = [{ question: 'Q1?', header: '', labels: ['A (Recommended)', 'B'], multiSelect: false }, { question: 'Q2?', header: '', labels: ['C (Recommended)', 'D'], multiSelect: false }];
    expect(codexResult(qs, ['q1', 'q2'], '{"answers":{}}')).toEqual({ kind: 'rejected' });
    expect(codexResult(qs, ['q1', 'q2'], '{"answers":{"q1":{"answers":["B"]}}}')).toEqual({ kind: 'answers', answers: { 'Q1?': 'B' } });
    expect(codexResult(qs, [null, null], '{"answers":{"Q2?":"D"}}')).toEqual({ kind: 'answers', answers: { 'Q2?': 'D' } });
  });
});

describe('through the real hook, called the way Codex calls it', () => {
  const run = (payload: unknown, event: string, dir: string, viaLauncher = false) =>
    Bun.spawnSync(viaLauncher ? ['/bin/sh', RUN, event, CODEX_ARG] : [process.execPath, HOOK, event, CODEX_ARG], {
      stdin: Buffer.from(JSON.stringify(payload)),
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.dirname(dir), AGENT_INBOX_DIR: dir, AGENT_INBOX_PORT: '4996' },
    });

  test('asked then answered becomes one row for Codex, split by product and by model, and asks for no import', () => {
    const dir = path.join(tmp(), 'inbox');
    for (const [payload, event] of [[pre(), 'PreToolUse'], [post(answered('Blue (Recommended)')), 'PostToolUse']] as const) {
      const r = run(payload, event, dir, event === 'PreToolUse'); // once through the launcher, once direct
      expect([r.exitCode, r.stdout.toString()]).toEqual([0, '']);
    }
    const [row] = readQuestions(dir, { now: Date.now() }).rows;
    expect([row.outcome, row.product, row.model, row.agent, row.skill]).toEqual(['AGREED', CODEX, 'gpt-test-1', MAIN_AGENT, undefined]);
    const board = boardData(dir, { now: Date.now() });
    expect(board.totals.splits.product).toEqual([{ name: CODEX, agreed: 1, answered: 1, medianMs: expect.any(Number), timed: 1 }]);
    expect(board.totals.splits.model.map((r) => r.name)).toEqual(['gpt-test-1']);
    expect(board.needsImport).toBe(0);
  });

  test('only the store is written: no session event, no attrs state, no option text, and no server is started', () => {
    const dir = path.join(tmp(), 'inbox');
    run(pre(), 'PreToolUse', dir);
    run(post('{"answers":{}}'), 'PostToolUse', dir);
    // Even a session start, should Codex ever be made to send one, must do nothing here.
    const start = run({ ...common, hook_event_name: 'SessionStart', source: 'startup' }, 'SessionStart', dir);
    expect([start.exitCode, start.stdout.toString()]).toEqual([0, '']);
    expect(fs.readdirSync(dir).sort()).toEqual([OUTCOMES_FILE]);
    expect(fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8')).not.toContain('SECRET_OPTION_TEXT');
    expect(readObservations(dir).observations.map((o) => o.kind)).toEqual([ASKED, 'DISMISSED']);
  });

  test('bad input still exits 0 and prints nothing', () => {
    const dir = path.join(tmp(), 'inbox');
    const r = Bun.spawnSync([process.execPath, HOOK, 'PreToolUse', CODEX_ARG], { stdin: Buffer.from('{not json'), env: { PATH: '/usr/bin:/bin', HOME: path.dirname(dir), AGENT_INBOX_DIR: dir } });
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, '']);
    expect(fs.readFileSync(path.join(dir, 'hook-errors.log'), 'utf8')).toContain('unparsable Codex hook payload');
  });
});

describe('the Codex plugin files', () => {
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));

  test('the two manifests name the same plugin at the same version', () => {
    const claude = read('.claude-plugin/plugin.json');
    const codex = read('.codex-plugin/plugin.json');
    expect([codex.name, codex.version, codex.license]).toEqual([APP_NAME, claude.version, claude.license]);
    expect(codex.hooks).toBe('./hooks/codex-hooks.json');
    expect(fs.existsSync(path.join(REPO, codex.hooks))).toBe(true);
  });

  test('Codex registers the question tool only, before and after, through the launcher with the codex argument', () => {
    const hooks = read('hooks/codex-hooks.json').hooks as Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]>;
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse']);
    for (const [event, entries] of Object.entries(hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0].matcher).toBe(`^${CODEX_QUESTION_TOOL}$`);
      expect(entries[0].hooks).toEqual([{ type: 'command', command: `"\${PLUGIN_ROOT}/hooks/run.sh" ${event} ${CODEX_ARG}`, timeout: 5 }]);
    }
  });
});
