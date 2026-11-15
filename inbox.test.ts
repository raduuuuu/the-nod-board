import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOUR,
  Inbox,
  SNAPSHOT_PRUNE_MS,
  UNASSIGNED,
  captureSince,
  markCaptureStart,
  movedOnIndex,
  fold,
  foldIntoSnapshot,
  mapTodoProject,
  maybeCompact,
  parseLines,
  readEventLog,
  readTodos,
  recoverLeftovers,
  rotatedFiles,
  type InboxEvent,
} from './inbox';

const FIX = path.join(import.meta.dir, 'test', 'fixtures');
const MIN = 60_000;
const T0 = Date.parse('2026-11-03T10:00:00Z');
const S = 'sess-1';

function ev(name: string, ts: number, extra: Partial<InboxEvent> = {}, sid = S): InboxEvent {
  return { session_id: sid, cwd: '/w/proj', hook_event_name: name, notification_type: null, message: null, ts, ...extra };
}
const idle = (ts: number, sid = S) => ev('Notification', ts, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, sid);
const perm = (ts: number, sid = S) => ev('Notification', ts, { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, sid);

const tmps: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inbox-test-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});
const jsonl = (events: InboxEvent[]) => events.map((e) => JSON.stringify(e) + '\n').join('');

// ---------------------------------------------------------------- fold

