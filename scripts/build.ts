#!/usr/bin/env bun
/**
 * build.ts: produce dist/, the files the local server serves for the dashboard.
 *
 *   dist/index.html, dist/app.css   copied from app/
 *   dist/app.js                     app/main.tsx bundled with Preact (the only runtime dependency)
 *   dist/fonts/*                    the three IBM Plex files the stylesheet names, plus their license
 *
 * Releases are built by CI from the pinned lockfile; this script is the same build, for a checkout.
 * `--outdir <path>` builds somewhere else (the tests use it).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(import.meta.dir, '..');
const at = process.argv.indexOf('--outdir');
const out = at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : path.join(root, 'dist');

export const FONTS: [pkg: string, file: string][] = [
  ['ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
  ['ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
  ['ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

const built = await Bun.build({
  entrypoints: [path.join(root, 'app', 'main.tsx')],
  target: 'browser',
  format: 'esm',
  minify: true,
  // The production JSX runtime: no source positions in the bundle.
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: 'none',
});
if (!built.success || built.outputs.length !== 1) {
  for (const log of built.logs) console.error(log);
  console.error('build failed');
  process.exit(1);
}
await Bun.write(path.join(out, 'app.js'), built.outputs[0]);
for (const name of ['index.html', 'app.css']) fs.copyFileSync(path.join(root, 'app', name), path.join(out, name));
for (const [pkg, file] of FONTS) fs.copyFileSync(path.join(root, 'node_modules', '@fontsource', pkg, 'files', file), path.join(out, 'fonts', file));
fs.copyFileSync(path.join(root, 'node_modules', '@fontsource', 'ibm-plex-sans', 'LICENSE'), path.join(out, 'fonts', 'LICENSE.txt'));

const size = (f: string) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(1)} KB`;
console.log(`built ${out}: app.js ${size('app.js')}, app.css ${size('app.css')}, fonts ${FONTS.map(([, f]) => size(path.join('fonts', f))).join(' + ')}`);
