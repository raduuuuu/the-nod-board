import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LIVE, SNAPSHOT, maybeCompact } from './inbox';
import { CONFLICT, OUTCOMES, aggregate } from './judgment';
import {
  ASKED,
  ATTRIBUTES,
  ATTRIBUTE_MAX,
  DEFAULT_PRODUCT,
  FORMAT_VERSION,
  IMPORT_RAN_FILE,
  OUTCOMES_FILE,
  SESSION_GONE_MS,
  appendNew,
  appendObservation,
  boardData,
  importHistory,
  productOf,
  readObservations,
  readQuestions,
  reconcile,
  type Observation,
  type ObservedKind,
} from './outcomes';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-outcomes-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const freshDir = () => path.join(tmp, `d${seq++}`);

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const NOW = T0 + 60_000;
const obs = (kind: ObservedKind, extra: Partial<Observation> = {}): Observation => ({
  v: FORMAT_VERSION,
  source: 'hook',
  call: 'toolu_1',
  pos: 0,
  kind,
  chip: 'Approach',
  title: 'Ship it?',
  session: 'sess-1',
  project: 'app',
  askTs: null,
  answerTs: null,
  ...extra,
});
const asked = (extra: Partial<Observation> = {}) => obs(ASKED, { askTs: T0, ...extra });
const answer = (kind: ObservedKind, extra: Partial<Observation> = {}) => obs(kind, { answerTs: T0 + 20_000, ...extra });
/** Every ordering of a short list. */
function orders<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest]));
}
const one = (list: Observation[], opts = { now: NOW }) => {
  const rows = reconcile(list, opts);
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe('the file', () => {
  test('append and read back; the line holds exactly the stored fields, in a private file', () => {
    const dir = freshDir();
    const a = asked();
    const b = answer('AGREED');
    appendObservation(dir, a);
    appendObservation(dir, b);
    expect(readObservations(dir)).toEqual({ observations: [a, b], unreadable: 0 });
    const file = path.join(dir, OUTCOMES_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    expect(Object.keys(first)).toEqual(['v', 'source', 'call', 'pos', 'kind', 'chip', 'title', 'session', 'project', 'askTs', 'answerTs']);
  });

  test('a field outside the stored set never reaches the file', () => {
    const dir = freshDir();
    const leaky = { ...answer('OVERRODE_TYPED'), answer: 'my typed secret', options: ['A', 'B'] } as Observation;
    appendObservation(dir, leaky);
    appendNew(dir, [{ ...leaky, pos: 1 } as Observation]);
    const text = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8');
    expect(text).not.toContain('my typed secret');
    expect(text).not.toContain('options');
  });

  test('no file yet is an empty store; lines of another shape or version are counted, not used', () => {
    const dir = freshDir();
    expect(readObservations(dir)).toEqual({ observations: [], unreadable: 0 });
    fs.mkdirSync(dir, { recursive: true });
    const good = JSON.stringify(asked());
    fs.writeFileSync(
      path.join(dir, OUTCOMES_FILE),
      [good, 'not json', JSON.stringify({ ...asked(), v: 2 }), JSON.stringify({ ...asked(), kind: 'MAYBE' }), JSON.stringify({ ...asked(), pos: -1 }), good.slice(0, 40)].join('\n'),
    );
    const r = readObservations(dir);
    expect(r.observations).toHaveLength(1);
    expect(r.unreadable).toBe(5);
  });
});

describe('reconcile', () => {
  test('asked then answered is one row with the time between them, in either arrival order', () => {
    for (const list of orders([asked(), answer('AGREED')])) {
      expect(one(list)).toEqual({
        call: 'toolu_1',
        pos: 0,
        outcome: 'AGREED',
        inferred: false,
        chip: 'Approach',
        title: 'Ship it?',
        session: 'sess-1',
        project: 'app',
        askTs: T0,
        elapsedMs: 20_000,
      });
    }
  });

  test('a later import supplies an answer the hook missed, and an undecoded hook result yields to it', () => {
    const imported = answer('OVERRODE_OPTION', { source: 'import', askTs: T0 });
    for (const list of orders([asked(), imported])) expect(one(list).outcome).toBe('OVERRODE_OPTION');
    for (const list of orders([asked(), answer('UNDECODED'), imported])) expect(one(list).outcome).toBe('OVERRODE_OPTION');
  });

  test('the same answer seen by the hook and the import is one row', () => {
    const rows = reconcile([asked(), answer('AGREED'), answer('AGREED', { source: 'import', askTs: T0 })], { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('AGREED');
  });

  test('two different observed answers are unreadable, in every order', () => {
    for (const list of orders([asked(), answer('AGREED'), answer('OVERRODE_OPTION', { source: 'import' })])) {
      const row = one(list);
      expect(row.outcome).toBe('UNDECODED');
      expect(row.elapsedMs).toBeNull();
    }
  });

  test('a conflict from the import outranks a matching hook answer, in every order', () => {
    for (const list of orders([asked(), answer('AGREED'), obs(CONFLICT, { source: 'import', askTs: T0 })])) {
      expect(one(list).outcome).toBe('UNDECODED');
    }
  });

  test('a call with two questions keeps two rows with their own outcomes, from both sources', () => {
    const list = [
      asked({ pos: 0 }),
      asked({ pos: 1, title: 'Second?' }),
      answer('AGREED', { pos: 0 }),
      answer('OVERRODE_TYPED', { pos: 1, title: 'Second?' }),
      answer('AGREED', { pos: 0, source: 'import', askTs: T0 }),
      answer('OVERRODE_TYPED', { pos: 1, title: 'Second?', source: 'import', askTs: T0 }),
    ];
    for (const order of [list, [...list].reverse()]) {
      const rows = reconcile(order, { now: NOW });
      expect(rows.map((r) => [r.pos, r.outcome, r.elapsedMs])).toEqual([
        [0, 'AGREED', 20_000],
        [1, 'OVERRODE_TYPED', 20_000],
      ]);
      const totals = aggregate(rows);
      expect(totals.overall).toEqual({ agreed: 1, answered: 2 });
      expect(totals.calls).toBe(1);
      expect(totals.timing.n).toBe(1); // once per call, not once per question
    }
  });

  test('an excluded question stays excluded whether or not it was answered', () => {
    expect(one([asked(), obs('EXCLUDED_MULTI')]).outcome).toBe('EXCLUDED_MULTI');
    expect(one([asked(), answer('EXCLUDED_NO_REC')]).outcome).toBe('EXCLUDED_NO_REC');
  });

  test('every stored kind reconciles to a member of OUTCOMES', () => {
    for (const kind of [...OUTCOMES, ASKED, CONFLICT] as ObservedKind[]) {
      expect(OUTCOMES).toContain(one([obs(kind, { askTs: T0 })]).outcome);
    }
  });
});

describe('dismissal is inferred from the session moving on', () => {
  test('asked and nothing since: unanswered', () => {
    const row = one([asked()]);
    expect([row.outcome, row.inferred]).toEqual(['UNANSWERED', false]);
  });

  test('a later prompt, Stop or SessionEnd in the session: dismissed, marked inferred', () => {
    const row = one([asked()], { now: NOW, movedOnAt: (s) => (s === 'sess-1' ? T0 + 17_000 : null) });
    expect([row.outcome, row.inferred]).toEqual(['DISMISSED', true]);
  });

  test('an event before the question, or in another session, does not count', () => {
    expect(one([asked()], { now: NOW, movedOnAt: () => T0 - 1 }).outcome).toBe('UNANSWERED');
    expect(one([asked()], { now: NOW, movedOnAt: (s) => (s === 'other' ? T0 + 5_000 : null) }).outcome).toBe('UNANSWERED');
  });

  test('a later question in the same session means the earlier one was left behind', () => {
    const rows = reconcile([asked(), asked({ call: 'toolu_2', askTs: T0 + 30_000 })], { now: NOW });
    expect(rows.map((r) => [r.call, r.outcome, r.inferred])).toEqual([
      ['toolu_1', 'DISMISSED', true],
      ['toolu_2', 'UNANSWERED', false],
    ]);
  });

  test('no trace of the session for 7 days: dismissed; one millisecond less: still unanswered', () => {
    expect(one([asked()], { now: T0 + SESSION_GONE_MS + 1 }).outcome).toBe('DISMISSED');
    expect(one([asked()], { now: T0 + SESSION_GONE_MS }).outcome).toBe('UNANSWERED');
  });

  test('an inferred dismissal gives way to an answer that arrives later', () => {
    const movedOn = { now: NOW, movedOnAt: () => T0 + 17_000 };
    expect(one([asked()], movedOn).outcome).toBe('DISMISSED');
    const row = one([asked(), answer('AGREED', { source: 'import', askTs: T0 })], movedOn);
    expect([row.outcome, row.inferred]).toEqual(['AGREED', false]);
  });

  test('a rejection recorded in a transcript is observed, not inferred', () => {
    const row = one([asked(), obs('DISMISSED', { source: 'import', askTs: T0, answerTs: T0 + 9_000 })]);
    expect([row.outcome, row.inferred, row.elapsedMs]).toEqual(['DISMISSED', false, null]);
  });
});

describe('appendNew (the import path)', () => {
  test('a second run with the same observations adds nothing', () => {
    const dir = freshDir();
    const batch = [asked({ source: 'import' }), answer('AGREED', { source: 'import', askTs: T0 })];
    expect(appendNew(dir, batch)).toBe(2);
    expect(appendNew(dir, batch)).toBe(0);
    expect(appendNew(dir, [...batch, ...batch])).toBe(0);
    expect(readObservations(dir).observations).toHaveLength(2);
  });

  test('a question the hook only saw being asked gets its answer from a later import', () => {
    const dir = freshDir();
    appendObservation(dir, asked());
    const movedOn = { now: NOW, movedOnAt: () => T0 + 17_000 };
    expect(readQuestions(dir, movedOn).rows[0].outcome).toBe('DISMISSED');
    expect(appendNew(dir, [answer('OVERRODE_OPTION', { source: 'import', askTs: T0 })])).toBe(1);
    expect(readQuestions(dir, movedOn).rows[0].outcome).toBe('OVERRODE_OPTION');
  });

  test('importing an unfinished session and then the finished one keeps the answer', () => {
    const dir = freshDir();
    appendNew(dir, [asked({ source: 'import' })]);
    appendNew(dir, [asked({ source: 'import' }), answer('AGREED', { source: 'import', askTs: T0 })]);
    const { rows, unreadable } = readQuestions(dir, { now: NOW });
    expect(unreadable).toBe(0);
    expect(rows.map((r) => r.outcome)).toEqual(['AGREED']);
  });
});

describe('the index through the store', () => {
  test('3 agreed, 1 other option, 1 typed, 1 dismissed, 1 unanswered, 1 multi-select is 3 of 5', () => {
    const dir = freshDir();
    const kinds: ObservedKind[] = ['AGREED', 'AGREED', 'AGREED', 'OVERRODE_OPTION', 'OVERRODE_TYPED', 'EXCLUDED_MULTI'];
    kinds.forEach((kind, i) => {
      const call = `toolu_${i}`;
      appendObservation(dir, asked({ call, askTs: T0 + i * 1000, title: `Q${i}?` }));
      appendObservation(dir, answer(kind, { call, answerTs: T0 + i * 1000 + 5_000, title: `Q${i}?` }));
    });
    appendObservation(dir, asked({ call: 'toolu_dismissed', askTs: T0 + 10_000, session: 'sess-2' }));
    appendObservation(dir, asked({ call: 'toolu_open', askTs: T0 + 11_000, session: 'sess-3' }));
    const { rows } = readQuestions(dir, { now: NOW, movedOnAt: (s) => (s === 'sess-2' ? T0 + 12_000 : null) });
    const totals = aggregate(rows);
    expect(totals.overall).toEqual({ agreed: 3, answered: 5 });
    expect(totals.counts).toMatchObject({ DISMISSED: 1, UNANSWERED: 1, EXCLUDED_MULTI: 1, UNDECODED: 0 });
    expect(totals.questions).toBe(8);
    expect(totals.overrides.map((o) => o.title)).toEqual(['Q4?', 'Q3?']);
  });
});

describe('history and session-event compaction', () => {
  test('compacting events.jsonl leaves every stored outcome in place', async () => {
    const dir = freshDir();
    appendObservation(dir, asked());
    appendObservation(dir, answer('AGREED'));
    const before = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8');
    const event = { session_id: 'sess-1', cwd: '/x', hook_event_name: 'Stop', notification_type: null, message: null, ts: T0 };
    fs.writeFileSync(path.join(dir, LIVE), (JSON.stringify(event) + '\n').repeat(50));
    expect(await maybeCompact(dir, { thresholdBytes: 1, graceMs: 0, sleep: async () => {}, now: () => NOW })).toBe(true);
    expect(fs.existsSync(path.join(dir, SNAPSHOT))).toBe(true);
    expect(fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8')).toBe(before);
    expect(readQuestions(dir, { now: NOW }).rows.map((r) => r.outcome)).toEqual(['AGREED']);
  });
});

describe('importHistory (past sessions from transcripts)', () => {
  // Synthetic transcript lines, in the shapes judgment.test.ts covers in detail.
  const HOME = '/Users/someone';
  const REC = 'Do it (Recommended)';
  const question = (text: string, extra: Record<string, unknown> = {}) => ({
    question: text,
    header: 'Approach',
    options: [{ label: REC, description: 'SECRET_OPTION_TEXT' }, { label: 'Skip it', description: 'd' }],
    multiSelect: false,
    ...extra,
  });
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const use = (id: string, qs: unknown[], ms = 0, cwd: string | null = '/Users/someone/Developer/app') => ({
    type: 'assistant',
    timestamp: at(ms),
    ...(cwd ? { cwd } : {}),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: qs } }] },
  });
  const answered = (id: string, qs: unknown[], answers: Record<string, string>, ms = 30_000) => ({
    type: 'user',
    timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] },
    toolUseResult: { questions: qs, answers, annotations: {} },
  });
  const rejected = (id: string, ms = 9_000) => ({
    type: 'user',
    timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "The user doesn't want to proceed with this tool use." }] },
    toolUseResult: 'User rejected tool use',
  });
  const transcripts = (files: Record<string, unknown[]>) => {
    const root = freshDir();
    for (const [rel, lines] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
    }
    return root;
  };
  const q1 = question('Ship it?\nSECRET_SECOND_LINE');
  const q2 = question('Rename it?');

  test('imports each question once, reports counts, and a second run adds nothing', async () => {
    const root = transcripts({
      '-Users-someone-Developer-app/s1.jsonl': [
        use('toolu_a', [q1, q2], 0),
        answered('toolu_a', [q1, q2], { [q1.question]: REC, 'Rename it?': 'SECRET_TYPED_ANSWER' }),
        use('toolu_b', [q2], 60_000),
        rejected('toolu_b', 69_000),
        use('toolu_c', [q2], 120_000),
      ],
    });
    const dir = freshDir();
    expect(await importHistory(dir, root, HOME)).toEqual({ files: 1, skipped: 0, unrecognizedFiles: 0, questions: 4, added: 4 });
    expect(await importHistory(dir, root, HOME)).toEqual({ files: 1, skipped: 0, unrecognizedFiles: 0, questions: 4, added: 0 });
    const { rows } = readQuestions(dir, { now: T0 + 130_000 });
    expect(rows.map((r) => [r.call, r.pos, r.outcome, r.inferred, r.elapsedMs])).toEqual([
      ['toolu_a', 0, 'AGREED', false, 30_000],
      ['toolu_a', 1, 'OVERRODE_TYPED', false, 30_000],
      ['toolu_b', 0, 'DISMISSED', false, null], // a recorded rejection is observed, not inferred
      ['toolu_c', 0, 'UNANSWERED', false, null],
    ]);
    const text = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8');
    for (const leak of ['SECRET_TYPED_ANSWER', 'SECRET_OPTION_TEXT', 'SECRET_SECOND_LINE', 'Skip it', REC]) expect(text).not.toContain(leak);
    expect(rows[0].title).toBe('Ship it?');
  });

  test('a rejected call times nothing: its excluded question carries no answer time', async () => {
    const multi = question('Pick several?', { multiSelect: true });
    const root = transcripts({ 'p/s.jsonl': [use('toolu_a', [multi, q2], 0), rejected('toolu_a', 9_000)] });
    const dir = freshDir();
    await importHistory(dir, root, HOME);
    const rows = readQuestions(dir, { now: NOW }).rows;
    expect(rows.map((r) => [r.outcome, r.elapsedMs])).toEqual([
      ['EXCLUDED_MULTI', null],
      ['DISMISSED', null],
    ]);
    expect(aggregate(rows).timing.n).toBe(0);
  });

  test('projects are named from the working directory, the same name live capture gives', async () => {
    const root = transcripts({
      '-Users-someone-Developer-app/s1.jsonl': [use('toolu_a', [q2], 0), answered('toolu_a', [q2], { 'Rename it?': REC })],
      '-Users-someone/home.jsonl': [use('toolu_h', [q2], 0, '/Users/someone'), answered('toolu_h', [q2], { 'Rename it?': REC })],
      '-Users-someone-Developer-old/s2.jsonl': [use('toolu_o', [q2], 0, null), answered('toolu_o', [q2], { 'Rename it?': REC })],
    });
    const dir = freshDir();
    await importHistory(dir, root, HOME);
    const byCall = Object.fromEntries(readQuestions(dir, { now: NOW }).rows.map((r) => [r.call, r.project]));
    expect(byCall).toEqual({ toolu_a: 'app', toolu_h: '(home directory)', toolu_o: 'Developer-old' }); // no cwd on the line: the folder name
  });

  test('importing an open session, then again after it was answered, ends with the answer', async () => {
    const dir = freshDir();
    const open = transcripts({ 'p/s.jsonl': [use('toolu_a', [q2], 0)] });
    expect((await importHistory(dir, open, HOME)).added).toBe(1);
    const closed = transcripts({ 'p/s.jsonl': [use('toolu_a', [q2], 0), answered('toolu_a', [q2], { 'Rename it?': 'Skip it' })] });
    expect((await importHistory(dir, closed, HOME)).added).toBe(1);
    expect(readQuestions(dir, { now: NOW }).rows.map((r) => r.outcome)).toEqual(['OVERRODE_OPTION']);
  });

  test('a question the live hook saw and a transcript also holds is one row; the import supplies a missed answer', async () => {
    const dir = freshDir();
    // The hook saw two questions asked, and the answer to the first only.
    appendObservation(dir, asked({ call: 'toolu_a', title: 'Rename it?', project: 'app', session: 's1' }));
    appendObservation(dir, answer('AGREED', { call: 'toolu_a', title: 'Rename it?', project: 'app', session: 's1' }));
    appendObservation(dir, asked({ call: 'toolu_b', title: 'Rename it?', project: 'app', session: 's1', askTs: T0 + 60_000 }));
    const root = transcripts({
      '-Users-someone-Developer-app/s1.jsonl': [
        use('toolu_a', [q2], 0),
        answered('toolu_a', [q2], { 'Rename it?': REC }),
        use('toolu_b', [q2], 60_000),
        answered('toolu_b', [q2], { 'Rename it?': 'Skip it' }, 75_000),
      ],
    });
    await importHistory(dir, root, HOME);
    const rows = readQuestions(dir, { now: T0 + 80_000 }).rows;
    expect(rows.map((r) => [r.call, r.outcome, r.project, r.session])).toEqual([
      ['toolu_a', 'AGREED', 'app', 's1'],
      ['toolu_b', 'OVERRODE_OPTION', 'app', 's1'],
    ]);
    expect(aggregate(rows).overall).toEqual({ agreed: 1, answered: 2 });
  });

  test('transcript copies that contradict each other stay unreadable even beside a matching hook answer', async () => {
    const dir = freshDir();
    appendObservation(dir, asked({ call: 'toolu_a' }));
    appendObservation(dir, answer('AGREED', { call: 'toolu_a' }));
    const root = transcripts({
      'p/a.jsonl': [use('toolu_a', [q2], 0), answered('toolu_a', [q2], { 'Rename it?': REC })],
      'p/b.jsonl': [use('toolu_a', [q2], 0), answered('toolu_a', [q2], { 'Rename it?': 'Skip it' })],
    });
    await importHistory(dir, root, HOME);
    expect(readObservations(dir).observations.some((o) => o.kind === CONFLICT)).toBe(true);
    expect(readQuestions(dir, { now: NOW }).rows.map((r) => r.outcome)).toEqual(['UNDECODED']);
  });

  test('a file in an unknown format is counted, and a missing transcripts directory is an error', async () => {
    const odd = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'AskUserQuestion', input: { prompts: [] } }] } };
    const root = transcripts({ 'p/s.jsonl': [odd] });
    expect(await importHistory(freshDir(), root, HOME)).toEqual({ files: 1, skipped: 0, unrecognizedFiles: 1, questions: 0, added: 0 });
    await expect(importHistory(freshDir(), path.join(tmp, 'no-such-dir'), HOME)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('the import script prints counts only, and exits 1 with a hint when there is nothing to read', () => {
    const root = transcripts({ 'p/s.jsonl': [use('toolu_a', [q1], 0), answered('toolu_a', [q1], { [q1.question]: REC })] });
    const dir = freshDir();
    const run = (transcriptsDir: string) =>
      Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'scripts', 'import.ts')], {
        env: { PATH: '/usr/bin:/bin', HOME: tmp, AGENT_INBOX_DIR: dir, AGENT_INBOX_TRANSCRIPTS: transcriptsDir },
      });
    const first = run(root);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain('Imported 1 new record for 1 question found in 1 session file.');
    expect(first.stdout.toString()).not.toContain('Ship it?');
    expect(run(root).stdout.toString()).toContain('Nothing new: 1 question from 1 session file already stored.');
    const missing = run(path.join(tmp, 'no-such-dir'));
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.toString()).toContain('No past sessions imported');
  });
});

