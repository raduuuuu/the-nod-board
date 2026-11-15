import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INSTANCE_HEADER, onSessionStart, probeServer, runStarter, firstRunLine, type ServerState, type StartDeps } from './hook';
import {
  ADDRESS_FILE,
  APP_NAME,
  DEFAULT_PORT,
  Inbox,
  PORT_RANGE,
  candidatePorts,
  clearAddressPort,
  explicitPort,
  instanceId,
  knownPort,
  markAddressShown,
  boardUrl,
  readAddressPort,
  writeAddressPort,
  writeWantedVersion,
} from './inbox';
import { openBoard, statusLines, type BoardIo } from './scripts/board';
import { WANTED_CHECK_MS, serve, settle, start } from './server';

const REPO = import.meta.dir;
const tmps: string[] = [];
const stops: (() => void)[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-ports-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (stops.length) stops.pop()!();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** Ports that were free a moment ago, lowest first. The tests never use the real range. */
function freePorts(n: number): number[] {
  const held = Array.from({ length: n }, () => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') }));
  const ports = held.map((s) => s.port).sort((a, b) => a - b);
  for (const s of held) s.stop(true);
  return ports;
}
/** Another program: answers, but is not the board. */
function foreignOn(port: number) {
  const s = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('<html>someone else</html>') });
  stops.push(() => s.stop(true));
  return s;
}
function inboxIn(dir: string): Inbox {
  fs.mkdirSync(dir, { recursive: true });
  return new Inbox({ dir, home: dir, stateRoot: path.join(dir, 'no-gstack'), transcriptsDir: path.join(dir, 'no-transcripts') });
}
const healthOf = async (port: number) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return (await res.json()) as { app?: string; version?: string };
  } catch {
    return null;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('which ports', () => {
  test('without a fixed port: ten ports from the default, lowest first', () => {
    expect(candidatePorts({})).toEqual(Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i));
    expect(candidatePorts({})[0]).toBe(4777);
    expect(explicitPort({})).toBeNull();
  });

  test('a fixed port is the only candidate; nonsense is not a fixed port', () => {
    expect(candidatePorts({ AGENT_INBOX_PORT: '5123' })).toEqual([5123]);
    for (const bad of ['', 'abc', '0', '-1', '70000', '12.5']) expect(explicitPort({ AGENT_INBOX_PORT: bad })).toBeNull();
  });

  test('the address file holds a port number and nothing else is ever read from it', () => {
    const dir = tmp();
    expect(readAddressPort(dir)).toBeNull();
    writeAddressPort(dir, 4780);
    expect(readAddressPort(dir)).toBe(4780);
    expect(fs.statSync(path.join(dir, ADDRESS_FILE)).mode & 0o777).toBe(0o600);
    for (const bad of ['{"port":"4780; rm -rf"}', '{"port":99999}', '{"url":"http://evil.example/"}', 'not json']) {
      fs.writeFileSync(path.join(dir, ADDRESS_FILE), bad);
      expect(readAddressPort(dir)).toBeNull();
    }
  });

  test('where to look: the fixed port, else the recorded one when the server could have chosen it, else the first', () => {
    const dir = tmp();
    expect(knownPort({}, dir)).toBe(DEFAULT_PORT);
    writeAddressPort(dir, DEFAULT_PORT + 3);
    expect(knownPort({}, dir)).toBe(DEFAULT_PORT + 3);
    expect(knownPort({ AGENT_INBOX_PORT: '5123' }, dir)).toBe(5123);
    writeAddressPort(dir, 9); // not a port the server may choose: ignored
    expect(knownPort({}, dir)).toBe(DEFAULT_PORT);
  });

  test('a server leaving removes its own address entry, never a successor’s', () => {
    const dir = tmp();
    writeAddressPort(dir, 4778);
    clearAddressPort(dir, 4777);
    expect(readAddressPort(dir)).toBe(4778);
    clearAddressPort(dir, 4778);
    expect(readAddressPort(dir)).toBeNull();
  });
});

