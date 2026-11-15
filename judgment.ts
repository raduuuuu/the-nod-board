/**
 * judgment.ts: how often the user took the agent's recommendation ("meat proxy index").
 *
 * Two sources feed it. Live: the hook classifies each answered question (hook.ts) and stores the
 * outcome (outcomes.ts). History: the import reads Claude Code transcripts once
 * (<transcriptsDir>/<project>/<session>.jsonl and .../<session>/subagents/*.jsonl), in memory.
 * This module holds what both share: the transcript reader, the classifier and the arithmetic.
 *
 *   readCalls(line)     the one place that knows transcript line shapes
 *   classify(q, result) one question -> one OUTCOMES member
 *   scanChunks(stream)  bytes -> lines -> calls of one file (whole-file scan, no offsets)
 *   mergeCalls(files)   copies of a call (resumed sessions repeat lines) merged by call id
 *   rowsFromCalls(calls) one classified row per question (the shape outcomes.ts stores and returns)
 *   aggregate(rows)     the numbers the page shows
 *
 * Per question of an AskUserQuestion call, first match wins:
 *   question is multi-select ............................ EXCLUDED_MULTI
 *   options with "(recommended)" in the label != 1 ...... EXCLUDED_NO_REC
 *   no tool_result for the call ......................... UNANSWERED
 *   result is a rejection ............................... DISMISSED
 *   result has no structured answer for the question .... UNDECODED
 *   answer equals the recommended label ................. AGREED            \
 *   answer equals another option's label ................ OVERRODE_OPTION    > the rate's denominator
 *   anything else (typed text) .......................... OVERRODE_TYPED    /
 * The answer is read only from the structured `toolUseResult.answers[question text]`; the
 * human-readable result text is never matched against labels.
 *
 * Rate = AGREED / (AGREED + OVERRODE_OPTION + OVERRODE_TYPED). Time to answer is per call
 * (result line timestamp minus tool_use line timestamp): elapsed time, not attention.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLAUDE_CODE, UNKNOWN, fromTranscript, type Who } from './attrs';
import { HOME_PROJECT, projectOfCwd, projectOfSession } from './project';

export { HOME_PROJECT, projectOfCwd };

export const OUTCOMES = [
  'AGREED',
  'OVERRODE_OPTION',
  'OVERRODE_TYPED',
  'DISMISSED',
  'UNANSWERED',
  'UNDECODED',
  'EXCLUDED_MULTI',
  'EXCLUDED_NO_REC',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes that form the denominator. */
export const ANSWERED: ReadonlySet<Outcome> = new Set<Outcome>(['AGREED', 'OVERRODE_OPTION', 'OVERRODE_TYPED']);

/** Below this many answered questions a rate is shown as "too few". */
export const MIN_N = 5;
export const FAST_ANSWER_MS = 15_000;
/** "The last 7 days": the rolling 168 hours before now, by the time of the answer. */
export const RECENT_WINDOW_MS = 7 * 24 * 3_600_000;
export const RECENT_SESSIONS = 20;
/** The answer-time histogram: buckets of this width, and one more for everything slower. */
export const TIME_BUCKET_MS = 5_000;
export const TIME_BUCKETS = 36;
/** A session's answers are sent in order, the latest this many of them. */
export const SESSION_MARKS = 60;
/** How many models the profile compares. */
export const PROFILE_MAX = 4;
export const MAX_OVERRIDES = 50;
export const TITLE_MAX = 120;

// ---------------------------------------------------------------- transcript line shapes

export interface QuestionDef {
  question: string;
  header: string;
  labels: string[];
  multiSelect: boolean;
}

export type CallResult =
  | { kind: 'answers'; answers: Record<string, string> }
  | { kind: 'rejected' }
  | { kind: 'undecoded' }
  /** Copies of one call decoded to different answers: known to be contradictory, not merely unread. */
  | { kind: 'conflict' };

