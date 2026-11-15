/**
 * attrs.ts: who asked a question. The only module that knows how that is found out.
 *
 *   note(dir, event)        live: remember what a hook event says about the current skill or model
 *   at(dir, event)          live: who is asking, at the moment a question is asked
 *   fromTranscript(line)    import: who asked, as Claude Code recorded it on the asking line
 *
 * Why state is needed: the hook payload of a question says which agent asked (agent_type) but not
 * which skill or model (measured on Claude Code 2.1.325). Those arrive on other events:
 *
 *   PreToolUse for the Skill tool   tool_input.skill        the agent started a skill
 *   UserPromptExpansion             command_name            the user typed a command
 *   Stop                                                    the turn ended: the skill ends with it
 *   SubagentStop                                            that agent is gone
 *   SessionStart (when it says so)  model                   the session's model
 *   PostModelSwitch                 to_model                the model changed
 *   SessionEnd                                              the session's state is removed
 *
 * The skill rule (set by a skill call or a typed command, cleared when the turn ends) agrees with
 * Claude Code's own attribution on 1,470 of 1,473 questions in one user's history. The known
 * differences: a plain prompt typed in the middle of a turn, and two questions after a
 * compaction. An import corrects them, since the transcript's value wins (outcomes.ts).
 *
 * State on disk: <dir>/attrs/<session>/<agent>.skill and <dir>/attrs/<session>/model, one short
 * value each, 0600. One file per session and agent, so two hook processes never rewrite the same
 * file for different agents and nothing is read, changed and written back. A session's folder is
 * removed when the session ends, and after 7 days without a change.
 *
 * Values: a skill or command name without its plugin prefix, as transcripts write it; NO_SKILL
 * when the question was asked outside any skill; MAIN_AGENT when no subagent asked. A value that
 * is not known is left out, never guessed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Asked outside any skill. A skill name has no space, so this cannot collide with one. */
export const NO_SKILL = 'no skill';
/** Asked by the session's own agent, not a subagent. */
export const MAIN_AGENT = 'main agent';
/** The product every question came from before products were recorded, and the one this hook serves. */
export const CLAUDE_CODE = 'Claude Code';
/** How a split names the questions whose value no source captured. */
export const UNKNOWN = 'unknown';
export const STATE_DIR = 'attrs';
export const STATE_MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAIN = 'main';
const VALUE_MAX = 80;
/** Set once a typed command has been seen expanding: only then does "no skill file" mean "no skill". */
const EXPANSION_SEEN = '.expansion-seen';

export interface Who {
  model?: string;
  skill?: string;
  agent?: string;
  product?: string;
}

/** What attrs needs from a hook payload; hook.ts reads the payload and fills this. */
export interface AttrEvent {
  event: string;
  sessionId: string;
  /** Present when the event fired inside a subagent. */
  agentId: string | null;
  agentType: string | null;
  toolName: string | null;
  /** tool_input.skill of a Skill tool call. */
  skill: string | null;
  /** command_name of a UserPromptExpansion. */
  commandName: string | null;
  /** model (SessionStart) or to_model (PostModelSwitch). */
  model: string | null;
}

/** "plugin:skill" and "/skill" both become "skill", the way transcripts name it. */
export function skillName(raw: string): string | null {
  const name = raw.trim().replace(/^\//, '').split(':').pop()!.trim().slice(0, VALUE_MAX);
  return name || null;
}

/** Ids become file names, so only plain ones are used; anything else gets no state at all. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safe = (id: string | null): string | null => (id !== null && SAFE_ID.test(id) ? id : null);

function sessionDir(dir: string, sessionId: string): string | null {
  const id = safe(sessionId);
  return id ? path.join(dir, STATE_DIR, id) : null;
}
function agentKey(agentId: string | null): string | null {
  return agentId === null ? MAIN : safe(agentId);
}

function put(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write beside the file and rename: a reader sees the old value or the new one, never half of one.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value.slice(0, VALUE_MAX), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function get(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim().slice(0, VALUE_MAX) || null;
  } catch {
    return null;
  }
}

/** Remove the state of sessions that left no trace for STATE_MAX_AGE_MS (a session that never ended). */
function prune(dir: string, now: number): void {
  const root = path.join(dir, STATE_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!SAFE_ID.test(name)) continue;
    const full = path.join(root, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory() && now - st.mtimeMs > STATE_MAX_AGE_MS) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to remove
    }
  }
}