// A synthetic history in the format version 0.1.1 stored (no real question text). The numbers
// below were computed by 0.1.1 itself; any change to the reader or to reconciliation that moves
// one of them changes what an existing user sees for the history they already have.
describe('history stored by 0.1.1 reads the same', () => {
  const FIXTURE = path.join(import.meta.dir, 'test', 'fixtures', 'outcomes-0.1.1.jsonl');
  const FIXTURE_NOW = Date.parse('2026-11-01T00:00:00.000Z');
  const load = () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(dir, OUTCOMES_FILE));
    return dir;
  };

  test('totals, outcomes, projects, timing and the weekly trend are unchanged', () => {
    const board = boardData(load(), { now: FIXTURE_NOW });
    const t = board.totals;
    expect(t.overall).toEqual({ agreed: 25, answered: 31 });
    expect(t.counts).toEqual({
      AGREED: 25,
      OVERRODE_OPTION: 3,
      OVERRODE_TYPED: 3,
      DISMISSED: 3,
      UNANSWERED: 1,
      UNDECODED: 2,
      EXCLUDED_MULTI: 1,
      EXCLUDED_NO_REC: 3,
    });
    expect([t.calls, t.questions]).toEqual([40, 41]);
    expect(t.timing).toEqual({ n: 34, medianMs: 30000, fast: 14 });
    expect(t.projects).toEqual([
      { project: 'beta', agreed: 9, answered: 12, medianMs: 30000, timed: 12 },
      { project: 'alpha', agreed: 7, answered: 10, medianMs: 30000, timed: 10 },
      { project: 'gamma', agreed: 9, answered: 9, medianMs: 30000, timed: 9 },
    ]);
    expect([t.sessions.length, t.overrides.length]).toEqual([15, 6]);
    expect(board.weekly.map((w) => [w.agreed, w.answered]).slice(-4)).toEqual([[10, 12], [10, 12], [5, 7], [0, 0]]);
    expect([board.unreadable, board.inferredDismissed]).toEqual([1, 0]);
    expect(board.sources).toEqual({ hook: true, import: true });
  });

  test('every readable line is kept: 56 observations, and only the unfinished last line is unreadable', () => {
    const stored = readObservations(load());
    expect([stored.observations.length, stored.unreadable]).toEqual([56, 1]);
  });

  test('storing the same observations again adds nothing, so a repeated import of old history is a no-op', () => {
    const dir = load();
    expect(appendNew(dir, readObservations(dir).observations)).toBe(0);
  });
});

