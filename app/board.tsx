/**
 * board.tsx: the whole dashboard as pure components (DESIGN.md).
 *
 *   wide (1024px and up)                          narrow
 *   +-------------+----------------------------+   Needs you
 *   | NEEDS YOU   | acceptance number, outcome |   acceptance number, outcome bar,
 *   | (aside)     |   bar, last 7 days         |     last 7 days
 *   | TODOS,      |   [histogram of answer     |   histogram of answer times
 *   |   folded    |    times, beside from 1280]|
 *   |             | trend (share, answer time) |   trend
 *   |             | recent sessions (10)       |   recent sessions
 *   |             | where you overrode (10,    |   where you overrode
 *   |             |   then "Show all N")       |
 *   |             | [import hint, when it helps]|   [import hint]
 *   |             | splits: skill, model,      |   splits, and the profile per
 *   |             |   project, [profile per    |     model after By project
 *   |             |   model], agent, product   |
 *   +-------------+----------------------------+   capture health
 *   | capture health                           |
 *   +------------------------------------------+
 *   The split blocks sit two to a row from 1280px. The graphics themselves are in charts.tsx.
 *
 * Every string from a session (titles, messages, project names) is rendered as text by Preact;
 * nothing here builds HTML from data. The components take plain props, so each state in the
 * design's state table is one render call in the tests.
 */
import type { InboxPayload, JudgmentPayload, PlainTextPayload, SessionPayload } from '../server';
import { ago, clock, count, day, dayTime, duration, lasting, percent, share } from './format';
import { freshness, type Link } from './poll';
import { Histogram, Marks, OutcomeBar, SeriesKey, Spider, TimeBar, Track, type OutcomeSegment } from './charts';
import { Trend, axisStart } from './trend';

export interface BoardProps {
  inbox: InboxPayload | null;
  judgment: JudgmentPayload | null;
  link: Link;
  now: number;
  /** The most weeks the trend shows: 12, or 8 on screens under 640px. It starts at the first week with an answer. */
  weeks: number;
  /** Width of the main column in pixels, once measured: the trend is drawn at that width. */
  trendWidth?: number;
  timeZone?: string;
  /** Where this page is served, taken from its own location; shown in capture health. */
  address?: string;
}

const DASH = '–';
const TOO_FEW = 'too few';
export const IMPORT_COMMAND = '/nod-board:import';
/** Same text as settings.ts UPDATE_COMMAND; the app does not import server modules. */
export const UPDATE_COMMAND = 'claude plugin update nod-board@nod-board';
/** Rows shown at once in the two lists; the overrides list offers the rest on request. */
export const LIST_ROWS = 10;
/** The row for questions whose skill, model or agent no source captured (attrs.ts UNKNOWN). It is never folded. */
export const UNKNOWN_ROW = 'unknown';
/** A split table longer than this folds its "too few" rows into one closing line. */
export const FOLD_ABOVE = 6;

/** Shown while the plain-text check has nothing to say: off, not begun, or unreadable. */
export const NOT_SEEN = 'Only choices asked through the question tool are counted; a recommendation made in plain text is not seen.';
/** The setting that asks the agent to use the question tool (settings.ts ASK_THROUGH_QUESTION_TOOL). */
export const ASK_SETTING = '"ask_through_question_tool": true';

/**
 * The board's one estimate, under the exact figures (DESIGN.md, "The plain-text line"). Counts,
 * never a percentage, and always "about": it comes from matching phrases, not from an answer.
 */
export function PlainTextLine(props: { plainText: PlainTextPayload | undefined; minN: number; timeZone?: string }) {
  const pt = props.plainText;
  if (!pt || pt.unreadable) return <p class="muted framing">{NOT_SEEN}</p>;
  const { last, before } = pt;
  if (last.checked === 0) return <p class="muted framing">Outside the question tool: no replies were checked in the last 7 days.</p>;
  if (last.checked < props.minN) {
    return <p class="muted framing">Outside the question tool, last 7 days: too few replies checked to say ({count(last.checked)}).</p>;
  }
  const compared =
    before === null
      ? `counting since ${day(pt.since, props.timeZone)}`
      : before.checked === 0
        ? 'none checked in the 7 days before'
        : `7 days before: ${count(before.matched)} of ${count(before.checked)}`;
  return (
    <p class="muted framing">
      Outside the question tool, last 7 days:{' '}
      <span class="fig">
        about {count(last.matched)} of {count(last.checked)}
      </span>{' '}
      replies ended with a recommendation ({compared}). These are not in the share above.
    </p>
  );
}

