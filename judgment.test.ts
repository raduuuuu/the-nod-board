import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ANSWERED,
  HOME_PROJECT,
  MAX_OVERRIDES,
  OUTCOMES,
  PROFILE_MAX,
  SESSION_MARKS,
  TIME_BUCKETS,
  TIME_BUCKET_MS,
  TITLE_MAX,
  aggregate,
  classify,
  listTranscripts,
  median,
  mergeCalls,
  projectLabel,
  projectOfCwd,
  readCalls,
  rowsFromCalls,
  scanChunks,
  titleOf,
  weekStart,
  weeklySeries,
  weeklyTimes,
  type CallResult,
  type FileRef,
  type FileRows,
  type Outcome,
  type QuestionDef,
  type QuestionRow,
} from './judgment';

// Synthetic transcript lines only: no real transcript text belongs in this repo.

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

interface RawQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}
const rawQ = (question: string, labels: string[], extra: Partial<RawQuestion> = {}): RawQuestion => ({
  question,
  header: 'Approach',
  options: labels.map((label) => ({ label, description: 'd' })),
  multiSelect: false,
  ...extra,
});
const REC = 'Do it (Recommended)';
const yesNo = (question: string, extra: Partial<RawQuestion> = {}) => rawQ(question, [REC, 'Skip it'], extra);

const use = (id: string, questions: RawQuestion[], ms: number | null = 0) => ({
  type: 'assistant',
  ...(ms === null ? {} : { timestamp: at(ms) }),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
});
const answered = (id: string, questions: RawQuestion[], answers: Record<string, string>, ms: number | null = 30_000) => ({
  type: 'user',
  ...(ms === null ? {} : { timestamp: at(ms) }),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered.' }] },
  toolUseResult: { questions, answers, annotations: {} },
});
const rejected = (id: string, ms = 30_000) => ({
  type: 'user',
  timestamp: at(ms),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "The user doesn't want to proceed with this tool use." }],
  },
  toolUseResult: 'User rejected tool use',
});
/** A result with no structured field, as the copy shape carries it. */
const plainResult = (id: string) => ({
  type: 'api-request-blob',
  sessionId: 's',
  hash: 'h',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered: "x"="y"' }] },
});
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l) + '\n').join('');

async function* chunksOf(text: string | Uint8Array, size = 1 << 16): AsyncGenerator<Uint8Array> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const scan = (lines: unknown[], size?: number) => scanChunks(chunksOf(jsonl(lines), size));
const ref = (name: string, project = 'proj'): FileRef => ({ path: `/t/${project}/${name}.jsonl`, project, session: name });
const totalsOf = async (files: Record<string, unknown[]>) => {
  const rows: { ref: FileRef; rows: FileRows }[] = [];
  for (const [name, lines] of Object.entries(files)) rows.push({ ref: ref(name), rows: await scan(lines) });
  return aggregate(rowsFromCalls(mergeCalls(rows)));
};

const def = (labels: string[], extra: Partial<QuestionDef> = {}): QuestionDef => ({
  question: 'Q?',
  header: 'Approach',
  labels,
  multiSelect: false,
  ...extra,
});
const ans = (a: string): CallResult => ({ kind: 'answers', answers: { 'Q?': a } });