describe('attributes: who asked', () => {
  const WHO = { model: 'claude-test-1', skill: 'plan-review', agent: 'Explore', product: 'Codex CLI' };

  test('an observation without attributes is written exactly as 0.1.1 wrote it', () => {
    const dir = freshDir();
    appendObservation(dir, obs('AGREED', { askTs: T0, answerTs: T0 + 1 }));
    const line = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8').trim();
    expect(Object.keys(JSON.parse(line))).toEqual(['v', 'source', 'call', 'pos', 'kind', 'chip', 'title', 'session', 'project', 'askTs', 'answerTs']);
  });

  test('known attributes are stored after the 0.1.1 keys, in a fixed order, and read back', () => {
    const dir = freshDir();
    appendObservation(dir, obs(ASKED, { askTs: T0, ...WHO }));
    const line = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8').trim();
    expect(Object.keys(JSON.parse(line)).slice(-4)).toEqual([...ATTRIBUTES]);
    expect(readObservations(dir).observations[0]).toMatchObject(WHO);
  });

  test('a malformed attribute is dropped and the line keeps its outcome; a long one is cut', () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = { v: 1, source: 'hook', call: 'c', pos: 0, kind: 'AGREED', chip: '', title: '', session: 's', project: 'p', askTs: null, answerTs: T0 };
    const lines = [
      { ...base, call: 'c1', model: 42, skill: '', agent: '   ', product: { a: 1 } },
      { ...base, call: 'c2', model: 'm'.repeat(200) },
    ];
    fs.writeFileSync(path.join(dir, OUTCOMES_FILE), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const stored = readObservations(dir);
    expect(stored.unreadable).toBe(0);
    expect(ATTRIBUTES.filter((k) => stored.observations[0][k] !== undefined)).toEqual([]);
    expect(stored.observations[1].model).toHaveLength(ATTRIBUTE_MAX);
  });

  test('a question nobody attributed yields a row without attribute keys; its product reads Claude Code', () => {
    const [row] = reconcile([obs(ASKED, { askTs: T0 }), obs('AGREED', { answerTs: T0 + 5 })], { now: NOW });
    expect(ATTRIBUTES.filter((k) => k in row)).toEqual([]);
    expect(productOf(row)).toBe(DEFAULT_PRODUCT);
  });

  test('attributes are merged one by one: a later import fills what the hook did not know', () => {
    const asked = obs(ASKED, { askTs: T0, skill: 'plan-review', agent: 'Explore' });
    const answered = obs('AGREED', { answerTs: T0 + 5 });
    const imported = obs('AGREED', { source: 'import', askTs: T0, answerTs: T0 + 5, model: 'claude-test-1' });
    for (const order of [[asked, answered, imported], [imported, answered, asked]]) {
      const [row] = reconcile(order, { now: NOW });
      expect([row.outcome, row.model, row.skill, row.agent]).toEqual(['AGREED', 'claude-test-1', 'plan-review', 'Explore']);
    }
  });

  test('two known values: the import wins for model and skill, the hook for agent and product', () => {
    const asked = obs(ASKED, { askTs: T0, model: 'hook-model', skill: 'hook-skill', agent: 'hook-agent', product: 'hook-product' });
    const imported = obs('AGREED', { source: 'import', askTs: T0, answerTs: T0 + 5, model: 'import-model', skill: 'import-skill', agent: 'import-agent', product: 'import-product' });
    for (const order of [[asked, imported], [imported, asked]]) {
      const [row] = reconcile(order, { now: NOW });
      expect([row.model, row.skill, row.agent, row.product]).toEqual(['import-model', 'import-skill', 'hook-agent', 'hook-product']);
    }
  });

  test('the hook value counts only from the moment of asking, never from the answer', () => {
    const asked = obs(ASKED, { askTs: T0, skill: 'at-ask' });
    const answered = obs('AGREED', { answerTs: T0 + 5, skill: 'at-answer', model: 'at-answer' });
    const [row] = reconcile([answered, asked], { now: NOW });
    expect([row.outcome, row.skill, row.model]).toEqual(['AGREED', 'at-ask', undefined]);
  });

  test('an import that now knows the model is new evidence and is stored once; a repeat adds nothing', () => {
    const dir = freshDir();
    const old = obs('AGREED', { source: 'import', askTs: T0, answerTs: T0 + 5 });
    expect(appendNew(dir, [old])).toBe(1);
    const withModel = { ...old, model: 'claude-test-1' };
    expect(appendNew(dir, [withModel])).toBe(1);
    expect(appendNew(dir, [withModel])).toBe(0);
    const { rows } = readQuestions(dir, { now: NOW });
    expect(rows.map((r) => [r.outcome, r.model])).toEqual([['AGREED', 'claude-test-1']]);
  });
});

