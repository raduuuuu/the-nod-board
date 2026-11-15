import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STATE_DIR } from './attrs';
import { handle } from './hook';
import { Inbox } from './inbox';
import { mergeCalls, scanChunks, type FileRef, type FileRows } from './judgment';
import { FORMAT_VERSION, boardData, importHistory, readObservations, reconcile, type Observation } from './outcomes';
import { ALIASES_FILE, HOME_PROJECT, NAME_MAX, NO_PROJECT, aliasOf, nameOfRemote, noteStart, originUrl, projectAt, projectOfSession, projectResolver, gstackStateRoot, readAliases, repositoryOf, resolveProject, shownName } from './project';

// Every repository here is a folder written by hand: no git program runs, as none runs in the hook.

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-project-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
// The developer's own gstack settings must not decide where these tests look.
const STATE_VARS = ['AGENT_INBOX_GSTACK_STATE_ROOT', 'GSTACK_STATE_ROOT', 'GSTACK_HOME', 'GSTACK_STATE_DIR'];
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const k of STATE_VARS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let seq = 0;
/** A fresh home directory with nothing in it. */
const freshHome = () => {
  const home = path.join(tmp, `home${seq++}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
};
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const config = (url: string | null) =>
  `[core]\n\trepositoryformatversion = 0\n${url === null ? '' : `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`}[branch "main"]\n\tremote = origin\n`;
/** A checkout at `dir`, with the given origin or none. */
const repo = (dir: string, url: string | null) => {
  write(path.join(dir, '.git', 'config'), config(url));
  write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
};
/** A worktree of `main` at `dir`, the way git lays one out. */
const worktree = (main: string, dir: string, name: string) => {
  const gitDir = path.join(main, '.git', 'worktrees', name);
  write(path.join(gitDir, 'commondir'), '../..\n');
  write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/x\n');
  write(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
  return dir;
};

describe('the name of a remote', () => {
  test('the last segment of the address, without ".git", for every usual form', () => {
    expect(
      ['git@github.com:owner/thing.git', 'https://github.com/owner/thing', 'https://github.com/owner/thing.git/', 'ssh://git@host:2222/group/sub/thing.git', '/srv/git/thing.git', 'file:///srv/git/thing', 'host:thing.git'].map(nameOfRemote),
    ).toEqual(Array(7).fill('thing'));
    expect([nameOfRemote(''), nameOfRemote('   '), nameOfRemote('.git')]).toEqual([null, null, null]);
    expect(nameOfRemote(`https://h/${'x'.repeat(300)}`)).toHaveLength(NAME_MAX);
  });

  test('origin is read from the config text; other remotes and other sections are not', () => {
    expect(originUrl(config('git@github.com:owner/thing.git'))).toBe('git@github.com:owner/thing.git');
    expect(originUrl(config(null))).toBeNull();
    expect(originUrl('[remote "upstream"]\n\turl = https://h/other.git\n[remote "origin"]\n\turl = "https://h/mine.git"\n')).toBe('https://h/mine.git');
    expect(originUrl('[remote "upstream"]\n\turl = https://h/other.git\n')).toBeNull();
    expect(originUrl('[remote "origin"]\n\tfetch = x\n[core]\n\turl = https://h/not-a-remote.git\n')).toBeNull();
    expect(originUrl('')).toBeNull();
  });
});