export interface LineCalls {
  /** The line's own timestamp; null on the copy shape that carries none. */
  ts: number | null;
  /** Working directory of the session when the line was written, when the line carries it. */
  cwd: string | null;
  uses: { id: string; questions: QuestionDef[] }[];
  results: { id: string; result: CallResult }[];
  /** Who asked, when this line is one Claude Code attributes (attrs.ts); absent otherwise. */
  who?: Who;
}

const TOOL = 'AskUserQuestion';
const REJECTION = "The user doesn't want to proceed";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The `questions` array of an AskUserQuestion call, as transcripts and hook payloads both carry it. */
export function toQuestions(v: unknown): QuestionDef[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: QuestionDef[] = [];
  for (const q of v) {
    if (!isObject(q) || typeof q.question !== 'string' || !Array.isArray(q.options)) return null;
    const labels: string[] = [];
    for (const o of q.options) {
      if (!isObject(o) || typeof o.label !== 'string') return null;
      labels.push(o.label);
    }
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      labels,
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && isObject(content[0]) && typeof content[0].text === 'string') return content[0].text;
  return '';
}

function toResult(block: Record<string, unknown>, toolUseResult: unknown): CallResult {
  if (isObject(toolUseResult) && isObject(toolUseResult.answers)) {
    const answers: Record<string, string> = {};
    for (const [k, v] of Object.entries(toolUseResult.answers)) if (typeof v === 'string') answers[k] = v;
    return { kind: 'answers', answers };
  }
  // A rejection is the harness's own fixed error result, not an answer: recognised by its form.
  if (block.is_error === true) {
    const said = typeof toolUseResult === 'string' ? toolUseResult : '';
    if (said === 'User rejected tool use' || said.includes(REJECTION) || blockText(block.content).startsWith(REJECTION))
      return { kind: 'rejected' };
  }
  return { kind: 'undecoded' };
}

/**
 * One parsed transcript line -> the AskUserQuestion calls and the tool results on it.
 * Results are returned for every tool; the caller keeps those whose id is a known call.
 * Returns null when the line is not a message with a content list.
 */
export function readCalls(v: unknown): LineCalls | null {
  if (!isObject(v) || !isObject(v.message) || !Array.isArray(v.message.content)) return null;
  const parsed = typeof v.timestamp === 'string' ? Date.parse(v.timestamp) : NaN;
  const out: LineCalls = { ts: Number.isNaN(parsed) ? null : parsed, cwd: typeof v.cwd === 'string' && v.cwd ? v.cwd : null, uses: [], results: [] };
  for (const b of v.message.content) {
    if (!isObject(b)) continue;
    if (b.type === 'tool_use' && b.name === TOOL && typeof b.id === 'string') {
      const questions = toQuestions(isObject(b.input) ? b.input.questions : null);
      if (questions) out.uses.push({ id: b.id, questions });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.results.push({ id: b.tool_use_id, result: toResult(b, v.toolUseResult) });
    }
  }
  if (out.uses.length) {
    const who = fromTranscript(v);
    if (Object.keys(who).length) out.who = who;
  }
  return out;
}

// ---------------------------------------------------------------- classify

const RECOMMENDED_RE = /\(recommended\)/i;

export function classify(q: QuestionDef, result: CallResult | null): Outcome {
  if (q.multiSelect) return 'EXCLUDED_MULTI';
  const recommended = q.labels.filter((l) => RECOMMENDED_RE.test(l));
  if (recommended.length !== 1) return 'EXCLUDED_NO_REC';
  if (!result) return 'UNANSWERED';
  if (result.kind === 'rejected') return 'DISMISSED';
  if (result.kind === 'undecoded' || result.kind === 'conflict') return 'UNDECODED';
  const answer = result.answers[q.question];
  if (typeof answer !== 'string') return 'UNDECODED';
  if (answer === recommended[0]) return 'AGREED';
  if (q.labels.includes(answer)) return 'OVERRODE_OPTION';
  return 'OVERRODE_TYPED';
}

// ---------------------------------------------------------------- one file

