import { count, day, duration, percent } from './format';

export interface WeekPoint {
  start: number;
  agreed: number;
  answered: number;
}
export interface WeekTime {
  start: number;
  medianMs: number | null;
  timed: number;
}

/**
 * Where the share axis starts, in percent: the round ten at or below the lowest weekly share that
 * is drawn, and never above 90. A share that hovers near the top is a flat line on a 0 to 100
 * axis; the chart says on its face where its axis starts.
 */
export function axisStart(points: readonly WeekPoint[], minN: number): number {
  const shares = points.filter((p) => p.answered >= minN).map((p) => (100 * p.agreed) / p.answered);
  if (!shares.length) return 0;
  return Math.max(0, Math.min(90, Math.floor(Math.min(...shares) / 10) * 10));
}

/**
 * Drawing width in SVG units. The page passes the width of its main column, so the chart spans
 * it and one unit is one pixel: labels keep their size and only the plot gets wider. Without a
 * measured width (the first paint) the narrow drawing is used with 8 weeks and the wide one otherwise.
 */
const WIDE = 600;
const NARROW = 380;
export const MIN_WIDTH = 280;
export const MAX_WIDTH = 1400;
const SHARE_TOP = 10;
const SHARE_H = 90;
const BAR_TOP = 116;
const BAR_H = 34;
/** The answer-time panel sits between the share and the bars when there are times to draw. */
const TIME_H = 36;
const TIME_GAP = 24;
const LEFT = 58; // room for the widest axis label, "answers"
const BAR_MAX_W = 48;

/**
 * Weekly trend: a dot per week for the share, a bar beneath for how many answers it rests on.
 * A week with fewer than `minN` answers shows its bar and no dot, and the line is drawn only
 * between adjacent weeks that both have a dot, so thin weeks appear as gaps, never as swings.
 * The same numbers are available as a table for screen readers and for exact reading.
 *
 * The chart begins at the first week that has an answer: a history shorter than `weeks` fills
 * the drawing instead of leaving it half empty, and the heading says how many weeks are shown.
 * Empty weeks after that first one stay, as gaps.
 *
 * The share axis starts at axisStart() and says so. With `weeklyTime`, a second panel shows the
 * weekly median answer time on the same weeks, drawn only for weeks with `minN` timed prompts.
 */