describe('the project of a folder', () => {
  test('the home directory is "(home directory)", with or without a trailing slash', () => {
    const home = freshHome();
    expect([resolveProject(home, home), resolveProject(`${home}/`, `${home}/`)]).toEqual([HOME_PROJECT, HOME_PROJECT]);
    expect([resolveProject(null, home), resolveProject('', home), resolveProject(undefined, home)]).toEqual([null, null, null]);
  });

  test('a checkout is named after its origin, whatever the folder is called, from any folder inside it', () => {
    const home = freshHome();
    const dir = repo(path.join(home, 'Developer', 'old-folder-name'), 'git@github.com:owner/beta.git');
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    expect(resolveProject(dir, home)).toBe('beta');
    expect(resolveProject(path.join(dir, 'src', 'deep'), home)).toBe('beta');
    expect(resolveProject(`${dir}/`, home)).toBe('beta');
    // a second clone under another name is the same project
    expect(resolveProject(repo(path.join(home, 'Developer', 'copy-2'), 'https://github.com/owner/beta'), home)).toBe('beta');
  });

  test('a repository without an origin is named after its folder', () => {
    const home = freshHome();
    const dir = repo(path.join(home, 'Developer', 'local-only'), null);
    fs.mkdirSync(path.join(dir, 'pkg'));
    expect(resolveProject(path.join(dir, 'pkg'), home)).toBe('local-only');
  });

  test('a worktree belongs to the repository it was made from, with or without an origin', () => {
    const home = freshHome();
    const main = repo(path.join(home, 'Developer', 'main-checkout'), 'git@github.com:owner/thing.git');
    const wt = worktree(main, path.join(home, 'Developer', 'wt-one'), 'wt-one');
    fs.mkdirSync(path.join(wt, 'src'));
    expect(resolveProject(wt, home)).toBe('thing');
    expect(resolveProject(path.join(wt, 'src'), home)).toBe('thing');
    const plain = repo(path.join(home, 'Developer', 'plain'), null);
    expect(resolveProject(worktree(plain, path.join(home, 'scratch', 'wt-2'), 'wt-2'), home)).toBe('plain');
  });

  test('a folder in no repository is named after itself', () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, 'notes', 'today'), { recursive: true });
    expect(resolveProject(path.join(home, 'notes', 'today'), home)).toBe('today');
  });

  test('a home directory that is itself a repository does not claim the folders in it', () => {
    const home = freshHome();
    repo(home, 'git@github.com:owner/dotfiles.git');
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    expect(resolveProject(path.join(home, 'notes'), home)).toBe('notes');
    expect(resolveProject(home, home)).toBe(HOME_PROJECT);
    expect(resolveProject(repo(path.join(home, 'Developer', 'x'), 'https://h/owner/real.git'), home)).toBe('real');
  });

  test('outside the home directory the rule is the same', () => {
    const home = freshHome();
    const outside = repo(path.join(tmp, `outside${seq++}`, 'checkout'), 'https://h/owner/elsewhere.git');
    expect(resolveProject(outside, home)).toBe('elsewhere');
  });

  test('what cannot be read falls back to the folder name, and nothing throws', () => {
    const home = freshHome();
    expect(resolveProject(path.join(home, 'Developer', 'gone'), home)).toBe('gone'); // the folder no longer exists
    expect(resolveProject('relative/path', home)).toBe('path');
    const broken = path.join(home, 'Developer', 'broken');
    write(path.join(broken, '.git'), 'not a pointer\n');
    expect(resolveProject(broken, home)).toBe('broken');
    const dangling = path.join(home, 'Developer', 'dangling');
    write(path.join(dangling, '.git'), `gitdir: ${path.join(home, 'nowhere')}\n`);
    expect(resolveProject(dangling, home)).toBe('dangling');
    const empty = repo(path.join(home, 'Developer', 'odd'), '');
    expect(resolveProject(empty, home)).toBe('odd');
    const long = repo(path.join(home, 'Developer', 'long'), `https://h/o/${'n'.repeat(200)}.git`);
    expect(resolveProject(long, home)).toHaveLength(NAME_MAX);
  });

  test('the project of a question: the start; from a home start, the repository asked in; without a start, the folder asked in', () => {
    const home = freshHome();
    const app = repo(path.join(home, 'Developer', 'app-folder'), 'https://h/o/app.git');
    const plain = path.join(home, 'notes');
    fs.mkdirSync(plain);
    expect(projectOfSession(app, plain, home)).toBe('app');
    expect(projectOfSession(plain, app, home)).toBe('notes');
    expect(projectOfSession(home, app, home)).toBe('app');
    expect(projectOfSession(home, plain, home)).toBe(HOME_PROJECT);
    expect(projectOfSession(home, null, home)).toBe(HOME_PROJECT);
    expect(projectOfSession(home, path.join(home, 'Developer', 'renamed-away'), home)).toBe('renamed-away'); // gone: not judged, keeps its name
    expect(projectOfSession(null, plain, home)).toBe('notes');
    expect(projectOfSession(null, null, home)).toBeNull();
    expect([repositoryOf(app, home), repositoryOf(plain, home), repositoryOf(home, home), repositoryOf('relative', home), repositoryOf(null, home)]).toEqual(['app', null, null, null, null]);
  });

  test('a resolver for a run answers each pair of folders once', () => {
    const home = freshHome();
    const dir = repo(path.join(home, 'Developer', 'x'), 'https://h/o/first.git');
    const resolve = projectResolver(home);
    expect(resolve(dir, null)).toBe('first');
    write(path.join(dir, '.git', 'config'), config('https://h/o/second.git'));
    expect(resolve(dir, null)).toBe('first');
    expect(resolveProject(dir, home)).toBe('second');
    expect(resolve(null, null)).toBeNull();
    expect(resolve(home, dir)).toBe('second');
  });
});

