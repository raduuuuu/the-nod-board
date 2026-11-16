import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { render } from 'preact-render-to-string';
import { Acceptance, Board, CaptureHealth, FOLD_ABOVE, IMPORT_COMMAND, ImportHint, LIST_ROWS, NeedsYou, Overrides, RecentSessions, Split, type BoardProps, type SplitRow } from './app/board';
import { ago, count, dayTime, duration, lasting, percent, share } from './app/format';
import { FAILURES_BEFORE_UNREACHABLE, SLOW_FIRST_MS, freshness, initialLink, onFailure, onSuccess } from './app/poll';
import { Histogram, OutcomeBar, Spider, TIME_BAR_MAX_MS, TimeBar, Track, spokeScale, spokes, type Profile } from './app/charts';
import { Trend, axisStart, type WeekPoint } from './app/trend';
import { FAST_ANSWER_MS, MIN_N, OUTCOMES, TIME_BUCKETS, TIME_BUCKET_MS } from './judgment';
import { CSP, makeHandler, type InboxPayload, type JudgmentPayload, type SessionPayload } from './server';
import { Inbox } from './inbox';

const XSS = '<script>alert(1)</script>';
const NOW = Date.UTC(2026, 10, 12, 14, 2); // Thursday 12 November 2026, 14:02 UTC
const MON = Date.UTC(2026, 10, 9);
const WEEK = 7 * 24 * 3_600_000;
const UTC = 'UTC';

const session = (extra: Partial<SessionPayload> = {}): SessionPayload => ({
  session_id: 'sess-1',
  project: 'thing',
  cwd: '/Users/someone/thing',
  state: 'WAITING',
  display: 'WAITING',
  since: NOW - 4 * 60_000,
  last_ts: NOW - 4 * 60_000,
  message: 'Claude is waiting for your input',
  ...extra,
});
const inbox = (extra: Partial<InboxPayload> = {}): InboxPayload => ({
  now: NOW,
  waiting: [],
  permission: [],
  done_unread: [],
  stale: [],
  todos: null,
  health: { events: 'ok', unreadable_lines: 0, hook_errors: 0, sessions_running: 1, last_event_ts: NOW - 30_000 },
  ...extra,
});
const weeks = (pairs: [number, number][]): WeekPoint[] => pairs.map(([agreed, answered], i) => ({ start: MON - (pairs.length - 1 - i) * WEEK, agreed, answered }));
const emptyCounts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as JudgmentPayload['counts'];
const judgment = (extra: Partial<JudgmentPayload> = {}): JudgmentPayload => ({
  now: NOW,
  version: '0.1.0',
  min_n: MIN_N,
  fast_ms: FAST_ANSWER_MS,
  live_since: NOW - 3 * 24 * 3_600_000,
  overall: { agreed: 1281, answered: 1387 },
  counts: { ...emptyCounts, AGREED: 1281, OVERRODE_OPTION: 102, OVERRODE_TYPED: 4, DISMISSED: 53, EXCLUDED_MULTI: 15, EXCLUDED_NO_REC: 90 },
  calls: 1413,
  questions: 1545,
  timing: { n: 1362, medianMs: 41_654, fast: 274 },
  recent: { agreed: 124, answered: 138 },
  // 1,362 timed prompts: 274 under 15 s in the first three buckets, 60 slower than 3 minutes in the last
  timeBuckets: [90, 100, 84, ...Array.from({ length: TIME_BUCKETS - 3 }, (_, i) => (i < 4 ? 250 : i < 6 ? 14 : 0)), 60],
  modelProfiles: [],
  splits: {
    skill: [
      { name: 'plan-review', agreed: 60, answered: 62, medianMs: 12_000, timed: 60 },
      { name: 'no skill', agreed: 30, answered: 38, medianMs: 55_000, timed: 30 },
    ],
    model: [{ name: 'unknown', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 }],
    agent: [{ name: 'main agent', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 }],
    product: [{ name: 'Claude Code', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 }],
  },
  projects: [
    { project: 'thing', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 },
    { project: 'tiny', agreed: 2, answered: 2, medianMs: 9_000, timed: 2 },
  ],
  sessions: [{ session: 'sess-1', project: 'thing', lastTs: NOW - 3_600_000, agreed: 9, answered: 11, medianMs: 101_000, timed: 9, marks: '11101111011' }],
  overrides: [
    { ts: NOW - 3_600_000, project: 'thing', title: 'Rename the module?', typed: false },
    { ts: NOW - 7_200_000, project: 'thing', title: 'Which name?', typed: true },
  ],
  inferred_dismissed: 0,
  needs_import: 0,
  weekly: weeks([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [174, 199], [3, 4], [329, 349], [353, 371], [293, 324], [124, 138]]),
  weekly_time: weeks([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [174, 199], [3, 4], [329, 349], [353, 371], [293, 324], [124, 138]]).map((w) => ({ start: w.start, medianMs: w.answered ? 40_000 : null, timed: w.answered })),
  time_bucket_ms: TIME_BUCKET_MS,
  capture: { unreadable_lines: 0, sources: { hook: true, import: true } },
  ...extra,
});
const okLink = onSuccess(initialLink(NOW - 60_000), NOW - 3_000);
const board = (extra: Partial<BoardProps> = {}) => render(<Board inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} {...extra} />);
/** The text a reader sees, without the markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
/** A table's markup without its row graphics: the drawings and the fixed-width wrapper of a number are taken out, the cells stay. */
const cells = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<span class="val">([^<]*)<\/span>/g, '$1');

describe('format', () => {
  test('counts, shares, durations and ages', () => {
    expect(count(1387)).toBe('1,387');
    expect(percent(1281, 1387)).toBe('92%');
    expect(share({ agreed: 4, answered: MIN_N - 1 }, MIN_N)).toBeNull();
    expect(share({ agreed: 4, answered: MIN_N }, MIN_N)).toBe('80%');
    expect(share({ agreed: 0, answered: 0 }, MIN_N)).toBeNull(); // never NaN%
    expect([duration(41_654), duration(119_400), duration(150_000), duration(null)]).toEqual(['42 s', '119 s', '3 min', '']);
    expect([ago(0), ago(4_999), ago(5_000), ago(59_000), ago(240_000), ago(3_600_000), ago(49 * 3_600_000), ago(-5)]).toEqual(['just now', 'just now', '5 s ago', '59 s ago', '4 min ago', '1 h ago', '2 d ago', 'just now']);
    expect([lasting(0), lasting(59_000), lasting(240_000), lasting(13 * 3_600_000), lasting(49 * 3_600_000)]).toEqual(['just now', 'for 59 s', 'for 4 min', 'for 13 h', 'for 2 d']);
    expect(dayTime(NOW, UTC)).toBe('Nov 12, 14:02');
    expect(dayTime(null)).toBe('unknown');
  });
});