describe('readCalls', () => {
  test('reads a tool_use line and its structured result line', () => {
    const qs = [yesNo('Ship?')];
    const u = readCalls(use('toolu_1', qs, 0))!;
    expect(u.ts).toBe(T0);
    expect(u.uses).toEqual([{ id: 'toolu_1', questions: [{ question: 'Ship?', header: 'Approach', labels: [REC, 'Skip it'], multiSelect: false }] }]);
    const r = readCalls(answered('toolu_1', qs, { 'Ship?': REC }, 5_000))!;
    expect(r.ts).toBe(T0 + 5_000);
    expect(r.results).toEqual([{ id: 'toolu_1', result: { kind: 'answers', answers: { 'Ship?': REC } } }]);
  });

  test('reads the copy shape that has no timestamp', () => {
    const line = { type: 'api-request-blob', sessionId: 's', hash: 'h', message: use('toolu_2', [yesNo('Ship?')]).message };
    const r = readCalls(line)!;
    expect(r.ts).toBeNull();
    expect(r.uses.map((u) => u.id)).toEqual(['toolu_2']);
  });

  test('a rejection and a result with no structured answers are told apart', () => {
    expect(readCalls(rejected('toolu_3'))!.results[0].result).toEqual({ kind: 'rejected' });
    expect(readCalls(plainResult('toolu_3'))!.results[0].result).toEqual({ kind: 'undecoded' });
    // Some other tool error is not the user dismissing the question.
    const failed = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: 'InputValidationError' }] } };
    expect(readCalls(failed)!.results[0].result).toEqual({ kind: 'undecoded' });
  });

  test('lines that are not messages, and questions it cannot read, yield no call', () => {
    for (const v of [null, 3, 'x', [], {}, { message: 'text' }, { message: { content: 'text' } }]) expect(readCalls(v)).toBeNull();
    const odd = { message: { content: [{ type: 'tool_use', id: 'toolu_4', name: 'AskUserQuestion', input: { prompts: [] } }] } };
    expect(readCalls(odd)!.uses).toEqual([]);
    const badOption = use('toolu_5', [{ ...yesNo('Q'), options: [{ title: 'x' }] as never }]);
    expect(readCalls(badOption)!.uses).toEqual([]);
  });
});

describe('classify', () => {
  const cases: [Outcome, QuestionDef, CallResult | null][] = [
    ['AGREED', def([REC, 'B']), ans(REC)],
    ['OVERRODE_OPTION', def([REC, 'B']), ans('B')],
    ['OVERRODE_TYPED', def([REC, 'B']), ans('something I typed')],
    ['DISMISSED', def([REC, 'B']), { kind: 'rejected' }],
    ['UNANSWERED', def([REC, 'B']), null],
    ['UNDECODED', def([REC, 'B']), { kind: 'undecoded' }],
    ['EXCLUDED_MULTI', def([REC, 'B'], { multiSelect: true }), ans(REC)],
    ['EXCLUDED_NO_REC', def(['A', 'B']), ans('A')],
  ];

  test('one case per outcome, and every outcome has a case', () => {
    for (const [want, q, result] of cases) expect(classify(q, result)).toBe(want);
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(OUTCOMES));
  });

  test('two recommended options is not a single recommendation', () => {
    expect(classify(def(['A (Recommended)', 'B (recommended)']), ans('A (Recommended)'))).toBe('EXCLUDED_NO_REC');
  });

  test('the marker is matched in any case', () => {
    expect(classify(def(['A (recommended)', 'B']), ans('A (recommended)'))).toBe('AGREED');
    expect(classify(def(['A (RECOMMENDED)', 'B']), ans('B'))).toBe('OVERRODE_OPTION');
  });

  test('labels are compared whole: a prefix or a quoted label is not a match', () => {
    const q = def(['Yes (Recommended)', 'Yes', 'Say "no"']);
    expect(classify(q, ans('Yes'))).toBe('OVERRODE_OPTION');
    expect(classify(q, ans('Say "no"'))).toBe('OVERRODE_OPTION');
    expect(classify(q, ans('Yes (Recommended) but later'))).toBe('OVERRODE_TYPED');
  });

  test('a result with no answer for this question is undecoded, never an override', () => {
    expect(classify(def([REC, 'B']), { kind: 'answers', answers: { 'Another question?': 'B' } })).toBe('UNDECODED');
    expect(classify(def([REC, 'B']), { kind: 'answers', answers: {} })).toBe('UNDECODED');
  });
});

