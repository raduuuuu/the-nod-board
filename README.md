# The Nod Board

A local dashboard for Claude Code sessions. It shows what needs you right now, and how often
you nod along with the agent's recommendation. Everything stays on your machine.

- **Needs you:** sessions waiting for input, waiting on a permission, or finished and unread,
  each with the command that resumes it.
- **Recommendations taken:** of the questions where the agent marked exactly one option
  "(Recommended)" and you answered, the share where you picked that option. Under it: one bar
  showing where every question went, and the share for the last 7 days. Beside it: a histogram
  of how fast you answer, with the share under 15 seconds and the median. Then a trend of up to 12 weeks
  of the share and of the answer time, your recent sessions with a square per answer, the
  questions where you chose otherwise, the share split by skill, model, project, agent and
  product, and a spider diagram that compares how you respond to each model.

A high share does not by itself mean the agent is right: it is the same number a reviewer who
stopped reading would produce. Read it next to the answer times.

Formerly agent-inbox. The plugin id is `nod-board`. The data directory (`~/.agent-inbox`) and
the `AGENT_INBOX_*` environment variables keep their old names for now.

## How it works

```
Claude Code session ── hooks/hooks.json ──> hook.ts (run by Bun)
     session events  ──> ~/.agent-inbox/events.jsonl     what needs you
     question asked / answered ──> outcomes.jsonl        one line per observation
     skill started, command typed, turn ended, model switched
                     ──> attrs/                          who is asking right now
     session start   ──> starts the local server when none is running

/nod-board:import ──> reads past transcripts once ──> outcomes.jsonl

server.ts (127.0.0.1, port 4777 or the next free one up to 4786, read-only)
          ──> /api/inbox, /api/judgment ──> the dashboard app
```

