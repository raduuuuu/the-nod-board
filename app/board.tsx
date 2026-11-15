/**
 * board.tsx: the whole dashboard as pure components (DESIGN.md).
 *
 *   wide (1024px and up)                          narrow
 *   +-------------+----------------------------+   Needs you
 *   | NEEDS YOU   | acceptance number          |   acceptance number
 *   | (aside)     |   median | fast | 7 days   |     three figures, one per line
 *   |             | trend                      |   trend
 *   |             | recent sessions (10)       |   recent sessions
 *   |             | where you overrode (10,    |   where you overrode
 *   |             |   then "Show all N")       |
 *   |             | splits: by project         |   splits
 *   +-------------+----------------------------+   capture health
 *   | capture health                           |
 *   +------------------------------------------+
 *   The splits sit two to a row from 1280px.
 *
 * Every string from a session (titles, messages, project names) is rendered as text by Preact;
 * nothing here builds HTML from data. The components take plain props, so each state in the
 * design's state table is one render call in the tests.
 */
import type { InboxPayload, JudgmentPayload, SessionPayload } from '../server';
import { ago, clock, count, dayTime, duration, percent, share } from './format';
import { freshness, type Link } from './poll';
import { Trend } from './trend';

export interface BoardProps {
  inbox: InboxPayload | null;
  judgment: JudgmentPayload | null;
  link: Link;
  now: number;
  /** Weeks shown in the trend: 12, or 8 on screens under 640px. */
  weeks: number;
  timeZone?: string;
  /** Where this page is served, taken from its own location; shown in capture health. */
  address?: string;
}

const DASH = '–';
const TOO_FEW = 'too few';
export const IMPORT_COMMAND = '/nod-board:import';
/** Rows shown at once in the two lists; the overrides list offers the rest on request. */
export const LIST_ROWS = 10;
/** A split table longer than this folds its "too few" rows into one closing line. */
export const FOLD_ABOVE = 6;

function Command(props: { text: string }) {
  // Focusable and selected whole on click, so it can be copied with the keyboard or the mouse.
  return (
    <code class="command" tabIndex={0}>
      {props.text}
    </code>
  );
}

function sessionLabel(s: SessionPayload, now: number): string {
  const stale = s.display === 'STALE' ? ' (no event for 12 h+)' : '';
  if (s.state === 'WAITING') return `waiting ${ago(now - s.since)}${stale}`;
  if (s.state === 'PERMISSION_ASKED') return `permission asked ${ago(now - s.since)}, may be approved${stale}`;
  return `finished ${ago(now - s.since)}`;
}

