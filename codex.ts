/**
 * codex.ts: questions asked by the Codex CLI. The only module that knows Codex's payload shape.
 *
 * Codex has a question tool, `request_user_input`, and runs hooks around it the way Claude Code
 * does around AskUserQuestion. hooks/codex-hooks.json registers hook.ts for that one tool, with
 * "codex" as its second argument; hook.ts hands such a call to codexObservations() and does
 * nothing else with it: no session event, no server start, no attrs state.
 *
 * Measured on Codex CLI 0.163.0 (one non-interactive run):
 *   every payload    session_id, cwd, model, permission_mode, hook_event_name
 *   PreToolUse       tool_name "request_user_input", tool_use_id, turn_id,
 *                    tool_input.questions[] = { id, header, question, options[] = { label, description } }
 *                    the model marks its pick with a label ending in "(Recommended)"; no multi-select
 *   PostToolUse      the same, plus tool_response: a JSON *string*. Unanswered: '{"answers":{}}'
 *
 * NOT measured: the tool_response of an answered question. Other tools' notes describe
 * {"answers": {"<question id>": {"answers": ["<label>"]}}}. This reader accepts that, and the
 * plainer {"answers": {"<id>": "<label>"}}, keyed by id or by question text. Anything else is
 * stored as UNDECODED, which the board reports as "answers could not be read": a wrong guess about
 * the shape shows up as that banner, never as a made-up override.
 *
 * An empty answers object means the tool returned without an answer (Codex cannot ask in exec
 * mode, and presumably when the question is dismissed): the question is stored as dismissed.
 *
 * Stored per question: the same fields as for Claude Code (outcomes.ts), with product "Codex CLI",
 * the model from the payload and the agent "main agent". Option text and the answer are never
 * stored. Codex has no skill attribution, so the skill stays unknown.
 */
import { MAIN_AGENT } from './attrs';
import { classify, projectOfCwd, titleOf, toQuestions, type CallResult, type QuestionDef } from './judgment';
import { ASKED, FORMAT_VERSION, type Observation } from './outcomes';

export const CODEX = 'Codex CLI';
export const CODEX_QUESTION_TOOL = 'request_user_input';
/** The second argument hooks/codex-hooks.json passes to the hook. */
export const CODEX_ARG = 'codex';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** One answer as a string, from the shapes described in the header; null when it is none of them. */
function answerText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  if (isObject(v)) return answerText(v.answers ?? v.answer);
  return null;
}

/**
 * The result of a question call, in the form classify() takes (answers keyed by question text).
 * `ids` are the questions' ids, in order.
 */
export function codexResult(questions: readonly QuestionDef[], ids: readonly (string | null)[], response: unknown): CallResult {
  let body: unknown = response;
  if (typeof response === 'string') {
    try {
      body = JSON.parse(response);
    } catch {
      return { kind: 'undecoded' };
    }
  }
  if (!isObject(body) || !isObject(body.answers)) return { kind: 'undecoded' };
  const given = body.answers;
  if (Object.keys(given).length === 0) return { kind: 'rejected' }; // the tool came back without an answer
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const id = ids[i];
    const text = answerText((id !== null ? given[id] : undefined) ?? given[q.question]);
    if (text !== null) answers[q.question] = text;
  });
  // An answer that is there but unreadable leaves its question out; classify() then calls it UNDECODED.
  return { kind: 'answers', answers };
}

/** What one Codex hook payload adds to the store: nothing, unless it is the question tool. */
export function codexObservations(v: unknown, now: number, home: string): Observation[] {
  if (!isObject(v)) return [];
  const event = str(v.hook_event_name);
  const session = str(v.session_id);
  const call = str(v.tool_use_id);
  if (v.tool_name !== CODEX_QUESTION_TOOL || !session || !call) return [];
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return [];
  const base = { v: FORMAT_VERSION, source: 'hook' as const, call, session, project: projectOfCwd(str(v.cwd), home) ?? '(unknown)' };
  const raw = isObject(v.tool_input) ? v.tool_input.questions : null;
  const questions = toQuestions(raw);
  if (!questions) {
    // A payload this reader cannot read still leaves a trace, so the board can say so.
    return event === 'PostToolUse' ? [{ ...base, pos: 0, kind: 'UNDECODED', chip: '', title: '', askTs: null, answerTs: now }] : [];
  }
  if (event === 'PreToolUse') {
    // Who asked is fixed here; the answer's line carries none of it (outcomes.ts).
    const model = str(v.model);
    const who = { product: CODEX, agent: MAIN_AGENT, ...(model ? { model } : {}) };
    return questions.map((q, pos) => ({ ...base, ...who, pos, kind: ASKED, chip: q.header, title: titleOf(q.question), askTs: now, answerTs: null }));
  }
  const ids = (raw as unknown[]).map((q) => (isObject(q) ? str(q.id) : null));
  const result = codexResult(questions, ids, v.tool_response);
  return questions.map((q, pos) => ({ ...base, pos, kind: classify(q, result), chip: q.header, title: titleOf(q.question), askTs: null, answerTs: now }));
}