describe('connection state', () => {
  const clock = (ts: number) => `T${ts}`;
  test('ok after the first answer; unreachable only after three failures in a row; a success recovers', () => {
    let link = initialLink(0);
    expect(link.state).toBe('loading');
    link = onSuccess(link, 100);
    expect([link.state, link.lastOkAt]).toEqual(['ok', 100]);
    for (let i = 1; i < FAILURES_BEFORE_UNREACHABLE; i++) {
      link = onFailure(link, 100 + i * 5000);
      expect(link.state).toBe('ok'); // one bad check does not alarm
    }
    link = onFailure(link, 20_000);
    expect([link.state, link.unreachableSince, link.lastOkAt]).toEqual(['unreachable', 20_000, 100]);
    link = onFailure(link, 25_000);
    expect(link.unreachableSince).toBe(20_000); // the moment it was lost, not the latest failure
    link = onSuccess(link, 30_000);
    expect([link.state, link.failures, link.unreachableSince]).toEqual(['ok', 0, null]);
  });

  test('a server that never answered becomes unreachable too', () => {
    let link = initialLink(0);
    for (let i = 0; i < FAILURES_BEFORE_UNREACHABLE; i++) link = onFailure(link, i * 5000);
    expect([link.state, link.lastOkAt]).toEqual(['unreachable', null]);
  });

  test('the freshness line', () => {
    const start = initialLink(1_000);
    expect(freshness(start, 1_000 + SLOW_FIRST_MS, clock, ago)).toBe(''); // first paint: nothing yet
    expect(freshness(start, 1_001 + SLOW_FIRST_MS, clock, ago)).toBe('waiting for the local server');
    expect(freshness(onSuccess(start, 2_000), 9_000, clock, ago)).toBe('updated 7 s ago');
    let lost = onSuccess(start, 2_000);
    for (let i = 0; i < 3; i++) lost = onFailure(lost, 50_000);
    expect(freshness(lost, 90_000, clock, ago)).toBe('server not reachable since T50000');
  });
});

describe('first paint (no data yet)', () => {
  const html = render(<Board inbox={null} judgment={null} link={initialLink(NOW)} now={NOW} weeks={12} timeZone={UTC} />);

  test('the final frame is already there: every heading, a dash for the number, nothing that spins', () => {
    for (const heading of ['The Nod Board', 'Needs you', 'Recommendations taken', 'Recent sessions', 'Where you overrode', 'By skill', 'By model', 'By project', 'By agent', 'By product']) expect(html).toContain(heading);
    expect(html).toContain('<span class="number">–</span>');
    expect(text(html)).toContain('live since –');
    for (const moving of ['spinner', 'skeleton', 'loading', 'animate']) expect(html.toLowerCase()).not.toContain(moving);
    expect(html).not.toContain('Nothing needs you'); // not known yet
    expect(html).not.toContain('NaN');
  });

  test('a slow first answer says so in the health line', () => {
    const slow = render(<CaptureHealth inbox={null} judgment={null} link={initialLink(NOW - SLOW_FIRST_MS - 1)} now={NOW} weeks={12} timeZone={UTC} />);
    expect(text(slow)).toContain('waiting for the local server');
  });
});

describe('needs you', () => {
  test('nothing waiting: one quiet line and no accent', () => {
    const html = render(<NeedsYou inbox={inbox()} now={NOW} />);
    expect(text(html)).toBe('Needs you Nothing needs you.');
    expect(html).not.toContain('accent');
  });

  test('sessions by state, with how long, the message and a resume command that can be focused and copied', () => {
    const html = render(
      <NeedsYou
        now={NOW}
        inbox={inbox({
          waiting: [session()],
          permission: [session({ session_id: 'sess-2', state: 'PERMISSION_ASKED', display: 'PERMISSION_ASKED', since: NOW - 120_000, message: null })],
          done_unread: [session({ session_id: 'sess-3', state: 'DONE_UNREAD', display: 'DONE_UNREAD', since: NOW - 600_000, message: null })],
          stale: [session({ session_id: 'sess-4', display: 'STALE', since: NOW - 13 * 3_600_000 })],
        })}
      />,
    );
    const t = text(html);
    expect(t).toContain('Needs you (4)');
    expect(html).toContain('<h2 id="needs-h" class="accent">'); // the accent is only for things that need you
    expect(t).toContain('thing waiting for 4 min Claude is waiting for your input claude --resume sess-1');
    expect(t).toContain('permission asked 2 min ago, may be approved');
    expect(t).toContain('finished 10 min ago');
    expect(t).toContain('waiting for 13 h (no event for 12 h+)');
    expect(html).toContain('<li class="stale">');
    expect(html).toContain('<code class="command" tabindex="0">claude --resume sess-2</code>');
    expect(html.indexOf('Waiting on you')).toBeLessThan(html.indexOf('Permission asked'));
    expect(html.indexOf('Permission asked')).toBeLessThan(html.indexOf('Done, unread'));
  });

  test('gstack TODOS appear only when the server sent some', () => {
    expect(render(<NeedsYou inbox={inbox()} now={NOW} />)).not.toContain('TODOS');
    expect(render(<NeedsYou inbox={inbox({ todos: [] })} now={NOW} />)).not.toContain('TODOS');
    const html = render(<NeedsYou inbox={inbox({ todos: [{ project: 'owner-repo', file: 'owner-repo-TODOS.md', items: ['a deferred thing'] }] })} now={NOW} />);
    expect(text(html)).toContain('TODOS owner-repo a deferred thing');
  });
});

