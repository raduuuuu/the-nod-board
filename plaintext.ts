/**
 * plaintext.ts: the estimate of how many replies end with a recommendation made in plain text.
 * The only module that knows the phrase list and the turns folder.
 *
 *   hasRecommendation(text)          does a reply's text hold a recommendation phrase
 *   noteTurnEnd(dir, now, matched)   the hook's write: one line appended to today's file
 *   turnWindows(dir, now)            the server's read: the last 7 days and the 7 before
 *   noticeShownAt / markNoticeShown  when this machine's user was told about the check
 *
 * Why it exists: the board counts a choice only when the agent asks it through the question tool.
 * A recommendation written in an ordinary reply is never seen. This module does not try to learn
 * whether the user agreed; it only notes that such a reply happened, so the board can say how
 * much is outside its exact share.
 *
 * What is read: the text of the agent's final message of a turn, in memory, at most TEXT_MAX
 * characters, with fenced code and quoted lines removed. What is stored: nothing from that text.
 *
 *   <dir>/turns/<UTC day>   one line per checked turn end: "1" (a phrase was found) or "0".
 *                           No session id and no time of day. Appended, never rewritten, never
 *                           compacted (about 400 bytes on a busy day). Any other line is ignored.
 *   <dir>/plain-text-notice the time the one-time notice was shown. Until it exists nothing is
 *                           checked; it is also the "counting since" the board shows.
 *
 * A server older than this module never opens either, so a rollback shows a normal board.
 *
 * Offers. A reply can also end by asking for a go-ahead: "Want me to start?", or "Say the word
 * and I'll merge it". hasOffer() looks for that in the last OFFER_TAIL characters of the same
 * final message. It is counted beside the recommendations, never added to them, in a store of
 * the same shape with its own one-time notice:
 *
 *   <dir>/offers/<UTC day>  one line per checked turn end: "1" (an offer was found) or "0".
 *   <dir>/offers-notice     the time the offers notice was shown; nothing is noted before it.
 *
 * Keeping it apart leaves the recommendation store exactly as it was, gives the offers their own
 * "checked" count (turn ends from before their notice say nothing about offers), and means an
 * older server ignores it whole.
 *
 * The phrase list was measured on one person's history on 2026-11-16: 43 of 46 matches were real
 * recommendations (93%); at least 4 in 10 real recommendations use other words and are missed.
 * It is English only. Re-measure before changing it.
 *
 * The offer phrases were measured on the same person's history on 2026-11-17 (1,091 distinct
 * replies): all 88 question matches put a decision to the user (80 were yes/no offers, 8 were
 * "A or B?"); of 60 sampled go-ahead matches about 55 were real. "say so" was measured and left
 * out: half its matches were other uses. Offers in other words ("I can rename it if you want")
 * are missed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TURNS_DIR = 'turns';
export const NOTICE_FILE = 'plain-text-notice';
export const TEXT_MAX = 20_000;
export const WINDOW_DAYS = 7;
const DAY_MS = 24 * 3_600_000;

/** Literal phrases, lower case. Matched as whole words, anywhere in the cleaned text. */
export const PHRASES: readonly string[] = [
  "i'd recommend",
  'i would recommend',
  'i recommend',
  'my recommendation',
  'recommendation:',
  "i'd suggest",
  'i would suggest',
  'i suggest',
  "i'd go with",
  "i'd do",
  "i'd pick",
  "i'd choose",
  "i'd lean",
  'my pick',
];
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One alternation of literals: no nested repetition, so the time is linear in the text.
const PATTERN = new RegExp(`(?:^|[^a-z])(?:${PHRASES.map(escaped).join('|')})(?![a-z])`, 'i');
const FENCE = /```[\s\S]*?```/g;
const QUOTED_LINE = /^>.*$/gm;

/** True when the reply holds a recommendation phrase outside code and quotes. Curly apostrophes count. */
export function hasRecommendation(text: string): boolean {
  const cleaned = text.slice(0, TEXT_MAX).replace(/’/g, "'").replace(FENCE, ' ').replace(QUOTED_LINE, ' ');
  return PATTERN.test(cleaned);
}

export const OFFERS_DIR = 'offers';
export const OFFERS_NOTICE_FILE = 'offers-notice';
/** An offer closes a reply, so only its end is looked at. */
export const OFFER_TAIL = 400;
/** Offers asked as a question: the phrase, then a question mark on the same line within 200 characters. */
export const OFFER_QUESTIONS: readonly string[] = ['do you want me to', 'would you like me to', 'want me to', 'should i', 'shall i'];
/**
 * Offers made as a request for a go-ahead. `say "<a few words>"` is matched besides these, but
 * only where a sentence or clause begins: 'it should say "left"' describes text, it asks nothing.
 */
export const OFFER_REQUESTS: readonly string[] = ['say the word', 'say go', 'say if you', 'say which', 'tell me if you', 'tell me which', 'tell me whether'];
const words = (list: readonly string[]) => list.map(escaped).join('|');
// Literals and bounded runs only, over at most OFFER_TAIL characters.
const OFFER_QUESTION = new RegExp(`(?:^|[^a-z])(?:${words(OFFER_QUESTIONS)})(?![a-z])[^?\\n]{0,200}\\?`, 'i');
const OFFER_REQUEST = new RegExp(`(?:^|[^a-z])(?:${words(OFFER_REQUESTS)})(?![a-z])`, 'i');
const OFFER_SAY_QUOTED = /(?:^|[.!?;,\n]\s+|[—–]\s*)(?:(?:and|or|then)\s+)?say "[^"\n]{1,40}"/i;

