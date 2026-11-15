#!/usr/bin/env bun
/**
 * validate-judgment.ts: check the Judgment parser against the owner's own reading of real questions.
 *
 *   bun scripts/validate-judgment.ts sheet   write a labelling sheet (about 10 real questions per outcome
 *                                            class, parser verdict withheld) and a separate key file
 *   bun scripts/validate-judgment.ts check   compare the labels with the key; exit 1 on any mismatch
 *
 * Both commands also reconcile counts against a scan that shares no code with the parser:
 *   distinct AskUserQuestion call ids (plain text match)  ==  calls the parser found
 *   sum of questions per distinct call                    ==  questions the parser classified
 *
 * The sheet holds real question text. It is written to <data dir>/validation (mode 0600), never
 * to the repository. Delete the directory when you are done.
 *
 * Options: --dir <path> (default ~/.agent-inbox/validation), --per-class <n> (default 10).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { configFromEnv } from '../inbox';
import { OUTCOMES, aggregate, classify, listTranscripts, mergeCalls, rowsFromCalls, scanChunks, type FileRef, type FileRows, type Outcome } from '../judgment';

/** What the owner writes for each outcome. Both excluded kinds share a letter: the reader need not tell them apart. */
const LETTER: Record<Outcome, string> = {
  AGREED: 'A',
  OVERRODE_OPTION: 'O',
  OVERRODE_TYPED: 'T',
  DISMISSED: 'D',
  UNANSWERED: 'N',
  UNDECODED: 'U',
  EXCLUDED_MULTI: 'X',
  EXCLUDED_NO_REC: 'X',
};
const LEGEND = [
  'A  you picked the option marked (Recommended)',
  'O  you picked a different listed option',
  'T  you typed your own answer',
  'D  you dismissed the question without answering',
  'N  the question was never answered (no result recorded)',
  'X  not countable: multi-select, or not exactly one option marked (Recommended)',
  'U  you cannot tell from what is shown',
];

interface KeyItem {
  n: number;
  id: string;
  index: number;
  outcome: Outcome;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function parserView(root: string) {
  const refs = await listTranscripts(root, process.env.HOME ?? '');
  const files: { ref: FileRef; rows: FileRows }[] = [];
  for (const ref of refs) files.push({ ref, rows: await scanChunks(fs.createReadStream(ref.path, { highWaterMark: 1 << 20 })) });
  const calls = mergeCalls(files);
  return { refs, calls, totals: aggregate(rowsFromCalls(calls)) };
}

const USE_RE = /"type":"tool_use","id":"([^"]+)","name":"AskUserQuestion","input":/g;

/**
 * The independent scan: line text and a regular expression, no parser code. Returns the distinct
 * call ids with the number of questions each holds, plus the recorded result text of `wanted` ids.
 */
async function plainView(refs: FileRef[], wanted: Set<string>) {
  const questionsById = new Map<string, number>();
  const resultText = new Map<string, string>();
  for (const ref of refs) {
    let tail = Buffer.alloc(0);
    const onLine = (line: Buffer) => {
      const named = line.includes('"name":"AskUserQuestion","input":');
      let hit = false;
      if (!named && line.includes('tool_result')) for (const id of wanted) if (line.includes(id)) hit = true;
      if (!named && !hit) return;
      const text = line.toString('utf8');
      let obj: any = null;
      try {
        obj = JSON.parse(text);
      } catch {
        return;
      }
      for (const m of text.matchAll(USE_RE)) {
        if (questionsById.has(m[1])) continue;
        const block = obj?.message?.content?.find?.((b: any) => b?.id === m[1]);
        questionsById.set(m[1], Array.isArray(block?.input?.questions) ? block.input.questions.length : 0);
      }
      for (const b of obj?.message?.content ?? []) {
        if (b?.type !== 'tool_result' || !wanted.has(b.tool_use_id)) continue;
        const c = typeof b.content === 'string' ? b.content : (b.content?.[0]?.text ?? '');
        if (c && (!resultText.has(b.tool_use_id) || obj.timestamp)) resultText.set(b.tool_use_id, c);
      }
    };
    for await (const chunk of fs.createReadStream(ref.path, { highWaterMark: 1 << 20 })) {
      let buf = tail.length ? Buffer.concat([tail, chunk as Buffer]) : (chunk as Buffer);
      let start = 0;
      for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
        onLine(buf.subarray(start, nl));
        start = nl + 1;
      }
      tail = Buffer.from(buf.subarray(start));
    }
  }
  return { questionsById, resultText };
}