describe('the last 7 days, answer times and timed prompts, through the store', () => {
  const DAY = 24 * 3_600_000;
  const AT = Date.parse('2026-11-20T12:00:00.000Z');
  const pair = (call: string, askTs: number, answerTs: number, kind: ObservedKind = 'AGREED', extra: Partial<Observation> = {}): Observation[] => [
    obs(ASKED, { call, askTs, ...extra }),
    obs(kind, { call, answerTs, ...extra }),
  ];
  const board = (observations: Observation[]) => {
    const dir = freshDir();
    for (const o of observations) appendObservation(dir, o);
    return boardData(dir, { now: AT }).totals;
  };

  test('recent means answered within the last 168 hours: asked earlier still counts, answered exactly 168 hours ago does not', () => {
    const t = board([
      ...pair('in', AT - 8 * DAY, AT - 6 * DAY),
      ...pair('edge', AT - 9 * DAY, AT - 7 * DAY),
      ...pair('old', AT - 30 * DAY, AT - 30 * DAY + 1000, 'OVERRODE_OPTION'),
      ...pair('now', AT - 1000, AT, 'OVERRODE_TYPED'),
    ]);
    expect(t.recent).toEqual({ agreed: 1, answered: 2 });
    expect(t.overall).toEqual({ agreed: 2, answered: 4 });
  });

  test('an answer whose time is unknown falls back to when it was asked', () => {
    const t = board([obs('AGREED', { source: 'import', call: 'c', askTs: AT - DAY, answerTs: null })]);
    expect(t.recent).toEqual({ agreed: 1, answered: 1 });
  });

  test('a session is dated by its latest answer, not by when that question was asked', () => {
    const t = board(pair('c', AT - 3 * DAY, AT - 2 * DAY));
    expect(t.sessions.map((s) => s.lastTs)).toEqual([AT - 2 * DAY]);
  });

  test('timed counts prompts, not questions: two questions answered in one prompt are one timing', () => {
    const t = board([
      obs(ASKED, { call: 'c', pos: 0, askTs: AT - 5000 }),
      obs(ASKED, { call: 'c', pos: 1, askTs: AT - 5000 }),
      obs('AGREED', { call: 'c', pos: 0, answerTs: AT }),
      obs('OVERRODE_OPTION', { call: 'c', pos: 1, answerTs: AT }),
    ]);
    expect(t.projects).toEqual([{ project: 'app', agreed: 1, answered: 2, medianMs: 5000, timed: 1 }]);
    expect(t.sessions.map((s) => [s.answered, s.timed])).toEqual([[2, 1]]);
  });

  test('without the current time nothing counts as recent', () => {
    const { rows } = readQuestions(
      (() => {
        const dir = freshDir();
        for (const o of pair('c', AT - 1000, AT)) appendObservation(dir, o);
        return dir;
      })(),
      { now: AT },
    );
    expect(aggregate(rows).recent).toEqual({ agreed: 0, answered: 0 });
  });
});