export interface FileCall {
  id: string;
  useTs: number | null;
  /** Working directory on the tool_use line; names the project the same way live capture does. */
  cwd: string | null;
  questions: QuestionDef[];
  result: CallResult | null;
  resultTs: number | null;
  /** Who asked, from the first copy of the asking line that says so. */
  who?: Who;
}

export interface FileRows {
  calls: FileCall[];
  /** Working directory on the file's first line that carries one: the folder the session started in. Absent when no line does. */
  startCwd?: string;
  /** Candidate lines that were not JSON. */
  unparsable: number;
  /** Lines that hold an AskUserQuestion tool_use this parser could not read. */
  unrecognized: number;
}

const NEWLINE = 0x0a;
/** How a tool_use block of this tool is serialised. Tool definitions carry the name too, but never followed by "input". */
const USE_MARKER = `"name":"${TOOL}","input":`;
const CWD_MARKER = '"cwd":"';

/**
 * Scan one transcript from its first byte. Lines are framed on newline bytes, so a record or
 * a multibyte character split across chunks is reassembled before decoding. A last line with
 * no newline is still being written: it is left for the scan that follows the file's next change.
 *
 * Only two kinds of line are decoded: those naming the tool, and tool_result lines that mention
 * a call id still waiting for its result. Everything else (most of a 600 MB file) is skipped as bytes.
 */
export async function scanChunks(chunks: AsyncIterable<Uint8Array>): Promise<FileRows> {
  const calls = new Map<string, FileCall>();
  const pending = new Set<string>();
  const rows: FileRows = { calls: [], unparsable: 0, unrecognized: 0 };

  const onLine = (line: Buffer) => {
    // The first line that says where the session is working says where it started.
    if (rows.startCwd === undefined && line.includes(CWD_MARKER)) {
      try {
        const first = JSON.parse(line.toString('utf8')) as unknown;
        if (isObject(first) && typeof first.cwd === 'string' && first.cwd) rows.startCwd = first.cwd;
      } catch {
        // not a record; a later line will say
      }
    }
    const namesTool = line.includes(TOOL);
    let wanted = namesTool;
    if (!wanted && pending.size && line.includes('tool_result')) {
      for (const id of pending) {
        if (line.includes(id)) {
          wanted = true;
          break;
        }
      }
    }
    if (!wanted) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8'));
    } catch {
      rows.unparsable++;
      return;
    }
    const lc = readCalls(parsed);
    if (namesTool && line.includes(USE_MARKER) && !lc?.uses.length) rows.unrecognized++;
    if (!lc) return;
    for (const u of lc.uses) {
      const call = calls.get(u.id);
      if (!call) {
        const fresh: FileCall = { id: u.id, useTs: lc.ts, cwd: lc.cwd, questions: u.questions, result: null, resultTs: null };
        if (lc.who) fresh.who = lc.who;
        calls.set(u.id, fresh);
        pending.add(u.id);
      } else {
        if (call.useTs === null) call.useTs = lc.ts;
        if (call.cwd === null) call.cwd = lc.cwd;
        if (!call.who && lc.who) call.who = lc.who;
      }
    }
    for (const r of lc.results) {
      const call = calls.get(r.id);
      if (!call) continue;
      // A decoded answer is never replaced by a weaker copy of the same result.
      if (call.result === null || (call.result.kind !== 'answers' && r.result.kind === 'answers')) {
        call.result = r.result;
        call.resultTs = lc.ts;
      }
      // An undecoded copy keeps the id waiting: the structured copy of the same result may follow.
      if (call.result.kind !== 'undecoded') pending.delete(r.id);
    }
  };

  let parts: Buffer[] = [];
  for await (const chunk of chunks) {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let nl = buf.indexOf(NEWLINE, start); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
      let line = buf.subarray(start, nl);
      if (parts.length) {
        parts.push(line);
        line = Buffer.concat(parts);
        parts = [];
      }
      onLine(line);
      start = nl + 1;
    }
    if (start < buf.length) parts.push(Buffer.from(buf.subarray(start))); // copied: the stream may reuse the chunk
  }
  rows.calls = [...calls.values()];
  return rows;
}