export function NeedsYou(props: { inbox: InboxPayload | null; now: number }) {
  const inbox = props.inbox;
  const stale = inbox?.stale ?? [];
  const groups: [string, SessionPayload[]][] = inbox
    ? [
        ['Waiting on you', [...inbox.waiting, ...stale.filter((s) => s.state === 'WAITING')]],
        ['Permission asked', [...inbox.permission, ...stale.filter((s) => s.state === 'PERMISSION_ASKED')]],
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
                <li class={s.display === 'STALE' ? 'stale' : ''}>
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
        <div class="group">
          <h3>TODOS</h3>
          <ul>
            {inbox.todos.flatMap((t) => t.items.map((item) => (
              <li>
                <span class="project">{t.project}</span> <span>{item}</span>
              </li>
            )))}
          </ul>
        </div>
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
  if (j.questions === 0) {
    // First run: say that capture works, what is stored, and the one next step.
    return (
      <section class="acceptance" aria-labelledby="acc-h">
        <h2 id="acc-h">Recommendations taken</h2>
        <p class="lead">Capturing since {dayTime(j.live_since, props.timeZone)}. Nothing answered yet.</p>
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
  // Only what is there: a count of zero says nothing.
  const apart = [
    c.DISMISSED ? `dismissed ${count(c.DISMISSED)}${j.inferred_dismissed ? ` (${count(j.inferred_dismissed)} inferred)` : ''}` : '',
    c.UNANSWERED ? `unanswered ${count(c.UNANSWERED)}` : '',
    c.UNDECODED ? `unreadable ${count(c.UNDECODED)}` : '',
    excluded ? `excluded ${count(excluded)}` : '',
  ].filter(Boolean);
  const t = j.timing;
  // The three figures beside the anchor. Each share keeps its count and the too-few rule.
  const figures: { label: string; value: string; basis?: string }[] = [
    { label: 'median answer', value: t.medianMs === null ? DASH : duration(t.medianMs) },
    {
      label: `under ${duration(j.fast_ms)}`,
      value: t.n === 0 ? DASH : t.n < j.min_n ? TOO_FEW : percent(t.fast, t.n),
      basis: t.n === 0 ? undefined : `${count(t.fast)} of ${count(t.n)}`,
    },
    { label: 'last 7 days', value: share(j.recent, j.min_n) ?? TOO_FEW, basis: `${count(j.recent.agreed)} of ${count(j.recent.answered)}` },
  ];
  return (
    <section class="acceptance" aria-labelledby="acc-h">
      <h2 id="acc-h">Recommendations taken</h2>
      <Banner judgment={j} />
      {j.overall.answered === 0 ? (
        <p class="lead">No answered recommendations yet.</p>
      ) : (
        <>
          <p class="headline">
            <span class="number">{shown ?? TOO_FEW}</span>
            <span class="basis">
              took the recommendation, {count(j.overall.agreed)} of {count(j.overall.answered)}
            </span>
          </p>
          <dl class="figures">
            {figures.map((f) => (
              <div>
                <dt>
                  {f.label}
                  {f.basis ? <span class="count">{f.basis}</span> : null}
                </dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          <p class="muted framing">
            A high share can mean good recommendations or quick clicking; the answer time beside it is the clue.
          </p>
        </>
      )}
      {apart.length ? <p class="muted small">Not in the share: {apart.join(' · ')}</p> : null}
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
                <td>
                  {count(s.agreed)} of {count(s.answered)}
                </td>
                <td>{s.timed ? duration(s.medianMs) : DASH}</td>
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
            <td>{o.project}</td>
            <th scope="row">{o.title}</th>
            <td>{o.typed ? 'typed' : 'other option'}</td>
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
export function Split(props: { id: string; title: string; rows: SplitRow[]; minN: number; loaded: boolean }) {
  if (props.loaded && !props.rows.length) return null;
  const fold = props.rows.length > FOLD_ABOVE;
  const shown = fold ? props.rows.filter((r) => r.answered >= props.minN) : props.rows;
  const folded = fold ? props.rows.filter((r) => r.answered < props.minN) : [];
  const foldedAnswers = folded.reduce((n, r) => n + r.answered, 0);
  return (
    <section aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      {shown.length ? (
        <table class="split">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" class="num">Share</th>
              <th scope="col" class="num">Answers</th>
              <th scope="col" class="num">Answer time</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr>
                <th scope="row">{r.name}</th>
                <td class="num">{share(r, props.minN) ?? TOO_FEW}</td>
                <td class="num">{count(r.answered)}</td>
                <td class="num">{r.timed >= props.minN ? duration(r.medianMs) : DASH}</td>
              </tr>
            ))}
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
    items.push(['hook errors', count(inbox.health.hook_errors)]);
  }
  if (j) {
    items.push(['past sessions', j.capture.sources.import ? 'imported' : 'not imported']);
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
      {/* Only a lost connection is announced; routine refreshes stay silent for screen readers. */}
      <p class="fresh" role={link.state === 'unreachable' ? 'status' : undefined}>
        {fresh}
      </p>
    </footer>
  );
}

export function Board(props: BoardProps) {
  const j = props.judgment;
  const hasNumbers = !!j && j.overall.answered > 0;
  return (
    <div class="board">
      <h1>The Nod Board</h1>
      <NeedsYou inbox={props.inbox} now={props.now} />
      <main>
        <Acceptance judgment={j} timeZone={props.timeZone} />
        {hasNumbers ? <Trend weekly={j.weekly} minN={j.min_n} weeks={props.weeks} timeZone={props.timeZone} /> : null}
        {!j || hasNumbers ? <RecentSessions judgment={j} timeZone={props.timeZone} /> : null}
        {!j || hasNumbers ? <Overrides judgment={j} timeZone={props.timeZone} /> : null}
        {!j || hasNumbers ? (
          <div class="splits">
            <Split
              id="proj-h"
              title="By project"
              loaded={!!j}
              minN={j?.min_n ?? 0}
              rows={(j?.projects ?? []).map((p) => ({ name: p.project, agreed: p.agreed, answered: p.answered, medianMs: p.medianMs, timed: p.timed }))}
            />
          </div>
        ) : null}
      </main>
      <CaptureHealth {...props} />
    </div>
  );
}
