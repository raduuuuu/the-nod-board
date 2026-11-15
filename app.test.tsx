import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { render } from 'preact-render-to-string';
import { Acceptance, Board, CaptureHealth, FOLD_ABOVE, IMPORT_COMMAND, LIST_ROWS, NeedsYou, Overrides, RecentSessions, Split, type BoardProps, type SplitRow } from './app/board';
import { ago, count, dayTime, duration, percent, share } from './app/format';
import { FAILURES_BEFORE_UNREACHABLE, SLOW_FIRST_MS, freshness, initialLink, onFailure, onSuccess } from './app/poll';
import { Trend, type WeekPoint } from './app/trend';
import { FAST_ANSWER_MS, MIN_N, OUTCOMES } from './judgment';
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
  projects: [
    { project: 'thing', agreed: 90, answered: 100, medianMs: 30_000, timed: 80 },
    { project: 'tiny', agreed: 2, answered: 2, medianMs: 9_000, timed: 2 },
  ],
  sessions: [{ session: 'sess-1', project: 'thing', lastTs: NOW - 3_600_000, agreed: 9, answered: 11, medianMs: 101_000, timed: 9 }],
  overrides: [
    { ts: NOW - 3_600_000, project: 'thing', title: 'Rename the module?', typed: false },
    { ts: NOW - 7_200_000, project: 'thing', title: 'Which name?', typed: true },
  ],
  inferred_dismissed: 0,
  weekly: weeks([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [174, 199], [3, 4], [329, 349], [353, 371], [293, 324], [124, 138]]),
  capture: { unreadable_lines: 0, sources: { hook: true, import: true } },
  ...extra,
});
const okLink = onSuccess(initialLink(NOW - 60_000), NOW - 3_000);
const board = (extra: Partial<BoardProps> = {}) => render(<Board inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} {...extra} />);
/** The text a reader sees, without the markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

describe('format', () => {
  test('counts, shares, durations and ages', () => {
    expect(count(1387)).toBe('1,387');
    expect(percent(1281, 1387)).toBe('92%');
    expect(share({ agreed: 4, answered: MIN_N - 1 }, MIN_N)).toBeNull();
    expect(share({ agreed: 4, answered: MIN_N }, MIN_N)).toBe('80%');
    expect(share({ agreed: 0, answered: 0 }, MIN_N)).toBeNull(); // never NaN%
    expect([duration(41_654), duration(119_400), duration(150_000), duration(null)]).toEqual(['42 s', '119 s', '3 min', '']);
    expect([ago(0), ago(4_999), ago(5_000), ago(59_000), ago(240_000), ago(3_600_000), ago(49 * 3_600_000), ago(-5)]).toEqual(['just now', 'just now', '5 s ago', '59 s ago', '4 min ago', '1 h ago', '2 d ago', 'just now']);
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
    for (const heading of ['The Nod Board', 'Needs you', 'Recommendations taken', 'Recent sessions', 'Where you overrode', 'By project']) expect(html).toContain(heading);
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
    expect(t).toContain('thing waiting 4 min ago Claude is waiting for your input claude --resume sess-1');
    expect(t).toContain('permission asked 2 min ago, may be approved');
    expect(t).toContain('finished 10 min ago');
    expect(t).toContain('waiting 13 h ago (no event for 12 h+)');
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

  test('the number, what it rests on, three figures under it with their counts, and the framing sentence', () => {
    const html = render(<Acceptance judgment={judgment()} timeZone={UTC} />);
    expect(html).toContain('<span class="number">92%</span>');
    const t = text(html);
    expect(t).toContain('92% took the recommendation, 1,281 of 1,387 median answer 42 s under 15 s 274 of 1,362 20% last 7 days 124 of 138 90%');
    expect((html.match(/class="number"/g) ?? []).length).toBe(1); // one anchor
    expect(t).toContain('A high share can mean good recommendations or quick clicking; the answer time beside it is the clue.');
    expect(t).toContain('Not in the share: dismissed 53 · excluded 105');
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
    expect(bars(html)).toBe(12);
    expect(circles(html)).toBe(5); // six weeks have answers; the week with 4 has a bar and no dot
    expect(links(html)).toBe(3); // 174/199 | gap | 329/349 - 353/371 - 293/324 - 124/138
    expect(html).toContain('class="bar thin"');
    expect(text(html)).toContain('A week with fewer than 5 answers has a bar and no dot.');
  });

  test('the same numbers as a table, and a text summary on the chart itself', () => {
    const html = render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={12} timeZone={UTC} />);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Share of recommendations taken per week over the last 12 weeks\. 5 weeks have at least 5 answers; the latest of those is 90%\."/);
    const t = text(html);
    expect(t).toContain('Weekly numbers Week of Share Answers');
    expect(t).toContain('Nov 9 90% 138');
    expect(t).toContain('Oct 12 too few 4');
    expect(t).toContain('Oct 5 87% 199');
    expect(html).toContain('<th scope="row">Aug 24</th><td class="num"></td><td class="num">0</td>'); // an empty week has no share at all
  });

  test('narrow screens show the last 8 weeks', () => {
    const html = render(<Trend weekly={judgment().weekly} minN={MIN_N} weeks={8} timeZone={UTC} />);
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
    const html = board();
    expect(html).toContain('<th scope="row">thing</th><td class="num">90%</td><td class="num">100</td><td class="num">30 s</td>');
    expect(html).toContain('<th scope="row">tiny</th><td class="num">too few</td><td class="num">2</td><td class="num">–</td>');
    expect(html).not.toContain('By label');
    expect(html).toContain('<th scope="col" class="num">Answer time</th>');
    expect(html).toContain('<th scope="col" class="num">Share</th>');
  });
});

describe('the three figures', () => {
  const figures = (extra: Partial<JudgmentPayload>) => text(render(<Acceptance judgment={judgment(extra)} timeZone={UTC} />));

  test('no timed answer: dashes for both time figures, and no count that would read 0 of 0', () => {
    const t = figures({ timing: { n: 0, medianMs: null, fast: 0 } });
    expect(t).toContain('median answer – under 15 s – last 7 days');
  });

  test('fewer than five timed answers, or five answers in the last 7 days: "too few" with the count', () => {
    const t = figures({ timing: { n: 4, medianMs: 9_000, fast: 3 }, recent: { agreed: 2, answered: 3 } });
    expect(t).toContain('under 15 s 3 of 4 too few');
    expect(t).toContain('last 7 days 2 of 3 too few');
    expect(t).not.toContain('75%');
    expect(t).not.toContain('67%');
  });

  test('nothing set apart: the "Not in the share" line is absent', () => {
    expect(figures({ counts: { ...emptyCounts, AGREED: 9, OVERRODE_OPTION: 1 } })).not.toContain('Not in the share');
  });
});

describe('recent sessions', () => {
  const sessionRow = (i: number, extra = {}) => ({ session: `s${i}`, project: `proj ${i}`, lastTs: NOW - i * 3_600_000, agreed: i, answered: i + 1, medianMs: 20_000, timed: 1, ...extra });

  test('when it last answered, the project, counts instead of a share, and the answer time', () => {
    const t = text(render(<RecentSessions judgment={judgment()} timeZone={UTC} />));
    expect(t).toBe('Recent sessions Last answer Project Taken Answer time Nov 12, 13:02 thing 9 of 11 101 s');
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
    const html = split([row('a', 20, { timed: 5 }), row('b', 20, { timed: 4 })]);
    expect(html).toContain('<th scope="row">a</th><td class="num">100%</td><td class="num">20</td><td class="num">12 s</td>');
    expect(html).toContain('<th scope="row">b</th><td class="num">100%</td><td class="num">20</td><td class="num">–</td>');
  });

  test('no rows: the block is absent', () => {
    expect(split([])).toBe('');
  });
});

describe('capture health', () => {
  const health = (extra: Partial<BoardProps> = {}) => text(render(<CaptureHealth inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} {...extra} />));

  test('live since, last event, hook errors, import state, version, and how fresh the page is', () => {
    expect(health()).toBe('live since : Nov 9, 14:02 last event : 30 s ago hook errors : 0 past sessions : imported version : 0.1.0 updated just now'.replace(/ :/g, ''));
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
    const order = ['Needs you', 'Recommendations taken', 'Trend, last 12 weeks', 'Recent sessions', 'Where you overrode', 'By project', 'live since'].map((s) => html.indexOf(s));
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
        sessions: [{ session: 's', project: `<img src=x onerror=alert(1)>`, lastTs: NOW, agreed: 5, answered: 5, medianMs: null, timed: 0 }],
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
    for (const color of ['#fff', '#121212', '#1a1a1a', '#ececec', '#666', '#9a9a9a', '#e3e3e3', '#2c2c2c', '#b4005a', '#ff6fae']) {
      expect([color, design.includes(`\`${color}\``), css.includes(color)]).toEqual([color, true, true]);
    }
    for (const size of ['13px', '16px', '20px', '40px']) expect([size, design.includes(size), css.includes(size)]).toEqual([size, true, true]);
    expect(css).not.toMatch(/box-shadow|gradient|border-radius/);
  });
});

describe('the address in capture health', () => {
  test('shown first when the page knows it, and absent otherwise', () => {
    const withAddress = text(render(<CaptureHealth inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} address="http://127.0.0.1:4777/" />));
    expect(withAddress.startsWith('address http://127.0.0.1:4777/ live since Nov 9, 14:02')).toBe(true);
    expect(text(render(<CaptureHealth inbox={inbox()} judgment={judgment()} link={okLink} now={NOW} weeks={12} timeZone={UTC} />))).not.toContain('address');
  });
});