// ---------------------------------------------------------------- merge copies

export interface FileRef {
  path: string;
  /** Directory name under the transcripts root. */
  project: string;
  /** Session id as used by `claude --resume`. */
  session: string;
}

export interface MergedCall {
  id: string;
  project: string;
  session: string;
  /** When the question was asked; null when no copy carries a timestamp. */
  ts: number | null;
  questions: QuestionDef[];
  result: CallResult | null;
  /** When the answer or the rejection was recorded, when a copy carries that time. */
  resultTs: number | null;
  /** Result timestamp minus tool_use timestamp, for answered calls with both. */
  elapsedMs: number | null;
  /** Who asked, from the earliest copy that says so. */
  who?: Who;
}

const nullsLast = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

/**
 * A resumed session copies earlier lines into a new file, so one call can appear in several
 * files, and a copy may lack the result or its structured form. The call belongs to the file
 * of its earliest copy; its answer comes from the earliest copy with a decoded result. Copies
 * that decode to different answers make the call a conflict (shown as UNDECODED). File order never matters.
 */
export function mergeCalls(
  files: readonly { ref: FileRef; rows: FileRows }[],
  home: string = os.homedir(),
  nameOf: (start: string | null | undefined, asked: string | null | undefined) => string | null = (start, asked) => projectOfSession(start, asked, home),
): MergedCall[] {
  const byId = new Map<string, { ref: FileRef; call: FileCall }[]>();
  // Where each session started: its own file says so; a subagent's file is asked only when that one cannot.
  const started = new Map<string, { cwd: string; own: boolean }>();
  for (const f of files) {
    const cwd = f.rows.startCwd;
    if (!cwd) continue;
    const own = path.basename(f.ref.path) === `${f.ref.session}.jsonl`;
    const known = started.get(f.ref.session);
    if (!known || (own && !known.own) || (own === known.own && cwd.localeCompare(known.cwd) < 0)) started.set(f.ref.session, { cwd, own });
  }
  for (const f of files) {
    for (const call of f.rows.calls) {
      const list = byId.get(call.id);
      if (list) list.push({ ref: f.ref, call });
      else byId.set(call.id, [{ ref: f.ref, call }]);
    }
  }
  const out: MergedCall[] = [];
  for (const [id, copies] of byId) {
    copies.sort((a, b) => nullsLast(a.call.useTs, b.call.useTs) || a.ref.path.localeCompare(b.ref.path));
    const owner = copies[0];
    const questions = owner.call.questions;
    const byResultTs = (a: { call: FileCall }, b: { call: FileCall }) => nullsLast(a.call.resultTs, b.call.resultTs);
    const decoded = copies.filter((c) => c.call.result?.kind === 'answers').sort(byResultTs);
    let result: CallResult | null = null;
    let from: FileCall | null = null;
    let resultTs: number | null = null;
    if (decoded.length) {
      from = decoded[0].call;
      const first = (from.result as { answers: Record<string, string> }).answers;
      const agree = decoded.every((c) =>
        questions.every((q) => (c.call.result as { answers: Record<string, string> }).answers[q.question] === first[q.question]),
      );
      result = agree ? from.result : { kind: 'conflict' };
      resultTs = from.resultTs;
    } else {
      const rejected = copies.find((c) => c.call.result?.kind === 'rejected');
      const any = copies.find((c) => c.call.result);
      result = (rejected ?? any)?.call.result ?? null;
      resultTs = (rejected ?? any)?.call.resultTs ?? null;
    }
    const useTs = from?.useTs ?? owner.call.useTs;
    const elapsed =
      result?.kind === 'answers' && from && from.resultTs !== null && useTs !== null && from.resultTs >= useTs
        ? from.resultTs - useTs
        : null;
    const who = copies.find((c) => c.call.who)?.call.who;
    out.push({
      ...(who ? { who } : {}),
      id,
      // The project is the one the session started in, as live capture names it (project.ts). A session
      // whose start is not on record is named after where the question was asked, then after its folder.
      project: nameOf(started.get(owner.ref.session)?.cwd, copies.find((c) => c.call.cwd)?.call.cwd) ?? owner.ref.project,
      session: owner.ref.session,
      ts: owner.call.useTs,
      questions,
      result,
      resultTs,
      elapsedMs: elapsed,
    });
  }
  return out;
}

