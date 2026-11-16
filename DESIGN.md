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
| series1 | `#0b5fa5` | `#6cb2ee` | first series of a chart with several series; solid line |
| series2 | `#b85c00` | `#f0a04b` | second series; long dashes |
| series3 | `#2f7d4f` | `#6fcf97` | third series; dots |
| series4 | `#0f766e` | `#4fd1c5` | fourth series; dash and dot |

- No color ever encodes a high or low acceptance share.
- The series colors only tell series apart, in a chart that holds several. Every other chart is
  text color and grey.
- Nothing is conveyed by color alone: each series also has its own line style. Body text has a
  contrast of at least 4.5:1 in both modes, and every series color at least 4.5:1 on the page.

## Type
IBM Plex Sans 400 and 600, IBM Plex Mono 400, shipped with the plugin (SIL Open Font License) and
served locally. Figures are tabular everywhere.

| Size | Use |
|---|---|
| 11px | text inside a chart: axis and spoke labels, nothing else |
| 13px | labels, headings, footer, commands |
| 16px | body |
| 20px | the basis beside the number, and the last 7 days under it |
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
| 1280px and up | as below; the answer-time histogram sits beside the acceptance number, and the split blocks sit two to a row |
| 1024px and up | two zones: Needs you 280px on the left, main area fluid, page at most 1440px; one split block per row |
| 640 to 1023px | one column: Needs you, then the main area, then capture health; tables keep their columns |
| under 640px | one column; each table row becomes a two-line block that keeps every value ("94% · 312 answers · 38 s") and drops its track and bar; a session's squares take the full width; the trend shows at most 8 weeks; commands wrap; tap targets at least 44px |

The main area reads top to bottom: the acceptance number with what it rests on, the trend, recent
sessions, where you overrode, then the splits with the profile per model after By project. What happened lately comes before the breakdowns.

No sideways page scrolling at any width.

## Headline
The acceptance number is the only 40px value. Under it, in this order: the outcome bar, one bar
for every question to scale (took, chose otherwise, dismissed, unanswered, unreadable, excluded)
with a key that gives each count and lists only what exists (excluded is a dotted grey outline, so it
shows in dark mode too); the last 7 days as one 20px line,
"Last 7 days: 91% (169 of 186)", or "too few" with the count under 5; then the framing sentence. The plain-text line closes the block.

Beside the number from 1280px, under it below: "How fast you answer", a histogram of answer
times in 5 second bars up to 3 minutes, with one outlined bar for everything slower, a dashed
marker at 15 seconds and a triangle at the median. One line under it says the same: the share
under 15 seconds with its count, and the median. Under 5 timed answers it draws nothing and
says how many there are.

## The plain-text line
The board's one estimate. It sits third under the number, after the last 7 days and the framing
sentence, at 16px in the muted color with its figures in the text color. It gives counts and the
word "about", never a percentage, so it cannot be read as a second acceptance share. "Replies"
are turn ends in which no question went through the question tool.

| State | Text |
|---|---|
| This week and the week before | Outside the question tool, last 7 days: about 9 of 140 replies ended with a recommendation (7 days before: 14 of 150). These are not in the share above. |
| Checking began under two weeks ago | the same, with "(counting since Nov 16)" in place of the comparison |
| Nothing checked in the week before | the same, with "(none checked in the 7 days before)" |
| Fewer than 5 replies checked | Outside the question tool, last 7 days: too few replies checked to say (3). |
| None checked | Outside the question tool: no replies were checked in the last 7 days. |
| Off, not begun, or unreadable | Only choices asked through the question tool are counted; a recommendation made in plain text is not seen. |

When the data cannot be read, capture health also says "plain-text check: could not be read".

On a board with no counted questions, once at least 5 replies were checked, the first-run block
says why it is empty: "Your agent has asked nothing through the question tool. In the last 7 days
about 9 of 140 replies ended with a recommendation in plain text, which the board cannot count."
While the agent is not yet asked to use the tool, it adds "To have choices asked through the
tool, add this to ~/.agent-inbox/settings.json:" and the setting as a command. When the data
directory was moved with AGENT_INBOX_DIR, the sentence names the settings file there.