It needs [Bun](https://bun.sh) and nothing else. When Bun is missing, the session start says
so once and nothing is captured.

## Install

You need [Bun](https://bun.sh). Then, in Claude Code:

1. Install the plugin:
   ```
   /plugin install nod-board --marketplace raduuuuu/the-nod-board
   ```
2. Start a new session. It starts the board and tells you, once, where it is running:
   > The Nod Board is running at http://127.0.0.1:4777/ and keeps everything on this machine.
   > Open it with /nod-board:open; load your past sessions with /nod-board:import.
3. Run `/nod-board:open`, and `/nod-board:import` if you want your past sessions on the board.

A session that was already open when you installed captures nothing until you run
`/reload-plugins` in it or start a new one.

| Command | What it does |
|---|---|
| `/nod-board:open` | starts the board when it is not running, opens it in your browser and prints the address |
| `/nod-board:status` | whether it is running and where, the version, the last event, how many questions are stored, hook errors, the data folder and, when you keep an alias file, how many project aliases are in use; counts only |
| `/nod-board:import` | loads your past sessions; safe to repeat |

On Claude Code older than 2.1.275, install in two steps: `/plugin marketplace add
raduuuuu/the-nod-board`, then `/plugin install nod-board@nod-board`. The plugin is installed from
the `release` branch, which only the release workflow writes: it holds the source plus the built
dashboard, checked against a second build of the same commit.

Updates are not automatic for third-party marketplaces unless you turn that on in `/plugin`.
To update by hand: `claude plugin update nod-board@nod-board`.

## Codex CLI (experimental)

The board can also count the questions Codex asks you. Codex has its own question tool
(`request_user_input`, available in Plan mode) and runs hooks around it; a recommended option is
marked the same way, with "(Recommended)" in its label. Those questions appear on the board with
the product "Codex CLI" and their model, which Codex does report to hooks.

What has been checked, on Codex CLI 0.163.0: the hooks fire, the question and its options reach
the hook, the recommendation is marked, and a question is stored when asked and when the tool
returns without an answer.

What has not been checked:

- **The result of an answered question.** It could not be measured without an interactive Plan
  mode session. The reader accepts the shapes other tools describe; if Codex sends something
  else, the board says "answers could not be read" for those questions and never invents an
  outcome.
- **Installing through a Codex plugin marketplace.** The repository carries a Codex plugin
  manifest (`.codex-plugin/plugin.json`, hooks in `hooks/codex-hooks.json`), but that route has
  not been tried.

To register the hooks by hand, from a clone of this repository, add this to `~/.codex/hooks.json`
(Codex's documented format), with your own path:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "^request_user_input$", "hooks": [{ "type": "command", "command": "/path/to/the-nod-board/hooks/run.sh PreToolUse codex", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "^request_user_input$", "hooks": [{ "type": "command", "command": "/path/to/the-nod-board/hooks/run.sh PostToolUse codex", "timeout": 5 }] }
    ]
  }
}
```

Codex asks you to review and trust a new hook before it runs (`/hooks`). Nothing here edits your
Codex configuration for you.

For Codex only the question outcomes are captured: Codex sessions do not appear under "Needs
you", past Codex sessions are not imported, and Codex does not start the board. The board is
started by a Claude Code session or by `bun scripts/board.ts open`.

## Try it from a checkout

```sh
bun install && bun run build                 # builds dist/, the files the server serves
claude --plugin-dir /path/to/this/checkout   # hooks load for that session only
claude plugin validate /path/to/this/checkout
```

Open http://127.0.0.1:4777/ once a session has started. To load your past sessions, run
`/nod-board:import` in a session. It is safe to repeat: a second run adds only what is new,
including answers to questions that were still open the first time. It prints counts, never
question text.

`bun test` runs every test against temporary directories only.

## Releasing

1. Raise `version` in `.claude-plugin/plugin.json` and in `.codex-plugin/plugin.json` (a test keeps
   the two equal) and merge to `main`.
2. Run the `release` workflow from the Actions tab.

The workflow runs the tests, builds the dashboard twice and compares the results, commits source
plus build to the `release` branch, checks that exact commit out fresh and verifies it again,
and only then tags `v<version>`. Nothing is built or published by hand.
`bun scripts/verify-dist.ts dist` runs the same comparison locally.

## What is stored

Two append-only files in `~/.agent-inbox` (files 0600, directory 0700), beside a few one-line
marker files (when capture began, the port the server took, the address you were last told
about, a pending server start, when the last import ran):

- `events.jsonl`: per hook event, the session id, working directory, event name, notification
  type, notification text (cut to 500 characters) and time. At 5 MB it is compacted to at most
  two events per live session.
- `outcomes.jsonl`: per question, its call id and position, the outcome, the label the agent
  gave it, its first line (cut to 120 characters), session, project and two timestamps, and who
  asked when that is known: the model id, the skill or command name, the agent type and the
  product (names only, each cut to 80 characters). It is never compacted; it is the history.

While a session runs, `attrs/<session id>/` holds the name of the skill each of its agents is in,
the session's model and the session's project, one short file each. A session's folder is removed when the session
ends, or after 7 days.

Never stored: option text, the answer you picked or typed, prompts, tool input or output.
Transcripts are read only when you run the import, in memory; the hook never opens them. Nothing leaves the machine: the
server binds 127.0.0.1, rejects any Host header other than `127.0.0.1:<port>` or
`localhost:<port>` for the port it took, and has no route that changes anything.

You can read both files with any text tool; that is deliberate.

`project-aliases.json` in the same folder is yours: the board reads it and never writes it (see
"How questions are counted").

## How questions are counted

Per question of an AskUserQuestion call, the first rule that matches:

| Rule | Outcome |
|---|---|
| multi-select | excluded |
| not exactly one option marked "(recommended)" | excluded |
| answered with the recommended option | took the recommendation |
| answered with another option, or with typed text | overrode |
| rejected in a transcript | dismissed |
| asked, no answer, and the session then moved on | dismissed, marked as inferred |
| asked, no answer yet | unanswered |
| a result that could not be read, or copies that contradict each other | unreadable |

- The share is "took" divided by "took" plus "overrode". Everything else is listed apart.
- A share is never shown without its count; under 5 answers it reads "too few".
- A dismissed question fires no hook of its own, so live capture infers it once the session
  shows a later prompt, stop or end. A later import replaces an inference with what the
  transcript recorded.
- Several observations of one question (the hook and an import, or a resumed session's copies)
  are reconciled by strength of evidence; the order they arrive in never matters. The one
  exception is the project's name, which comes from the line written last, so that an import
  after an update can rename history.
- Time to answer is measured between the hook's two events, once per question prompt, however
  many questions the prompt holds. It is elapsed time, not attention. The "under 15 s" share and
  every median are over timed prompts; a median is shown with at least 5 of them.
- "Last 7 days" is the 168 hours before now, by the time of the answer.
- Charts that sit near the top do not start at zero, and say so: the trend's share axis and the
  dot tracks in the split tables name where they start. The spider diagram has a separate scale
  per spoke, named at its edge, because its five measures differ in size; compare its outlines
  spoke by spoke.
- A session is dated by its latest answer.
- A session's project is the folder it started in, not wherever it worked later. The folder is
  named after its git repository: the last part of the address of the remote called `origin`,
  or the repository's main folder when there is no such remote. A renamed checkout, a second
  clone and a worktree are therefore one project. The home directory is "no project"; a
  folder in no repository has its own name. Only the name is kept: the hook reads `.git/config`
  for it, starts no program, and never stores the address.
- A session started in the home directory has no project of its own. Each of its questions
  belongs to the repository it was asked in, and to "no project" when it was asked in none.
  ("no project" is stored as `(home directory)`, the name it had up to 0.3.0.)
- gstack keeps a project's plans and reviews in `~/.gstack/projects/<name>`, outside the
  checkout. A question asked from there belongs to `<name>`. If gstack's name differs from the
  repository's (`owner-repo`, or an older name), an alias merges the two.
- History captured by 0.2.1 or earlier was named after the folder a question was asked in. Run
  `/nod-board:import` once after updating: it names past sessions by the new rule.
- A folder that no longer exists cannot be looked up, so its sessions keep the folder's name.
  To rename or merge projects yourself, write `~/.agent-inbox/project-aliases.json`, one JSON
  object of `"name shown": "name wanted"`, for example `{"old-folder": "my-repo"}`. It is
  applied when the board is read and never changes what is stored. `/nod-board:status` says
  how many aliases are in use, or that the file could not be read.
- A question Codex asked is counted by the same rules. When its tool returns with no answer at
  all, the question is dismissed.
- Who asked: the skill is the one the agent started or the command you typed, until the turn
  ends; "no skill" means the question was asked outside any. The agent is the subagent type, or
  "main agent". The model is not in the hook payload of a question (Claude Code 2.1.325), so a
  question captured live shows "unknown" under By model until `/nod-board:import` reads it from
  the session file; the page says when an import would fill something in. When the hook and an
  import disagree, the import wins for skill and model (it is Claude Code's own record) and the
  hook wins for agent and product.
- Questions stored by 0.1.1 or earlier have no skill, model or agent until you run the import again, and
  stay "unknown" where their session file no longer exists.

The answer is read only from the structured payload, never by matching text. When Claude Code
changes that payload, the dashboard says answers could not be read instead of drifting. To
check the transcript reader against your own reading of real questions:

```sh
bun scripts/validate-judgment.ts sheet   # about 10 real questions per outcome, verdict withheld
bun scripts/validate-judgment.ts check   # 0 mismatches and "reconciled", or exit 1
```

The sheet holds real question text; it is written to `~/.agent-inbox/validation/` and the script
refuses to write inside the repository. Delete that directory when you are done.

## The server

| Route | What it returns |
|---|---|
| `/` | the dashboard app (`dist/`, built by `scripts/build.ts`) |
| `/api/inbox` | sessions that need you, as JSON |
| `/api/judgment` | totals, the last 7 days, the answer-time buckets, the profile per model, sessions, the splits (skill, model, project, agent, product) and the weekly trend of share and answer time from `outcomes.jsonl`, as JSON |
| `/health` | app name, version, whether a newer version wants to take over, source states |

The session-start hook starts the server when none is running. The first session start after
install waits up to 2 seconds for it to answer, so the line it shows names an address that
works; no other session start waits. If a start never comes up, the next session start says so
once and names the log. After a plugin update, the next
session start records the version it wants; the running server notices within 2 seconds that
another version is wanted and exits by itself, and a detached starter brings up the new one. The
same happens in reverse when you go back to an older version. No process is killed.

Which port: the server takes 4777, or the next free port up to 4786 when another program holds
it, and writes the port it took to `~/.agent-inbox/server-address.json`. The session line, the
footer, `/nod-board:open` and `/nod-board:status` all show that address. If you set
`AGENT_INBOX_PORT`, only that port is used; when another program holds it, the session start
says so. There is one server per data folder: a second start finds the first and leaves, with
no lock file to go stale. A board serving another data folder on the same machine (another
user, or a checkout with its own `AGENT_INBOX_DIR`) is left alone.

The page may load scripts, styles, fonts and data from this server only, with no inline script
(Content-Security-Policy). The app renders all session text as text. Its only runtime dependency
is Preact; the fonts are IBM Plex (SIL Open Font License), shipped with the build. `DESIGN.md`
holds the design rules the stylesheet follows.

gstack is optional: when its state directory exists, the Needs you column also lists its TODO
files. Each list is named after the gstack project its file belongs to (`<name>-TODOS.md`), else
after the name the file carries, and your project aliases apply.

## When something looks wrong

- **The dashboard does not load:** run `/nod-board:open`, or start any Claude Code session; both
  start the server. `/nod-board:status` says whether it is running and where. The log is
  `~/.agent-inbox/server.log`.
- **"The dashboard has not been built":** run `bun run build` in the checkout.
- **Nothing is captured:** `~/.agent-inbox/hook-errors.log` has one line per problem. Check that
  `bun` is on the PATH your sessions run with.
- **"answers could not be read":** Claude Code changed the question payload. `readHookPayload`
  in `hook.ts` (live) or `readCalls` in `judgment.ts` (import) needs to learn the new shape.
  Look at the keys of one payload, not its content, and add a synthetic fixture.
- **"server not reachable" in the page:** the server stopped; the page keeps its last numbers
  and recovers by itself when a session start brings the server back.

## Environment

`AGENT_INBOX_DIR` (data directory), `AGENT_INBOX_PORT` (one fixed port; without it the first free
port from 4777 to 4786),
`AGENT_INBOX_TRANSCRIPTS` (default `~/.claude/projects`), `AGENT_INBOX_GSTACK_STATE_ROOT`
(else `GSTACK_STATE_ROOT`, `GSTACK_HOME`, `GSTACK_STATE_DIR`, `~/.gstack`).
