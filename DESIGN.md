# The Nod Board: design system

One page, used beside an editor. It reports; it does not judge. Decisions below come from the
design reviews of 2026-11-15 and are the source for `app/app.css`.

## Color
Light or dark follows the system setting, because the page sits next to an editor that already does.

| Token | Light | Dark | Use |
|---|---|---|---|
| page | `#fff` | `#121212` | background |
| text | `#1a1a1a` | `#ececec` | text, chart dots and lines, focus outline |
| muted | `#666` | `#9a9a9a` | labels, secondary text, chart bars |
| line | `#e3e3e3` | `#2c2c2c` | one-pixel rules |
| accent | `#b4005a` | `#ff6fae` | only the "Needs you" heading when something needs you |

- No color ever encodes a high or low acceptance share.
- Nothing is conveyed by color alone. Body text has a contrast of at least 4.5:1 in both modes.

## Type
IBM Plex Sans 400 and 600, IBM Plex Mono 400, shipped with the plugin (SIL Open Font License) and
served locally. Figures are tabular everywhere.

| Size | Use |
|---|---|
| 13px | labels, headings, footer, commands |
| 16px | body |
| 20px | the three figures under the number, and its basis |
| 40px | the acceptance number, the page's one anchor |

## Space
Steps of 4: 4, 8, 12, 16, 24, 32, 48. More space above a heading than below it.

## Surface
Flat. Zones are separated by one-pixel lines and whitespace; hierarchy comes from type size and
weight. No cards, no shadows, no gradients, radius 0. Tables are real tables.

## Motion
None. Updates change text in place. The reduced-motion setting is respected.

## Layout
| Width | Layout |
|---|---|
| 1280px and up | as below, and the split tables sit two to a row |
| 1024px and up | two zones: Needs you 280px on the left, main area fluid, content at most 1200px; one split table per row |
| 640 to 1023px | one column: Needs you, then the main area, then capture health; tables keep their columns |
| under 640px | one column; each table row becomes a two-line block that keeps every value ("94% · 312 answers · 38 s"); the three figures stack one per line; the trend shows 8 weeks; commands wrap; tap targets at least 44px |

The main area reads top to bottom: the acceptance number with its figures, the trend, recent
sessions, where you overrode, then the splits. What happened lately comes before the breakdowns.

No sideways page scrolling at any width.

## Headline
The acceptance number is the only 40px value. Under it, one row of three figures: median answer,
the share answered in under 15 seconds, and the share for the last 7 days. Each is a 20px value
above a 13px label; a share has its count under the label. A figure with nothing behind it shows
an en dash; under 5 it reads "too few".

## Lists and splits
Recent sessions and Where you overrode show 10 rows. The overrides list offers the rest through
the browser's own disclosure, styled as 13px underlined text in the text color with no marker:
"Show all 50", then "Show 10". Its open state survives the refresh.

A split table has four columns: name, share, answers, answer time. An answer time needs 5 timed
prompts behind it, else an en dash. In a table of more than 6 rows, the rows under 5 answers fold
into one closing line that keeps their total; a shorter table names every row. The splits come
in this order: skill, model, project, agent, product. A split is shown even with one row. The
"unknown" row is last and is never folded.

While an import would fill in a model or a skill, one 16px line above the splits says for how
many questions and shows the import command. It is not repeated per table and it disappears
once an import has looked.

## States
First paint is the final frame with an en dash where each number will go; nothing spins or
pulses. The page checks for new data every 5 seconds and says "updated N s ago". After three
failed checks it says "server not reachable since HH:MM" and keeps the last numbers. A share is
never shown without its count; under 5 answers it reads "too few". Counts that are zero are
not listed.

## Trend
A dot per week for the share, a bar beneath for the number of answers. Weeks under 5 answers
show the bar only, drawn as an outline. Dots are joined only between adjacent weeks that both qualify. The same
numbers are available as a table.

## Accessibility
Landmarks: main, complementary (Needs you), contentinfo (capture health, which begins with the
address the page is served from). One h1, an h2 per
block. Every command is focusable and selected whole. Focus outline: 2px in the text color.
Refreshes never move focus; only "server not reachable" is announced.

## Copy
Utility language: "Needs you", "took the recommendation", "Where you overrode", "Capture health".
Under the number, always: "A high share can mean good recommendations or quick clicking; the
answer time beside it is the clue."