describe('live: the project is fixed when the session starts', () => {
  const question = { question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes (Recommended)', description: 'd' }, { label: 'No', description: 'd' }], multiSelect: false };
  const setup = () => {
    const home = freshHome();
    const dir = path.join(home, '.agent-inbox');
    const app = repo(path.join(home, 'Developer', 'renamed-folder'), 'git@github.com:owner/app.git');
    const other = repo(path.join(home, 'Developer', 'other'), 'git@github.com:owner/other.git');
    const env = { HOME: home, AGENT_INBOX_DIR: dir };
    const send = (v: Record<string, unknown>, at = 1_000) => handle(JSON.stringify({ session_id: 's1', ...v }), env, at);
    const ask = (cwd: string, id = 'toolu_1', extra: Record<string, unknown> = {}) =>
      send({ hook_event_name: 'PreToolUse', cwd, tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: { questions: [question] }, ...extra });
    const projects = () => readObservations(dir).observations.map((o) => o.project);
    return { home, dir, app, other, send, ask, projects };
  };

  test('a question asked after the session moved elsewhere still belongs to where the session started', () => {
    const s = setup();
    s.send({ hook_event_name: 'SessionStart', cwd: s.app, source: 'startup' });
    s.ask(s.other);
    s.ask(path.join(s.home, '.gstack', 'projects', 'someone'), 'toolu_2'); // a started session keeps its project even there
    expect(s.projects()).toEqual(['app', 'app']);
    expect(fs.readFileSync(path.join(s.dir, STATE_DIR, 's1', 'project'), 'utf8')).toBe('app'); // the name only, never the address
  });

  test('a session started in the home directory: a question belongs to the repository it is asked in, else to the home directory', () => {
    const s = setup();
    fs.mkdirSync(path.join(s.home, 'notes', 'today'), { recursive: true });
    s.send({ hook_event_name: 'SessionStart', cwd: s.home, source: 'startup' });
    s.ask(s.home, 'toolu_1');
    s.ask(s.app, 'toolu_2');
    s.ask(path.join(s.home, 'notes', 'today'), 'toolu_3'); // a folder that is no repository names nothing
    s.ask(s.other, 'toolu_4');
    expect(s.projects()).toEqual([HOME_PROJECT, 'app', HOME_PROJECT, 'other']);
    expect(fs.readFileSync(path.join(s.dir, STATE_DIR, 's1', 'project'), 'utf8')).toBe(HOME_PROJECT);
  });

  test('a later start of the same session (after a compaction or a clear) does not rename it', () => {
    const s = setup();
    s.send({ hook_event_name: 'SessionStart', cwd: s.app, source: 'startup' });
    s.send({ hook_event_name: 'SessionStart', cwd: s.other, source: 'compact' });
    s.ask(s.other);
    expect(s.projects()).toEqual(['app']);
  });

  test('a session that ended and is resumed is named after where it was resumed', () => {
    const s = setup();
    s.send({ hook_event_name: 'SessionStart', cwd: s.app, source: 'startup' });
    s.send({ hook_event_name: 'SessionEnd', cwd: s.app });
    s.send({ hook_event_name: 'SessionStart', cwd: s.other, source: 'resume' });
    s.ask(s.other);
    expect(s.projects()).toEqual(['other']);
  });

  test('a session whose start was not seen is named after the repository it is asking from', () => {
    const s = setup();
    fs.mkdirSync(path.join(s.app, 'src'));
    s.ask(path.join(s.app, 'src'));
    expect(s.projects()).toEqual(['app']);
    expect(projectAt(s.dir, 'never-started', null, s.home)).toBeNull();
    expect(projectAt(undefined, 's1', s.other, s.home)).toBe('other');
  });

  test('a start with no folder, or a session id that cannot name a file, records nothing', () => {
    const s = setup();
    noteStart(s.dir, 's1', null, s.home);
    noteStart(s.dir, '../escape', s.app, s.home);
    expect(fs.existsSync(path.join(s.dir, STATE_DIR))).toBe(false);
    expect(projectAt(s.dir, '../escape', s.app, s.home)).toBe('app');
  });
});

describe('import: the project is where the session file says it started', () => {
  const T0 = Date.parse('2026-11-01T10:00:00.000Z');
  const q = { question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes (Recommended)', description: 'd' }, { label: 'No', description: 'd' }], multiSelect: false };
  const first = (cwd: string) => ({ type: 'user', timestamp: new Date(T0).toISOString(), cwd, message: { role: 'user', content: 'hello' } });
  const use = (id: string, cwd: string | null, ms: number) => ({
    type: 'assistant',
    timestamp: new Date(T0 + ms).toISOString(),
    ...(cwd === null ? {} : { cwd }),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [q] } }] },
  });
  const scan = async (lines: unknown[]): Promise<FileRows> => {
    const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l) + '\n').join(''));
    return scanChunks((async function* () { yield bytes; })());
  };
  const ref = (session: string, file = `${session}.jsonl`): FileRef => ({ path: `/t/-folder/${file}`, project: 'folder-name', session });

  test('the first line that carries a working directory is the start; a file with none has no start', async () => {
    expect((await scan([{ type: 'summary', summary: 'x' }, first('/a/start'), use('toolu_1', '/a/later', 1000)])).startCwd).toBe('/a/start');
    expect((await scan([use('toolu_1', null, 1000)])).startCwd).toBeUndefined();
    expect((await scan([{ type: 'user', message: { role: 'user', content: 'the text "cwd":"/not/a/field" in prose' } }, first('/a/start')])).startCwd).toBe('/a/start');
  });

  test('a session started in the home directory: each question by the repository it was asked in, else the home directory', async () => {
    const home = freshHome();
    const app = repo(path.join(home, 'Developer', 'app-folder'), 'git@github.com:owner/app.git');
    fs.mkdirSync(path.join(home, 'notes', 'today'), { recursive: true });
    const rows = await scan([first(home), use('toolu_1', home, 1000), use('toolu_2', app, 2000), use('toolu_3', path.join(home, 'notes', 'today'), 3000), use('toolu_4', path.join(home, 'Developer', 'renamed-away'), 4000)]);
    // the last folder no longer exists: it cannot be looked at, so it keeps its own name
    expect(mergeCalls([{ ref: ref('s1'), rows }], home).map((c) => c.project)).toEqual([HOME_PROJECT, 'app', HOME_PROJECT, 'renamed-away']);
  });

  test('every question of the session takes the project of the start, not of where it was asked', async () => {
    const home = freshHome();
    const app = repo(path.join(home, 'Developer', 'renamed-folder'), 'git@github.com:owner/app.git');
    const rows = await scan([first(app), use('toolu_1', app, 1000), use('toolu_2', path.join(home, '.gstack', 'projects', 'someone'), 2000)]);
    expect(mergeCalls([{ ref: ref('s1'), rows }], home).map((c) => c.project)).toEqual(['app', 'app']);
  });

  test('a subagent file belongs to its session; the session file wins over it, in either file order', async () => {
    const home = freshHome();
    const app = repo(path.join(home, 'Developer', 'app-folder'), 'git@github.com:owner/app.git');
    const other = repo(path.join(home, 'Developer', 'other'), 'git@github.com:owner/other.git');
    const main = { ref: ref('s1'), rows: await scan([first(app), use('toolu_1', app, 1000)]) };
    const sub = { ref: ref('s1', 's1/subagents/agent-1.jsonl'), rows: await scan([first(other), use('toolu_2', other, 2000)]) };
    expect(mergeCalls([main, sub], home).map((c) => c.project)).toEqual(['app', 'app']);
    expect(mergeCalls([sub, main], home).map((c) => c.project)).toEqual(['app', 'app']);
    expect(mergeCalls([sub], home).map((c) => c.project)).toEqual(['other']);
  });

  test('without a start: the repository of the folder the question was asked in, then the transcript folder name', async () => {
    const home = freshHome();
    const app = repo(path.join(home, 'Developer', 'app-folder'), 'git@github.com:owner/app.git');
    const asked: FileRows = { calls: [{ id: 'toolu_1', useTs: T0, cwd: path.join(app), questions: [], result: null, resultTs: null }], unparsable: 0, unrecognized: 0 };
    const bare: FileRows = { calls: [{ id: 'toolu_2', useTs: T0, cwd: null, questions: [], result: null, resultTs: null }], unparsable: 0, unrecognized: 0 };
    expect(mergeCalls([{ ref: ref('s1'), rows: asked }], home).map((c) => c.project)).toEqual(['app']);
    expect(mergeCalls([{ ref: ref('s2'), rows: bare }], home).map((c) => c.project)).toEqual(['folder-name']);
  });

  test('an import after the update renames the history it looks at: one new line per question, and a third run adds nothing', async () => {
    const home = freshHome();
    const dir = path.join(home, '.agent-inbox');
    const app = repo(path.join(home, 'Developer', 'renamed-folder'), 'git@github.com:owner/app.git');
    const root = path.join(home, 'transcripts');
    write(path.join(root, '-folder', 's1.jsonl'), [first(app), use('toolu_1', path.join(home, 'elsewhere'), 1000)].map((l) => JSON.stringify(l) + '\n').join(''));
    // what an earlier version stored for the same question: named after the folder it was asked in
    const old: Observation = { v: FORMAT_VERSION, source: 'import', call: 'toolu_1', pos: 0, kind: 'ASKED', chip: 'Ship', title: 'Ship it?', session: 's1', project: 'elsewhere', askTs: T0 + 1000, answerTs: null };
    write(path.join(dir, 'outcomes.jsonl'), JSON.stringify(old) + '\n');
    expect((await importHistory(dir, root, home)).added).toBe(1);
    expect((await importHistory(dir, root, home)).added).toBe(0);
    expect(readObservations(dir).observations.map((o) => o.project)).toEqual(['elsewhere', 'app']);
    expect(boardData(dir, { now: T0 + 5000 }).totals.questions).toBe(1); // still one question
  });
});

