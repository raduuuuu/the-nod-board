/**
 * project.ts: what a session's project is called. The only module that knows the rule.
 *
 *   resolveProject(folder, home)   the name of the project a folder belongs to
 *   projectOfSession(start, asked) the project of a question, from where its session started
 *   noteStart / projectAt          live: fixed when the session starts, read when a question is asked
 *   readAliases / aliasOf          the user's own renames, applied when the board is read
 *
 * The rule: a session belongs to the folder it started in, not to wherever it later worked.
 * That folder is named after its git repository, so a renamed checkout, a second clone and a
 * worktree of one repository are one project:
 *
 *   the home directory itself                 HOME_PROJECT
 *   inside a repository with an "origin"      the last segment of origin's address, without ".git"
 *   inside a repository without one           the name of the repository's main folder
 *   anywhere else                             the folder's own name
 *
 * Only that one name is kept; the address of the remote is read and never stored.
 *
 * One exception, measured on a real history: a session started in the home directory is in no
 * project of its own, and such sessions do most of their work after moving into a checkout
 * (687 of 1,472 answers in one user's history). So a question of a home-started session
 * belongs to the repository it was asked in, and to HOME_PROJECT only when it was asked in
 * none. A folder that is not a repository never names such a question, so a tool's own state
 * folder does not turn into a project. A folder that no longer exists is the one case left as
 * it was: it keeps its own name.
 *
 * The repository is found by reading files (.git, commondir, config). No program is started: a
 * hook must return at once. The search goes upward from the folder and stops below the home
 * directory, so a home directory that is itself a repository does not claim every folder in it.
 * Anything that cannot be read falls back to the folder's own name. Never throws.
 *
 * A folder that no longer exists cannot be resolved, so its sessions keep the folder's name.
 * For those, and for any name the user wants changed, there is the alias file:
 * <data dir>/project-aliases.json, one object of "name as shown": "name wanted". It is applied
 * when the board is read, in one step (an alias of an alias is not followed), and never
 * changes what is stored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSessionValue, putSessionValue } from './attrs';

export const HOME_PROJECT = '(home directory)';
export const ALIASES_FILE = 'project-aliases.json';
export const NAME_MAX = 80;
/** The session's project, kept beside its other state while the session lives. */
const START_VALUE = 'project';
const CONFIG_MAX = 256 * 1024;
const MAX_DEPTH = 64;

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
/** A name as it may be stored and shown: one line, no control characters, cut to NAME_MAX. */
const clean = (name: string | null | undefined): string | null => {
  if (!name) return null;
  const s = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return s || null;
};

/** Display name from a working directory alone: the home directory, or the folder's own name. */
export function projectOfCwd(cwd: string | null | undefined, home: string): string | null {
  if (!cwd) return null;
  const dir = cwd.replace(/\/+$/, '');
  if (dir === home.replace(/\/+$/, '')) return HOME_PROJECT;
  return path.basename(dir) || null;
}

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > CONFIG_MAX) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The last segment of a remote's address: "git@host:owner/name.git" and "https://host/owner/name" both give "name". */
export function nameOfRemote(url: string): string | null {
  const trimmed = url.trim().replace(/[/\\]+$/, '').replace(/\.git$/i, '');
  return clean(trimmed.split(/[/\\:]/).pop());
}

/** The address of the remote called "origin" in a git config file's text, or null. */
export function originUrl(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim().replace(/^"(.*)"$/, '$1') || null;
  }
  return null;
}

/** The repository a folder is in, as its name; null when it is in none or it cannot be read. Never throws. */
export function repositoryOf(folder: string | null | undefined, home: string): string | null {
  if (!folder || !path.isAbsolute(folder)) return null;
  try {
    return repositoryName(trimSlash(folder), home);
  } catch {
    return null;
  }
}