/** True when the reply ends with an offer: a question such as "Want me to start?", or a request such as "Say the word and I'll start". */
export function hasOffer(text: string): boolean {
  const cleaned = text.slice(0, TEXT_MAX).replace(/’/g, "'").replace(/[“”]/g, '"').replace(FENCE, ' ').replace(QUOTED_LINE, ' ');
  const tail = cleaned.trimEnd().slice(-OFFER_TAIL);
  return OFFER_QUESTION.test(tail) || OFFER_REQUEST.test(tail) || OFFER_SAY_QUOTED.test(tail);
}

/** "2026-11-16": the UTC day a time falls in, which names its file. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Append one checked turn end. Throws when the folder or file cannot be written; the hook logs that. */
export function noteTurnEnd(dir: string, now: number, matched: boolean, store: string = TURNS_DIR): void {
  const folder = path.join(dir, store);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(folder, dayKey(now)), matched ? '1\n' : '0\n', { mode: 0o600 });
}

export interface TurnCount {
  checked: number;
  matched: number;
}

/** One day's counts. A missing file is a day with nothing checked; any other read error throws. */
function dayCount(dir: string, day: string, store: string): TurnCount {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, store, day), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { checked: 0, matched: 0 };
    throw err;
  }
  const out = { checked: 0, matched: 0 };
  for (const line of text.split('\n')) {
    if (line === '1') out.matched++;
    if (line === '1' || line === '0') out.checked++;
  }
  return out;
}

function sumDays(dir: string, lastDayTs: number, days: number, store: string): TurnCount {
  const out = { checked: 0, matched: 0 };
  for (let i = 0; i < days; i++) {
    const c = dayCount(dir, dayKey(lastDayTs - i * DAY_MS), store);
    out.checked += c.checked;
    out.matched += c.matched;
  }
  return out;
}

export interface TurnWindows {
  /** When checking began on this machine. */
  since: number;
  /** The last WINDOW_DAYS UTC days, today included. */
  last: TurnCount;
  /** The WINDOW_DAYS days before those, or null when checking began inside them. */
  before: TurnCount | null;
}

/**
 * What the board shows, or null while the notice has not been shown (nothing is checked yet).
 * Throws when a day file exists and cannot be read: the caller says so and keeps its own numbers.
 */
export function turnWindows(dir: string, now: number, store: string = TURNS_DIR, notice: string = NOTICE_FILE): TurnWindows | null {
  const since = noticeShownAt(dir, notice);
  if (since === null) return null;
  const beforeEnd = now - WINDOW_DAYS * DAY_MS;
  const beforeStartDay = dayKey(now - (2 * WINDOW_DAYS - 1) * DAY_MS);
  return {
    since,
    last: sumDays(dir, now, WINDOW_DAYS, store),
    before: dayKey(since) <= beforeStartDay ? sumDays(dir, beforeEnd, WINDOW_DAYS, store) : null,
  };
}

/** When the notice was shown here, or null when it was not (or the marker cannot be read). */
export function noticeShownAt(dir: string, file: string = NOTICE_FILE): number | null {
  try {
    const ts = Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

/** Record that the notice was shown. Called only after the line was written out. Throws on failure. */
export function markNoticeShown(dir: string, now: number, file: string = NOTICE_FILE): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, file), `${now}\n`, { mode: 0o600 });
}

/** Shown once to the user at a session start, before anything is checked. Never reaches the agent. */
export function noticeLine(settingsFile: string): string {
  return `The Nod Board now checks the agent's last message of each turn for recommendation phrases, to estimate how many choices are made in plain text. It stores a 1 or a 0 per reply, never the text, and does not read what you type. To turn it off, add "count_plain_text": false to ${settingsFile}.`;
}
/** The notice for the default data directory. */
export const NOTICE_LINE = noticeLine('~/.agent-inbox/settings.json');

/**
 * Shown once, at a session start after the one that showed the notice above, before any offer is
 * noted. A machine that already saw the first notice was told "a 1 or a 0 per reply"; this says
 * what is added.
 */
export function offersNoticeLine(settingsFile: string): string {
  return `The Nod Board now also checks the end of the agent's last message of each turn for an offer, such as "Want me to start?" or "Say the word and I'll start". It stores one more 1 or 0 per reply, never the text, and still does not read what you type. To turn both checks off, add "count_plain_text": false to ${settingsFile}.`;
}

/** The per-session value that says whether this turn may be checked (hook.ts sets and reads it). */
export const TURN_STATE = 'turn';
/** Written at a prompt: nothing was asked through the tool in this turn so far. */
export const TURN_CLEAR = 'clear';
/** Written when a question goes through the tool: its turn end is not checked. */
export const TURN_ASKED = 'asked';
/** The per-session value that holds the prompt id of the turn that asked, so a prompt event inside that turn is known. */
export const TURN_PROMPT = 'turn-prompt';
/** The per-session value that holds the ids of background tasks whose end will arrive as a prompt nobody typed. */
export const TURN_DUE = 'turn-due';
/** At most this many are remembered; with TASK_ID they fit one stored value. */
export const DUE_MAX = 4;
/** A background task id as Claude Code writes it. Anything else is ignored, so nothing but a plain id is ever kept. */
export const TASK_ID = /^[A-Za-z0-9_-]{1,19}$/;