describe('gstack state folders belong to the project they are kept for', () => {
  test('the state root: this tool\'s setting, then gstack\'s own three, then ~/.gstack, as for the TODOS list', () => {
    const all = { AGENT_INBOX_GSTACK_STATE_ROOT: '/a', GSTACK_STATE_ROOT: '/b', GSTACK_HOME: '/c', GSTACK_STATE_DIR: '/d' };
    expect(gstackStateRoot(all, '/h')).toBe('/a');
    expect(gstackStateRoot({ ...all, AGENT_INBOX_GSTACK_STATE_ROOT: undefined }, '/h')).toBe('/b');
    expect(gstackStateRoot({ GSTACK_HOME: '/c', GSTACK_STATE_DIR: '/d' }, '/h')).toBe('/c');
    expect(gstackStateRoot({ GSTACK_STATE_DIR: '/d' }, '/h')).toBe('/d');
    expect(gstackStateRoot({}, '/h/')).toBe('/h/.gstack');
  });

  const setup = () => {
    const home = freshHome();
    const state = path.join(home, '.gstack', 'projects');
    for (const d of ['thing', path.join('thing', 'designs', 'v2'), path.basename(home), 'owner-thing']) fs.mkdirSync(path.join(state, d), { recursive: true });
    return { home, state };
  };

  test('a question asked from a project\'s state folder, or anywhere inside it, belongs to that project', () => {
    const { home, state } = setup();
    expect(projectOfSession(home, path.join(state, 'thing'), home)).toBe('thing');
    expect(projectOfSession(home, path.join(state, 'thing', 'designs', 'v2'), home)).toBe('thing');
    expect(projectOfSession(home, `${path.join(state, 'thing')}/`, home)).toBe('thing');
    expect(projectOfSession(home, path.join(state, 'owner-thing'), home)).toBe('owner-thing'); // the folder's name as it is; an alias can merge it
    expect(projectOfSession(null, path.join(state, 'thing', 'designs', 'v2'), home)).toBe('thing'); // start not seen
    expect(resolveProject(path.join(state, 'thing'), home)).toBe('thing'); // started there
    expect(projectOfSession(home, path.join(state, 'gone-project', 'plans'), home)).toBe('gone-project'); // the path says it; the folder need not exist
  });

  test('the state folder of the home directory itself, the projects folder and the rest of the state root are no project', () => {
    const { home, state } = setup();
    fs.mkdirSync(path.join(home, '.gstack', 'analytics'), { recursive: true });
    expect(projectOfSession(home, path.join(state, path.basename(home)), home)).toBe(HOME_PROJECT);
    expect(projectOfSession(home, state, home)).toBe(HOME_PROJECT);
    expect(projectOfSession(home, path.join(home, '.gstack', 'analytics'), home)).toBe(HOME_PROJECT);
    expect(projectOfSession(home, path.join(home, '.gstack'), home)).toBe(HOME_PROJECT);
    expect(resolveProject(`${state}-other`, home)).toBe(path.basename(`${state}-other`)); // a look-alike folder is not the projects folder
  });

  test('a session that started in a repository keeps it, even when it asks from another project\'s state folder', () => {
    const { home, state } = setup();
    const app = repo(path.join(home, 'Developer', 'app-folder'), 'https://h/o/app.git');
    expect(projectOfSession(app, path.join(state, 'thing'), home)).toBe('app');
  });

  test('a state root set through the environment is used instead of ~/.gstack', () => {
    const { home, state } = setup();
    const elsewhere = path.join(home, 'state-elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'projects', 'moved'), { recursive: true });
    const before = process.env.AGENT_INBOX_GSTACK_STATE_ROOT;
    process.env.AGENT_INBOX_GSTACK_STATE_ROOT = `${elsewhere}/`;
    try {
      expect(projectOfSession(home, path.join(elsewhere, 'projects', 'moved'), home)).toBe('moved');
      expect(projectOfSession(home, path.join(state, 'thing'), home)).toBe(HOME_PROJECT); // no longer a state folder: a plain folder in no repository
    } finally {
      if (before === undefined) delete process.env.AGENT_INBOX_GSTACK_STATE_ROOT;
      else process.env.AGENT_INBOX_GSTACK_STATE_ROOT = before;
    }
  });
});

describe('"no project" is how the stored home marker is shown', () => {
  const aliases = (names: Record<string, string>) => ({ state: 'ok' as const, names: new Map(Object.entries(names)) });

  test('the marker keeps its stored text and reads "no project"; other names read as they are', () => {
    expect(HOME_PROJECT).toBe('(home directory)'); // lines stored by every version mean the same
    expect([shownName(aliases({}), HOME_PROJECT), shownName(aliases({}), 'thing')]).toEqual([NO_PROJECT, 'thing']);
  });

  test('an alias may use either text for it, as the name shown or as the name wanted', () => {
    expect(shownName(aliases({ [NO_PROJECT]: 'misc' }), HOME_PROJECT)).toBe('misc');
    expect(shownName(aliases({ [HOME_PROJECT]: 'misc' }), HOME_PROJECT)).toBe('misc');
    expect(shownName(aliases({ scratch: HOME_PROJECT }), 'scratch')).toBe(NO_PROJECT);
    expect(shownName(aliases({ scratch: NO_PROJECT }), 'scratch')).toBe(NO_PROJECT);
  });
});

describe('import: a rule that returns a question to an earlier name', () => {
  const T0 = Date.parse('2026-11-01T10:00:00.000Z');
  test('the earlier line is written again, so it is the last; the next run adds nothing', async () => {
    const home = freshHome();
    const dir = path.join(home, '.agent-inbox');
    const state = path.join(home, '.gstack', 'projects', 'thing');
    fs.mkdirSync(state, { recursive: true });
    const q = { question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes (Recommended)', description: 'd' }, { label: 'No', description: 'd' }], multiSelect: false };
    const lines = [
      { type: 'user', timestamp: new Date(T0).toISOString(), cwd: home, message: { role: 'user', content: 'hello' } },
      { type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(), cwd: state, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [q] } }] } },
    ];
    const root = path.join(home, 'transcripts');
    write(path.join(root, '-folder', 's1.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''));
    // 0.2.1 named it after the folder; 0.3.0 moved it to the home marker
    const first: Observation = { v: FORMAT_VERSION, source: 'import', call: 'toolu_1', pos: 0, kind: 'ASKED', chip: 'Ship', title: 'Ship it?', session: 's1', project: 'thing', askTs: T0 + 1000, answerTs: null };
    write(path.join(dir, 'outcomes.jsonl'), [first, { ...first, project: HOME_PROJECT }].map((l) => JSON.stringify(l) + '\n').join(''));
    expect((await importHistory(dir, root, home)).added).toBe(1);
    expect((await importHistory(dir, root, home)).added).toBe(0);
    expect(readObservations(dir).observations.map((o) => o.project)).toEqual(['thing', HOME_PROJECT, 'thing']);
    const board = boardData(dir, { now: T0 + 2000 });
    expect([board.totals.questions, reconcile(readObservations(dir).observations, { now: T0 + 2000 }).map((r) => r.project)]).toEqual([1, ['thing']]);
  });
});