type Case = { name: string; events: InboxEvent[]; now?: number; state?: string; display: string };
const cases: Case[] = [
  { name: 'idle_prompt → WAITING', events: [idle(T0)], display: 'WAITING' },
  { name: 'elicitation_dialog → WAITING', events: [ev('Notification', T0, { notification_type: 'elicitation_dialog' })], display: 'WAITING' },
  { name: 'permission_prompt → PERMISSION_ASKED', events: [perm(T0)], display: 'PERMISSION_ASKED' },
  { name: 'untyped permission message → PERMISSION_ASKED', events: [ev('Notification', T0, { message: 'Claude needs your permission to use Edit' })], display: 'PERMISSION_ASKED' },
  { name: 'untyped waiting message → WAITING', events: [ev('Notification', T0, { message: 'Claude is waiting for your input' })], display: 'WAITING' },
  { name: 'auth_success notification alone → nothing', events: [ev('Notification', T0, { notification_type: 'auth_success' })], display: 'NONE' },
  { name: 'auth_success does not clear WAITING', events: [idle(T0), ev('Notification', T0 + MIN, { notification_type: 'auth_success' })], display: 'WAITING' },
  { name: 'approve then long tool: stays PERMISSION_ASKED until PostToolUse', events: [perm(T0)], now: T0 + 5 * MIN, display: 'PERMISSION_ASKED' },
  { name: 'approve then tool completes → RUNNING (hidden)', events: [perm(T0), ev('PostToolUse', T0 + 5 * MIN)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'approve then failing tool (PostToolUse) → RUNNING', events: [perm(T0), ev('PostToolUse', T0 + MIN)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'approve then failing tool (PostToolUseFailure) → RUNNING', events: [perm(T0), ev('PostToolUseFailure', T0 + MIN)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'deny then Stop → DONE_UNREAD', events: [perm(T0), ev('Stop', T0 + MIN)], display: 'DONE_UNREAD' },
  { name: 'WAITING resolved by UserPromptSubmit', events: [idle(T0), ev('UserPromptSubmit', T0 + MIN)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'WAITING resolved by PostToolUse', events: [idle(T0), ev('PostToolUse', T0 + MIN)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'Stop → DONE_UNREAD', events: [ev('UserPromptSubmit', T0), ev('Stop', T0 + MIN)], display: 'DONE_UNREAD' },
  { name: 'DONE_UNREAD clears on next prompt', events: [ev('Stop', T0), ev('UserPromptSubmit', T0 + MIN)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'DONE_UNREAD not cleared by a later PostToolUse', events: [ev('Stop', T0), ev('PostToolUse', T0 + MIN)], display: 'DONE_UNREAD' },
  { name: 'DONE_UNREAD clears on SessionEnd', events: [ev('Stop', T0), ev('SessionEnd', T0 + MIN)], state: 'ENDED', display: 'HIDDEN' },
  { name: 'DONE_UNREAD clears after 12h', events: [ev('Stop', T0)], now: T0 + 12 * HOUR + 1, display: 'HIDDEN' },
  { name: 'DONE_UNREAD kept just under 12h', events: [ev('Stop', T0)], now: T0 + 12 * HOUR - MIN, display: 'DONE_UNREAD' },
  { name: 'SessionEnd → hidden', events: [idle(T0), ev('SessionEnd', T0 + MIN)], state: 'ENDED', display: 'HIDDEN' },
  { name: 'event after SessionEnd starts a new lifecycle', events: [ev('SessionEnd', T0), idle(T0 + MIN)], display: 'WAITING' },
  { name: 'WAITING 12h without events → STALE', events: [idle(T0)], now: T0 + 12 * HOUR + 1, state: 'WAITING', display: 'STALE' },
  { name: 'PERMISSION_ASKED 12h without events → STALE', events: [perm(T0)], now: T0 + 13 * HOUR, state: 'PERMISSION_ASKED', display: 'STALE' },
  { name: 'WAITING just under 7 days without events → still STALE', events: [idle(T0)], now: T0 + 7 * 24 * HOUR - 1, state: 'WAITING', display: 'STALE' },
  { name: 'WAITING 7 days without events → hidden', events: [idle(T0)], now: T0 + 7 * 24 * HOUR + 1, state: 'WAITING', display: 'HIDDEN' },
  { name: 'PERMISSION_ASKED 7 days without events → hidden', events: [perm(T0)], now: T0 + 8 * 24 * HOUR, state: 'PERMISSION_ASKED', display: 'HIDDEN' },
  { name: 'informational event keeps an old ask visible', events: [idle(T0), ev('Notification', T0 + 6 * 24 * HOUR, { notification_type: 'auth_success' })], now: T0 + 8 * 24 * HOUR, state: 'WAITING', display: 'STALE' },
  { name: 'out-of-order: prompt line written before an older Notification', events: [ev('UserPromptSubmit', T0 + MIN), idle(T0)], state: 'RUNNING', display: 'HIDDEN' },
  { name: 'out-of-order: Stop line before older prompt', events: [ev('Stop', T0 + 2 * MIN), ev('UserPromptSubmit', T0)], display: 'DONE_UNREAD' },
  { name: 'idle_prompt after Stop → WAITING', events: [ev('Stop', T0), idle(T0 + MIN)], display: 'WAITING' },
];

describe('fold', () => {
  for (const c of cases) {
    test(c.name, () => {
      const s = fold(c.events, c.now ?? T0 + 10 * MIN).get(S);
      if (c.display === 'NONE') return expect(s).toBeUndefined();
      expect(s).toBeDefined();
      expect(s!.display).toBe(c.display as any);
      if (c.state) expect(s!.state).toBe(c.state as any);
    });
  }

  test('repeated ask restarts the clock; message kept', () => {
    const s = fold([perm(T0), perm(T0 + 3 * MIN)], T0 + 4 * MIN).get(S)!;
    expect(s.since).toBe(T0 + 3 * MIN);
    expect(s.message).toBe('Claude needs your permission to use Bash');
  });

  test('sessions are independent', () => {
    const m = fold([idle(T0, 'a'), ev('Stop', T0, {}, 'b'), ev('UserPromptSubmit', T0 + MIN, {}, 'a')], T0 + 2 * MIN);
    expect(m.get('a')!.state).toBe('RUNNING');
    expect(m.get('b')!.display).toBe('DONE_UNREAD');
  });
});

// ---------------------------------------------------------------- reads

describe('reads', () => {
  test('partial last line skipped + counted; garbage lines counted', () => {
    const text = jsonl([idle(T0)]) + 'not json\n{"no_session":1,"ts":1}\n' + '{"session_id":"x","hook_event_na';
    const r = parseLines(text);
    expect(r.events.length).toBe(1);
    expect(r.stats.partial).toBe(1);
    expect(r.stats.unreadable).toBe(2);
  });

  test('ISO ts accepted', () => {
    const r = parseLines(JSON.stringify({ session_id: 'a', hook_event_name: 'Stop', ts: '2026-11-03T10:00:00Z' }) + '\n');
    expect(r.events[0].ts).toBe(T0);
  });

  test('DONE_UNREAD survives refresh and restart, clears on prompt', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([ev('UserPromptSubmit', T0), ev('Stop', T0 + MIN)]));
    const cfg = { dir, stateRoot: path.join(dir, 'gstack'), home: '/Users/someone', transcriptsDir: '/nonexistent' };
    const a = await new Inbox(cfg).model(T0 + 5 * MIN);
    const again = await new Inbox(cfg).model(T0 + 6 * MIN); // "restart": fresh instance, same files
    expect(a.doneUnread.length).toBe(1);
    expect(again.doneUnread.length).toBe(1);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), jsonl([ev('UserPromptSubmit', T0 + 7 * MIN)]));
    const after = await new Inbox(cfg).model(T0 + 8 * MIN);
    expect(after.doneUnread.length).toBe(0);
  });

  test('missing dir → events "none yet", still renders a model', async () => {
    const dir = path.join(tmp(), 'nope');
    const m = await new Inbox({ dir, stateRoot: dir, home: '/Users/someone', transcriptsDir: '/x' }).model(T0);
    expect(m.health.events).toBe('none yet');
    expect(m.todos).toBeNull();
  });

  test('a session is named after its working directory; no cwd is Unassigned; home is named as such', async () => {
    const d = tmp();
    const at = (session_id: string, cwd: string | null) => ({ ...idle(T0), session_id, cwd });
    fs.writeFileSync(path.join(d, 'events.jsonl'), jsonl([at('a', '/Users/someone/Developer/thing'), at('b', null), at('c', '/Users/someone')]));
    const m = await new Inbox({ dir: d, stateRoot: d, home: '/Users/someone', transcriptsDir: '/nonexistent' }).model(T0 + MIN);
    expect(Object.fromEntries(m.waiting.map((s) => [s.session_id, s.project]))).toEqual({ a: 'thing', b: UNASSIGNED, c: 'no project' });
  });
});

// ---------------------------------------------------------------- compaction

describe('compaction (R7)', () => {
  test('writer appends between rename and fold: nothing lost', async () => {
    const dir = tmp();
    const live = path.join(dir, 'events.jsonl');
    // Old traffic to push the file over the threshold, plus a dormant WAITING session.
    const filler: InboxEvent[] = [];
    for (let i = 0; i < 50; i++) filler.push(ev('PostToolUse', T0 + i, {}, `busy-${i % 5}`));
    fs.writeFileSync(live, jsonl([idle(T0 - 3 * 24 * HOUR, 'dormant'), ...filler]));
    const rotated = await maybeCompact(dir, {
      thresholdBytes: 1000,
      now: () => T0 + HOUR,
      sleep: async () => {
        // During the grace period: a hook that opened the old path still appends to the rotated
        // file, and a fresh hook run creates a new live file.
        const [rot] = rotatedFiles(dir);
        fs.appendFileSync(rot, jsonl([perm(T0 + 100, 'inflight')]));
        fs.appendFileSync(live, jsonl([idle(T0 + 200, 'fresh')]));
      },
    });
    expect(rotated).toBe(true);
    expect(rotatedFiles(dir)).toEqual([]);
    const m = fold(readEventLog(dir).events, T0 + HOUR);
    expect(m.get('inflight')!.display).toBe('PERMISSION_ASKED');
    expect(m.get('fresh')!.display).toBe('WAITING');
    expect(m.get('dormant')!.display).toBe('STALE');
    expect(m.get('dormant')!.state).toBe('WAITING');
    // Snapshot holds at most two events per session (state event + newest), not the filler.
    const snap = parseLines(fs.readFileSync(path.join(dir, 'state-snapshot.jsonl'), 'utf8')).events;
    expect(snap.length).toBe(12); // dormant 1 + inflight 1 + 5 busy × (first + last of 10)
    expect(fs.statSync(path.join(dir, 'state-snapshot.jsonl')).mode & 0o777).toBe(0o600);
  });

  test('below threshold → no rotation', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([idle(T0)]));
    expect(await maybeCompact(dir, { thresholdBytes: 5 * 1024 * 1024, sleep: async () => {} })).toBe(false);
  });

  test('ENDED sessions dropped; DONE_UNREAD and WAITING under 7 days kept; WAITING past 7 days pruned', () => {
    const dir = tmp();
    const rot = path.join(dir, 'events.1.jsonl');
    fs.writeFileSync(
      rot,
      jsonl([
        idle(T0, 'ended'),
        ev('SessionEnd', T0 + 1, {}, 'ended'),
        ev('Stop', T0, {}, 'done'),
        idle(T0 - 6 * 24 * HOUR, 'dormant'),
        idle(T0 - 30 * 24 * HOUR, 'old'),
      ]),
    );
    foldIntoSnapshot(dir, rot, T0 + MIN);
    fs.rmSync(rot);
    const m = fold(readEventLog(dir).events, T0 + MIN);
    expect(m.has('ended')).toBe(false);
    expect(m.get('done')!.display).toBe('DONE_UNREAD');
    expect(m.get('dormant')!.display).toBe('STALE');
    expect(m.has('old')).toBe(false);
  });

  test('compaction does not move the inactivity clocks (last event kept beside the state event)', () => {
    const dir = tmp();
    const rot = path.join(dir, 'events.1.jsonl');
    const DAY = 24 * HOUR;
    const events = [
      idle(T0 - 8 * DAY, 'touched'), // asked 8 days ago...
      ev('Notification', T0 - DAY, { notification_type: 'auth_success' }, 'touched'), // ...but active yesterday
      idle(T0 - 3 * HOUR, 'fresh'),
      idle(T0 - 13 * HOUR, 'recent'),
      ev('Notification', T0 - HOUR, { notification_type: 'auth_success' }, 'recent'),
    ];
    const view = (evs: InboxEvent[], now: number) =>
      [...fold(evs, now).values()].map((s) => `${s.session_id}:${s.display}:${s.last_ts}`).sort();
    const before = view(events, T0);
    expect(before).toEqual([`fresh:WAITING:${T0 - 3 * HOUR}`, `recent:WAITING:${T0 - HOUR}`, `touched:STALE:${T0 - DAY}`]);
    fs.writeFileSync(rot, jsonl(events));
    foldIntoSnapshot(dir, rot, T0);
    fs.rmSync(rot);
    const kept = readEventLog(dir).events;
    expect(view(kept, T0)).toEqual(before);
    // Expiry lands at the same moment with or without compaction.
    const later = T0 + SNAPSHOT_PRUNE_MS - DAY + 1;
    expect(view(kept, later)).toEqual(view(events, later));
    expect(fold(kept, later).get('touched')!.display).toBe('HIDDEN');
  });

  test('crash between fold and delete: startup recovery compacts the leftover once', async () => {
    const dir = tmp();
    const live = path.join(dir, 'events.jsonl');
    fs.writeFileSync(live, jsonl([idle(T0, 'w'), ev('Stop', T0, {}, 'd'), ...Array.from({ length: 30 }, (_, i) => ev('PostToolUse', T0 + i, {}, 'r'))]));
    await expect(
      maybeCompact(dir, {
        thresholdBytes: 100,
        sleep: async () => {},
        now: () => T0 + MIN,
        beforeDelete: () => {
          throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(rotatedFiles(dir).length).toBe(1);
    expect(fs.existsSync(path.join(dir, 'state-snapshot.jsonl'))).toBe(true);
    // While the leftover exists, reads see snapshot + leftover (duplicates are harmless).
    expect(fold(readEventLog(dir).events, T0 + MIN).get('w')!.display).toBe('WAITING');
    expect(recoverLeftovers(dir, { now: () => T0 + MIN })).toBe(1);
    expect(rotatedFiles(dir)).toEqual([]);
    const m = fold(readEventLog(dir).events, T0 + MIN);
    expect(m.get('w')!.display).toBe('WAITING');
    expect(m.get('d')!.display).toBe('DONE_UNREAD');
    const snap = parseLines(fs.readFileSync(path.join(dir, 'state-snapshot.jsonl'), 'utf8')).events;
    expect(snap.length).toBe(4); // w 1 + d 1 + r (first + last of 30)
  });

  test('two compactions in a row keep state', async () => {
    const dir = tmp();
    const live = path.join(dir, 'events.jsonl');
    const big = (sid: string) => Array.from({ length: 20 }, (_, i) => ev('PostToolUse', T0 + i, {}, sid));
    fs.writeFileSync(live, jsonl([perm(T0, 'p'), ...big('x')]));
    await maybeCompact(dir, { thresholdBytes: 500, sleep: async () => {}, now: () => T0 + MIN });
    fs.writeFileSync(live, jsonl([ev('UserPromptSubmit', T0 + 2 * MIN, {}, 'p'), ...big('y')]));
    await maybeCompact(dir, { thresholdBytes: 500, sleep: async () => {}, now: () => T0 + 3 * MIN });
    const m = fold(readEventLog(dir).events, T0 + 3 * MIN);
    expect(m.get('p')!.state).toBe('RUNNING');
  });
});


describe('todos', () => {
  test('mapping: exact slug or repo-name part only, unambiguous', () => {
    const known = ['owner-TrackPlanner', 'photo-site', 'toy-shop', 'someone'];
    expect(mapTodoProject('photo-site', known)).toBe('photo-site');
    expect(mapTodoProject('toy-shop', known)).toBe('toy-shop');
    expect(mapTodoProject('TrackPlanner', known)).toBe('owner-TrackPlanner');
    expect(mapTodoProject('other', known)).toBe(UNASSIGNED);
    expect(mapTodoProject('site', known)).toBe('photo-site'); // repo-name part of "photo-site"
    expect(mapTodoProject('shop', ['toy-shop', 'big-shop'])).toBe(UNASSIGNED); // ambiguous
    expect(mapTodoProject('trackplanner', known)).toBe(UNASSIGNED); // exact, case-sensitive
  });

  test('reads *-TODOS.md under projects/*, ## headings as items', () => {
    const root = tmp();
    const home = path.join(root, 'projects', 'someone');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(root, 'projects', 'toy-shop'));
    fs.writeFileSync(path.join(home, 'toy-shop-TODOS.md'), '# TODOS\n\n## P2 — Gallery\ntext\n### sub\n## P3 — Search\n');
    fs.writeFileSync(path.join(home, 'other-TODOS.md'), '## One\n');
    fs.writeFileSync(path.join(home, 'notes.md'), '## ignored\n');
    const t = readTodos(root, ['toy-shop', 'someone'])!;
    expect(t.map((x) => [x.project, x.items])).toEqual([
      [UNASSIGNED, ['One']],
      ['toy-shop', ['P2 — Gallery', 'P3 — Search']],
    ]);
  });
});

describe('what the outcome store needs from session events', () => {
  test('moved on: the latest prompt, Stop or SessionEnd per session; notifications and tool events do not count', () => {
    const e = (session_id: string, hook_event_name: string, ts: number) => ({ session_id, cwd: null, hook_event_name, notification_type: null, message: null, ts });
    const index = movedOnIndex([
      e('a', 'UserPromptSubmit', 10),
      e('a', 'Stop', 30),
      e('a', 'Notification', 99),
      e('a', 'PostToolUse', 98),
      e('b', 'SessionEnd', 5),
      e('c', 'Notification', 7),
    ]);
    expect([...index].sort()).toEqual([
      ['a', 30],
      ['b', 5],
    ]);
  });

  test('capture start is recorded once; without a record it is when the data directory was made', () => {
    const d = path.join(tmp(), 'data');
    expect(captureSince(d)).toBeNull(); // no directory yet
    markCaptureStart(d, 1_000);
    markCaptureStart(d, 2_000);
    expect(captureSince(d)).toBe(1_000);
    const plain = tmp();
    const born = captureSince(plain);
    expect(born).not.toBeNull();
    expect(Math.abs(born! - Date.now())).toBeLessThan(60_000);
  });
});