// ---------------------------------------------------------------- aggregate

export interface Rate {
  agreed: number;
  /** n: answered single-select questions that had exactly one recommendation. */
  answered: number;
}

export interface Timing {
  /** Answered calls with both timestamps. */
  n: number;
  medianMs: number | null;
  fast: number;
}

export interface ProjectRow extends Rate {
  project: string;
  medianMs: number | null;
  /** Question prompts with a measured answer time behind medianMs. */
  timed: number;
}
/** The splits by who asked, in the order the page shows them. */
export const SPLIT_KEYS = ['skill', 'model', 'agent', 'product'] as const;
export type SplitKey = (typeof SPLIT_KEYS)[number];
export interface SplitRow extends Rate {
  /** The skill, model, agent or product; UNKNOWN when no source captured it. */
  name: string;
  medianMs: number | null;
  timed: number;
}
/**
 * How one model's questions went, for the profile chart. Shares are left to the page:
 * took = agreed / answered, fast = fast / timed, option and typed = of answered,
 * dismissed = dismissed / (answered + dismissed).
 */
export interface ProfileRow {
  name: string;
  answered: number;
  agreed: number;
  /** Answered with another option. */
  option: number;
  /** Answered with typed text. */
  typed: number;
  dismissed: number;
  /** Question prompts with a measured answer time, and how many of those were under FAST_ANSWER_MS. */
  timed: number;
  fast: number;
}
export interface SessionRow extends Rate {
  session: string;
  project: string;
  /** When the session's latest answer arrived (the time it was asked, when the answer time is not known). */
  lastTs: number | null;
  medianMs: number | null;
  timed: number;
  /** The session's answers in order, the latest SESSION_MARKS: "1" took the recommendation, "0" chose otherwise. */
  marks: string;
}
export interface OverrideRow {
  ts: number | null;
  project: string;
  /** First line of the question, cut to TITLE_MAX characters. */
  title: string;
  typed: boolean;
}

export interface Totals {
  overall: Rate;
  counts: Record<Outcome, number>;
  calls: number;
  questions: number;
  timing: Timing;
  /** Answered in the last 7 days (RECENT_WINDOW_MS); zeros when aggregate() was not told the time. */
  recent: Rate;
  /** Timed prompts per TIME_BUCKET_MS of answer time; the last entry holds everything slower. */
  timeBuckets: number[];
  /** The models with the most answers (never UNKNOWN), at most PROFILE_MAX, for the profile chart. */
  modelProfiles: ProfileRow[];
  /** The share per skill, model, agent and product. Largest first; the UNKNOWN row last. */
  splits: Record<SplitKey, SplitRow[]>;
  projects: ProjectRow[];
  sessions: SessionRow[];
  overrides: OverrideRow[];
}