function reconcile(parser: Awaited<ReturnType<typeof parserView>>, plain: Awaited<ReturnType<typeof plainView>>): boolean {
  const plainCalls = plain.questionsById.size;
  const plainQuestions = [...plain.questionsById.values()].reduce((a, b) => a + b, 0);
  const classified = OUTCOMES.reduce((n, o) => n + parser.totals.counts[o], 0);
  console.log(`calls:     plain scan ${plainCalls}, parser ${parser.totals.calls}`);
  console.log(`questions: plain scan ${plainQuestions}, parser classified ${classified}`);
  const ok = plainCalls === parser.totals.calls && plainQuestions === classified;
  console.log(ok ? 'reconciled' : 'NOT reconciled: the parser and the plain scan disagree');
  return ok;
}

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== 'sheet' && cmd !== 'check') {
    console.error('usage: bun scripts/validate-judgment.ts sheet|check [--dir <path>] [--per-class <n>]');
    process.exit(2);
  }
  const cfg = configFromEnv();
  const dir = arg('--dir', path.join(cfg.dir, 'validation'));
  const sheetFile = path.join(dir, 'judgment-labels.txt');
  const keyFile = path.join(dir, 'judgment-key.json');
  if (path.resolve(dir).startsWith(path.resolve(import.meta.dir, '..') + path.sep)) {
    console.error('refusing to write real question text inside the repository; pick another --dir');
    process.exit(2);
  }
  const parser = await parserView(cfg.transcriptsDir);

  if (cmd === 'sheet') {
    const perClass = Number(arg('--per-class', '10'));
    const byLetter = new Map<string, { id: string; index: number; outcome: Outcome }[]>();
    for (const call of parser.calls)
      call.questions.forEach((q, index) => {
        const outcome = classify(q, call.result);
        const list = byLetter.get(LETTER[outcome]) ?? [];
        list.push({ id: call.id, index, outcome });
        byLetter.set(LETTER[outcome], list);
      });
    const picked = shuffled([...byLetter.values()].flatMap((list) => shuffled(list).slice(0, perClass)));
    const plain = await plainView(parser.refs, new Set(picked.map((p) => p.id)));
    const callById = new Map(parser.calls.map((c) => [c.id, c]));
    const key: KeyItem[] = [];
    const out: string[] = [
      'Judgment parser check. For each item, write one letter after "Your label:" and save the file.',
      'Judge from the question, its options and the recorded result. Do not open judgment-key.json.',
      '',
      ...LEGEND.map((l) => `  ${l}`),
      '',
    ];
    picked.forEach((p, i) => {
      const n = i + 1;
      const call = callById.get(p.id)!;
      const q = call.questions[p.index];
      key.push({ n, id: p.id, index: p.index, outcome: p.outcome });
      out.push(
        `### ${n}`,
        `Asked: ${call.ts === null ? 'unknown' : new Date(call.ts).toISOString()} in ${call.project}`,
        `Question${call.questions.length > 1 ? ` (${p.index + 1} of ${call.questions.length} in one prompt)` : ''}: ${q.question}`,
        `Multi-select: ${q.multiSelect ? 'yes' : 'no'}`,
        'Options:',
        ...q.labels.map((l) => `  - ${l}`),
        `Recorded result: ${plain.resultText.get(p.id) ?? '(no result recorded)'}`,
        'Your label: ',
        '',
      );
    });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sheetFile, out.join('\n'), { mode: 0o600 });
    fs.writeFileSync(keyFile, JSON.stringify(key), { mode: 0o600 });
    const sizes = [...byLetter].map(([l, list]) => `${l} ${Math.min(list.length, perClass)} of ${list.length}`).sort();
    console.log(`sheet: ${sheetFile}`);
    console.log(`items: ${picked.length} (${sizes.join(', ')})`);
    const ok = reconcile(parser, plain);
    console.log(`\nLabel the sheet, then run: bun scripts/validate-judgment.ts check`);
    process.exit(ok ? 0 : 1);
  }

  let key: KeyItem[];
  let sheet: string;
  try {
    key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    sheet = fs.readFileSync(sheetFile, 'utf8');
  } catch {
    console.error(`no sheet in ${dir}; run: bun scripts/validate-judgment.ts sheet`);
    process.exit(2);
  }
  const labels = new Map<number, string>();
  let current: number | null = null;
  for (const line of sheet.split('\n')) {
    const head = /^### (\d+)\s*$/.exec(line);
    if (head) current = Number(head[1]);
    const label = /^Your label:\s*([A-Za-z])?\s*$/.exec(line);
    if (label && current !== null && label[1]) labels.set(current, label[1].toUpperCase());
  }
  const missing = key.filter((k) => !labels.has(k.n)).map((k) => k.n);
  const cannotTell = key.filter((k) => labels.get(k.n) === 'U' && k.outcome !== 'UNDECODED').map((k) => k.n);
  const wrong = key.filter((k) => labels.has(k.n) && labels.get(k.n) !== 'U' && labels.get(k.n) !== LETTER[k.outcome]);
  console.log(`labelled ${labels.size} of ${key.length}`);
  if (missing.length) console.log(`not labelled: items ${missing.join(', ')}`);
  if (cannotTell.length) console.log(`marked U (cannot tell), not counted either way: items ${cannotTell.join(', ')}`);
  for (const k of wrong) console.log(`MISMATCH item ${k.n}: you wrote ${labels.get(k.n)}, the parser says ${LETTER[k.outcome]} (${k.outcome})`);
  console.log(`${wrong.length} mismatches`);
  const ok = reconcile(parser, await plainView(parser.refs, new Set()));
  process.exit(ok && !wrong.length && !missing.length ? 0 : 1);
}

await main();