export function Trend(props: { weekly: WeekPoint[]; weeklyTime?: WeekTime[]; minN: number; weeks: number; width?: number; timeZone?: string }) {
  const window = props.weekly.slice(-props.weeks);
  if (!window.some((p) => p.answered >= props.minN)) return null; // hidden until one week qualifies
  const firstWeek = window.findIndex((p) => p.answered > 0);
  const points = window.slice(firstWeek);
  const W = props.width ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(props.width))) : props.weeks <= 8 ? NARROW : WIDE;
  const step = (W - LEFT) / points.length;
  const x = (i: number) => LEFT + step * (i + 0.5);
  // With few weeks a bar would be as wide as its column; it stays a bar.
  const barW = Math.min(step * 0.6, BAR_MAX_W);
  const from = axisStart(points, props.minN);
  const y = (p: WeekPoint) => SHARE_TOP + SHARE_H * (1 - Math.max(0, (100 * p.agreed) / p.answered - from) / (100 - from));
  const times = (props.weeklyTime ?? []).slice(-props.weeks).slice(firstWeek);
  const timed = points.map((_, i) => (times[i] && times[i].timed >= props.minN && times[i].medianMs !== null ? (times[i].medianMs as number) : null));
  const hasTimes = timed.some((v) => v !== null);
  const maxTime = Math.max(1, ...timed.map((v) => v ?? 0));
  const timeTop = SHARE_TOP + SHARE_H + TIME_GAP;
  const ty = (ms: number) => timeTop + TIME_H * (1 - ms / maxTime);
  const barTop = hasTimes ? timeTop + TIME_H + TIME_GAP : BAR_TOP;
  const timeLines: [number, number][] = [];
  for (let i = 1; i < points.length; i++) if (timed[i - 1] !== null && timed[i] !== null) timeLines.push([i - 1, i]);
  const maxAnswered = Math.max(...points.map((p) => p.answered), 1);
  const shown = points.map((p) => p.answered >= props.minN);
  const lines: [number, number][] = [];
  for (let i = 1; i < points.length; i++) if (shown[i - 1] && shown[i]) lines.push([i - 1, i]);
  const qualifying = points.filter((_, i) => shown[i]);
  const summary = `Share of recommendations taken per week over the last ${points.length} ${points.length === 1 ? 'week' : 'weeks'}. ${qualifying.length} ${qualifying.length === 1 ? 'week has' : 'weeks have'} at least ${props.minN} answers; the latest of those is ${percent(qualifying[qualifying.length - 1].agreed, qualifying[qualifying.length - 1].answered)}.`;
  return (
    <section class="trend" aria-labelledby="trend-h">
      <h2 id="trend-h">Trend, {points.length === 1 ? 'this week' : `last ${points.length} weeks`}</h2>
      <svg viewBox={`0 0 ${W} ${barTop + BAR_H + 18}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        <text class="axis" x={LEFT - 6} y={SHARE_TOP + 4} text-anchor="end">100%</text>
        <text class="axis" x={LEFT - 6} y={SHARE_TOP + SHARE_H / 2 + 4} text-anchor="end">{(100 + from) / 2}%</text>
        <text class="axis" x={LEFT - 6} y={SHARE_TOP + SHARE_H + 4} text-anchor="end">{from}%</text>
        <line class="rule" x1={LEFT} x2={W} y1={SHARE_TOP} y2={SHARE_TOP} />
        <line class="rule" x1={LEFT} x2={W} y1={SHARE_TOP + SHARE_H / 2} y2={SHARE_TOP + SHARE_H / 2} />
        <line class="rule strong" x1={LEFT} x2={W} y1={SHARE_TOP + SHARE_H} y2={SHARE_TOP + SHARE_H} />
        {lines.map(([a, b]) => (
          <line class="link" x1={x(a)} y1={y(points[a])} x2={x(b)} y2={y(points[b])} />
        ))}
        {points.map((p, i) => (shown[i] ? <circle class="dot" cx={x(i)} cy={y(p)} r="4" /> : null))}
        {hasTimes ? (
          <g class="time">
            <text class="axis" x={LEFT - 6} y={timeTop + 4} text-anchor="end">{duration(maxTime)}</text>
            <text class="axis" x={LEFT - 6} y={timeTop + TIME_H + 4} text-anchor="end">0</text>
            <line class="rule" x1={LEFT} x2={W} y1={timeTop} y2={timeTop} />
            <line class="rule strong" x1={LEFT} x2={W} y1={timeTop + TIME_H} y2={timeTop + TIME_H} />
            {timeLines.map(([a, b]) => (
              <line class="link thin" x1={x(a)} y1={ty(timed[a] as number)} x2={x(b)} y2={ty(timed[b] as number)} />
            ))}
            {timed.map((v, i) => (v === null ? null : <rect class="tick" x={x(i) - 3} y={ty(v) - 3} width="6" height="6" />))}
          </g>
        ) : null}
        {points.map((p, i) => {
          const h = p.answered ? Math.max(2, (BAR_H * p.answered) / maxAnswered) : 0;
          return <rect class={shown[i] ? 'bar' : 'bar thin'} x={x(i) - barW / 2} y={barTop + BAR_H - h} width={barW} height={h} />;
        })}
        <text class="axis" x={LEFT - 6} y={barTop + BAR_H} text-anchor="end">answers</text>
        {points.length > 1 ? <text class="axis" x={x(0)} y={barTop + BAR_H + 14} text-anchor="middle">{day(points[0].start, props.timeZone)}</text> : null}
        <text class="axis" x={x(points.length - 1)} y={barTop + BAR_H + 14} text-anchor="middle">this week</text>
      </svg>
      <p class="muted small">
        Dots show the share taken{from > 0 ? `; the share axis starts at ${from}%` : ''}.{hasTimes ? ' Squares show the median answer time.' : ''} Bars show how many answers each week had. A week with fewer than {props.minN} answers has a bar and no dot.
      </p>
      <details>
        <summary>Weekly numbers</summary>
        <table class="weeks">
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col" class="num">Share</th>
              <th scope="col" class="num">Answers</th>
              {hasTimes ? <th scope="col" class="num">Median answer</th> : null}
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr>
                <th scope="row">{day(p.start, props.timeZone)}</th>
                <td class="num">{shown[i] ? percent(p.agreed, p.answered) : p.answered ? 'too few' : ''}</td>
                <td class="num">{count(p.answered)}</td>
                {hasTimes ? <td class="num">{timed[i] === null ? '' : duration(timed[i])}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