describe('reading: the line written last names the project, and the user can rename', () => {
  const T0 = Date.parse('2026-11-01T10:00:00.000Z');
  const obs = (extra: Partial<Observation>): Observation => ({ v: FORMAT_VERSION, source: 'hook', call: 'c1', pos: 0, kind: 'ASKED', chip: 'x', title: 't', session: 's', project: 'p', askTs: T0, answerTs: null, ...extra });

  test('of several lines about one question the last one names the project, whichever source wrote it', () => {
    const asked = obs({ project: 'old-name' });
    const answered = obs({ kind: 'AGREED', project: 'old-name', askTs: null, answerTs: T0 + 9000 });
    const renamed = obs({ source: 'import', kind: 'AGREED', project: 'new-name', answerTs: T0 + 9000 });
    expect(reconcile([asked, answered, renamed], { now: T0 }).map((r) => [r.project, r.outcome])).toEqual([['new-name', 'AGREED']]);
    expect(reconcile([renamed, asked, answered], { now: T0 }).map((r) => r.project)).toEqual(['old-name']);
    expect(reconcile([asked], { now: T0 }).map((r) => r.project)).toEqual(['old-name']);
  });

  const store = (aliases: string | null) => {
    const dir = path.join(freshHome(), '.agent-inbox');
    const lines = [
      obs({ call: 'c1', kind: 'AGREED', project: 'alpha-old', answerTs: T0 + 1000 }),
      obs({ call: 'c2', kind: 'AGREED', project: 'beta', session: 's2', answerTs: T0 + 1000 }),
      obs({ call: 'c3', kind: 'OVERRODE_OPTION', project: 'someone', session: 's3', answerTs: T0 + 1000 }),
    ];
    write(path.join(dir, 'outcomes.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''));
    if (aliases !== null) write(path.join(dir, ALIASES_FILE), aliases);
    return dir;
  };
  const projectsOf = (dir: string) => boardData(dir, { now: T0 + 5000 }).totals.projects.map((p) => [p.project, p.answered]);

  test('aliases merge names on the board and leave the stored lines alone', () => {
    const dir = store(JSON.stringify({ 'alpha-old': 'beta', someone: HOME_PROJECT }));
    expect(projectsOf(dir)).toEqual([['beta', 2], [NO_PROJECT, 1]]);
    const board = boardData(dir, { now: T0 + 5000 });
    expect(board.totals.overrides.map((o) => o.project)).toEqual([NO_PROJECT]);
    expect(board.totals.sessions.map((s) => s.project).sort()).toEqual([NO_PROJECT, 'beta', 'beta'].sort());
    expect(readObservations(dir).observations.map((o) => o.project)).toEqual(['alpha-old', 'beta', 'someone']);
  });

  test('no file, and a file that cannot be used, rename nothing', () => {
    expect(projectsOf(store(null))).toEqual([['alpha-old', 1], ['beta', 1], ['someone', 1]]);
    for (const bad of ['not json', '["a","b"]', '"text"', 'null', '']) {
      const dir = store(bad);
      expect([bad, readAliases(dir).state]).toEqual([bad, 'unreadable']);
      expect(projectsOf(dir)).toHaveLength(3);
    }
    expect(readAliases(store(null)).state).toBe('none');
  });

  test('an entry that is not a name is skipped, an alias is one step, and a name is cut like any other', () => {
    const dir = store(JSON.stringify({ a: 'b', b: 'c', same: 'same', n: 5, empty: '  ', '': 'x', long: 'y'.repeat(300), line: 'two\nlines' }));
    const aliases = readAliases(dir);
    expect(aliases.state).toBe('ok');
    expect([...aliases.names.keys()].sort()).toEqual(['a', 'b', 'line', 'long']);
    expect([aliasOf(aliases, 'a'), aliasOf(aliases, 'b'), aliasOf(aliases, 'untouched')]).toEqual(['b', 'c', 'untouched']);
    expect(aliasOf(aliases, 'long')).toHaveLength(NAME_MAX);
    expect(aliasOf(aliases, 'line')).toBe('twolines');
  });

  test('"Needs you" names a session the same way: where it started, by repository, then the alias', async () => {
    const home = freshHome();
    const dir = path.join(home, '.agent-inbox');
    const app = repo(path.join(home, 'Developer', 'renamed-folder'), 'git@github.com:owner/app.git');
    const event = (session_id: string, hook_event_name: string, cwd: string, ts: number, extra = {}) => JSON.stringify({ session_id, cwd, hook_event_name, notification_type: null, message: null, ts, ...extra });
    write(
      path.join(dir, 'events.jsonl'),
      [
        event('a', 'SessionStart', app, T0),
        event('a', 'UserPromptSubmit', app, T0 + 1000),
        event('a', 'Stop', path.join(home, 'elsewhere'), T0 + 2000),
        event('b', 'UserPromptSubmit', path.join(home, 'gone-folder'), T0 + 1000),
        event('b', 'Stop', path.join(home, 'gone-folder'), T0 + 3000),
      ].join('\n') + '\n',
    );
    write(path.join(dir, ALIASES_FILE), JSON.stringify({ 'gone-folder': 'app' }));
    const model = await new Inbox({ dir, home, stateRoot: path.join(home, 'gstack'), transcriptsDir: path.join(home, 'none') }).model(T0 + 60_000);
    const shown = [...model.waiting, ...model.permission, ...model.doneUnread, ...model.stale].map((s) => [s.session_id, s.project]).sort();
    expect(shown).toEqual([['a', 'app'], ['b', 'app']]);
  });
});