describe('the acceptance number', () => {
  test('first run: capture is on, what is stored, and the import command', () => {
    const html = render(<Acceptance judgment={judgment({ questions: 0, overall: { agreed: 0, answered: 0 }, counts: emptyCounts, live_since: NOW })} timeZone={UTC} />);
    const t = text(html);
    expect(t).toContain('Capturing since Nov 12, 14:02. Nothing answered yet.');
    expect(t).toContain('Each question you answer is stored as its outcome and first line only. Typed answers are never stored.');
    expect(t).toContain(`To load your past sessions, run: ${IMPORT_COMMAND}`);
    expect(html).toContain(`<code class="command" tabindex="0">${IMPORT_COMMAND}</code>`);
    expect(html).not.toContain('%');
  });

  test('the number, what it rests on, where every question went, the last 7 days, how fast, and the framing sentence', () => {
    const html = render(<Acceptance judgment={judgment()} timeZone={UTC} />);
    expect(html).toContain('<span class="number">92%</span>');
    const t = text(html);
    expect(t).toContain('92% took the recommendation, 1,281 of 1,387 took 1,281 chose otherwise 106 dismissed 53 excluded 105 Last 7 days: 90% (124 of 138)');
    expect(t).toContain('How fast you answer');
    expect(t).toContain('20% under 15 s (274 of 1,362) · median 42 s');
    expect((html.match(/class="number"/g) ?? []).length).toBe(1); // one anchor
    expect(t).toContain('A high share can mean good recommendations or quick clicking; the answer time beside it is the clue.');
    expect(t).toContain('Only choices asked through the question tool are counted; a recommendation made in plain text is not seen.');
    expect(t).not.toContain('unanswered');
    expect(t).not.toContain('unreadable');
    expect(html).not.toContain('banner');
  });

  test('fewer than five answers: "too few" with the count, never a share', () => {
    const html = render(<Acceptance judgment={judgment({ overall: { agreed: 3, answered: 4 } })} timeZone={UTC} />);
    expect(html).toContain('<span class="number">too few</span>');
    expect(text(html)).toContain('took the recommendation, 3 of 4');
    expect(html).not.toMatch(/class="number">\d/);
  });

  test('questions but none answered: a plain line, no number and no NaN', () => {
    const html = render(<Acceptance judgment={judgment({ overall: { agreed: 0, answered: 0 }, counts: { ...emptyCounts, DISMISSED: 2 }, timing: { n: 0, medianMs: null, fast: 0 } })} timeZone={UTC} />);
    expect(text(html)).toContain('No answered recommendations yet.');
    expect(text(html)).toContain('dismissed 2');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('class="number"');
  });

  test('inferred dismissals are labelled as such', () => {
    const html = render(<Acceptance judgment={judgment({ inferred_dismissed: 7 })} timeZone={UTC} />);
    expect(text(html)).toContain('dismissed 53 (7 inferred)');
  });

  test('a banner says when answers or stored lines could not be read', () => {
    const html = render(<Acceptance judgment={judgment({ counts: { ...emptyCounts, AGREED: 9, UNDECODED: 3 }, capture: { unreadable_lines: 2, sources: { hook: true, import: false } } })} timeZone={UTC} />);
    expect(text(html)).toContain('3 answers could not be read · 2 stored lines could not be read. The numbers below may be incomplete.');
  });
});