/**
 * Remember what this event says. Most events say nothing and cost nothing. Throws on a failed
 * write; the caller logs it and carries on, and the attribute is then simply not known.
 */
export function note(dir: string, e: AttrEvent, now: number = Date.now()): void {
  const sdir = sessionDir(dir, e.sessionId);
  if (!sdir) return;
  const agent = agentKey(e.agentId);
  switch (e.event) {
    case 'SessionStart':
      prune(dir, now);
      if (e.model) put(path.join(sdir, 'model'), e.model);
      return;
    case 'PostModelSwitch':
      if (e.model) put(path.join(sdir, 'model'), e.model);
      return;
    case 'PreToolUse': {
      const name = e.toolName === 'Skill' && e.skill ? skillName(e.skill) : null;
      if (name && agent) put(path.join(sdir, `${agent}.skill`), name);
      return;
    }
    case 'UserPromptExpansion': {
      const name = e.commandName ? skillName(e.commandName) : null;
      if (!name) return;
      put(path.join(sdir, `${MAIN}.skill`), name);
      const seen = path.join(dir, STATE_DIR, EXPANSION_SEEN);
      if (!fs.existsSync(seen)) put(seen, '1');
      return;
    }
    case 'Stop':
      // The turn of the session's own agent ended. A subagent's skill ends with the subagent.
      fs.rmSync(path.join(sdir, `${MAIN}.skill`), { force: true });
      return;
    case 'SubagentStop':
      if (agent && agent !== MAIN) fs.rmSync(path.join(sdir, `${agent}.skill`), { force: true });
      return;
    case 'SessionEnd':
      fs.rmSync(sdir, { recursive: true, force: true });
      return;
  }
}

/** Who is asking, read at the moment of asking. Never throws; what cannot be read is left out. */
export function at(dir: string, e: AttrEvent): Who {
  const who: Who = { agent: e.agentType?.trim().slice(0, VALUE_MAX) || MAIN_AGENT };
  const sdir = sessionDir(dir, e.sessionId);
  const agent = agentKey(e.agentId);
  if (!sdir || !agent) return who;
  const model = get(path.join(sdir, 'model'));
  if (model) who.model = model;
  const skill = get(path.join(sdir, `${agent}.skill`));
  if (skill) who.skill = skill;
  // No skill on record means "outside any skill" only when typed commands are known to reach this
  // hook. On a Claude Code that does not send UserPromptExpansion a typed command would be missed,
  // so there the skill is left unknown rather than called "no skill".
  else if (fs.existsSync(path.join(dir, STATE_DIR, EXPANSION_SEEN))) who.skill = NO_SKILL;
  return who;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Who asked, from a transcript line that holds the question. Only an assistant line carries
 * Claude Code's attribution; the timestamp-less copy shape says nothing and yields nothing.
 * `attributionSkill` exists in every Claude Code version seen (2.1.224 to 2.1.325), so on an
 * assistant line its absence is Claude Code's own "no skill attributed".
 */
export function fromTranscript(line: unknown): Who {
  if (!isObject(line) || line.type !== 'assistant' || !isObject(line.message)) return {};
  const who: Who = {};
  const model = typeof line.message.model === 'string' ? line.message.model.trim().slice(0, VALUE_MAX) : '';
  if (model) who.model = model;
  const attributed = typeof line.attributionSkill === 'string' ? skillName(line.attributionSkill) : null;
  who.skill = attributed ?? NO_SKILL;
  // A subagent's line does not name the agent type; the hook's value is used for those.
  if (line.isSidechain !== true) who.agent = MAIN_AGENT;
  return who;
}