describe('the splits by who asked, through the store', () => {
  const AT = Date.parse('2026-11-20T12:00:00.000Z');
  const answeredBy = (call: string, who: Partial<Observation>, kind: ObservedKind = 'AGREED', wait = 20_000): Observation[] => [
    obs(ASKED, { call, askTs: AT - 60_000, ...who }),
    obs(kind, { call, answerTs: AT - 60_000 + wait }),
  ];
  const totals = (observations: Observation[]) => {
    const dir = freshDir();
    for (const o of observations) appendObservation(dir, o);
    return boardData(dir, { now: AT }).totals;
  };

  test('each split counts every answered question once; the unknown row is last; old history is Claude Code', () => {
    const t = totals([
      ...answeredBy('a', { skill: 'plan-review', model: 'm-1', agent: 'main agent' }),
      ...answeredBy('b', { skill: 'plan-review', model: 'm-2', agent: 'main agent' }, 'OVERRODE_OPTION'),
      ...answeredBy('c', { skill: 'no skill', agent: 'Explore' }),
      ...answeredBy('d', {}), // stored before anyone recorded who asked
      ...answeredBy('e', { product: 'Codex CLI' }),
    ]);
    const names = (key: keyof typeof t.splits) => t.splits[key].map((r) => [r.name, r.agreed, r.answered]);
    expect(names('skill')).toEqual([['plan-review', 1, 2], ['no skill', 1, 1], ['unknown', 2, 2]]);
    expect(names('model')).toEqual([['m-1', 1, 1], ['m-2', 0, 1], ['unknown', 3, 3]]);
    expect(names('agent')).toEqual([['main agent', 1, 2], ['Explore', 1, 1], ['unknown', 2, 2]]);
    expect(names('product')).toEqual([['Claude Code', 3, 4], ['Codex CLI', 1, 1]]);
    for (const key of ['skill', 'model', 'agent', 'product'] as const) {
      expect(t.splits[key].reduce((n, r) => n + r.answered, 0)).toBe(t.overall.answered);
    }
  });

  test('a split row has the median answer time of its prompts and how many were timed', () => {
    const t = totals([...answeredBy('a', { skill: 's' }, 'AGREED', 10_000), ...answeredBy('b', { skill: 's' }, 'AGREED', 30_000)]);
    expect(t.splits.skill).toEqual([{ name: 's', agreed: 2, answered: 2, medianMs: 20_000, timed: 2 }]);
  });
});