describe('taking a port', () => {
  test('the first free port of the list is taken; a busy one is skipped', () => {
    const [a, b] = freePorts(2);
    foreignOn(a);
    const s = start({ ports: [a, b], inbox: inboxIn(tmp()), compact: false });
    stops.push(() => s.stop());
    expect(s.port).toBe(b);
  });

  test('every port busy: an error that names them; a fixed busy port is never replaced by another', () => {
    const [a, b, c] = freePorts(3);
    foreignOn(a);
    foreignOn(b);
    expect(() => start({ ports: [a, b], inbox: inboxIn(tmp()), compact: false })).toThrow(`no free port among ${a}, ${b}`);
    expect(() => start({ port: a, ports: [c], inbox: inboxIn(tmp()), compact: false })).toThrow(`no free port among ${a}`);
  });

  test('the Host check follows the port that was taken', async () => {
    const [a, b] = freePorts(2);
    foreignOn(a);
    const s = start({ ports: [a, b], inbox: inboxIn(tmp()), compact: false });
    stops.push(() => s.stop());
    expect((await fetch(`http://127.0.0.1:${b}/health`)).status).toBe(200);
    expect((await fetch(`http://localhost:${b}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${b}/health`, { headers: { Host: `127.0.0.1:${a}` } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${b}/health`, { headers: { Host: 'evil.example' } })).status).toBe(403);
  });
});

describe('after binding: stay, or leave for a server that was there first', () => {
  const deps = (byPort: Record<number, ServerState[]>) => {
    const calls: number[] = [];
    let slept = 0;
    const seen: Record<number, number> = {};
    return {
      calls,
      slept: () => slept,
      d: {
        version: '2.0.0',
        probe: async (port: number) => {
          calls.push(port);
          const states = byPort[port] ?? ['silent'];
          const i = Math.min(seen[port] ?? 0, states.length - 1);
          seen[port] = (seen[port] ?? 0) + 1;
          return states[i];
        },
        sleep: async (ms: number) => void (slept += ms),
      },
    };
  };

  test('on the lowest port there is nobody to ask', async () => {
    const { d, calls } = deps({});
    expect(await settle(4777, [4777, 4778, 4779], d)).toBe('stay');
    expect(calls).toEqual([]);
  });

  test('a current server of ours on a lower port: leave', async () => {
    const { d } = deps({ 4777: ['foreign'], 4778: ['current'] });
    expect(await settle(4779, [4777, 4778, 4779], d)).toBe('leave');
  });

  test('another program or nobody on the lower ports: stay, and only lower ports are asked', async () => {
    const { d, calls, slept } = deps({ 4777: ['foreign'], 4778: ['silent'] });
    expect(await settle(4779, [4777, 4778, 4779, 4780], d)).toBe('stay');
    expect(calls).toEqual([4777, 4778]);
    expect(slept()).toBe(0);
  });

  test('an older server of ours on a lower port: wait for it to leave, then stay', async () => {
    const { d, slept } = deps({ 4777: ['stale', 'stale', 'silent'] });
    expect(await settle(4778, [4777, 4778], d)).toBe('stay');
    expect(slept()).toBe(400);
  });

  test('an older server that never leaves does not block the new one forever', async () => {
    const { d, slept } = deps({ 4777: ['stale'] });
    expect(await settle(4778, [4777, 4778], d)).toBe('stay');
    expect(slept()).toBe(5_000);
  });
});

describe('one server per data folder, with real servers', () => {
  test('a second start for the same data leaves; the first keeps serving and owns the address', async () => {
    const dir = tmp();
    const [a, b] = freePorts(2);
    const left: string[] = [];
    const first = await serve({ version: '2.0.0', ports: [a, b], inbox: inboxIn(dir), compact: false, onLeave: (r) => left.push(`first:${r}`) });
    stops.push(() => first?.stop());
    const second = await serve({ version: '2.0.0', ports: [a, b], inbox: inboxIn(dir), compact: false, onLeave: (r) => left.push(`second:${r}`) });
    expect(first!.port).toBe(a);
    expect(second).toBeNull();
    expect(left).toEqual(['second:another-server']);
    expect(readAddressPort(dir)).toBe(a);
    expect((await healthOf(a))?.app).toBe(APP_NAME);
    expect(await healthOf(b)).toBeNull();
  });

  test('another program on the first port: the board takes the next one and records it', async () => {
    const dir = tmp();
    const [a, b] = freePorts(2);
    foreignOn(a);
    const s = await serve({ version: '2.0.0', ports: [a, b], inbox: inboxIn(dir), compact: false, onLeave: () => {} });
    stops.push(() => s?.stop());
    expect(s!.port).toBe(b);
    expect(readAddressPort(dir)).toBe(b);
  });

  test('a board serving other data on a lower port is not ours: both stay', async () => {
    const [a, b] = freePorts(2);
    const other = await serve({ version: '2.0.0', ports: [a, b], inbox: inboxIn(tmp()), compact: false, onLeave: () => {} });
    stops.push(() => other?.stop());
    const mine = await serve({ version: '2.0.0', ports: [a, b], inbox: inboxIn(tmp()), compact: false, onLeave: () => {} });
    stops.push(() => mine?.stop());
    expect([other!.port, mine!.port]).toEqual([a, b]);
  });

  test('another version is wanted: the server leaves by itself, whatever its port, and takes its address entry with it', async () => {
    const dir = tmp();
    const [a, b] = freePorts(2);
    foreignOn(a);
    const left: string[] = [];
    const s = await serve({ version: '2.0.0', ports: [a, b], inbox: inboxIn(dir), compact: false, onLeave: (r) => left.push(r) });
    stops.push(() => s?.stop());
    expect(s!.port).toBe(b);
    // What an older hook does on a rollback: it records the version it wants and looks only at its own port.
    writeWantedVersion(dir, '1.0.0', '/older-plugin');
    await sleep(WANTED_CHECK_MS + 500);
    expect(left).toEqual(['not-wanted']);
    expect(await healthOf(b)).toBeNull();
    expect(readAddressPort(dir)).toBeNull();
  }, 10_000);

  test('two real processes started together, with another program on the first port, end as one server', async () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    const [a, b, c] = freePorts(3);
    foreignOn(a);
    const script = path.join(tmp(), 'serve.ts');
    fs.writeFileSync(
      script,
      `import { serve } from ${JSON.stringify(path.join(REPO, 'server.ts'))};
       const s = await serve({ version: '2.0.0', ports: [${a}, ${b}, ${c}], compact: false, onLeave: () => { console.log('LEFT'); process.exit(0); } });
       if (s) console.log('STAYED ' + s.port);`,
    );
    const env = { ...process.env, AGENT_INBOX_DIR: dir, AGENT_INBOX_GSTACK_STATE_ROOT: path.join(dir, 'no-gstack') };
    const procs = [0, 1].map(() => Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' }));
    stops.push(() => procs.forEach((p) => p.kill()));
    // Both have decided once one of them has left and the other has published its address.
    let answering: number[] = [];
    for (let waited = 0; waited < 8_000; waited += 200) {
      await sleep(200);
      answering = [];
      for (const port of [b, c]) if ((await healthOf(port))?.app === APP_NAME) answering.push(port);
      if (answering.length === 1 && readAddressPort(dir) !== null && procs.some((p) => p.exitCode !== null)) break;
    }
    expect(answering).toEqual([b]);
    expect(readAddressPort(dir)).toBe(b);
    expect(procs.filter((p) => p.exitCode === null)).toHaveLength(1);
  }, 15_000);
});

describe('telling our server from another', () => {
  const answering = (body: unknown, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { headers })) as unknown as typeof fetch;
  const ours = { app: APP_NAME, version: '2.0.0', stale: false };

  test('a board that serves other data is another program; one too old to say is taken as ours', async () => {
    expect(await probeServer(1, '2.0.0', answering(ours, { [INSTANCE_HEADER]: 'aaaaaaaaaaaa' }), 'aaaaaaaaaaaa')).toBe('current');
    expect(await probeServer(1, '2.0.0', answering(ours, { [INSTANCE_HEADER]: 'bbbbbbbbbbbb' }), 'aaaaaaaaaaaa')).toBe('foreign');
    expect(await probeServer(1, '2.0.0', answering(ours), 'aaaaaaaaaaaa')).toBe('current');
    expect(await probeServer(1, '2.0.0', answering({ ...ours, version: '1.0.0' }), 'aaaaaaaaaaaa')).toBe('stale');
  });

  test('the name of a data folder is short, stable, and differs between folders', () => {
    expect(instanceId('/a/b')).toBe(instanceId('/a/b/'));
    expect(instanceId('/a/b')).not.toBe(instanceId('/a/c'));
    expect(instanceId('/a/b')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('the hook and the commands with a port the server chose', () => {
  const envIn = (dir: string) => ({ HOME: path.dirname(dir), AGENT_INBOX_DIR: dir }); // no fixed port
  const deps = (byPort: (port: number, call: number) => ServerState) => {
    const launched: string[][] = [];
    const asked: number[] = [];
    const d: StartDeps = {
      root: '/plugin',
      version: '2.0.0',
      probe: async (port) => {
        asked.push(port);
        return byPort(port, asked.length);
      },
      launch: (args) => void launched.push(args),
      sleep: async () => {},
    };
    return { d, launched, asked };
  };

  test('a session start looks where the server said it is, and nowhere else', async () => {
    const dir = path.join(tmp(), 'inbox');
    writeAddressPort(dir, DEFAULT_PORT + 2);
    markAddressShown(dir, boardUrl(DEFAULT_PORT + 2));
    const { d, asked, launched } = deps(() => 'current');
    expect(await onSessionStart(envIn(dir), d)).toBeNull();
    expect(asked).toEqual([DEFAULT_PORT + 2]);
    expect(launched).toEqual([]);
  });

  test('another program on the default port is not reported when no port was fixed: the server is simply started', async () => {
    const dir = path.join(tmp(), 'inbox');
    markAddressShown(dir, boardUrl(DEFAULT_PORT));
    const { d, launched } = deps(() => 'foreign');
    expect(await onSessionStart(envIn(dir), d)).toBeNull();
    expect(launched).toEqual([['/plugin/hook.ts', '--start-server']]);
  });

  test('the first-run line names the port the server took, not the default', async () => {
    const dir = path.join(tmp(), 'inbox');
    // Nothing answers on the default port; while the hook waits, the server records the port it took.
    const { d } = deps((port, call) => {
      if (call === 2) writeAddressPort(dir, DEFAULT_PORT + 1);
      return port === DEFAULT_PORT + 1 ? 'current' : 'silent';
    });
    expect(await onSessionStart(envIn(dir), d)).toBe(firstRunLine(`http://127.0.0.1:${DEFAULT_PORT + 1}/`));
  });

  test('the server moved to another port since the user was told: the line is shown again with the new address', async () => {
    const dir = path.join(tmp(), 'inbox');
    markAddressShown(dir, boardUrl(DEFAULT_PORT));
    writeAddressPort(dir, DEFAULT_PORT + 4);
    expect(await onSessionStart(envIn(dir), deps(() => 'current').d)).toBe(firstRunLine(`http://127.0.0.1:${DEFAULT_PORT + 4}/`));
  });

  test('the starter asks every port the server may choose before starting anything', async () => {
    const dir = path.join(tmp(), 'inbox');
    const quiet = deps(() => 'silent');
    expect(await runStarter(envIn(dir), quiet.d)).toBe('started');
    expect(quiet.asked).toEqual(candidatePorts({}));
    expect(quiet.launched.map((a) => a[0])).toEqual(['/plugin/server.ts']);
    const running = deps((port) => (port === DEFAULT_PORT + 5 ? 'current' : port === DEFAULT_PORT ? 'foreign' : 'silent'));
    expect(await runStarter(envIn(dir), running.d)).toBe('current');
    expect(running.launched).toEqual([]);
  });

  test('the starter starts nothing while an older server of ours is still up on any port', async () => {
    const dir = path.join(tmp(), 'inbox');
    let rounds = 0;
    const { d, launched } = deps((port) => {
      if (port === DEFAULT_PORT) rounds++;
      return port === DEFAULT_PORT + 1 && rounds < 3 ? 'stale' : 'silent';
    });
    expect(await runStarter(envIn(dir), d)).toBe('started');
    expect(rounds).toBe(3);
    expect(launched).toHaveLength(1);
  });

  test('open and status use the port the server took', async () => {
    const dir = path.join(tmp(), 'inbox');
    writeAddressPort(dir, DEFAULT_PORT + 1);
    const opened: string[] = [];
    const io: BoardIo = { openInBrowser: (url) => (opened.push(url), true), fetchJson: async () => ({ last_event_ts: null }), now: () => 0 };
    const { d } = deps((port) => (port === DEFAULT_PORT + 1 ? 'current' : 'foreign'));
    expect(await openBoard(envIn(dir), d, io)).toEqual([`The Nod Board: opened http://127.0.0.1:${DEFAULT_PORT + 1}/`]);
    expect((await statusLines(envIn(dir), d, io))[1]).toBe(`running: yes, at http://127.0.0.1:${DEFAULT_PORT + 1}/`);
    // Another program on the default port, and no board anywhere: "not running", not "port in use".
    fs.rmSync(path.join(dir, ADDRESS_FILE));
    expect((await statusLines(envIn(dir), deps(() => 'foreign').d, io))[1]).toBe('running: no. Start it with /nod-board:open');
  });
});

describe('/nod-board:open after an update, with a real older server still running', () => {
  test('open records the version it wants, the older server leaves, and the new one is opened', async () => {
    const dir = path.join(tmp(), 'inbox');
    const [port] = freePorts(1);
    const env = { HOME: path.dirname(dir), AGENT_INBOX_DIR: dir, AGENT_INBOX_PORT: String(port) };
    const left: string[] = [];
    // What is running right after `claude plugin update`: the previous version, wanted by its own last session start.
    writeWantedVersion(dir, '1.0.0', '/older-plugin');
    const older = await serve({ version: '1.0.0', port, inbox: inboxIn(dir), compact: false, onLeave: (r) => left.push(r) });
    stops.push(() => older?.stop());
    expect((await healthOf(port))?.version).toBe('1.0.0');

    let newer: Awaited<ReturnType<typeof serve>> = null;
    const d: StartDeps = {
      root: '/newer-plugin',
      version: '2.0.0',
      probe: (p, wanted) => probeServer(p, wanted, fetch, instanceId(dir)),
      // The starter launches server.ts; here that is the newer server in this process.
      launch: () => void serve({ version: '2.0.0', port, inbox: inboxIn(dir), compact: false, onLeave: () => {} }).then((s) => (newer = s)),
      sleep,
    };
    stops.push(() => newer?.stop());
    const opened: string[] = [];
    const io: BoardIo = { openInBrowser: (url) => (opened.push(url), true), fetchJson: async () => ({}), now: () => Date.now() };

    expect(await openBoard(env, d, io)).toEqual([`The Nod Board: opened http://127.0.0.1:${port}/`]);
    expect(left).toEqual(['stale']);
    expect((await healthOf(port))?.version).toBe('2.0.0');
    expect(opened).toEqual([`http://127.0.0.1:${port}/`]);
  }, 15_000);
});
