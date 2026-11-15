#!/usr/bin/env bun
/**
 * verify-dist.ts: prove that a built directory is exactly what this source produces.
 *
 *   bun scripts/verify-dist.ts <dir>
 *
 * Builds the app again into a temporary directory and compares it with <dir> file by file,
 * byte by byte. Exit 0 when identical; exit 1 with the differing, missing or extra files
 * otherwise. The release workflow runs this on the exact commit it is about to tag, so a
 * released bundle that differs from its source cannot be published.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: bun scripts/verify-dist.ts <dir>');
  process.exit(2);
}

function listing(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'nod-board-verify-'));
try {
  const built = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'build.ts'), '--outdir', fresh], { stdout: 'ignore', stderr: 'inherit' });
  if (built.exitCode !== 0) {
    console.error('verify: the fresh build failed');
    process.exit(1);
  }
  let have: Map<string, string>;
  try {
    have = listing(path.resolve(target));
  } catch {
    console.error(`verify: cannot read ${target}`);
    process.exit(1);
  }
  const want = listing(fresh);
  const problems: string[] = [];
  for (const [file, hash] of want) {
    if (!have.has(file)) problems.push(`missing: ${file}`);
    else if (have.get(file) !== hash) problems.push(`differs: ${file}`);
  }
  for (const file of have.keys()) if (!want.has(file)) problems.push(`extra: ${file}`);
  if (problems.length) {
    console.error(`verify: ${target} is not what this source builds\n  ${problems.sort().join('\n  ')}`);
    process.exit(1);
  }
  console.log(`verified: ${want.size} files in ${target} match a fresh build`);
} finally {
  fs.rmSync(fresh, { recursive: true, force: true });
}