describe('who asked, from past sessions', () => {
  const HOME_DIR = '/Users/someone';
  const iso = (ms: number) => new Date(T0 + ms).toISOString();
  const q = { question: 'Ship it?', header: 'Approach', options: [{ label: 'Yes (recommended)', description: 'd' }, { label: 'No', description: 'd' }], multiSelect: false };
  const use = (id: string, ms: number, extra: Record<string, unknown> = {}) => ({
    type: 'assistant',
    timestamp: iso(ms),
    cwd: '/Users/someone/Developer/app',
    message: { role: 'assistant', model: 'claude-test-1', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [q] } }] },
    ...extra,
  });
  const answered = (id: string, ms: number) => ({
    type: 'user',
    timestamp: iso(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] },
    toolUseResult: { questions: [q], answers: { 'Ship it?': 'Yes (recommended)' }, annotations: {} },
  });
  const transcripts = (lines: unknown[]) => {
    const root = freshDir();
    const file = path.join(root, '-Users-someone-Developer-app', 's1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
    return root;
  };

  test('the import stores the model and skill Claude Code recorded on the asking line', async () => {
    const root = transcripts([
      use('t1', 0, { attributionSkill: 'gstack:plan-review' }),
      answered('t1', 5_000),
      use('t2', 60_000), // no attribution: Claude Code says no skill
      answered('t2', 65_000),
    ]);
    const dir = freshDir();
    await importHistory(dir, root, HOME_DIR);
    const { rows } = readQuestions(dir, { now: T0 + 70_000 });
    expect(rows.map((r) => [r.call, r.model, r.skill, r.agent])).toEqual([
      ['t1', 'claude-test-1', 'plan-review', 'main agent'],
      ['t2', 'claude-test-1', 'no skill', 'main agent'],
    ]);
  });

  test('a question captured live gets its model from a later import, and keeps the agent the hook saw', async () => {
    const dir = freshDir();
    appendObservation(dir, obs(ASKED, { call: 't1', askTs: T0, session: 's1', skill: 'guessed-live', agent: 'Explore' }));
    appendObservation(dir, obs('AGREED', { call: 't1', answerTs: T0 + 5_000, session: 's1' }));
    expect(boardData(dir, { now: T0 + 6_000 }).needsImport).toBe(1);
    await importHistory(dir, transcripts([use('t1', 0, { attributionSkill: 'plan-review' }), answered('t1', 5_000)]), HOME_DIR);
    const [row] = readQuestions(dir, { now: T0 + 6_000 }).rows;
    expect([row.model, row.skill, row.agent]).toEqual(['claude-test-1', 'plan-review', 'Explore']);
  });

  test('the hint counts what an import can still fill, and ends once an import has looked', async () => {
    const dir = freshDir();
    // History stored by 0.1.1: no attributes, and its session file is long gone.
    appendObservation(dir, obs('AGREED', { source: 'import', call: 'old', askTs: T0 - 90 * 24 * 3_600_000, answerTs: T0 - 90 * 24 * 3_600_000 + 1 }));
    expect(boardData(dir, { now: T0 }).needsImport).toBe(1);
    expect(fs.existsSync(path.join(dir, IMPORT_RAN_FILE))).toBe(false);
    await importHistory(dir, transcripts([]), HOME_DIR);
    expect(fs.existsSync(path.join(dir, IMPORT_RAN_FILE))).toBe(true);
    expect(boardData(dir, { now: Date.now() }).needsImport).toBe(0); // looked at, nothing to fill: no hint
    // A question asked after that import has no model until the next one.
    const later = Date.now() + 1_000;
    appendObservation(dir, obs(ASKED, { call: 'new', askTs: later, skill: 'no skill', agent: 'main agent' }));
    expect(boardData(dir, { now: later + 1 }).needsImport).toBe(1);
  });

  test('a question from another product never asks for a Claude Code import', () => {
    const dir = freshDir();
    appendObservation(dir, obs(ASKED, { call: 'x', askTs: T0, product: 'Codex CLI' }));
    appendObservation(dir, obs('AGREED', { call: 'x', answerTs: T0 + 1 }));
    expect(boardData(dir, { now: T0 + 2 }).needsImport).toBe(0);
  });
});

