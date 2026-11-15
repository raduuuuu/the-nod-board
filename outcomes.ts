/**
 * outcomes.ts: the history of question outcomes. The only module that knows the file.
 *
 *   appendObservation(dir, obs)   one short line appended (the hook's write path)
 *   appendNew(dir, observations)  append only observations not already stored (the import's write path)
 *   readQuestions(dir, opts)      every question, reconciled to one outcome each
 *   importHistory(dir, ...)       past sessions from Claude Code transcripts, through appendNew
 *   boardData(dir, opts)          the numbers and the weekly trend the dashboard shows
 *
 * File: <dir>/outcomes.jsonl, append-only, 0600, never compacted (session-event compaction in
 * inbox.ts does not touch it). One JSON line per observation. An observation is what one source
 * saw about one question at one moment; several may exist per question:
 *   hook, PreToolUse   -> ASKED
 *   hook, PostToolUse  -> the classified outcome
 *   import             -> the classified outcome from a transcript, ASKED when it holds no result,
 *                         CONFLICT when its copies contradict each other
 *
 * What a line holds (and nothing else): the question's identity (call id + position), its
 * outcome, label chip, first line (cut to 120 characters), session, project and two timestamps.
 * Option text and answers are never written.
 *
 * Reconciliation, per question, strongest evidence wins; arrival order never matters:
 *   CONFLICT, or two different observed answers ...... UNDECODED
 *   an observed answer or an exclusion ............... that outcome
 *   an observed rejection (from a transcript) ........ DISMISSED
 *   UNDECODED ........................................ UNDECODED
 *   only ASKED ....................................... DISMISSED (inferred) once the session moved on,
 *                                                      otherwise UNANSWERED
 * "The session moved on" means a later prompt, Stop or SessionEnd in that session, a later
 * question in it, or no trace of the session for 7 days. A dismissed question fires no hook of
 * its own, so this is an inference and the row says so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFLICT,
  OUTCOMES,
  aggregate,
  classify,
  listTranscripts,
  mergeCalls,
  scanChunks,
  titleOf,
  weeklySeries,
  type FileRef,
  type FileRows,
  type MergedCall,
  type Outcome,
  type QuestionRow,
  type Totals,
  type WeekPoint,
} from './judgment';

export const OUTCOMES_FILE = 'outcomes.jsonl';
export const FORMAT_VERSION = 1;
export const ASKED = 'ASKED';
/** An unanswered question whose session left no later trace for this long is taken as dismissed. */
export const SESSION_GONE_MS = 7 * 24 * 3_600_000;

export type ObservedKind = Outcome | typeof ASKED | typeof CONFLICT;

export interface Observation {
  v: typeof FORMAT_VERSION;
  source: 'hook' | 'import';
  call: string;
  pos: number;
  kind: ObservedKind;
  chip: string;
  title: string;
  session: string;
  project: string;
  /** When the question was asked, if this source saw that. */
  askTs: number | null;
  /** When the answer or rejection arrived, if this source saw that. */
  answerTs: number | null;
}

const KINDS: ReadonlySet<string> = new Set<string>([...OUTCOMES, ASKED, CONFLICT]);

function toObservation(v: unknown): Observation | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ts = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : x === null ? null : undefined);
  const askTs = ts(o.askTs);
  const answerTs = ts(o.answerTs);
  if (o.v !== FORMAT_VERSION) return null;
  if (o.source !== 'hook' && o.source !== 'import') return null;
  if (typeof o.call !== 'string' || !o.call) return null;
  if (typeof o.pos !== 'number' || !Number.isInteger(o.pos) || o.pos < 0) return null;
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  if (typeof o.chip !== 'string' || typeof o.title !== 'string') return null;
  if (typeof o.session !== 'string' || typeof o.project !== 'string') return null;
  if (askTs === undefined || answerTs === undefined) return null;
  return {
    v: FORMAT_VERSION,
    source: o.source,
    call: o.call,
    pos: o.pos,
    kind: o.kind as ObservedKind,
    chip: o.chip,
    title: o.title,
    session: o.session,
    project: o.project,
    askTs,
    answerTs,
  };
}