describe('scanChunks', () => {
  const qs = [yesNo('Ship?')];
  const pair = [use('toolu_a', qs, 0), answered('toolu_a', qs, { 'Ship?': REC }, 20_000)];

  test('a call and its result in one file', async () => {
    const rows = await scan([{ type: 'user', message: { role: 'user', content: 'hello' } }, ...pair]);
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]).toMatchObject({ id: 'toolu_a', useTs: T0, resultTs: T0 + 20_000, result: { kind: 'answers' } });
    expect(rows).toMatchObject({ unparsable: 0, unrecognized: 0 });
  });

  test('a record split across chunks is reassembled, at every chunk size', async () => {
    const whole = await scan(pair);
    for (const size of [1, 7, 64, 333]) expect(await scan(pair, size)).toEqual(whole);
  });

  test('a multibyte character split across chunks survives', async () => {
    const q = [rawQ('Envoyer à Zoë — 日本語?', ['Oui ✓ (Recommended)', 'Non ✗'])];
    const lines = [use('toolu_u', q, 0), answered('toolu_u', q, { 'Envoyer à Zoë — 日本語?': 'Non ✗' })];
    for (const size of [1, 2, 3, 5]) {
      const rows = await scan(lines, size);
      expect(rows.calls[0].questions[0].question).toBe('Envoyer à Zoë — 日本語?');
      expect(classify(rows.calls[0].questions[0], rows.calls[0].result)).toBe('OVERRODE_OPTION');
    }
  });

  test('a last line with no newline is not read in this scan', async () => {
    const text = jsonl([pair[0]]) + JSON.stringify(pair[1]); // result still being written
    const rows = await scanChunks(chunksOf(text));
    expect(rows.calls[0].result).toBeNull();
    expect(rows.unparsable).toBe(0);
    const later = await scanChunks(chunksOf(text + '\n'));
    expect(later.calls[0].result).toMatchObject({ kind: 'answers' });
  });

  test('a candidate line that is not JSON is counted and skipped', async () => {
    const rows = await scanChunks(chunksOf(`{"broken AskUserQuestion\n${jsonl(pair)}`));
    expect(rows.unparsable).toBe(1);
    expect(rows.calls).toHaveLength(1);
  });

  test('a result line is found by its call id even though it never names the tool', async () => {
    expect(JSON.stringify(pair[1])).not.toContain('AskUserQuestion');
    expect((await scan(pair)).calls[0].result).toMatchObject({ kind: 'answers' });
  });

  test('results of other tools are ignored', async () => {
    const other = { type: 'user', timestamp: at(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }] } };
    const rows = await scan([pair[0], other]);
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0].result).toBeNull();
  });

  test('an undecoded copy of a result does not hide the structured copy that follows it', async () => {
    const rows = await scan([pair[0], plainResult('toolu_a'), pair[1]]);
    expect(rows.calls[0].result).toEqual({ kind: 'answers', answers: { 'Ship?': REC } });
    const reversed = await scan([pair[0], pair[1], plainResult('toolu_a')]);
    expect(reversed.calls[0].result).toEqual({ kind: 'answers', answers: { 'Ship?': REC } });
  });

  test('a tool_use this parser cannot read is counted as unrecognized', async () => {
    const odd = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'AskUserQuestion', input: { prompts: ['new shape'] } }] } };
    const rows = await scan([odd]);
    expect(rows.calls).toEqual([]);
    expect(rows.unrecognized).toBe(1);
  });

  test('lines that only mention the tool (definitions, prose) are not unrecognized', async () => {
    const definition = { type: 'attachment', attachment: { tools: [{ name: 'AskUserQuestion', description: 'asks' }] } };
    const prose = { type: 'user', message: { role: 'user', content: 'why did {"name":"AskUserQuestion","input":{}} fail?' } };
    const rows = await scan([definition, prose]);
    expect(rows).toEqual({ calls: [], unparsable: 0, unrecognized: 0 });
  });
});

