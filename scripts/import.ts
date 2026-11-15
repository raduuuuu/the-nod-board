#!/usr/bin/env bun
/**
 * import.ts: load past Claude Code sessions into The Nod Board's store (the /nod-board:import command).
 *
 * Reads the transcripts under ~/.claude/projects (AGENT_INBOX_TRANSCRIPTS to override) once, in
 * memory, and appends one observation per question to outcomes.jsonl: the outcome, the label, the
 * first line, session, project and timestamps. Option text and answers are not stored. Running it
 * again adds only what is new. Prints counts only, never question text.
 */
import * as os from 'node:os';
import { configFromEnv } from '../inbox';
import { importHistory } from '../outcomes';

const n = (count: number, noun: string) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
const cfg = configFromEnv();
try {
  const r = await importHistory(cfg.dir, cfg.transcriptsDir, process.env.HOME || os.homedir());
  const lines = [
    r.added === 0
      ? `Nothing new: ${n(r.questions, 'question')} from ${n(r.files, 'session file')} already stored.`
      : `Imported ${n(r.added, 'new record')} for ${n(r.questions, 'question')} found in ${n(r.files, 'session file')}.`,
  ];
  if (r.skipped) lines.push(`${n(r.skipped, 'file')} could not be read and skipped.`);
  if (r.unrecognizedFiles) lines.push(`${n(r.unrecognizedFiles, 'file')} with questions in a format this version does not recognize; those questions were not imported.`);
  lines.push(`Stored in ${cfg.dir}/outcomes.jsonl.`);
  console.log(lines.join('\n'));
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name;
  console.log(`No past sessions imported: cannot read ${cfg.transcriptsDir} (${code}). Set AGENT_INBOX_TRANSCRIPTS if your transcripts are elsewhere.`);
  process.exit(1);
}