describe('trend', () => {
  const circles = (html: string) => (html.match(/<circle /g) ?? []).length;
  const links = (html: string) => (html.match(/class="link"/g) ?? []).length;
  const bars = (html: string) => (html.match(/<rect /g) ?? []).length;

  test('a dot per qualifying week, a bar for every week, and the line only between adjacent qualifying weeks', () => {
    const html = render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect(bars(html)).toBe(6); // the six weeks before the first answer are not drawn
    expect(circles(html)).toBe(5); // six weeks have answers; the week with 4 has a bar and no dot
    expect(links(html)).toBe(3); // 174/199 | gap | 329/349 - 353/371 - 293/324 - 124/138
    expect(html).toContain('class="bar thin"');
    expect(text(html)).toContain('A week with fewer than 5 answers has a bar and no dot.');
  });

  test('the same numbers as a table, and a text summary on the chart itself', () => {
    const html = render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Share of recommendations taken per week over the last 6 weeks\. 5 weeks have at least 5 answers; the latest of those is 90%\."/);
    const t = text(html);
    expect(t).toContain('Weekly numbers Week of Share Answers');
    expect(t).toContain('Nov 9 90% 138');
    expect(t).toContain('Oct 12 too few 4');
    expect(t).toContain('Oct 5 87% 199');
    expect(t).not.toContain('Aug 24'); // the chart and the table begin at the first week with an answer
    const gap = render(<Trend weekly={weeks([[9, 10], [0, 0], [9, 10]])} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect(gap).toContain('<th scope="row">Nov 2</th><td class="num"></td><td class="num">0</td>'); // an empty week has no share at all
  });

  test('a history shorter than the window: only the weeks since the first answer, and the heading counts them', () => {
    const html = render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={12} timeZone={UTC} />);
    const t = text(html);
    expect(t).toContain('Trend, last 6 weeks');
    expect(t).toContain('Oct 5'); // the first week with an answer labels the axis
    expect(html).toMatch(/<circle class="dot" cx="103\.1\d*"/); // its dot sits in the first sixth of the drawing, not in the right half
    // an empty week after the first answer stays, as a gap in the line
    const gap = render(<Trend weekly={weeks([[0, 0], [9, 10], [0, 0], [9, 10]])} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect([bars(gap), circles(gap), links(gap)]).toEqual([3, 2, 0]);
    expect(text(gap)).toContain('Trend, last 3 weeks');
    // twelve weeks of answers are all drawn
    expect(bars(render(<Trend weekly={weeks(Array.from({ length: 12 }, () => [9, 10] as [number, number]))} minN={MIN_N} weeks={12} timeZone={UTC} />))).toBe(12);
  });

  test('drawn at the width of the page column, within limits; the plot widens and the heights stay', () => {
    const at = (width: number | undefined) => render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={12} width={width} timeZone={UTC} />);
    expect(at(1064)).toContain('viewBox="0 0 1064 168"');
    expect(at(1063.6)).toContain('viewBox="0 0 1064 168"');
    expect(at(100)).toContain('viewBox="0 0 280 168"');
    expect(at(5000)).toContain('viewBox="0 0 1400 168"');
    expect(at(undefined)).toContain('viewBox="0 0 600 168"'); // not measured yet
    expect(at(1064)).toContain('<line class="rule" x1="58" x2="1064" y1="10" y2="10">');
    expect(board({ trendWidth: 900 })).toContain('viewBox="0 0 900 '); // the page hands its width on
  });

  test('a single week: one dot, one bar no wider than a bar, and no second axis label', () => {
    const html = render(<Trend weekly={weeks([[0, 0], [0, 0], [9, 10]])} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect([bars(html), circles(html)]).toEqual([1, 1]);
    expect(text(html)).toContain('Trend, this week');
    expect(html).toContain('over the last 1 week. 1 week has at least 5 answers');
    expect(html).toMatch(/<rect class="bar"[^>]*width="48"/);
    expect((text(html).match(/this week/g) ?? []).length).toBe(2); // the heading and the one axis label
    expect((text(html).match(/Nov 9/g) ?? []).length).toBe(1); // in the table only, not under the chart
  });

  test('narrow screens show the last 8 weeks', () => {
    const full = weeks(Array.from({ length: 12 }, () => [9, 10] as [number, number]));
    const html = render(<Trend weekly={full} minN={MIN_N} weeks={8} timeZone={UTC} />);
    expect(bars(html)).toBe(8);
    expect(text(html)).toContain('Trend, last 8 weeks');
    expect(text(html)).not.toContain('Aug 24');
    expect(html).toContain('viewBox="0 0 380 168"'); // a narrower drawing, so labels are not shrunk to illegibility
    expect(render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={12} timeZone={UTC} />)).toContain('viewBox="0 0 600 168"');
  });

  test('hidden until one week has enough answers', () => {
    expect(render(<Trend weekly={weeks([[0, 0], [2, 3], [4, 4]])} minN={MIN_N} weeks={12} timeZone={UTC} />)).toBe('');
    expect(circles(render(<Trend weekly={weeks([[0, 0], [2, 3], [5, 5]])} minN={MIN_N} weeks={12} timeZone={UTC} />))).toBe(1);
  });

  test('100% and 0% weeks sit on the top and bottom rules', () => {
    const html = render(<Trend weekly={weeks([[5, 5], [0, 5]])} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect(html).toMatch(/<circle[^>]*cy="10"/);
    expect(html).toMatch(/<circle[^>]*cy="100"/);
  });
});

describe('overrides and splits', () => {
  test('overrides: when, project, first line, and how it was answered', () => {
    const t = text(render(<Overrides judgment={judgment()} timeZone={UTC} />));
    expect(t).toContain('Where you overrode When Project Question Answer');
    expect(t).toContain('Nov 12, 13:02 thing Rename the module? other option');
    expect(t).toContain('Nov 12, 12:02 thing Which name? typed');
  });

  test('no overrides yet says so; with nothing answered the block is absent', () => {
    expect(text(render(<Overrides judgment={judgment({ overrides: [] })} timeZone={UTC} />))).toBe('Where you overrode No overrides yet.');
    expect(render(<Overrides judgment={judgment({ overall: { agreed: 0, answered: 0 } })} timeZone={UTC} />)).toBe('');
  });

  test('splits: a share with its count, "too few" under five, and real table headers', () => {
    const html = cells(board());
    expect(html).toContain('<th scope="row">thing</th><td class="num">90%</td><td class="num">100</td><td class="num">30 s</td>');
    expect(html).toContain('<th scope="row">tiny</th><td class="num">too few</td><td class="num">2</td><td class="num">–</td>');
    expect(html).not.toContain('By label');
    expect(html).toContain('<th scope="col" class="num">Answer time</th>');
    expect(html).toContain('<th scope="col" class="num">Share</th>');
  });
});

describe('the last 7 days, the answer times and the outcome key', () => {
  const figures = (extra: Partial<JudgmentPayload>) => text(render(<Acceptance judgment={judgment(extra)} timeZone={UTC} />));

  test('no timed answer: the histogram says so, with no share and no count that would read 0 of 0', () => {
    const t = figures({ timing: { n: 0, medianMs: null, fast: 0 } });
    expect(t).toContain('How fast you answer Too few timed answers to draw (0).');
    expect(t).not.toContain('under 15 s');
    expect(t).not.toContain('0 of 0');
  });

  test('fewer than five timed answers, or five answers in the last 7 days: "too few" with the count', () => {
    const t = figures({ timing: { n: 4, medianMs: 9_000, fast: 3 }, recent: { agreed: 2, answered: 3 } });
    expect(t).toContain('Too few timed answers to draw (4).');
    expect(t).toContain('Last 7 days: too few (2 of 3)');
    expect(t).not.toContain('75%');
    expect(t).not.toContain('67%');
  });

  test('nothing set apart: the key names only what exists', () => {
    const t = figures({ counts: { ...emptyCounts, AGREED: 9, OVERRODE_OPTION: 1 } });
    expect(t).toContain('took 9 chose otherwise 1 Last 7 days');
    expect(t).not.toContain('dismissed');
    expect(t).not.toContain('excluded');
  });
});

describe('recent sessions', () => {
  const sessionRow = (i: number, extra = {}) => ({ session: `s${i}`, project: `proj ${i}`, lastTs: NOW - i * 3_600_000, agreed: i, answered: i + 1, medianMs: 20_000, timed: 1, marks: '1'.repeat(i) + '0', ...extra });

  test('when it last answered, the project, counts instead of a share, and the answer time', () => {
    const t = text(render(<RecentSessions judgment={judgment()} timeZone={UTC} />));
    expect(t).toBe('Recent sessions Last answer Project Taken Answer time Nov 12, 13:02 thing 9 of 11 101 s');
  });

  test('a square per answer in order, filled when the recommendation was taken; a longer session says how many are shown', () => {
    const html = render(<RecentSessions judgment={judgment()} timeZone={UTC} />);
    expect((html.match(/class="mark took"/g) ?? []).length).toBe(9);
    expect((html.match(/class="mark other"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/<svg class="marks"[^>]*aria-hidden="true"/); // the count beside it says the same
    const long = render(<RecentSessions judgment={judgment({ sessions: [sessionRow(80, { marks: '1'.repeat(60) })] })} timeZone={UTC} />);
    expect(text(long)).toContain('80 of 81 (latest 60 shown)');
  });

  test('ten at most, none: the block is absent, no timed answer: a dash', () => {
    const many = render(<RecentSessions judgment={judgment({ sessions: Array.from({ length: 14 }, (_, i) => sessionRow(i)) })} timeZone={UTC} />);
    expect((many.match(/<tr>/g) ?? []).length).toBe(1 + LIST_ROWS);
    expect(render(<RecentSessions judgment={judgment({ sessions: [] })} timeZone={UTC} />)).toBe('');
    expect(text(render(<RecentSessions judgment={judgment({ sessions: [sessionRow(1, { timed: 0, medianMs: null })] })} timeZone={UTC} />))).toContain('1 of 2 –');
  });
});

describe('the overrides list shows ten and offers the rest', () => {
  const overrides = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: NOW - i * 60_000, project: 'thing', title: `Question ${i}?`, typed: false }));

  test('ten or fewer: every row, and no control', () => {
    const html = render(<Overrides judgment={judgment({ overrides: overrides(LIST_ROWS) })} timeZone={UTC} />);
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(LIST_ROWS);
    expect(html).not.toContain('<details');
  });

  test('more than ten: the ten newest, then a disclosure holding the rest with both of its labels', () => {
    const html = render(<Overrides judgment={judgment({ overrides: overrides(12) })} timeZone={UTC} />);
    const [first, rest] = html.split('<details class="more">');
    expect((first.match(/<th scope="row">/g) ?? []).length).toBe(LIST_ROWS);
    expect(first).toContain('Question 9?');
    expect(first).not.toContain('Question 10?');
    expect((rest.match(/<th scope="row">/g) ?? []).length).toBe(2);
    expect(rest).toContain('<summary><span class="closed">Show all 12</span><span class="open">Show 10</span></summary>');
    expect(rest).toContain('<thead class="sr-only">'); // the second table keeps its column names for screen readers
  });
});