describe('mergeCalls', () => {
  const qs = [yesNo('Ship?')];
  const rowsOf = async (files: Record<string, unknown[]>) => {
    const out: { ref: FileRef; rows: FileRows }[] = [];
    for (const [name, lines] of Object.entries(files)) out.push({ ref: ref(name), rows: await scan(lines) });
    return out;
  };

  test('the same call id in two files is one call, owned by the earliest copy', async () => {
    const lines = [use('toolu_d', qs, 0), answered('toolu_d', qs, { 'Ship?': REC })];
    const merged = mergeCalls(await rowsOf({ resumed: lines, original: lines }));
    expect(merged).toHaveLength(1);
    expect(merged[0].session).toBe('original'); // equal timestamps: path order decides, not listing order
    expect(aggregate(rowsFromCalls(merged)).overall).toEqual({ agreed: 1, answered: 1 });
  });

  test('an unanswered copy and an answered copy give the same result in either file order', async () => {
    const unanswered = [use('toolu_e', qs, 0)];
    const full = [use('toolu_e', qs, 0), answered('toolu_e', qs, { 'Ship?': 'Skip it' }, 9_000)];
    const a = mergeCalls(await rowsOf({ a: unanswered, b: full }));
    const b = mergeCalls(await rowsOf({ a: full, b: unanswered }));
    for (const m of [a, b]) {
      expect(m[0].result).toEqual({ kind: 'answers', answers: { 'Ship?': 'Skip it' } });
      expect(m[0].elapsedMs).toBe(9_000);
      expect(m[0].session).toBe('a');
    }
  });

  test('a copy without a timestamp never owns a call that has a timestamped copy', async () => {
    const blob = { type: 'api-request-blob', sessionId: 's', hash: 'h', message: use('toolu_f', qs).message };
    const merged = mergeCalls(await rowsOf({ a: [blob, plainResult('toolu_f')], z: [use('toolu_f', qs, 0), answered('toolu_f', qs, { 'Ship?': REC })] }));
    expect(merged[0].session).toBe('z');
    expect(merged[0].ts).toBe(T0);
    expect(merged[0].result).toMatchObject({ kind: 'answers' });
  });

  test('copies that decode to different answers are undecoded and stay out of the rate', async () => {
    const merged = mergeCalls(
      await rowsOf({
        a: [use('toolu_g', qs, 0), answered('toolu_g', qs, { 'Ship?': REC })],
        b: [use('toolu_g', qs, 0), answered('toolu_g', qs, { 'Ship?': 'Skip it' })],
      }),
    );
    const t = aggregate(rowsFromCalls(merged));
    expect(t.counts.UNDECODED).toBe(1);
    expect(t.overall.answered).toBe(0);
    // A contradiction is kept apart from a result that merely could not be read.
    expect(merged[0].result).toEqual({ kind: 'conflict' });
    expect(rowsFromCalls(merged)[0].conflict).toBe(true);
  });

  test('a rejected copy beats a copy with no result', async () => {
    const merged = mergeCalls(await rowsOf({ a: [use('toolu_h', qs, 0)], b: [use('toolu_h', qs, 0), rejected('toolu_h')] }));
    expect(merged[0].result).toEqual({ kind: 'rejected' });
  });
});