/** Fixed key order, so identical observations are identical lines. */
function lineOf(o: Observation): string {
  return JSON.stringify({
    v: o.v,
    source: o.source,
    call: o.call,
    pos: o.pos,
    kind: o.kind,
    chip: o.chip,
    title: o.title,
    session: o.session,
    project: o.project,
    askTs: o.askTs,
    answerTs: o.answerTs,
  });
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** One append per observation: short enough to land whole when several sessions write at once. */
export function appendObservation(dir: string, obs: Observation): void {
  ensureDir(dir);
  fs.appendFileSync(path.join(dir, OUTCOMES_FILE), lineOf(obs) + '\n', { mode: 0o600 });
}

export interface StoredObservations {
  observations: Observation[];
  /** Lines that are not a version-1 observation (including an unfinished last line). */
  unreadable: number;
}

export function readObservations(dir: string): StoredObservations {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, OUTCOMES_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { observations: [], unreadable: 0 };
    throw err;
  }
  const out: StoredObservations = { observations: [], unreadable: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obs: Observation | null = null;
    try {
      obs = toObservation(JSON.parse(line));
    } catch {
      obs = null;
    }
    if (obs) out.observations.push(obs);
    else out.unreadable++;
  }
  return out;
}

/**
 * Append the observations that are not stored yet and return how many were added. Only an
 * identical observation is skipped: new or stronger evidence about a known question is added,
 * so a later import can supply an answer the hook missed.
 */
export function appendNew(dir: string, observations: readonly Observation[]): number {
  const have = new Set(readObservations(dir).observations.map(lineOf));
  const fresh: string[] = [];
  for (const obs of observations) {
    const line = lineOf(obs);
    if (have.has(line)) continue;
    have.add(line);
    fresh.push(line);
  }
  if (!fresh.length) return 0;
  ensureDir(dir);
  fs.appendFileSync(path.join(dir, OUTCOMES_FILE), fresh.map((l) => l + '\n').join(''), { mode: 0o600 });
  return fresh.length;
}

export interface ReconcileOptions {
  now: number;
  /** Latest prompt, Stop or SessionEnd seen for a session, or null. Notifications do not count. */
  movedOnAt?: (session: string) => number | null;
}

const RANK = { conflict: 5, decided: 4, dismissed: 3, undecoded: 2, asked: 1 } as const;
function rankOf(kind: ObservedKind): number {
  if (kind === CONFLICT) return RANK.conflict;
  if (kind === ASKED) return RANK.asked;
  if (kind === 'UNDECODED') return RANK.undecoded;
  if (kind === 'DISMISSED') return RANK.dismissed;
  if (kind === 'UNANSWERED') return RANK.asked;
  return RANK.decided;
}

const earliest = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

export function reconcile(observations: readonly Observation[], opts: ReconcileOptions): QuestionRow[] {
  const byQuestion = new Map<string, Observation[]>();
  const callAsk = new Map<string, number | null>();
  const callAnswer = new Map<string, number | null>();
  const sessionLastAsk = new Map<string, number>();
  for (const o of observations) {
    const key = `${o.call}\u0000${o.pos}`;
    const list = byQuestion.get(key);
    if (list) list.push(o);
    else byQuestion.set(key, [o]);
    callAsk.set(o.call, earliest(callAsk.get(o.call) ?? null, o.askTs));
    if (rankOf(o.kind) === RANK.decided) callAnswer.set(o.call, earliest(callAnswer.get(o.call) ?? null, o.answerTs));
    if (o.askTs !== null && o.askTs > (sessionLastAsk.get(o.session) ?? -Infinity)) sessionLastAsk.set(o.session, o.askTs);
  }

  const rows: QuestionRow[] = [];
  for (const list of byQuestion.values()) {
    // Describe the question from its best-informed observation; ties go to the hook, then to the earlier one.
    const best = [...list].sort(
      (a, b) =>
        rankOf(b.kind) - rankOf(a.kind) ||
        (a.source === b.source ? 0 : a.source === 'hook' ? -1 : 1) ||
        (a.answerTs ?? Infinity) - (b.answerTs ?? Infinity),
    )[0];
    const decided = new Set(list.filter((o) => rankOf(o.kind) === RANK.decided).map((o) => o.kind));
    const askTs = callAsk.get(best.call) ?? null;
    let outcome: Outcome;
    let inferred = false;
    if (list.some((o) => o.kind === CONFLICT) || decided.size > 1) outcome = 'UNDECODED';
    else if (decided.size === 1) outcome = [...decided][0] as Outcome;
    else if (list.some((o) => o.kind === 'DISMISSED')) outcome = 'DISMISSED';
    else if (list.some((o) => o.kind === 'UNDECODED')) outcome = 'UNDECODED';
    else {
      const movedOn = opts.movedOnAt?.(best.session) ?? null;
      const gone =
        askTs !== null &&
        ((movedOn !== null && movedOn > askTs) ||
          (sessionLastAsk.get(best.session) ?? -Infinity) > askTs ||
          opts.now - askTs > SESSION_GONE_MS);
      outcome = gone ? 'DISMISSED' : 'UNANSWERED';
      inferred = gone;
    }
    const answerTs = callAnswer.get(best.call) ?? null;
    // The call was answered when exactly one decided outcome was observed for this question.
    const answered = decided.size === 1 && outcome !== 'UNDECODED';
    rows.push({
      call: best.call,
      pos: best.pos,
      outcome,
      inferred,
      chip: best.chip,
      title: best.title,
      session: best.session,
      project: best.project,
      askTs,
      // Elapsed time belongs to the call; aggregate() counts it once per call.
      elapsedMs: answered && askTs !== null && answerTs !== null && answerTs >= askTs ? answerTs - askTs : null,
    });
  }
  return rows.sort((a, b) => (a.askTs ?? Infinity) - (b.askTs ?? Infinity) || a.call.localeCompare(b.call) || a.pos - b.pos);
}

