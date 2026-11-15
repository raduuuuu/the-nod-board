/**
 * board.tsx: the whole dashboard as pure components (DESIGN.md).
 *
 *   wide (1024px and up)                      narrow
 *   +-------------+------------------------+   Needs you
 *   | NEEDS YOU   | acceptance number      |   acceptance number
 *   | (aside)     | trend                  |   trend
 *   |             | where you overrode     |   where you overrode
 *   |             | by project | by label  |   by project, by label
 *   +-------------+------------------------+   capture health
 *   | capture health                       |
 *   +--------------------------------------+
 *
 * Every string from a session (titles, messages, project names) is rendered as text by Preact;
 * nothing here builds HTML from data. The components take plain props, so each state in the
 * design's state table is one render call in the tests.
 */
import type { InboxPayload, JudgmentPayload, SessionPayload } from '../server';
import { ago, clock, count, dayTime, duration, share } from './format';
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
}

const DASH = '–';
export const IMPORT_COMMAND = '/nod-board:import';

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
  return (
    <section class="acceptance" aria-labelledby="acc-h">
      <h2 id="acc-h">Recommendations taken</h2>
      <Banner judgment={j} />
      {j.overall.answered === 0 ? (
        <p class="lead">No answered recommendations yet.</p>
      ) : (
        <>
          <p class="headline">
            <span class="number">{shown ?? 'too few'}</span>
            <span class="basis">
              took the recommendation, {count(j.overall.agreed)} of {count(j.overall.answered)}
            </span>
            {j.timing.medianMs !== null ? <span class="timing">median {duration(j.timing.medianMs)} to answer</span> : null}
          </p>
          <p class="muted framing">
            A high share can mean good recommendations or quick clicking; the answer time beside it is the clue.
          </p>
        </>
      )}
      <p class="muted small">
        Not in the share: dismissed {count(c.DISMISSED)}
        {j.inferred_dismissed ? ` (${count(j.inferred_dismissed)} inferred)` : ''} · unanswered {count(c.UNANSWERED)} · unreadable{' '}
        {count(c.UNDECODED)} · excluded {count(excluded)}
      </p>
    </section>
  );
}

export function Overrides(props: { judgment: JudgmentPayload | null; timeZone?: string }) {
  const j = props.judgment;
  if (j && j.overall.answered === 0) return null;
  return (
    <section aria-labelledby="over-h">
      <h2 id="over-h">Where you overrode</h2>
      {j && j.overrides.length === 0 ? <p class="quiet">No overrides yet.</p> : null}
      {j && j.overrides.length ? (
        <table class="list">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Project</th>
              <th scope="col">Question</th>
              <th scope="col">Answer</th>
            </tr>
          </thead>
          <tbody>
            {j.overrides.map((o) => (
              <tr>
                <td class="when">{dayTime(o.ts, props.timeZone)}</td>
                <td>{o.project}</td>
                <th scope="row">{o.title}</th>
                <td>{o.typed ? 'typed' : 'other option'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function Split(props: { id: string; title: string; rows: { name: string; agreed: number; answered: number }[]; minN: number; loaded: boolean }) {
  if (props.loaded && !props.rows.length) return null;
  return (
    <section aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      {props.rows.length ? (
        <table class="split">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" class="num">Share</th>
              <th scope="col" class="num">Answers</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr>
                <th scope="row">{r.name}</th>
                <td class="num">{share(r, props.minN) ?? 'too few'}</td>
                <td class="num">{count(r.answered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function CaptureHealth(props: BoardProps) {
  const { inbox, judgment: j, link, now, timeZone } = props;
  const fresh = freshness(link, now, (ts) => clock(ts, timeZone), ago);
  const items: [string, string][] = [['live since', j ? dayTime(j.live_since, timeZone) : DASH]];
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
        {!j || hasNumbers ? <Overrides judgment={j} timeZone={props.timeZone} /> : null}
        {!j || hasNumbers ? (
          <div class="splits">
            <Split id="proj-h" title="By project" loaded={!!j} minN={j?.min_n ?? 0} rows={(j?.projects ?? []).map((p) => ({ name: p.project, agreed: p.agreed, answered: p.answered }))} />
            <Split id="chip-h" title="By label" loaded={!!j} minN={j?.min_n ?? 0} rows={(j?.chips ?? []).map((p) => ({ name: p.label, agreed: p.agreed, answered: p.answered }))} />
          </div>
        ) : null}
      </main>
      <CaptureHealth {...props} />
    </div>
  );
}