describe('a split table', () => {
  const row = (name: string, answered: number, extra: Partial<SplitRow> = {}): SplitRow => ({ name, agreed: answered, answered, medianMs: 12_000, timed: answered, ...extra });
  const split = (rows: SplitRow[]) => render(<Split id="x-h" title="By thing" rows={rows} minN={MIN_N} loaded />);

  test('up to six rows: every row is named, a small one reads "too few"', () => {
    const html = split([row('a', 20), row('b', 9), row('c', 6), row('d', 5), row('e', 2), row('f', 1)]);
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(FOLD_ABOVE);
    expect(html).not.toContain('more with too few');
  });

  test('more than six rows: the "too few" rows fold into one line that keeps their total', () => {
    const html = split([row('a', 20), row('b', 9), row('c', 6), row('d', 5), row('e', 2), row('f', 1), row('g', 1)]);
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(4);
    expect(text(html)).toContain('3 more with too few answers (4 answers in total)');
    const one = split([row('a', 20), row('b', 9), row('c', 6), row('d', 5), row('e', 7), row('f', 8), row('g', 1)]);
    expect(text(one)).toContain('1 more with too few answers (1 answer in total)');
  });

  test('an answer time needs five timed prompts behind it', () => {
    const html = cells(split([row('a', 20, { timed: 5 }), row('b', 20, { timed: 4 })]));
    expect(html).toContain('<th scope="row">a</th><td class="num">100%</td><td class="num">20</td><td class="num">12 s</td>');
    expect(html).toContain('<th scope="row">b</th><td class="num">100%</td><td class="num">20</td><td class="num">–</td>');
  });

  test('no rows: the block is absent', () => {
    expect(split([])).toBe('');
  });
});

describe('the splits by who asked', () => {
  test('a row per skill with its share, count and answer time; a split with one row is still shown', () => {
    const html = cells(board());
    expect(html).toContain('<th scope="row">plan-review</th><td class="num">97%</td><td class="num">62</td><td class="num">12 s</td>');
    expect(html).toContain('<th scope="row">no skill</th><td class="num">79%</td><td class="num">38</td><td class="num">55 s</td>');
    expect(html).toContain('<th scope="row">main agent</th>');
    expect(html).toContain('<th scope="row">Claude Code</th>');
  });

  test('the unknown row is never folded away, however long the table', () => {
    const rows: SplitRow[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ name: `skill-${i}`, agreed: 9, answered: 10, medianMs: 1000, timed: 10 })),
      { name: 'tiny', agreed: 1, answered: 1, medianMs: null, timed: 0 },
      { name: 'unknown', agreed: 2, answered: 2, medianMs: null, timed: 0 },
    ];
    const html = cells(render(<Split id="x-h" title="By skill" rows={rows} minN={MIN_N} loaded />));
    expect(html).toContain('<th scope="row">unknown</th><td class="num">too few</td><td class="num">2</td>');
    expect(html).not.toContain('<th scope="row">tiny</th>');
    expect(text(html)).toContain('1 more with too few answers (1 answer in total)');
  });

  test('the import hint: one line above the tables with the count and the command, only while an import would help', () => {
    expect(render(<ImportHint judgment={judgment()} />)).toBe('');
    expect(text(render(<ImportHint judgment={judgment({ needs_import: 1584 })} />))).toBe(`Model or skill is not known yet for 1,584 questions. To fill them in, run: ${IMPORT_COMMAND}`);
    expect(text(render(<ImportHint judgment={judgment({ needs_import: 1 })} />))).toContain('for 1 question.');
    const page = board({ judgment: judgment({ needs_import: 3 }) });
    expect(page.indexOf('not known yet')).toBeGreaterThan(page.indexOf('Where you overrode'));
    expect(page.indexOf('not known yet')).toBeLessThan(page.indexOf('By skill'));
    expect((page.match(/not known yet/g) ?? []).length).toBe(1);
  });
});

describe('capture health', () => {
  const health = (extra: Partial<BoardProps> = {}) => text(render(<CaptureHealth inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} {...extra} />));

  test('live since, last event, hook errors, import state, version, and how fresh the page is', () => {
    expect(health()).toBe('live since : Nov 9, 14:02 last event : 30 s ago hook errors : 0 past sessions : imported version : 0.1.0 updated just now'.replace(/ :/g, ''));
  });

  test('a hook error says when the latest one happened; without a time it is the count alone', () => {
    const timed = health({ inbox: inbox({ health: { ...inbox().health, hook_errors: 2, last_hook_error_ts: NOW } }) });
    expect(timed).toContain('hook errors 2, last Nov 12, 14:02 past sessions');
    const untimed = health({ inbox: inbox({ health: { ...inbox().health, hook_errors: 2 } }) });
    expect(untimed).toContain('hook errors 2 past sessions');
  });

  test('a newer version is named with the command that installs it, and only when the server reports one', () => {
    const withUpdate = health({ judgment: { ...judgment(), latest_version: '0.1.1' } });
    expect(withUpdate).toContain('version 0.1.0 Version 0.1.1 is available. To update: claude plugin update nod-board@nod-board updated just now');
    expect(health()).not.toContain('is available');
  });

  test('history not imported yet, and no event yet', () => {
    const t = health({ inbox: inbox({ health: { ...inbox().health, last_event_ts: null } }), judgment: judgment({ capture: { unreadable_lines: 0, sources: { hook: true, import: false } } }) });
    expect(t).toContain('last event none yet');
    expect(t).toContain('past sessions not imported');
  });

  test('server not reachable: said once, announced to screen readers, and the last numbers stay', () => {
    let lost = okLink;
    for (let i = 0; i < 3; i++) lost = onFailure(lost, NOW);
    const html = board({ link: lost });
    expect(text(html)).toContain('server not reachable since 14:02');
    expect(html).toContain('<p class="fresh" role="status">');
    expect(html).toContain('<span class="number">92%</span>'); // the numbers are kept, not blanked
    expect(board()).not.toContain('role="status"'); // routine refreshes are not announced
  });
});

