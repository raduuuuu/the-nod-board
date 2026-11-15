/**
 * charts.tsx: the small graphics of the board, as pure components (DESIGN.md, "Charts").
 *
 *   Histogram    how fast you answer: timed prompts per 5 seconds, a marker at the "fast" limit
 *   OutcomeBar   where every question went, to scale, with a labelled key
 *   Track        one dot on a short track: a share within a table row
 *   TimeBar      one thin bar: an answer time within a table row
 *   Marks        a session's answers in order: filled took the recommendation, hollow chose otherwise
 *   Spider       how you respond, per model: five different measures, one outline per model
 *
 * Rules they share: hand-written SVG, no library; geometry in attributes and every color in the
 * stylesheet (the page allows no inline style); ink and grey, except the series colors of charts
 * that hold several series, where each series also has its own line style. No chart is the only
 * carrier of a number: each has a text line, a table or an aria-label that says the same.
 */
import { count, duration, percent } from './format';

const DASH = '–';

// ---------------------------------------------------------------- histogram

const H_W = 340;
const H_TOP = 14;
const H_PLOT = 56;
const H_GAP = 6; // between the last regular bucket and the "slower" one

export function Histogram(props: { buckets: number[]; bucketMs: number; fastMs: number; medianMs: number | null; n: number; fast: number; minN: number }) {
  const { buckets, bucketMs, n } = props;
  const regular = buckets.length - 1;
  if (n < props.minN || regular < 1) {
    return (
      <div class="histogram">
        <h3>How fast you answer</h3>
        <p class="muted small">Too few timed answers to draw ({count(n)}).</p>
      </div>
    );
  }
  const bw = (H_W - H_GAP) / buckets.length;
  const max = Math.max(...buckets, 1);
  const base = H_TOP + H_PLOT;
  const x = (i: number) => i * bw + (i === regular ? H_GAP : 0);
  const at = (ms: number) => Math.min(regular, ms / bucketMs) * bw;
  const fastX = at(props.fastMs);
  const minute = Math.round(60_000 / bucketMs);
  const ticks: [number, string][] = [[0, '0']];
  for (let m = 1; m * minute < regular; m++) ticks.push([m * minute * bw, `${m} min`]);
  const fastShare = percent(props.fast, n);
  const slower = duration(regular * bucketMs);
  const summary = `Answer times of ${count(n)} question prompts. ${fastShare} were answered in under ${duration(props.fastMs)}; the median is ${duration(props.medianMs)}.`;
  return (
    <div class="histogram">
      <h3>How fast you answer</h3>
      <svg viewBox={`0 0 ${H_W} ${base + 16}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        {buckets.map((c, i) => {
          const h = c ? Math.max(1.5, (H_PLOT * c) / max) : 0;
          return <rect class={i === regular ? 'bar over' : 'bar'} x={x(i) + 0.75} y={base - h} width={bw - 1.5} height={h} />;
        })}
        <line class="rule strong" x1="0" x2={H_W} y1={base} y2={base} />
        <line class="marker" x1={fastX} x2={fastX} y1={H_TOP - 8} y2={base} />
        <text class="axis" x={fastX + 4} y={H_TOP - 2}>{duration(props.fastMs)}</text>
        {props.medianMs !== null ? <path class="median" d={`M${at(props.medianMs) - 4} ${base + 7} l4 -6 l4 6 z`} /> : null}
        {ticks.map(([tx, label]) => (
          <text class="axis" x={tx} y={base + 14}>{label}</text>
        ))}
        <text class="axis" x={H_W} y={base + 14} text-anchor="end">{slower}+</text>
      </svg>
      <p class="muted small">
        {fastShare} under {duration(props.fastMs)} ({count(props.fast)} of {count(n)}) · median {props.medianMs === null ? DASH : duration(props.medianMs)} (▲)
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- where every question went

export interface OutcomeSegment {
  key: 'took' | 'other' | 'dismissed' | 'excluded' | 'unanswered' | 'unreadable';
  label: string;
  n: number;
  note?: string;
}

const O_W = 600;
const O_H = 10;

/** One bar for every question, to scale. Segments of zero are left out, so the key lists only what exists. */
export function OutcomeBar(props: { segments: OutcomeSegment[] }) {
  const segments = props.segments.filter((s) => s.n > 0);
  const total = segments.reduce((sum, s) => sum + s.n, 0);
  if (!total) return null;
  let x = 0;
  const summary = `Of ${count(total)} questions: ${segments.map((s) => `${s.label} ${count(s.n)}`).join(', ')}.`;
  return (
    <div class="outcomes">
      <svg viewBox={`0 0 ${O_W} ${O_H}`} role="img" aria-label={summary} preserveAspectRatio="none">
        {segments.map((s) => {
          const w = (O_W * s.n) / total;
          const rect = <rect class={`seg ${s.key}`} x={x + 0.5} y="0.5" width={Math.max(0.5, w - 1)} height={O_H - 1} />;
          x += w;
          return rect;
        })}
      </svg>
      <ul class="keys">
        {segments.map((s) => (
          <li>
            <svg class="key" viewBox="0 0 10 10" aria-hidden="true">
              <rect class={`seg ${s.key}`} x="0.5" y="0.5" width="9" height="9" />
            </svg>
            {s.label} {count(s.n)}
            {s.note ? ` (${s.note})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- inside a table row

const T_W = 80;
const T_PAD = 4;

/** A dot at `share` (0 to 100) on a track that runs from `from` to 100. No dot when there is no share to show. */
export function Track(props: { share: number | null; from: number }) {
  const span = 100 - props.from;
  const cx = props.share === null || span <= 0 ? null : T_PAD + ((T_W - 2 * T_PAD) * (Math.max(props.from, props.share) - props.from)) / span;
  return (
    <svg class="track" viewBox={`0 0 ${T_W} 12`} aria-hidden="true">
      <line class="rule strong" x1={T_PAD} x2={T_W - T_PAD} y1="6" y2="6" />
      {cx === null ? null : <circle class="dot" cx={cx} cy="6" r="3.5" />}
    </svg>
  );
}

const B_W = 56;

/** Every time bar on the page shares this scale, so bars compare across tables. */
export const TIME_BAR_MAX_MS = 90_000;

/** A thin bar for `ms` on the scale 0 to TIME_BAR_MAX_MS. A longer time fills the width as an outline, like the histogram's last bar. */
export function TimeBar(props: { ms: number | null }) {
  const over = props.ms !== null && props.ms > TIME_BAR_MAX_MS;
  const w = props.ms === null ? 0 : over ? B_W : Math.max(1, (B_W * props.ms) / TIME_BAR_MAX_MS);
  return (
    <svg class="tbar" viewBox={`0 0 ${B_W} 12`} aria-hidden="true">
      {w ? <rect class={over ? 'bar over' : 'bar'} x={over ? 0.5 : 0} y={over ? 4 : 3.5} width={over ? w - 1 : w} height={over ? 4 : 5} /> : null}
    </svg>
  );
}

const M_SIZE = 8;
const M_GAP = 2;
export const MARKS_PER_ROW = 30;

/** A session's answers in order. The count beside it says the same in words, so this is hidden from screen readers. */
export function Marks(props: { marks: string }) {
  const n = props.marks.length;
  if (!n) return null;
  const cols = Math.min(n, MARKS_PER_ROW);
  const rows = Math.ceil(n / MARKS_PER_ROW);
  const step = M_SIZE + M_GAP;
  return (
    <svg class="marks" viewBox={`0 0 ${MARKS_PER_ROW * step - M_GAP} ${rows * step - M_GAP}`} data-cols={cols} aria-hidden="true">
      {[...props.marks].map((m, i) => (
        <rect class={m === '1' ? 'mark took' : 'mark other'} x={(i % MARKS_PER_ROW) * step + 0.5} y={Math.floor(i / MARKS_PER_ROW) * step + 0.5} width={M_SIZE - 1} height={M_SIZE - 1} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- how you respond, per model

export interface Profile {
  name: string;
  answered: number;
  agreed: number;
  option: number;
  typed: number;
  dismissed: number;
  timed: number;
  fast: number;
}

/** The five measures, in spoke order starting at the top and going clockwise. Each is a share from 0 to 1, or null. */
export function spokes(p: Profile, minN: number, fastLabel: string): { label: string; value: number | null }[] {
  const of = (part: number, whole: number) => (whole > 0 ? part / whole : null);
  return [
    { label: 'took it', value: of(p.agreed, p.answered) },
    { label: `under ${fastLabel}`, value: p.timed >= minN ? of(p.fast, p.timed) : null },
    { label: 'chose another', value: of(p.option, p.answered) },
    { label: 'typed own answer', value: of(p.typed, p.answered) },
    { label: 'dismissed', value: of(p.dismissed, p.answered + p.dismissed) },
  ];
}

/** Each spoke has its own scale: up to the largest value drawn on it, rounded up to a round number of percent. */
export function spokeScale(values: (number | null)[]): number {
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const pct = max * 100;
  const step = pct <= 10 ? 2 : pct <= 30 ? 5 : 10;
  return Math.max(step, Math.ceil(pct / step) * step) / 100;
}

const S_W = 360;
const S_H = 290;
const S_CX = S_W / 2;
const S_CY = 148;
const S_R = 96;

export function Spider(props: { profiles: Profile[]; minN: number; fastMs: number }) {
  const shown = props.profiles.filter((p) => p.answered >= props.minN);
  if (!shown.length) return null;
  const fastLabel = duration(props.fastMs);
  const series = shown.map((p) => ({ profile: p, spokes: spokes(p, props.minN, fastLabel) }));
  const labels = series[0].spokes.map((s) => s.label);
  const scales = labels.map((_, i) => spokeScale(series.map((s) => s.spokes[i].value)));
  const angle = (i: number) => (-90 + (360 / labels.length) * i) * (Math.PI / 180);
  const point = (i: number, r: number): [number, number] => [S_CX + Math.cos(angle(i)) * r, S_CY + Math.sin(angle(i)) * r];
  const ring = (f: number) => labels.map((_, i) => point(i, S_R * f).map((n) => n.toFixed(1)).join(',')).join(' ');
  const summary = `How you respond, per model, on five measures. ${series
    .map((s) => `${s.profile.name}: ${s.spokes.map((k) => `${k.label} ${k.value === null ? 'not known' : `${Math.round(k.value * 100)}%`}`).join(', ')}`)
    .join('. ')}.`;
  return (
    <section class="spider" aria-labelledby="spider-h">
      <h2 id="spider-h">How you respond, per model</h2>
      <svg viewBox={`0 0 ${S_W} ${S_H}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        <polygon class="ring" points={ring(0.5)} />
        <polygon class="ring" points={ring(1)} />
        {labels.map((label, i) => {
          const [ex, ey] = point(i, S_R);
          const [lx, ly] = point(i, S_R + 16);
          const anchor = Math.abs(lx - S_CX) < 4 ? 'middle' : lx > S_CX ? 'start' : 'end';
          const up = ly < S_CY - S_R / 2;
          return (
            <g>
              <line class="rule" x1={S_CX} y1={S_CY} x2={ex} y2={ey} />
              <text class="axis strong" x={lx} y={up ? ly - 12 : ly + 2} text-anchor={anchor}>{label}</text>
              <text class="axis" x={lx} y={up ? ly : ly + 14} text-anchor={anchor}>edge = {Math.round(scales[i] * 100)}%</text>
            </g>
          );
        })}
        {series.map((s, n) => {
          const pts = s.spokes.map((k, i) => point(i, S_R * Math.min(1, (k.value ?? 0) / scales[i])));
          return (
            <g class={`series s${n + 1}`}>
              <polygon class="outline" points={pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')} />
              {pts.map(([px, py], i) => (s.spokes[i].value === null ? null : <circle class="vertex" cx={px} cy={py} r="3" />))}
            </g>
          );
        })}
      </svg>
      <ul class="keys">
        {series.map((s, n) => (
          <li>
            <SeriesKey n={n + 1} />
            {s.profile.name} <span class="muted">({count(s.profile.answered)} answers)</span>
          </li>
        ))}
      </ul>
      <p class="muted small">
        Each spoke has its own scale, from 0 at the centre to the value named at its edge. {shown.length === 1 ? 'Only one model has enough answers to draw. ' : ''}
        The exact numbers are in By model.
      </p>
    </section>
  );
}

/** The line sample that identifies a series: its color and its line style together. */
export function SeriesKey(props: { n: number }) {
  return (
    <svg class={`serieskey series s${props.n}`} viewBox="0 0 22 10" aria-hidden="true">
      <line class="outline" x1="1" x2="21" y1="5" y2="5" />
      <circle class="vertex" cx="11" cy="5" r="3" />
    </svg>
  );
}
