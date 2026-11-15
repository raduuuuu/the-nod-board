# The Nod Board: design system

One page, used beside an editor. It reports; it does not judge. Decisions below come from the
design review of 2026-11-15 and are the source for `app/app.css`.

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
| 20px | section values next to the number |
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
| 1024px and up | two zones: Needs you 280px on the left, main area fluid, content at most 1200px; By project and By label side by side |
| 640 to 1023px | one column: Needs you, acceptance, trend, overrides, splits, capture health; tables keep their columns |
| under 640px | one column; each table row becomes a two-line block; the trend shows 8 weeks; commands wrap; tap targets at least 44px |

No sideways page scrolling at any width.

## States
First paint is the final frame with an en dash where each number will go; nothing spins or
pulses. The page checks for new data every 5 seconds and says "updated N s ago". After three
failed checks it says "server not reachable since HH:MM" and keeps the last numbers. A share is
never shown without its count; under 5 answers it reads "too few".

## Trend
A dot per week for the share, a bar beneath for the number of answers. Weeks under 5 answers
show the bar only, drawn as an outline. Dots are joined only between adjacent weeks that both qualify. The same
numbers are available as a table.

## Accessibility
Landmarks: main, complementary (Needs you), contentinfo (capture health). One h1, an h2 per
block. Every command is focusable and selected whole. Focus outline: 2px in the text color.
Refreshes never move focus; only "server not reachable" is announced.

## Copy
Utility language: "Needs you", "took the recommendation", "Where you overrode", "Capture health".
Under the number, always: "A high share can mean good recommendations or quick clicking; the
answer time beside it is the clue."