describe('the whole page', () => {
  const html = board({ inbox: inbox({ waiting: [session()] }) });

  test('one h1, landmarks, and the blocks in reading order', () => {
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect((html.match(/<main/g) ?? []).length).toBe(1);
    expect(html).toContain('<aside class="needs" aria-labelledby="needs-h">');
    expect(html).toContain('<footer aria-label="Capture health">');
    const order = ['Needs you', 'Recommendations taken', 'Trend, last 6 weeks', 'Recent sessions', 'Where you overrode', 'By skill', 'By model', 'By project', 'By agent', 'By product', 'live since'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Every heading that labels a region exists.
    for (const id of html.match(/aria-labelledby="([^"]+)"/g) ?? []) expect(html).toContain(`id="${id.slice(17, -1)}"`);
  });

  test('text from sessions is shown as text everywhere it can appear', () => {
    const hostile = board({
      inbox: inbox({ waiting: [session({ project: XSS, message: XSS, session_id: `x"><img src=x onerror=alert(1)>` })], todos: [{ project: XSS, file: 'f', items: [XSS] }] }),
      judgment: judgment({
        overrides: [{ ts: NOW, project: XSS, title: XSS, typed: false }],
        projects: [{ project: XSS, agreed: 5, answered: 5, medianMs: null, timed: 0 }],
        sessions: [{ session: 's', project: `<img src=x onerror=alert(1)>`, lastTs: NOW, agreed: 5, answered: 5, medianMs: null, timed: 0, marks: '11111' }],
        modelProfiles: [{ name: XSS, answered: 9, agreed: 8, option: 1, typed: 0, dismissed: 0, timed: 9, fast: 2 }],
        splits: { ...judgment().splits, model: [{ name: XSS, agreed: 8, answered: 9, medianMs: 30_000, timed: 9 }] },
        version: XSS,
      }),
    });
    expect(hostile).not.toContain('<script');
    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('&lt;script>alert(1)&lt;/script>');
  });

  test('no element carries a style attribute or an inline handler, so the strict policy holds', () => {
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(CSP).not.toContain('unsafe-inline');
  });

  test('the app never builds HTML from data', () => {
    for (const file of fs.readdirSync(path.join(import.meta.dir, 'app'))) {
      const source = fs.readFileSync(path.join(import.meta.dir, 'app', file), 'utf8');
      for (const escape of ['dangerouslySetInnerHTML', 'innerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) expect([file, source.includes(escape)]).toEqual([file, false]);
    }
  });
});

describe('the build', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-dist-'));
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));
  const built = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'scripts', 'build.ts'), '--outdir', out]);

  test('produces the page, one script, one stylesheet, the three font files and their license', () => {
    expect(built.exitCode).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['app.css', 'app.js', 'fonts', 'index.html']);
    expect(fs.readdirSync(path.join(out, 'fonts')).sort()).toEqual([
      'LICENSE.txt',
      'ibm-plex-mono-latin-400-normal.woff2',
      'ibm-plex-sans-latin-400-normal.woff2',
      'ibm-plex-sans-latin-600-normal.woff2',
    ]);
    expect(fs.readFileSync(path.join(out, 'fonts', 'LICENSE.txt'), 'utf8')).toContain('SIL Open Font License');
    expect(fs.statSync(path.join(out, 'app.js')).size).toBeLessThan(80_000);
  });

  test('the page loads only its own script and stylesheet, with nothing inline and nothing remote', () => {
    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(page.match(/<script[^>]*>/g)).toEqual(['<script type="module" src="/app.js">']);
    expect(page.match(/<link[^>]*>/g)).toEqual(['<link rel="stylesheet" href="/app.css">']);
    expect(page).not.toMatch(/<style|\sstyle=|https?:\/\//);
    const css = fs.readFileSync(path.join(out, 'app.css'), 'utf8');
    expect(css.match(/url\("([^"]+)"\)/g)?.sort()).toEqual([
      'url("/fonts/ibm-plex-mono-latin-400-normal.woff2")',
      'url("/fonts/ibm-plex-sans-latin-400-normal.woff2")',
      'url("/fonts/ibm-plex-sans-latin-600-normal.woff2")',
    ]);
    expect(css).not.toMatch(/https?:\/\/|@import/);
    // The bundle names no host except the XML namespaces Preact needs to create SVG and MathML nodes.
    const urls = [...new Set(fs.readFileSync(path.join(out, 'app.js'), 'utf8').match(/https?:\/\/[^"'`\s)]+/g) ?? [])].sort();
    expect(urls.every((u) => u.startsWith('http://www.w3.org/'))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'app.js'), 'utf8').includes('void 0,this)')).toBe(false); // production JSX runtime: no source positions passed
  });

  test('the server serves the real build, every file the page and stylesheet name', async () => {
    const dir = path.join(out, 'data');
    fs.mkdirSync(dir);
    const handler = makeHandler(new Inbox({ dir, home: out, stateRoot: path.join(dir, 'none'), transcriptsDir: path.join(dir, 'none') }), () => 4777, { distDir: out });
    for (const p of ['/', '/app.js', '/app.css', '/fonts/ibm-plex-sans-latin-400-normal.woff2', '/fonts/ibm-plex-sans-latin-600-normal.woff2', '/fonts/ibm-plex-mono-latin-400-normal.woff2']) {
      const r = new Request(`http://127.0.0.1:4777${p}`);
      r.headers.set('host', '127.0.0.1:4777');
      const res = await handler(r);
      expect([p, res.status]).toEqual([p, 200]);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
  });

  test('verify-dist accepts the real build and rejects an altered, a missing or an extra file', () => {
    const verify = (dir: string) => Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'scripts', 'verify-dist.ts'), dir]);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-copy-'));
    try {
      fs.cpSync(out, copy, { recursive: true, filter: (src) => path.basename(src) !== 'data' });
      const good = verify(copy);
      expect([good.exitCode, good.stdout.toString()]).toEqual([0, `verified: 7 files in ${copy} match a fresh build\n`]);

      fs.appendFileSync(path.join(copy, 'app.js'), '\n// one extra line');
      const altered = verify(copy);
      expect(altered.exitCode).toBe(1);
      expect(altered.stderr.toString()).toContain('differs: app.js');

      fs.cpSync(path.join(out, 'app.js'), path.join(copy, 'app.js'));
      fs.writeFileSync(path.join(copy, 'extra.js'), 'x');
      fs.rmSync(path.join(copy, 'fonts', 'LICENSE.txt'));
      const changed = verify(copy).stderr.toString();
      expect(changed).toContain('extra: extra.js');
      expect(changed).toContain(`missing: ${path.join('fonts', 'LICENSE.txt')}`);
      expect(verify(path.join(copy, 'no-such-dir')).exitCode).toBe(1);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  test('DESIGN.md and the stylesheet agree on the tokens', () => {
    const design = fs.readFileSync(path.join(import.meta.dir, 'DESIGN.md'), 'utf8');
    const css = fs.readFileSync(path.join(import.meta.dir, 'app', 'app.css'), 'utf8');
    for (const color of ['#fff', '#121212', '#1a1a1a', '#ececec', '#666', '#9a9a9a', '#e3e3e3', '#2c2c2c', '#b4005a', '#ff6fae', '#0b5fa5', '#6cb2ee', '#b85c00', '#f0a04b', '#2f7d4f', '#6fcf97', '#0f766e', '#4fd1c5']) {
      expect([color, design.includes(`\`${color}\``), css.includes(color)]).toEqual([color, true, true]);
    }
    for (const size of ['13px', '16px', '20px', '40px']) expect([size, design.includes(size), css.includes(size)]).toEqual([size, true, true]);
    expect(css).not.toMatch(/box-shadow|gradient|border-radius/);
  });
});

describe('the charts', () => {
  const rects = (html: string) => (html.match(/<rect /g) ?? []).length;
  const profile = (name: string, extra: Partial<Profile> = {}): Profile => ({ name, answered: 100, agreed: 90, option: 8, typed: 2, dismissed: 4, timed: 80, fast: 20, ...extra });

  test('histogram: a bar per 5 seconds, an open bar for everything slower, the 15 s limit and the median marked, and the same in words', () => {
    const j = judgment();
    const html = render(<Histogram buckets={j.timeBuckets} bucketMs={j.time_bucket_ms} fastMs={j.fast_ms} medianMs={j.timing.medianMs} n={j.timing.n} fast={j.timing.fast} minN={MIN_N} />);
    expect(rects(html)).toBe(TIME_BUCKETS + 1);
    expect((html.match(/class="bar over"/g) ?? []).length).toBe(1);
    expect(html).toContain('class="marker"');
    expect(html).toContain('class="median"');
    expect(html).toContain('aria-label="Answer times of 1,362 question prompts. 20% were answered in under 15 s; the median is 42 s."');
    expect(text(html)).toContain('15 s 0 1 min 2 min 3 min+ 20% under 15 s (274 of 1,362) · median 42 s');
    expect(html).not.toContain('NaN');
  });

  test('histogram: with fewer than five timed answers it draws nothing and says how many there are', () => {
    const html = render(<Histogram buckets={judgment().timeBuckets} bucketMs={TIME_BUCKET_MS} fastMs={FAST_ANSWER_MS} medianMs={9_000} n={4} fast={3} minN={MIN_N} />);
    expect(html).not.toContain('<svg');
    expect(text(html)).toBe('How fast you answer Too few timed answers to draw (4).');
  });

  test('outcome bar: every question to scale, nothing for a count of zero, and the same in words', () => {
    const html = render(
      <OutcomeBar
        segments={[
          { key: 'took', label: 'took', n: 75 },
          { key: 'other', label: 'chose otherwise', n: 25 },
          { key: 'dismissed', label: 'dismissed', n: 0 },
          { key: 'excluded', label: 'excluded', n: 100, note: '7 inferred' },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Of 200 questions: took 75, chose otherwise 25, excluded 100."');
    expect(html).toContain('<rect class="seg took" x="0.5" y="0.5" width="224" height="9">'); // 75 of 200 on a width of 600, less the outline
    expect(html).not.toContain('seg dismissed');
    expect(text(html)).toBe('took 75 chose otherwise 25 excluded 100 (7 inferred)');
    expect(render(<OutcomeBar segments={[{ key: 'took', label: 'took', n: 0 }]} />)).toBe('');
  });

  test('track: the dot runs from the stated start to 100%, stays on the track, and is absent without a share', () => {
    expect(render(<Track share={80} from={80} />)).toContain('cx="4"');
    expect(render(<Track share={100} from={80} />)).toContain('cx="76"');
    expect(render(<Track share={90} from={80} />)).toContain('cx="40"');
    expect(render(<Track share={50} from={80} />)).toContain('cx="4"');
    expect(render(<Track share={null} from={80} />)).not.toContain('<circle');
    expect(render(<Track share={90} from={80} />)).toContain('aria-hidden="true"'); // the number beside it says the same
  });

  test('time bar: one scale for every table; a longer time fills the width as an outline; no time, no bar', () => {
    expect(render(<TimeBar ms={TIME_BAR_MAX_MS / 2} />)).toContain('<rect class="bar" x="0" y="3.5" width="28" height="5">');
    expect(render(<TimeBar ms={TIME_BAR_MAX_MS} />)).toContain('class="bar"');
    expect(render(<TimeBar ms={TIME_BAR_MAX_MS + 1} />)).toContain('<rect class="bar over" x="0.5" y="4" width="55" height="4">');
    expect(render(<TimeBar ms={null} />)).not.toContain('<rect');
  });

  test('the five measures of a profile, and the scale of a spoke', () => {
    const s = spokes(profile('m'), MIN_N, '15 s');
    expect(s.map((k) => k.label)).toEqual(['took it', 'under 15 s', 'chose another', 'typed own answer', 'dismissed']);
    expect(s[0].value).toBe(0.9);
    expect(s[1].value).toBe(0.25);
    expect(s[2].value).toBe(0.08);
    expect(s[3].value).toBe(0.02);
    expect(s[4].value).toBeCloseTo(4 / 104, 10); // of the answered and the dismissed together
    expect(spokes(profile('m', { timed: MIN_N - 1, fast: 1 }), MIN_N, '15 s')[1].value).toBeNull(); // too few timed prompts for a share
    expect(spokes(profile('m', { answered: 0, agreed: 0, option: 0, typed: 0, dismissed: 0 }), MIN_N, '15 s')[0].value).toBeNull(); // never NaN
    expect([spokeScale([0.9, 0.87]), spokeScale([0.21, 0.25]), spokeScale([0.02, null]), spokeScale([0.04]), spokeScale([null]), spokeScale([1])]).toEqual([0.9, 0.25, 0.02, 0.04, 0.02, 1]);
    expect(spokeScale([0.131])).toBe(0.15);
  });

  test('spider: an outline per model with enough answers, each with its own color and line style, a key, and every number in words', () => {
    const html = render(<Spider profiles={[profile('m-a'), profile('m-b', { agreed: 80, option: 15, typed: 5 }), profile('m-few', { answered: MIN_N - 1 })]} minN={MIN_N} fastMs={FAST_ANSWER_MS} />);
    expect((html.match(/<polygon class="outline"/g) ?? []).length).toBe(2);
    expect(html).toContain('<g class="series s1">');
    expect(html).toContain('<g class="series s2">');
    expect(html).not.toContain('m-few');
    expect(html).toContain('m-a: took it 90%, under 15 s 25%, chose another 8%, typed own answer 2%, dismissed 4%. m-b: took it 80%');
    const t = text(html);
    expect(t).toContain('How you respond, per model took it edge = 90% under 15 s edge = 25% chose another edge = 15% typed own answer edge = 6% dismissed edge = 4%');
    expect(t).toContain('m-a (100 answers) m-b (100 answers)');
    expect(t).toContain('Each spoke has its own scale, from 0 at the centre to the value named at its edge.');
    expect(t).toContain('The exact numbers are in By model.');
  });

  test('spider: one model says so; none with enough answers and the block is absent; a missing measure has no point', () => {
    expect(text(render(<Spider profiles={[profile('m-a')]} minN={MIN_N} fastMs={FAST_ANSWER_MS} />))).toContain('Only one model has enough answers to draw.');
    expect(render(<Spider profiles={[profile('m-few', { answered: 1 })]} minN={MIN_N} fastMs={FAST_ANSWER_MS} />)).toBe('');
    expect(render(<Spider profiles={[]} minN={MIN_N} fastMs={FAST_ANSWER_MS} />)).toBe('');
    const untimed = render(<Spider profiles={[profile('m-a', { timed: 0, fast: 0 })]} minN={MIN_N} fastMs={FAST_ANSWER_MS} />);
    expect((untimed.match(/<circle class="vertex"/g) ?? []).length).toBe(4 + 1); // four measures, and the key
    expect(untimed).toContain('under 15 s not known');
    expect(untimed).not.toContain('NaN');
  });

  test('on the page: the profile follows By project, and a profiled model carries its key in By model', () => {
    const page = board({
      judgment: judgment({
        modelProfiles: [profile('m-a'), profile('m-b')],
        splits: { ...judgment().splits, model: [{ name: 'm-a', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 }, { name: 'm-b', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 }, { name: 'unknown', agreed: 5, answered: 5, medianMs: null, timed: 0 }] },
      }),
    });
    expect(page.indexOf('How you respond, per model')).toBeGreaterThan(page.indexOf('By project'));
    expect(page.indexOf('How you respond, per model')).toBeLessThan(page.indexOf('By agent'));
    expect(page).toContain('<th scope="row"><svg class="serieskey series s1"');
    expect(page).toContain('<th scope="row"><svg class="serieskey series s2"');
    expect(page).toContain('<th scope="row">unknown</th>');
    expect(board()).not.toContain('How you respond, per model'); // no model with enough answers: no profile
  });

  test('on the page: the split tracks start where the trend axis starts, and the header says where', () => {
    expect(axisStart(judgment().weekly, MIN_N)).toBe(80); // the lowest drawn week is 174 of 199, 87%
    expect(axisStart(weeks([[5, 5], [0, 5]]), MIN_N)).toBe(0);
    expect(axisStart(weeks([[99, 100]]), MIN_N)).toBe(90); // never above 90
    expect(axisStart(weeks([[1, 4]]), MIN_N)).toBe(0); // no week drawn
    const page = board();
    expect(page).toContain('<th scope="col" class="num">Share, from 70%</th>'); // By skill holds a row at 79%, so its track starts lower
    expect(page).toContain('<th scope="col" class="num">Share, from 80%</th>');
  });

  test('trend: weekly median answer times as squares on the same weeks, drawn only with five timed prompts, and in the table', () => {
    const j = judgment();
    const html = render(<Trend weekly={j.weekly} weeklyTime={j.weekly_time} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect((html.match(/class="tick"/g) ?? []).length).toBe(5); // six weeks have times; the week with 4 has none drawn
    expect((html.match(/class="link thin"/g) ?? []).length).toBe(3);
    const t = text(html);
    expect(t).toContain('Dots show the share taken; the share axis starts at 80%. Squares show the median answer time. Bars show how many answers each week had.');
    expect(t).toContain('Weekly numbers Week of Share Answers Median answer');
    expect(t).toContain('Nov 9 90% 138 40 s');
    expect(html).toContain('100%</text>');
    expect(html).toContain('90%</text>');
    expect(html).toContain('80%</text>');
    const none = render(<Trend weekly={j.weekly} weeklyTime={j.weekly_time.map((w) => ({ ...w, timed: 0, medianMs: null }))} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect(none).not.toContain('class="tick"');
    expect(text(none)).not.toContain('Median answer');
  });

  test('gstack TODOS are folded away under their count', () => {
    const html = render(<NeedsYou inbox={inbox({ todos: [{ project: 'owner-repo', file: 'f', items: ['one', 'two'] }, { project: 'other', file: 'g', items: ['three'] }] })} now={NOW} />);
    expect(html).toContain('<details class="more todos">');
    expect(text(html)).toContain('TODOS (3)');
  });
});

describe('the address in capture health', () => {
  test('shown first when the page knows it, and absent otherwise', () => {
    const withAddress = text(render(<CaptureHealth inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} address="http://127.0.0.1:4777/" />));
    expect(withAddress.startsWith('address http://127.0.0.1:4777/ live since Nov 9, 14:02')).toBe(true);
    expect(text(render(<CaptureHealth inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} />))).not.toContain('address');
  });
});