function Command(props: { text: string }) {
  // Focusable and selected whole on click, so it can be copied with the keyboard or the mouse.
  return (
    <code class="command" tabIndex={0}>
      {props.text}
    </code>
  );
}

function sessionLabel(s: SessionPayload, now: number): string {
  if (s.state === 'WAITING') return `waiting ${lasting(now - s.since)}`;
  if (s.state === 'PERMISSION_ASKED') return `permission asked ${ago(now - s.since)}, may be approved`;
  return `finished ${ago(now - s.since)}`;
}

export function NeedsYou(props: { inbox: InboxPayload | null; now: number }) {
  const inbox = props.inbox;
  const groups: [string, SessionPayload[]][] = inbox
    ? [
        ['Waiting on you', inbox.waiting],
        ['Permission asked', inbox.permission],
        ['Done, unread', inbox.done_unread],
      ]
    : [];
  const total = groups.reduce((n, [, list]) => n + list.length, 0);
  return (
    <aside class="needs" aria-labelledby="needs-h">
      <h2 id="needs-h" class={total ? 'accent' : ''}>
        Needs you{total ? ` (${total})` : ''}
      </h2>
      {inbox && total === 0 ? <p class="quiet">Nothing needs you.</p> : null}
      {groups.map(([title, list]) =>
        list.length ? (
          <div class="group">
            <h3>{title}</h3>
            <ul>
              {list.map((s) => (
                <li>
                  <span class="project">{s.project}</span> <span class="muted">{sessionLabel(s, props.now)}</span>
                  {s.message ? <div class="message">{s.message}</div> : null}
                  <Command text={`claude --resume ${s.session_id}`} />
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {inbox?.todos && inbox.todos.some((t) => t.items.length) ? (
        // Backlog, not something that needs you right now: one line, opened on request.
        <details class="more todos">
          <summary>
            <span class="closed">TODOS ({count(inbox.todos.reduce((n, t) => n + t.items.length, 0))})</span>
            <span class="open">Hide TODOS</span>
          </summary>
          <ul>
            {inbox.todos.flatMap((t) => t.items.map((item) => (
              <li>
                <span class="project">{t.project}</span> <span>{item}</span>
              </li>
            )))}
          </ul>
        </details>
      ) : null}
    </aside>
  );
}

function Banner(props: { judgment: JudgmentPayload }) {
  const j = props.judgment;
  const parts: string[] = [];
  if (j.counts.UNDECODED) parts.push(`${count(j.counts.UNDECODED)} answers could not be read`);
  if (j.capture.unreadable_lines) parts.push(`${count(j.capture.unreadable_lines)} stored lines could not be read`);
  if (!parts.length) return null;
  return <p class="banner">{parts.join(' · ')}. The numbers below may be incomplete.</p>;
}

export function Acceptance(props: { judgment: JudgmentPayload | null; timeZone?: string }) {
  const j = props.judgment;
  if (!j) {
    return (
      <section class="acceptance" aria-labelledby="acc-h">
        <h2 id="acc-h">Recommendations taken</h2>
        <p class="headline">
          <span class="number">{DASH}</span>
        </p>
      </section>
    );
  }
  const pt = j.plain_text;
  const firstRunPlain = pt && !pt.unreadable && pt.last.checked >= j.min_n ? pt : null;
  if (j.questions === 0) {
    // First run: say that capture works, what is stored, and the one next step.
    return (
      <section class="acceptance" aria-labelledby="acc-h">
        <h2 id="acc-h">Recommendations taken</h2>
        <p class="lead">Capturing since {dayTime(j.live_since, props.timeZone)}. Nothing answered yet.</p>
        {/* Why the board is empty, for a user whose agent does not use the question tool, and the one step that changes it. */}
        {firstRunPlain ? (
          <p>
            Your agent has asked nothing through the question tool. In the last 7 days about {count(firstRunPlain.last.matched)} of{' '}
            {count(firstRunPlain.last.checked)} replies ended with a recommendation in plain text, which the board cannot count.
          </p>
        ) : null}
        {firstRunPlain && !firstRunPlain.asking ? (
          <>
            <p>To have choices asked through the tool, add this to ~/.agent-inbox/settings.json:</p>
            <Command text={ASK_SETTING} />
          </>
        ) : null}
        <p>
          Each question you answer is stored as its outcome and first line only. Typed answers are never stored.
        </p>
        <p>To load your past sessions, run:</p>
        <Command text={IMPORT_COMMAND} />
      </section>
    );
  }
  const shown = share(j.overall, j.min_n);
  const c = j.counts;
  const excluded = c.EXCLUDED_MULTI + c.EXCLUDED_NO_REC;
  // Every question, to scale. A segment of zero is left out by the bar.
  const segments: OutcomeSegment[] = [
    { key: 'took', label: 'took', n: c.AGREED },
    { key: 'other', label: 'chose otherwise', n: c.OVERRODE_OPTION + c.OVERRODE_TYPED },
    { key: 'dismissed', label: 'dismissed', n: c.DISMISSED, note: j.inferred_dismissed ? `${count(j.inferred_dismissed)} inferred` : undefined },
    { key: 'unanswered', label: 'unanswered', n: c.UNANSWERED },
    { key: 'unreadable', label: 'unreadable', n: c.UNDECODED },
    { key: 'excluded', label: 'excluded', n: excluded },
  ];
  const t = j.timing;
  return (
    <section class="acceptance" aria-labelledby="acc-h">
      <h2 id="acc-h">Recommendations taken</h2>
      <Banner judgment={j} />
      {j.overall.answered === 0 ? (
        <p class="lead">No answered recommendations yet.</p>
      ) : (
        <div class="band">
          <div class="band-main">
            <p class="headline">
              <span class="number">{shown ?? TOO_FEW}</span>
              <span class="basis">
                took the recommendation, {count(j.overall.agreed)} of {count(j.overall.answered)}
              </span>
            </p>
            <OutcomeBar segments={segments} />
            <p class="recent">
              Last 7 days: {share(j.recent, j.min_n) ?? TOO_FEW} ({count(j.recent.agreed)} of {count(j.recent.answered)})
            </p>
            <p class="muted framing">
              A high share can mean good recommendations or quick clicking; the answer time beside it is the clue.
            </p>
            <PlainTextLine plainText={pt} minN={j.min_n} timeZone={props.timeZone} />
          </div>
          <Histogram buckets={j.timeBuckets} bucketMs={j.time_bucket_ms} fastMs={j.fast_ms} medianMs={t.medianMs} n={t.n} fast={t.fast} minN={j.min_n} />
        </div>
      )}
      {j.overall.answered === 0 ? <OutcomeBar segments={segments} /> : null}
    </section>
  );
}

/** The sessions with the latest answers: counts, not a share, since one session rarely has enough answers for one. */
export function RecentSessions(props: { judgment: JudgmentPayload | null; timeZone?: string }) {
  const rows = (props.judgment?.sessions ?? []).slice(0, LIST_ROWS);
  if (props.judgment && !rows.length) return null;
  return (
    <section aria-labelledby="sess-h">
      <h2 id="sess-h">Recent sessions</h2>
      {rows.length ? (
        <table class="list">
          <thead>
            <tr>
              <th scope="col">Last answer</th>
              <th scope="col">Project</th>
              <th scope="col">Taken</th>
              <th scope="col">Answer time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr>
                <td class="when">{dayTime(s.lastTs, props.timeZone)}</td>
                <th scope="row">{s.project}</th>
                <td class="taken">
                  <div>
                    <Marks marks={s.marks} />
                    <span class="tally">
                      {count(s.agreed)} of {count(s.answered)}
                      {s.answered > s.marks.length ? <small> (latest {count(s.marks.length)} shown)</small> : null}
                    </span>
                  </div>
                </td>
                <td class="time">{s.timed ? duration(s.medianMs) : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

type Override = JudgmentPayload['overrides'][number];

function OverrideTable(props: { rows: Override[]; timeZone?: string; headHidden?: boolean }) {
  return (
    <table class="list">
      <thead class={props.headHidden ? 'sr-only' : undefined}>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Project</th>
          <th scope="col">Question</th>
          <th scope="col">Answer</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((o) => (
          <tr>
            <td class="when">{dayTime(o.ts, props.timeZone)}</td>
            <td class="proj">{o.project}</td>
            <th scope="row">{o.title}</th>
            <td class="kind">{o.typed ? 'typed' : 'other option'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Overrides(props: { judgment: JudgmentPayload | null; timeZone?: string }) {
  const j = props.judgment;
  if (j && j.overall.answered === 0) return null;
  const all = j?.overrides ?? [];
  const rest = all.slice(LIST_ROWS);
  return (
    <section aria-labelledby="over-h">
      <h2 id="over-h">Where you overrode</h2>
      {j && all.length === 0 ? <p class="quiet">No overrides yet.</p> : null}
      {all.length ? <OverrideTable rows={all.slice(0, LIST_ROWS)} timeZone={props.timeZone} /> : null}
      {rest.length ? (
        // The browser's own disclosure: keyboard and screen reader support come with it, and its
        // open state lives in the element, so the 5 second refresh does not close it.
        <details class="more">
          <summary>
            <span class="closed">Show all {count(all.length)}</span>
            <span class="open">Show {count(LIST_ROWS)}</span>
          </summary>
          <OverrideTable rows={rest} timeZone={props.timeZone} headHidden />
        </details>
      ) : null}
    </section>
  );
}

export interface SplitRow {
  name: string;
  agreed: number;
  answered: number;
  medianMs: number | null;
  /** Question prompts with a measured answer time. */
  timed: number;
}

/**
 * One split of the share. A row under `minN` answers has no share ("too few"); in a table longer
 * than FOLD_ABOVE those rows become one closing line that keeps their total, so the counts on the
 * page still add up. A median answer time is shown only with `minN` timed prompts behind it.
 */
export function Split(props: { id: string; title: string; rows: SplitRow[]; minN: number; loaded: boolean; from?: number; series?: string[] }) {
  if (props.loaded && !props.rows.length) return null;
  const fold = props.rows.length > FOLD_ABOVE;
  const keep = (r: SplitRow) => r.answered >= props.minN || r.name === UNKNOWN_ROW;
  const shown = fold ? props.rows.filter(keep) : props.rows;
  const folded = fold ? props.rows.filter((r) => !keep(r)) : [];
  const foldedAnswers = folded.reduce((n, r) => n + r.answered, 0);
  // One scale per table, so its rows line up. The track starts at the trend's axis start, or lower
  // when a row of this table would otherwise fall off it; the header says where it starts.
  const rated = shown.filter((r) => r.answered >= props.minN);
  const lowest = rated.length ? Math.min(...rated.map((r) => (100 * r.agreed) / r.answered)) : 100;
  const from = Math.max(0, Math.min(props.from ?? 0, Math.floor(lowest / 10) * 10));
  return (
    <section aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      {shown.length ? (
        <table class="split">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" class="num">Share{from > 0 ? `, from ${from}%` : ''}</th>
              <th scope="col" class="num">Answers</th>
              <th scope="col" class="num">Answer time</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const seriesN = props.series ? props.series.indexOf(r.name) + 1 : 0;
              const rate = r.answered >= props.minN ? (100 * r.agreed) / r.answered : null;
              const timed = r.timed >= props.minN;
              return (
                <tr>
                  <th scope="row">
                    {seriesN ? <SeriesKey n={seriesN} /> : null}
                    {r.name}
                  </th>
                  <td class="num">
                    <Track share={rate} from={from} />
                    <span class="val">{share(r, props.minN) ?? TOO_FEW}</span>
                  </td>
                  <td class="num">{count(r.answered)}</td>
                  <td class="num">
                    <TimeBar ms={timed ? r.medianMs : null} />
                    <span class="val">{timed ? duration(r.medianMs) : DASH}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {folded.length ? (
        <p class="muted small folded">
          {count(folded.length)} more with too few answers ({count(foldedAnswers)} {foldedAnswers === 1 ? 'answer' : 'answers'} in total)
        </p>
      ) : null}
    </section>
  );
}

export function CaptureHealth(props: BoardProps) {
  const { inbox, judgment: j, link, now, timeZone } = props;
  const fresh = freshness(link, now, (ts) => clock(ts, timeZone), ago);
  const items: [string, string][] = [];
  if (props.address) items.push(['address', props.address]);
  items.push(['live since', j ? dayTime(j.live_since, timeZone) : DASH]);
  if (inbox) {
    items.push(['last event', inbox.health.last_event_ts === null ? 'none yet' : ago(now - inbox.health.last_event_ts)]);
    // A count never clears by itself, so it says when the latest one happened: an old one reads as old.
    const lastError = inbox.health.last_hook_error_ts;
    items.push(['hook errors', count(inbox.health.hook_errors) + (lastError ? `, last ${dayTime(lastError, timeZone)}` : '')]);
  }
  if (j) {
    items.push(['past sessions', j.capture.sources.import ? 'imported' : 'not imported']);
    // Said only when it failed: the line under the number then falls back to its plain sentence.
    if (j.plain_text?.unreadable) items.push(['plain-text check', 'could not be read']);
    items.push(['version', j.version]);
  }
  return (
    <footer aria-label="Capture health">
      <dl>
        {items.map(([k, v]) => (
          <div>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {/* Present only when the user turned the update check on and a newer release exists. */}
      {j?.latest_version ? (
        <p class="update">
          Version {j.latest_version} is available. To update:
          <Command text={UPDATE_COMMAND} />
        </p>
      ) : null}
      {/* Only a lost connection is announced; routine refreshes stay silent for screen readers. */}
      <p class="fresh" role={link.state === 'unreachable' ? 'status' : undefined}>
        {fresh}
      </p>
    </footer>
  );
}

/** Shown only while another import would fill in who asked; one line for all the tables below it. */
export function ImportHint(props: { judgment: JudgmentPayload | null }) {
  const n = props.judgment?.needs_import ?? 0;
  if (!n) return null;
  return (
    <div class="hint">
      <p>
        Model or skill is not known yet for {count(n)} {n === 1 ? 'question' : 'questions'}. To fill them in, run:
      </p>
      <Command text={IMPORT_COMMAND} />
    </div>
  );
}

const SPLIT_TITLES = { skill: 'By skill', model: 'By model', agent: 'By agent', product: 'By product' } as const;

export function Board(props: BoardProps) {
  const j = props.judgment;
  const hasNumbers = !!j && j.overall.answered > 0;
  // The split tracks start where the trend's share axis starts, so a dot means the same in both.
  const from = j ? axisStart(j.weekly.slice(-props.weeks), j.min_n) : 0;
  // The models drawn in the profile, in its order: their rows in By model carry the same key.
  const profiled = (j?.modelProfiles ?? []).filter((p) => p.answered >= (j?.min_n ?? 0)).map((p) => p.name);
  return (
    <div class="board">
      <h1>The Nod Board</h1>
      <NeedsYou inbox={props.inbox} now={props.now} />
      <main>
        <Acceptance judgment={j} timeZone={props.timeZone} />
        {hasNumbers ? <Trend weekly={j.weekly} weeklyTime={j.weekly_time} minN={j.min_n} weeks={props.weeks} width={props.trendWidth} timeZone={props.timeZone} /> : null}
        {!j || hasNumbers ? <RecentSessions judgment={j} timeZone={props.timeZone} /> : null}
        {!j || hasNumbers ? <Overrides judgment={j} timeZone={props.timeZone} /> : null}
        {hasNumbers ? <ImportHint judgment={j} /> : null}
        {!j || hasNumbers ? (
          <div class="splits">
            <Split id="skill-h" title={SPLIT_TITLES.skill} loaded={!!j} minN={j?.min_n ?? 0} from={from} rows={j?.splits.skill ?? []} />
            <Split id="model-h" title={SPLIT_TITLES.model} loaded={!!j} minN={j?.min_n ?? 0} from={from} rows={j?.splits.model ?? []} series={profiled} />
            <Split
              id="proj-h"
              title="By project"
              loaded={!!j}
              minN={j?.min_n ?? 0}
              from={from}
              rows={(j?.projects ?? []).map((p) => ({ name: p.project, agreed: p.agreed, answered: p.answered, medianMs: p.medianMs, timed: p.timed }))}
            />
            {j ? <Spider profiles={j.modelProfiles} minN={j.min_n} fastMs={j.fast_ms} /> : null}
            {(['agent', 'product'] as const).map((k) => (
              <Split id={`${k}-h`} title={SPLIT_TITLES[k]} loaded={!!j} minN={j?.min_n ?? 0} from={from} rows={j?.splits[k] ?? []} />
            ))}
          </div>
        ) : null}
      </main>
      <CaptureHealth {...props} />
    </div>
  );
}