export interface AggregateOptions {
  /** The current time; without it nothing counts as recent. */
  now?: number;
  /** When a call was answered, when a source saw that; aggregate() falls back to the time it was asked. */
  answeredAt?: (call: string) => number | null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function titleOf(question: string): string {
  const first = question.split('\n', 1)[0].trim();
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

interface Bucket extends Rate {
  elapsed: number[];
  lastTs: number | null;
}
const bucket = (): Bucket => ({ agreed: 0, answered: 0, elapsed: [], lastTs: null });
function bump<K>(map: Map<K, Bucket>, key: K): Bucket {
  let b = map.get(key);
  if (!b) map.set(key, (b = bucket()));
  return b;
}

/**
 * One classified question. This is what aggregate() counts, what outcomes.ts stores and what it
 * returns after reconciling observations: no option text and no answer, only the outcome.
 */
export interface QuestionRow {
  /** tool_use id of the AskUserQuestion call. */
  call: string;
  /** Position of the question inside its call; (call, pos) identifies a question. */
  pos: number;
  outcome: Outcome;
  /** True when the outcome was inferred from a missing event, not observed. */
  inferred: boolean;
  /** Header label the agent gave the question. */
  chip: string;
  /** First line of the question, cut to TITLE_MAX characters. */
  title: string;
  session: string;
  project: string;
  /** When the question was asked. */
  askTs: number | null;
  /** Time to answer for the whole call, repeated on each of its rows; counted once per call. */
  elapsedMs: number | null;
  /** Who asked, when a source recorded it: model id, skill name, agent type. Absent means not captured. */
  model?: string;
  skill?: string;
  agent?: string;
  /** The agent product the question came from. Absent means Claude Code (outcomes.ts productOf). */
  product?: string;
}

/** Stored marker for a call whose copies contradict each other; reconciles to UNDECODED and outranks any single answer. */
export const CONFLICT = 'CONFLICT';

export function rowsFromCalls(calls: readonly MergedCall[]): (QuestionRow & { conflict: boolean })[] {
  const rows: (QuestionRow & { conflict: boolean })[] = [];
  for (const call of calls) {
    call.questions.forEach((q, pos) => {
      rows.push({
        call: call.id,
        pos,
        outcome: classify(q, call.result),
        inferred: false,
        conflict: call.result?.kind === 'conflict',
        chip: q.header,
        title: titleOf(q.question),
        session: call.session,
        project: call.project,
        askTs: call.ts,
        elapsedMs: call.result?.kind === 'answers' ? call.elapsedMs : null,
      });
    });
  }
  return rows;
}

export function aggregate(rows: readonly QuestionRow[], opts: AggregateOptions = {}): Totals {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const overall = bucket();
  const recent = bucket();
  const recentFrom = opts.now === undefined ? Infinity : opts.now - RECENT_WINDOW_MS;
  const projects = new Map<string, Bucket>();
  const splits = Object.fromEntries(SPLIT_KEYS.map((k) => [k, new Map<string, Bucket>()])) as Record<SplitKey, Map<string, Bucket>>;
  // A question from before products were recorded came from Claude Code; any other missing value is unknown.
  const valueOf = (row: QuestionRow, key: SplitKey) => row[key] ?? (key === 'product' ? CLAUDE_CODE : UNKNOWN);
  const profiles = new Map<string, ProfileRow>();
  const profileOf = (row: QuestionRow): ProfileRow | null => {
    if (row.model === undefined) return null;
    let p = profiles.get(row.model);
    if (!p) profiles.set(row.model, (p = { name: row.model, answered: 0, agreed: 0, option: 0, typed: 0, dismissed: 0, timed: 0, fast: 0 }));
    return p;
  };
  const marks = new Map<string, string[]>();
  const sessions = new Map<string, Bucket & { session: string; project: string }>();
  const overrides: OverrideRow[] = [];
  const byCall = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    const list = byCall.get(row.call);
    if (list) list.push(row);
    else byCall.set(row.call, [row]);
  }

  for (const callRows of byCall.values()) {
    const first = callRows[0];
    const sessionKey = `${first.project}/${first.session}`;
    let sess = sessions.get(sessionKey);
    let counted = false;
    // The answer belongs to the call: every question of one prompt was answered at the same moment.
    const answeredTs = opts.answeredAt?.(first.call) ?? first.askTs;
    const isRecent = answeredTs !== null && opts.now !== undefined && answeredTs > recentFrom && answeredTs <= opts.now;
    for (const row of callRows) {
      counts[row.outcome]++;
      const profile = profileOf(row);
      if (profile && row.outcome === 'DISMISSED') profile.dismissed++;
      if (!ANSWERED.has(row.outcome)) continue;
      counted = true;
      if (profile) {
        profile.answered++;
        if (row.outcome === 'AGREED') profile.agreed++;
        else if (row.outcome === 'OVERRODE_TYPED') profile.typed++;
        else profile.option++;
      }
      const sessionMarks = marks.get(sessionKey);
      if (sessionMarks) sessionMarks.push(row.outcome === 'AGREED' ? '1' : '0');
      else marks.set(sessionKey, [row.outcome === 'AGREED' ? '1' : '0']);
      if (!sess) sessions.set(sessionKey, (sess = { ...bucket(), session: first.session, project: first.project }));
      const buckets = [overall, bump(projects, row.project), sess, ...SPLIT_KEYS.map((k) => bump(splits[k], valueOf(row, k)))];
      if (isRecent) buckets.push(recent);
      for (const b of buckets) {
        b.answered++;
        if (row.outcome === 'AGREED') b.agreed++;
      }
      if (answeredTs !== null && (sess.lastTs === null || answeredTs > sess.lastTs)) sess.lastTs = answeredTs;
      if (row.outcome !== 'AGREED')
        overrides.push({ ts: row.askTs, project: row.project, title: row.title, typed: row.outcome === 'OVERRODE_TYPED' });
    }
    // One timing observation per call, however many questions it holds.
    const elapsed = callRows.find((r) => r.elapsedMs !== null)?.elapsedMs ?? null;
    if (elapsed !== null) {
      overall.elapsed.push(elapsed);
      if (counted) {
        bump(projects, first.project).elapsed.push(elapsed);
        sess?.elapsed.push(elapsed);
        // One prompt, one asker: the timing goes to the first question's skill, model, agent and product.
        for (const k of SPLIT_KEYS) bump(splits[k], valueOf(first, k)).elapsed.push(elapsed);
        const profile = profileOf(first);
        if (profile) {
          profile.timed++;
          if (elapsed < FAST_ANSWER_MS) profile.fast++;
        }
      }
    }
  }

  const neg = (n: number | null) => (n === null ? null : -n);
  const newestFirst = (a: { ts: number | null }, b: { ts: number | null }) => nullsLast(neg(a.ts), neg(b.ts));
  const bySize = <T extends Rate>(a: T, b: T) => b.answered - a.answered;

  return {
    overall: { agreed: overall.agreed, answered: overall.answered },
    counts,
    calls: byCall.size,
    questions: rows.length,
    timing: {
      n: overall.elapsed.length,
      medianMs: median(overall.elapsed),
      fast: overall.elapsed.filter((ms) => ms < FAST_ANSWER_MS).length,
    },
    recent: { agreed: recent.agreed, answered: recent.answered },
    timeBuckets: overall.elapsed.reduce((buckets, ms) => {
      buckets[Math.min(TIME_BUCKETS, Math.max(0, Math.floor(ms / TIME_BUCKET_MS)))]++;
      return buckets;
    }, new Array<number>(TIME_BUCKETS + 1).fill(0)),
    modelProfiles: [...profiles.values()]
      .filter((p) => p.name !== UNKNOWN)
      .sort((a, b) => b.answered - a.answered || a.name.localeCompare(b.name))
      .slice(0, PROFILE_MAX),
    splits: Object.fromEntries(
      SPLIT_KEYS.map((k) => [
        k,
        [...splits[k]]
          .map(([name, b]) => ({ name, agreed: b.agreed, answered: b.answered, medianMs: median(b.elapsed), timed: b.elapsed.length }))
          .sort((x, y) => Number(x.name === UNKNOWN) - Number(y.name === UNKNOWN) || bySize(x, y) || x.name.localeCompare(y.name)),
      ]),
    ) as Record<SplitKey, SplitRow[]>,
    projects: [...projects]
      .map(([project, b]) => ({ project, agreed: b.agreed, answered: b.answered, medianMs: median(b.elapsed), timed: b.elapsed.length }))
      .sort((a, b) => bySize(a, b) || a.project.localeCompare(b.project)),
    sessions: [...sessions.values()]
      .map((s) => ({
        session: s.session,
        project: s.project,
        lastTs: s.lastTs,
        agreed: s.agreed,
        answered: s.answered,
        medianMs: median(s.elapsed),
        timed: s.elapsed.length,
        marks: (marks.get(`${s.project}/${s.session}`) ?? []).slice(-SESSION_MARKS).join(''),
      }))
      .sort((a, b) => newestFirst({ ts: a.lastTs }, { ts: b.lastTs }) || a.session.localeCompare(b.session))
      .slice(0, RECENT_SESSIONS),
    overrides: overrides.sort(newestFirst).slice(0, MAX_OVERRIDES),
  };
}

// ---------------------------------------------------------------- trend

export const TREND_WEEKS = 12;
const WEEK_MS = 7 * 24 * 3_600_000;

export interface WeekPoint {
  /** Monday 00:00 UTC of the week. */
  start: number;
  agreed: number;
  /** Answered questions that week; below MIN_N the week has a count and no share. */
  answered: number;
}

/** Monday 00:00 UTC on or before `ts`. */
export function weekStart(ts: number): number {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** The last `weeks` calendar weeks ending with the current one, oldest first; weeks without answers are present with zeros. */
export function weeklySeries(rows: readonly QuestionRow[], now: number, weeks: number = TREND_WEEKS): WeekPoint[] {
  const last = weekStart(now);
  const points: WeekPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) points.push({ start: last - i * WEEK_MS, agreed: 0, answered: 0 });
  const first = points[0].start;
  for (const row of rows) {
    if (row.askTs === null || !ANSWERED.has(row.outcome)) continue;
    const start = weekStart(row.askTs);
    if (start < first || start > last) continue;
    const point = points[Math.round((start - first) / WEEK_MS)];
    point.answered++;
    if (row.outcome === 'AGREED') point.agreed++;
  }
  return points;
}

export interface WeekTime {
  /** Monday 00:00 UTC of the week, the same weeks as weeklySeries(). */
  start: number;
  /** Median answer time of the prompts asked that week, or null when none was timed. */
  medianMs: number | null;
  timed: number;
}

/** The weekly median answer time for the same weeks as weeklySeries(): one timing per prompt, by the week it was asked. */
export function weeklyTimes(rows: readonly QuestionRow[], now: number, weeks: number = TREND_WEEKS): WeekTime[] {
  const last = weekStart(now);
  const first = last - (weeks - 1) * WEEK_MS;
  const elapsed: number[][] = Array.from({ length: weeks }, () => []);
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.askTs === null || row.elapsedMs === null || seen.has(row.call)) continue;
    seen.add(row.call);
    const start = weekStart(row.askTs);
    if (start < first || start > last) continue;
    elapsed[Math.round((start - first) / WEEK_MS)].push(row.elapsedMs);
  }
  return elapsed.map((list, i) => ({ start: first + i * WEEK_MS, medianMs: median(list), timed: list.length }));
}

// ---------------------------------------------------------------- listing

/** Display name for a project directory: Claude Code names it after the cwd with separators as dashes. */
export function projectLabel(dirName: string, home: string): string {
  const enc = home.replace(/[^A-Za-z0-9]/g, '-');
  if (dirName === enc) return HOME_PROJECT;
  return dirName.startsWith(`${enc}-`) ? dirName.slice(enc.length + 1) : dirName;
}

/** Regular *.jsonl files under root (symlinks are not followed). Throws when root cannot be read. */
export async function listTranscripts(root: string, home: string): Promise<FileRef[]> {
  const out: FileRef[] = [];
  const walk = async (dir: string, top: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (top) throw err;
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, false);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const rel = path.relative(root, full).split(path.sep);
        if (rel.length < 2) continue; // a transcript always sits inside a project directory
        // <project>/<session>.jsonl, or <project>/<session>/subagents/<agent>.jsonl
        const session = rel.length === 2 ? rel[1].replace(/\.jsonl$/, '') : rel[1];
        out.push({ path: full, project: projectLabel(rel[0], home), session });
      }
    }
  };
  await walk(root, true);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