## Lists and splits
Recent sessions and Where you overrode show 10 rows. The overrides list offers the rest through
the browser's own disclosure, styled as 13px underlined text in the text color with no marker:
"Show all 50", then "Show 10". Its open state survives the refresh.
"Weekly numbers" under the trend is the same kind of disclosure and looks the same.

gstack TODOS, when there are any, sit under Needs you behind the same kind of disclosure,
closed, labelled with their count: "TODOS (33)". Each item begins with its project's name in
bold; a list is never shown as "Unassigned" when its file says what it is for.

Recent sessions shows a square per answer, in order, 30 to a line: filled took the
recommendation, hollow chose otherwise. The latest 60 are drawn; a longer session says so beside
its count. The count sits under the squares, and beside them from 1280px; under 640px the
answer time follows on its own line, labelled ("answer time 24 s").

A split table has four columns: name, share, answers, answer time. A share has a dot on an 80px
track in front of it; the track ends at 100% and starts where the trend's share axis starts, or
at a lower round ten when a row would fall off it, and the column header says where ("Share,
from 80%"). An answer time has a thin bar in front of it on one scale for the whole page, 0 to
90 seconds; a longer time fills the width as an outline. An answer time needs 5 timed
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
not listed. A count of hook errors says when the latest one happened ("1, last Nov 15, 20:47"),
since nothing clears it and an old error should read as old.

When the user has turned the update check on and a newer release exists, capture health gains
one line under its values, in the text color: "Version 0.3.8 is available. To update:" and the
command. Otherwise there is no trace of the check on the page.

## Trend
A dot per week for the share, a bar beneath for the number of answers. Weeks under 5 answers
show the bar only, drawn as an outline. Dots are joined only between adjacent weeks that both qualify. The same
numbers are available as a table.

The chart covers up to 12 weeks (8 on a narrow screen) and begins at the first week that has
an answer, so a shorter history fills the drawing. The chart spans the main column: it is drawn
at the column's width in pixels, so labels keep their size and only the plot widens; the heading counts the weeks shown ("Trend,
last 6 weeks"). Empty weeks after the first answer stay, as gaps. A bar is at most 48 units wide.

The share axis starts at the round ten at or below the lowest week drawn, never above 90%, so
a share that stays near the top is not a flat line. The axis labels and the line under the
chart both say where it starts. Between the share and the bars, a second panel shows the weekly
median answer time as grey squares on the same weeks, from 0 to the longest week, for weeks with
5 timed prompts.

## Charts
Hand-written SVG, no library. Geometry is in the markup and every color in the stylesheet. A
chart never carries a number alone: each has a line of text, a table or a spoken label that
says the same. Small graphics inside table rows are hidden from screen readers, since the cell
text beside them says the same.

"How you respond, per model" is a spider diagram with five spokes: took it, under 15 s, chose
another, typed own answer, dismissed. It draws one outline per model, for at most the four
models with the most answers and only those with 5 or more; each outline has a series color and
a line style, and the same sample marks the model's row in By model. The five measures differ
in size by an order of magnitude, so each spoke has its own scale, from 0 at the centre to a
round value named at its edge ("edge = 25%"); the outlines compare models spoke by spoke, and
their area means nothing. A measure with too little behind it has no point. With no model that
qualifies, the block is absent.

## Accessibility
Landmarks: main, complementary (Needs you), contentinfo (capture health, which begins with the
address the page is served from). One h1, an h2 per
block. Every command is focusable and selected whole. Focus outline: 2px in the text color.
Refreshes never move focus; only "server not reachable" is announced.

## Copy
Utility language: "Needs you", "took the recommendation", "Where you overrode", "Capture health".
Under the number, always: "A high share can mean good recommendations or quick clicking; the
answer time beside it is the clue."
After it, always, as its own line: the plain-text line, in the state that applies.
