import { count, day, percent } from './format';

export interface WeekPoint {
  start: number;
  agreed: number;
  answered: number;
}

/** Drawing width in SVG units. The narrow drawing is used with 8 weeks, so its labels stay near their real size on a phone. */
const WIDE = 600;
const NARROW = 380;
const SHARE_TOP = 10;
const SHARE_H = 90;
const BAR_TOP = 116;
const BAR_H = 34;
const LEFT = 58; // room for the widest axis label, "answers"

/**
 * Weekly trend: a dot per week for the share, a bar beneath for how many answers it rests on.
 * A week with fewer than `minN` answers shows its bar and no dot, and the line is drawn only
 * between adjacent weeks that both have a dot, so thin weeks appear as gaps, never as swings.
 * The same numbers are available as a table for screen readers and for exact reading.
 */
export function Trend(props: { weekly: WeekPoint[]; minN: number; weeks: number; timeZone?: string }) {
  const points = props.weekly.slice(-props.weeks);
  if (!points.some((p) => p.answered >= props.minN)) return null; // hidden until one week qualifies
  const W = props.weeks <= 8 ? NARROW : WIDE;
  const step = (W - LEFT) / points.length;
  const x = (i: number) => LEFT + step * (i + 0.5);
  const y = (p: WeekPoint) => SHARE_TOP + SHARE_H * (1 - p.agreed / p.answered);
  const maxAnswered = Math.max(...points.map((p) => p.answered), 1);
  const shown = points.map((p) => p.answered >= props.minN);
  const lines: [number, number][] = [];
  for (let i = 1; i < points.length; i++) if (shown[i - 1] && shown[i]) lines.push([i - 1, i]);
  const qualifying = points.filter((_, i) => shown[i]);
  const summary = `Share of recommendations taken per week over the last ${points.length} weeks. ${qualifying.length} weeks have at least ${props.minN} answers; the latest of those is ${percent(qualifying[qualifying.length - 1].agreed, qualifying[qualifying.length - 1].answered)}.`;
  return (
    <section class="trend" aria-labelledby="trend-h">
      <h2 id="trend-h">Trend, last {points.length} weeks</h2>
      <svg viewBox={`0 0 ${W} ${BAR_TOP + BAR_H + 18}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        <text class="axis" x={LEFT - 6} y={SHARE_TOP + 4} text-anchor="end">100%</text>
        <text class="axis" x={LEFT - 6} y={SHARE_TOP + SHARE_H / 2 + 4} text-anchor="end">50%</text>
        <text class="axis" x={LEFT - 6} y={SHARE_TOP + SHARE_H + 4} text-anchor="end">0%</text>
        <line class="rule" x1={LEFT} x2={W} y1={SHARE_TOP} y2={SHARE_TOP} />
        <line class="rule" x1={LEFT} x2={W} y1={SHARE_TOP + SHARE_H / 2} y2={SHARE_TOP + SHARE_H / 2} />
        <line class="rule strong" x1={LEFT} x2={W} y1={SHARE_TOP + SHARE_H} y2={SHARE_TOP + SHARE_H} />
        {lines.map(([a, b]) => (
          <line class="link" x1={x(a)} y1={y(points[a])} x2={x(b)} y2={y(points[b])} />
        ))}
        {points.map((p, i) => (shown[i] ? <circle class="dot" cx={x(i)} cy={y(p)} r="4" /> : null))}
        {points.map((p, i) => {
          const h = p.answered ? Math.max(2, (BAR_H * p.answered) / maxAnswered) : 0;
          return <rect class={shown[i] ? 'bar' : 'bar thin'} x={x(i) - step * 0.3} y={BAR_TOP + BAR_H - h} width={step * 0.6} height={h} />;
        })}
        <text class="axis" x={LEFT - 6} y={BAR_TOP + BAR_H} text-anchor="end">answers</text>
        <text class="axis" x={x(0)} y={BAR_TOP + BAR_H + 14} text-anchor="middle">{day(points[0].start, props.timeZone)}</text>
        <text class="axis" x={x(points.length - 1)} y={BAR_TOP + BAR_H + 14} text-anchor="middle">this week</text>
      </svg>
      <p class="muted small">Dots show the share taken; bars show how many answers each week had. A week with fewer than {props.minN} answers has a bar and no dot.</p>
      <details>
        <summary>Weekly numbers</summary>
        <table class="weeks">
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col" class="num">Share</th>
              <th scope="col" class="num">Answers</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr>
                <th scope="row">{day(p.start, props.timeZone)}</th>
                <td class="num">{shown[i] ? percent(p.agreed, p.answered) : p.answered ? 'too few' : ''}</td>
                <td class="num">{count(p.answered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
