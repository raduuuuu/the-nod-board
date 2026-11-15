# The Nod Board

A local dashboard for Claude Code sessions. It shows what needs you right now, and how often
you nod along with the agent's recommendation. Everything stays on your machine.

- **Needs you:** sessions waiting for input, waiting on a permission, or finished and unread,
  each with the command that resumes it.
- **Recommendations taken:** of the questions where the agent marked exactly one option
  "(Recommended)" and you answered, the share where you picked that option, with the time you
  took to answer beside it, a 12-week trend, and the questions where you chose otherwise.

A high share does not by itself mean the agent is right: it is the same number a reviewer who
stopped reading would produce. Read it next to the answer times.

Formerly agent-inbox. The plugin id is `nod-board`. The data directory (`~/.agent-inbox`) and
the `AGENT_INBOX_*` environment variables keep their old names for now.

## How it works

```
Claude Code session ── hooks/hooks.json ──> hook.ts (run by Bun)
     session events  ──> ~/.agent-inbox/events.jsonl     what needs you
     question asked / answered ──> outcomes.jsonl        one line per observation
     session start   ──> starts the local server when none is running

/nod-board:import ──> reads past transcripts once ──> outcomes.jsonl

server.ts (127.0.0.1:4777, read-only) ──> /api/inbox, /api/judgment ──> the dashboard app
```

It needs [Bun](https://bun.sh) and nothing else. When Bun is missing, the session start says
so once and nothing is captured.

## Install

```
/plugin install nod-board --marketplace raduuuuu/the-nod-board
```

or, in two steps, `/plugin marketplace add raduuuuu/the-nod-board` and then
`/plugin install nod-board@nod-board`. The plugin is installed from the `release` branch, which
only the release workflow writes: it holds the source plus the built dashboard, checked against
a second build of the same commit. Start a new session afterwards and open
http://127.0.0.1:4777/.

Updates are not automatic for third-party marketplaces unless you turn that on in `/plugin`.
To update by hand: `claude plugin update nod-board@nod-board`.

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

1. Raise `version` in `.claude-plugin/plugin.json` (the one place it is written) and merge to `main`.
2. Run the `release` workflow from the Actions tab.

The workflow runs the tests, builds the dashboard twice and compares the results, commits source
plus build to the `release` branch, checks that exact commit out fresh and verifies it again,
and only then tags `v<version>`. Nothing is built or published by hand.
`bun scripts/verify-dist.ts dist` runs the same comparison locally.

## What is stored

Two append-only files in `~/.agent-inbox` (files 0600, directory 0700):

- `events.jsonl`: per hook event, the session id, working directory, event name, notification
  type, notification text (cut to 500 characters) and time. At 5 MB it is compacted to at most
  two events per live session.
- `outcomes.jsonl`: per question, its call id and position, the outcome, the label the agent
  gave it, its first line (cut to 120 characters), session, project and two timestamps. It is
  never compacted; it is the history.

Never stored: option text, the answer you picked or typed, prompts, tool input or output.
Transcripts are read only when you run the import, in memory. Nothing leaves the machine: the
server binds 127.0.0.1, rejects any Host header other than `127.0.0.1:<port>` or
`localhost:<port>`, and has no route that changes anything.

You can read both files with any text tool; that is deliberate.

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
  are reconciled by strength of evidence; the order they arrive in never matters.
- Time to answer is measured between the hook's two events, once per question prompt. It is
  elapsed time, not attention.
- Projects are named after the last segment of the session's working directory.

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
| `/api/judgment` | totals, splits and the weekly trend from `outcomes.jsonl`, as JSON |
| `/health` | app name, version, whether a newer version wants to take over, source states |

The session-start hook starts the server when none is running. After a plugin update, the next
session start records the version it wants; the older server reports itself stale on `/health`
and exits, and a detached starter brings up the new one. No process is killed. If another
program holds the port, the session start says so; set `AGENT_INBOX_PORT` to a free port.

The page may load scripts, styles, fonts and data from this server only, with no inline script
(Content-Security-Policy). The app renders all session text as text. Its only runtime dependency
is Preact; the fonts are IBM Plex (SIL Open Font License), shipped with the build. `DESIGN.md`
holds the design rules the stylesheet follows.

gstack is optional: when its state directory exists, the Needs you column also lists its TODO
files.

## When something looks wrong

- **The dashboard does not load:** start any Claude Code session; the session-start hook starts
  the server. The log is `~/.agent-inbox/server.log`.
- **"The dashboard has not been built":** run `bun run build` in the checkout.
- **Nothing is captured:** `~/.agent-inbox/hook-errors.log` has one line per problem. Check that
  `bun` is on the PATH your sessions run with.
- **"answers could not be read":** Claude Code changed the question payload. `readHookPayload`
  in `hook.ts` (live) or `readCalls` in `judgment.ts` (import) needs to learn the new shape.
  Look at the keys of one payload, not its content, and add a synthetic fixture.
- **"server not reachable" in the page:** the server stopped; the page keeps its last numbers
  and recovers by itself when a session start brings the server back.

## Environment

`AGENT_INBOX_DIR` (data directory), `AGENT_INBOX_PORT` (default 4777),
`AGENT_INBOX_TRANSCRIPTS` (default `~/.claude/projects`), `AGENT_INBOX_GSTACK_STATE_ROOT`
(else `GSTACK_STATE_ROOT`, `GSTACK_HOME`, `GSTACK_STATE_DIR`, `~/.gstack`).