function repositoryName(start: string, home: string): string | null {
  const stop = trimSlash(home);
  let dir = start;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (dir === stop) return null; // the home directory and what is above it are never the project
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st) {
      let gitDir: string | null = null;
      if (st.isDirectory()) gitDir = dotGit;
      else if (st.isFile()) {
        // A worktree or a submodule: the file points at the real git folder.
        const m = /^gitdir:\s*(.+)$/m.exec(readSmall(dotGit) ?? '');
        if (m) gitDir = path.resolve(dir, m[1].trim());
      }
      if (!gitDir) return null;
      // A worktree's git folder names the folder it shares with the main checkout.
      const shared = readSmall(path.join(gitDir, 'commondir'));
      const common = shared ? path.resolve(gitDir, shared.trim()) : gitDir;
      const url = originUrl(readSmall(path.join(common, 'config')) ?? '');
      const fromRemote = url ? nameOfRemote(url) : null;
      if (fromRemote) return fromRemote;
      // No origin: the main checkout's folder, which a worktree shares with its siblings.
      return clean(path.basename(common) === '.git' ? path.basename(path.dirname(common)) : path.basename(dir));
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** The project a folder belongs to (see the header). Null only when no folder is given. */
export function resolveProject(folder: string | null | undefined, home: string): string | null {
  if (!folder) return null;
  const dir = trimSlash(folder);
  if (dir === trimSlash(home)) return HOME_PROJECT;
  return repositoryOf(dir, home) ?? clean(projectOfCwd(dir, home));
}

/**
 * What a home-started session's question is named: the repository it was asked in, or the home
 * directory. A folder that is gone (history only) cannot be looked at, so it is not judged: it
 * keeps its own name, as before, and an alias can say what it was.
 */
function fromHome(asked: string | null | undefined, home: string): string {
  const repo = repositoryOf(asked, home);
  if (repo) return repo;
  if (asked && path.isAbsolute(asked) && !fs.existsSync(asked)) return resolveProject(asked, home) ?? HOME_PROJECT;
  return HOME_PROJECT;
}

/**
 * The project of a question: where its session started, or, for a session started in the home
 * directory, the repository the question was asked in (see the header). A session whose start is
 * not known is named after the folder the question was asked in. Null when neither is known.
 */
export function projectOfSession(start: string | null | undefined, asked: string | null | undefined, home: string): string | null {
  if (!start) return resolveProject(asked, home);
  const name = resolveProject(start, home);
  return name === HOME_PROJECT ? fromHome(asked, home) : name;
}

/** projectOfSession, with each folder looked up once: for a run that names many sessions. */
export function projectResolver(home: string): (start: string | null | undefined, asked: string | null | undefined) => string | null {
  const known = new Map<string, string | null>();
  return (start, asked) => {
    const key = `${start ?? ''}\u0000${asked ?? ''}`;
    if (!known.has(key)) known.set(key, projectOfSession(start, asked, home));
    return known.get(key) ?? null;
  };
}

/**
 * A session started in `cwd`: fix its project for as long as its state lives. A session also
 * "starts" after a compaction or a clear; the first start is the one that counts. Throws on a
 * failed write.
 */
export function noteStart(dir: string, sessionId: string, cwd: string | null, home: string): void {
  if (getSessionValue(dir, sessionId, START_VALUE) !== null) return;
  const name = resolveProject(cwd, home);
  if (name) putSessionValue(dir, sessionId, START_VALUE, name);
}

/**
 * The project of a question asked now. A session whose start was not seen (it began before this
 * version, or its product sends no start) is named after the folder it is working in.
 */
export function projectAt(dir: string | undefined, sessionId: string, cwd: string | null, home: string): string | null {
  const fixed = dir ? getSessionValue(dir, sessionId, START_VALUE) : null;
  if (fixed === HOME_PROJECT) return fromHome(cwd, home);
  return fixed ?? resolveProject(cwd, home);
}

export interface Aliases {
  /** "none": no file. "unreadable": a file that is not an object of names. */
  state: 'none' | 'ok' | 'unreadable';
  names: ReadonlyMap<string, string>;
}

/** The user's renames. A file that cannot be used renames nothing and says so. Never throws. */
export function readAliases(dir: string): Aliases {
  const none: Aliases = { state: 'none', names: new Map() };
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, ALIASES_FILE), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? none : { ...none, state: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...none, state: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...none, state: 'unreadable' };
  const names = new Map<string, string>();
  for (const [from, to] of Object.entries(parsed as Record<string, unknown>)) {
    const target = typeof to === 'string' ? clean(to) : null;
    if (from && target && target !== from) names.set(from, target);
  }
  return { state: 'ok', names };
}

export function aliasOf(aliases: Aliases, name: string): string {
  return aliases.names.get(name) ?? name;
}