describe('aggregate', () => {
  test('the index counts only answered single-recommendation questions: 3 of 5 is 60%', async () => {
    const one = (id: string, q: RawQuestion, answer?: string) =>
      answer === undefined ? [use(id, [q])] : [use(id, [q]), answered(id, [q], { [q.question]: answer })];
    const multi = yesNo('Pick several?', { multiSelect: true });
    const t = await totalsOf({
      s1: [
        ...one('toolu_1', yesNo('Q1?'), REC),
        ...one('toolu_2', yesNo('Q2?'), REC),
        ...one('toolu_3', yesNo('Q3?'), REC),
        ...one('toolu_4', yesNo('Q4?'), 'Skip it'),
        ...one('toolu_5', yesNo('Q5?'), 'do something else entirely'),
        use('toolu_6', [yesNo('Q6?')]),
        rejected('toolu_6'),
        ...one('toolu_7', yesNo('Q7?')),
        ...one('toolu_8', multi, REC),
      ],
    });
    expect(t.overall).toEqual({ agreed: 3, answered: 5 });
    expect(t.counts).toEqual({
      AGREED: 3,
      OVERRODE_OPTION: 1,
      OVERRODE_TYPED: 1,
      DISMISSED: 1,
      UNANSWERED: 1,
      UNDECODED: 0,
      EXCLUDED_MULTI: 1,
      EXCLUDED_NO_REC: 0,
    });
    expect(t.calls).toBe(8);
    expect(t.questions).toBe(8);
    // Every question lands in exactly one outcome.
    expect(Object.values(t.counts).reduce((a, b) => a + b, 0)).toBe(t.questions);
    expect([...ANSWERED].reduce((n, o) => n + t.counts[o], 0)).toBe(t.overall.answered);
  });

  test('an undecoded result does not change the denominator', async () => {
    const q = yesNo('Q?');
    const base = [use('toolu_1', [q]), answered('toolu_1', [q], { 'Q?': REC })];
    const before = await totalsOf({ s: base });
    const after = await totalsOf({ s: [...base, use('toolu_2', [q], 60_000), plainResult('toolu_2')] });
    expect(after.overall).toEqual(before.overall);
    expect(after.counts.UNDECODED).toBe(1);
  });

  test('no questions at all: zero denominator, no rows, no timing', async () => {
    const t = await totalsOf({ s: [{ type: 'user', message: { role: 'user', content: 'hi' } }] });
    expect(t.overall).toEqual({ agreed: 0, answered: 0 });
    expect(t.timing).toEqual({ n: 0, medianMs: null, fast: 0 });
    expect([t.projects, t.sessions, t.overrides]).toEqual([[], [], []]);
  });

  test('time to answer is one observation per call, and calls without both timestamps are left out', async () => {
    const two = [yesNo('A?'), yesNo('B?')];
    const one = [yesNo('C?')];
    const t = await totalsOf({
      s: [
        use('toolu_1', two, 0),
        answered('toolu_1', two, { 'A?': REC, 'B?': REC }, 10_000),
        use('toolu_2', one, 100_000),
        answered('toolu_2', one, { 'C?': REC }, 140_000),
        use('toolu_3', one, null),
        answered('toolu_3', one, { 'C?': REC }, null),
      ],
    });
    expect(t.overall.answered).toBe(4);
    expect(t.timing).toEqual({ n: 2, medianMs: 25_000, fast: 1 });
    expect(median([5])).toBe(5);
    expect(median([])).toBeNull();
  });

  test('overrides: newest first, capped, first line only and cut to length', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < MAX_OVERRIDES + 5; i++) {
      const q = yesNo(`Override ${i}?\nsecond line that must not show`);
      lines.push(use(`toolu_${i}`, [q], i * 1000), answered(`toolu_${i}`, [q], { [q.question]: i % 2 ? 'Skip it' : 'typed' }, i * 1000 + 1));
    }
    const t = await totalsOf({ s: lines });
    expect(t.overrides).toHaveLength(MAX_OVERRIDES);
    expect(t.overrides[0]).toEqual({ ts: T0 + (MAX_OVERRIDES + 4) * 1000, project: 'proj', title: `Override ${MAX_OVERRIDES + 4}?`, typed: true });
    expect(t.overrides[1].typed).toBe(false);
    const long = titleOf('x'.repeat(500));
    expect(long).toHaveLength(TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  test('sessions and projects are split, newest session first', async () => {
    const q = yesNo('Q?');
    const pairAt = (id: string, ms: number, answer: string) => [use(id, [q], ms), answered(id, [q], { 'Q?': answer }, ms + 4_000)];
    const rows = [
      { ref: ref('old', 'alpha'), rows: await scan(pairAt('toolu_1', 0, REC)) },
      { ref: ref('new', 'beta'), rows: await scan([...pairAt('toolu_2', 60_000, 'Skip it'), ...pairAt('toolu_3', 90_000, REC)]) },
    ];
    const t = aggregate(rowsFromCalls(mergeCalls(rows)));
    expect(t.sessions.map((s) => [s.session, s.project, s.agreed, s.answered, s.lastTs, s.medianMs])).toEqual([
      ['new', 'beta', 1, 2, T0 + 90_000, 4_000],
      ['old', 'alpha', 1, 1, T0, 4_000],
    ]);
    expect(t.projects.map((p) => [p.project, p.agreed, p.answered])).toEqual([
      ['beta', 1, 2],
      ['alpha', 1, 1],
    ]);
  });
});

describe('listing', () => {
  test('project directories are shown without the home prefix', () => {
    expect(projectLabel('-Users-someone', '/Users/someone')).toBe(HOME_PROJECT);
    expect(projectLabel('-Users-someone-Developer-thing', '/Users/someone')).toBe('Developer-thing');
    expect(projectLabel('-opt-elsewhere', '/Users/someone')).toBe('-opt-elsewhere');
  });

  test('a project is named after the last segment of its working directory', () => {
    expect(projectOfCwd('/Users/someone/Developer/thing', '/Users/someone')).toBe('thing');
    expect(projectOfCwd('/Users/someone/Developer/thing/', '/Users/someone')).toBe('thing');
    expect(projectOfCwd('/Users/someone', '/Users/someone/')).toBe(HOME_PROJECT);
    expect(projectOfCwd(null, '/Users/someone')).toBeNull();
    expect(projectOfCwd('', '/Users/someone')).toBeNull();
  });
});

describe('listing transcripts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-listing-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('only regular .jsonl files inside project directories are listed; subagent files belong to their session', async () => {
    const root = path.join(tmp, 'root');
    const put = (rel: string) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
      return file;
    };
    put('-Users-someone/home.jsonl');
    put('-Users-someone-app/sess-9/subagents/agent-1.jsonl');
    put('stray.jsonl');
    put('-Users-someone-app/notes.txt');
    const outside = path.join(tmp, 'outside.jsonl');
    fs.writeFileSync(outside, '{}\n');
    fs.symlinkSync(outside, path.join(root, '-Users-someone-app', 'link.jsonl'));
    fs.mkdirSync(path.join(root, '-Users-someone-app', 'dir.jsonl'));
    const refs = await listTranscripts(root, '/Users/someone');
    expect(refs.map((r) => [r.project, r.session])).toEqual([
      ['app', 'sess-9'],
      [HOME_PROJECT, 'home'],
    ]);
  });

  test('a missing root is an error for the caller to report', async () => {
    await expect(listTranscripts(path.join(tmp, 'nope'), '/Users/someone')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('weekly trend', () => {
  const MON = Date.UTC(2026, 10, 9); // Monday 9 November 2026, 00:00 UTC
  const WEEK = 7 * 24 * 3_600_000;
  const row = (askTs: number | null, outcome: QuestionRow['outcome']): QuestionRow => ({
    call: `c${Math.random()}`,
    pos: 0,
    outcome,
    inferred: false,
    chip: 'x',
    title: 't',
    session: 's',
    project: 'p',
    askTs,
    elapsedMs: null,
  });

  test('a week starts on Monday 00:00 UTC', () => {
    expect(new Date(MON).getUTCDay()).toBe(1);
    expect(weekStart(MON)).toBe(MON);
    expect(weekStart(MON + WEEK - 1)).toBe(MON); // Sunday 23:59:59.999
    expect(weekStart(MON - 1)).toBe(MON - WEEK);
    expect(weekStart(Date.UTC(2027, 0, 1))).toBe(Date.UTC(2026, 11, 28)); // across a year boundary
  });

  test('twelve weeks, oldest first, ending with the current one; only answered questions count', () => {
    const nowTs = MON + 3 * 24 * 3_600_000; // Thursday
    const points = weeklySeries(
      [
        row(MON + 1000, 'AGREED'),
        row(MON + 2000, 'OVERRODE_TYPED'),
        row(MON + 3000, 'DISMISSED'), // not in the rate
        row(MON + 4000, 'EXCLUDED_MULTI'),
        row(MON - 1, 'AGREED'), // last millisecond of the previous week
        row(MON - 11 * WEEK, 'OVERRODE_OPTION'), // first moment of the oldest week
        row(MON - 11 * WEEK - 1, 'AGREED'), // one millisecond too old
        row(MON + WEEK, 'AGREED'), // next week: after "now"
        row(null, 'AGREED'), // no time: cannot be placed
      ],
      nowTs,
    );
    expect(points).toHaveLength(12);
    expect(points.map((p) => p.start)).toEqual(Array.from({ length: 12 }, (_, i) => MON - (11 - i) * WEEK));
    expect(points[11]).toEqual({ start: MON, agreed: 1, answered: 2 });
    expect(points[10]).toEqual({ start: MON - WEEK, agreed: 1, answered: 1 });
    expect(points[0]).toEqual({ start: MON - 11 * WEEK, agreed: 0, answered: 1 });
    expect(points.reduce((n, p) => n + p.answered, 0)).toBe(4);
  });

  test('a week with answers below the display minimum keeps its counts: the reader decides what to show', () => {
    const points = weeklySeries([row(MON, 'AGREED'), row(MON, 'AGREED')], MON, 2);
    expect(points).toEqual([
      { start: MON - WEEK, agreed: 0, answered: 0 },
      { start: MON, agreed: 2, answered: 2 },
    ]);
  });
});

describe('the data behind the charts', () => {
  const MON = Date.UTC(2026, 10, 9);
  const WEEK = 7 * 24 * 3_600_000;
  let n = 0;
  const row = (outcome: QuestionRow['outcome'], extra: Partial<QuestionRow> = {}): QuestionRow => ({
    call: `c${n++}`,
    pos: 0,
    outcome,
    inferred: false,
    chip: 'x',
    title: 't',
    session: 's',
    project: 'p',
    askTs: MON + n * 1000,
    elapsedMs: null,
    ...extra,
  });

  test('answer times fall into 5 second buckets, and everything slower than the last one into a final bucket', () => {
    const t = aggregate([
      row('AGREED', { elapsedMs: 0 }),
      row('AGREED', { elapsedMs: TIME_BUCKET_MS - 1 }),
      row('AGREED', { elapsedMs: TIME_BUCKET_MS }),
      row('OVERRODE_OPTION', { elapsedMs: TIME_BUCKETS * TIME_BUCKET_MS - 1 }),
      row('AGREED', { elapsedMs: TIME_BUCKETS * TIME_BUCKET_MS }),
      row('AGREED', { elapsedMs: 3_600_000 }),
      row('AGREED'), // not timed: in no bucket
    ]);
    expect(t.timeBuckets).toHaveLength(TIME_BUCKETS + 1);
    expect([t.timeBuckets[0], t.timeBuckets[1], t.timeBuckets[TIME_BUCKETS - 1], t.timeBuckets[TIME_BUCKETS]]).toEqual([2, 1, 1, 2]);
    expect(t.timeBuckets.reduce((a, b) => a + b, 0)).toBe(t.timing.n); // the histogram and the median rest on the same prompts
    expect(aggregate([]).timeBuckets).toEqual(new Array(TIME_BUCKETS + 1).fill(0));
  });

  test('a prompt with several questions is one answer time, as in the median', () => {
    const t = aggregate([row('AGREED', { call: 'same', elapsedMs: 7_000 }), row('AGREED', { call: 'same', pos: 1, elapsedMs: 7_000 })]);
    expect(t.timeBuckets[1]).toBe(1);
  });

  test('a profile per model: how each question went, dismissals beside the answers, timing once per prompt', () => {
    const t = aggregate([
      row('AGREED', { model: 'm-a', elapsedMs: 4_000 }),
      row('AGREED', { model: 'm-a', elapsedMs: 40_000 }),
      row('OVERRODE_OPTION', { model: 'm-a' }),
      row('OVERRODE_TYPED', { model: 'm-a' }),
      row('DISMISSED', { model: 'm-a' }),
      row('EXCLUDED_NO_REC', { model: 'm-a' }), // neither answered nor dismissed
      row('AGREED', { model: 'm-b', elapsedMs: 1_000 }),
      row('AGREED'), // no model recorded: in no profile
    ]);
    expect(t.modelProfiles).toEqual([
      { name: 'm-a', answered: 4, agreed: 2, option: 1, typed: 1, dismissed: 1, timed: 2, fast: 1 },
      { name: 'm-b', answered: 1, agreed: 1, option: 0, typed: 0, dismissed: 0, timed: 1, fast: 1 },
    ]);
  });

  test('the profiles are the models with the most answers, at most four', () => {
    const rows = Array.from({ length: PROFILE_MAX + 2 }, (_, i) => Array.from({ length: i + 1 }, () => row('AGREED', { model: `m-${i}` }))).flat();
    const names = aggregate(rows).modelProfiles.map((p) => p.name);
    expect(names).toEqual(['m-5', 'm-4', 'm-3', 'm-2']);
  });

  test('a session keeps its answers in order, the latest sixty: 1 took the recommendation, 0 chose otherwise', () => {
    const t = aggregate([row('AGREED'), row('OVERRODE_OPTION'), row('DISMISSED'), row('OVERRODE_TYPED'), row('AGREED')]);
    expect(t.sessions[0].marks).toBe('1001');
    const long = aggregate([row('OVERRODE_OPTION'), ...Array.from({ length: SESSION_MARKS }, () => row('AGREED'))]);
    expect(long.sessions[0].marks).toBe('1'.repeat(SESSION_MARKS)); // the oldest answer dropped out
    expect(long.sessions[0].answered).toBe(SESSION_MARKS + 1); // the count still has it
  });

  test('weekly answer times: the same weeks as the trend, one time per prompt, null for a week without one', () => {
    const now = MON + 3 * 24 * 3_600_000;
    const times = weeklyTimes(
      [
        row('AGREED', { askTs: MON + 1, elapsedMs: 10_000 }),
        row('OVERRODE_OPTION', { askTs: MON + 2, elapsedMs: 30_000 }),
        row('AGREED', { askTs: MON + 3, call: 'two', elapsedMs: 50_000 }),
        row('AGREED', { askTs: MON + 3, call: 'two', pos: 1, elapsedMs: 50_000 }),
        row('AGREED', { askTs: MON - 1, elapsedMs: 8_000 }),
        row('AGREED', { askTs: MON + 4 }), // not timed
        row('AGREED', { askTs: null, elapsedMs: 5_000 }), // cannot be placed
        row('AGREED', { askTs: MON - 12 * WEEK, elapsedMs: 5_000 }), // too old
      ],
      now,
    );
    expect(times.map((w) => w.start)).toEqual(weeklySeries([], now).map((w) => w.start));
    expect(times[11]).toEqual({ start: MON, medianMs: 30_000, timed: 3 });
    expect(times[10]).toEqual({ start: MON - WEEK, medianMs: 8_000, timed: 1 });
    expect(times[0]).toEqual({ start: MON - 11 * WEEK, medianMs: null, timed: 0 });
  });
});