export function readQuestions(dir: string, opts: ReconcileOptions): { rows: QuestionRow[]; unreadable: number } {
  const stored = readObservations(dir);
  return { rows: reconcile(stored.observations, opts), unreadable: stored.unreadable };
}

// ---------------------------------------------------------------- what the dashboard shows

export interface BoardData {
  totals: Totals;
  /** The last 12 calendar weeks, oldest first. */
  weekly: WeekPoint[];
  /** Lines in the store that could not be read. */
  unreadable: number;
  /** Which sources have written at least one observation. */
  sources: { hook: boolean; import: boolean };
  /** Dismissals that were inferred from the session moving on, not observed. */
  inferredDismissed: number;
}

export function boardData(dir: string, opts: ReconcileOptions): BoardData {
  const stored = readObservations(dir);
  const rows = reconcile(stored.observations, opts);
  return {
    totals: aggregate(rows),
    weekly: weeklySeries(rows, opts.now),
    unreadable: stored.unreadable,
    sources: {
      hook: stored.observations.some((o) => o.source === 'hook'),
      import: stored.observations.some((o) => o.source === 'import'),
    },
    inferredDismissed: rows.filter((r) => r.inferred && r.outcome === 'DISMISSED').length,
  };
}

// ---------------------------------------------------------------- import of past sessions

/** What a transcript says about each question of each call, as observations. */
export function observationsFromCalls(calls: readonly MergedCall[]): Observation[] {
  const out: Observation[] = [];
  for (const call of calls) {
    call.questions.forEach((q, pos) => {
      const outcome = classify(q, call.result);
      // An unanswered question is stored as asked, so that it can still become dismissed or answered.
      const kind: ObservedKind = call.result?.kind === 'conflict' ? CONFLICT : outcome === 'UNANSWERED' ? ASKED : outcome;
      out.push({
        v: FORMAT_VERSION,
        source: 'import',
        call: call.id,
        pos,
        kind,
        chip: q.header,
        title: titleOf(q.question),
        session: call.session,
        project: call.project,
        askTs: call.ts,
        // Only an answer or a recorded rejection has a time; an excluded question in a rejected call has none.
        answerTs: call.result?.kind === 'answers' || kind === 'DISMISSED' ? call.resultTs : null,
      });
    });
  }
  return out;
}

export interface ImportReport {
  files: number;
  /** Files that could not be read. */
  skipped: number;
  /** Files holding an AskUserQuestion call this parser could not read. */
  unrecognizedFiles: number;
  questions: number;
  /** Observations appended by this run; 0 when everything was already stored. */
  added: number;
}

/**
 * Read every transcript under `transcriptsDir` once and append what is new. Safe to repeat:
 * unchanged history adds nothing, and a session that has since been answered adds its answers.
 * Throws when the transcripts directory cannot be listed.
 */
export async function importHistory(dir: string, transcriptsDir: string, home: string): Promise<ImportReport> {
  const refs = await listTranscripts(transcriptsDir, home);
  const files: { ref: FileRef; rows: FileRows }[] = [];
  let skipped = 0;
  for (const ref of refs) {
    try {
      files.push({ ref, rows: await scanChunks(fs.createReadStream(ref.path, { highWaterMark: 1 << 20 })) });
    } catch {
      skipped++;
    }
  }
  const observations = observationsFromCalls(mergeCalls(files, home));
  return {
    files: files.length,
    skipped,
    unrecognizedFiles: files.filter((f) => f.rows.unrecognized > 0).length,
    questions: observations.length,
    added: appendNew(dir, observations),
  };
}
