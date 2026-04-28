#!/usr/bin/env -S node --experimental-strip-types
/**
Checks public JS entry import time.
Goal:
  - benchmark import time to avoid slowing startup time with pre-calculations at module load
Rules:
  - each public entry is measured in a fresh worker, so module cache does not leak across rows
  - the timer starts inside the worker around `await import(spec)`, excluding worker startup
  - public entries are measured serially to avoid workers inflating each other's timings
  - warn when median import time exceeds max(fastest median import * 2, fastest median import + 5ms)
  - fail when median import time exceeds 20x the fastest median import
  - standalone command prints a timing table; generic `jsbt check` should pass `quiet: true`
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { listModules, readPkg, type Pkg, type PublicMod } from './public.ts';
import {
  bundled,
  color,
  groupIssues,
  paint,
  status,
  stripAnsi,
  summary,
  type Issue as LogIssue,
  type Result,
  wantColor,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type Ctx = { cwd: string; pkg: Pkg; pkgFile: string };
type Probe = { error?: string; ms?: number };
type Row = PublicMod & {
  error?: string;
  fail?: boolean;
  file: string;
  limit: number;
  ms?: number;
  ratio: number;
  skip?: boolean;
  warn: boolean;
};
type Log = (line: string) => void;
type TableApi = {
  drawHeader: (sizes: number[], fields: string[]) => void;
  drawSeparator: (sizes: number[], changed: boolean[]) => void;
  printRow: (
    values: string[],
    prev: string[] | undefined,
    sizes: number[],
    selected: string[]
  ) => string[];
};

const usage = `usage:
  jsbt importtime <package.json>

examples:
  jsbt importtime package.json
  node /path/to/check-importtime.ts package.json`;

const WORKER = `import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
const start = performance.now();
try {
  await import(workerData.spec);
  parentPort.postMessage({ ms: performance.now() - start });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}`;
const SAMPLES = 5;
const ERROR_FACTOR = 20;
const WARN_FACTOR = 2;
const WARN_GAP = 5;
const ROOT_TRAP = /root module cannot be imported: import submodules instead\./i;
const CH = '─';
const NN = '│';
const LR = '┼';
const RN = '├';
const NL = '┤';

const err = (msg: string): never => {
  throw new Error(msg);
};
const median = (items: number[]) => {
  const sorted = items.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const guardChild = (cwd: string, file: string, label: string) => {
  const rel = relative(cwd, file);
  if (!rel || rel === '.' || rel.startsWith('..'))
    err(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
const resolveCtx = (args: Args, cwd = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  const root = dirname(pkgFile);
  return { cwd: root, pkg: readPkg(pkgFile), pkgFile };
};
const joinBorders = (str: string) =>
  str
    .replaceAll(`${CH}${NN}${CH}`, `${CH}${LR}${CH}`)
    .replaceAll(`${CH}${NN}`, `${CH}${NL}`)
    .replaceAll(`${NN}${CH}`, `${RN}${CH}`);
const pad = (s: string, len: number, end = true) => {
  const extra = len - stripAnsi(s).length;
  if (extra <= 0) return s;
  const fill = ' '.repeat(extra);
  return end ? s + fill : fill + s;
};
const table = (log: Log): TableApi => {
  const drawHeader = (sizes: number[], fields: string[]) =>
    log(fields.map((name, i) => `${name.padEnd(sizes[i])} `).join(NN));
  const drawSeparator = (sizes: number[], changed: boolean[]) => {
    const sep = sizes.map((size, i) => (changed[i] ? CH : ' ').repeat(size + 1));
    log(joinBorders(sep.join(NN)));
  };
  const printRow = (
    values: string[],
    prev: string[] | undefined,
    sizes: number[],
    selected: string[]
  ) => {
    const changed = values.map(() => true);
    for (let i = 0, parentChanged = false; i < selected.length; i++) {
      const curChanged = parentChanged || !prev || values[i] !== prev[i];
      changed[i] = curChanged;
      if (curChanged) parentChanged = true;
    }
    const head = changed.slice(0, selected.length);
    const skip = head.length < 2 ? true : head.slice(0, -1).every((v) => !v) && !!head.at(-1);
    if (!skip) drawSeparator(sizes, changed);
    log(
      values
        .map((val, i) => pad(!changed[i] ? ' ' : val, sizes[i] + 1, i < selected.length))
        .join(NN)
    );
    return values;
  };
  return { drawHeader, drawSeparator, printRow };
};
const measureOnce = (spec: string): Promise<Probe> =>
  new Promise((resolve) => {
    // `@types/node` here rejects `type: 'module'` on eval workers even though the runtime supports it.
    const worker = new Worker(WORKER, { eval: true, type: 'module', workerData: { spec } } as any);
    let done = false;
    const finish = (res: Probe, exited = false) => {
      if (done) return;
      done = true;
      resolve(res);
      // Measured modules may leave startup handles open; timing is complete after postMessage.
      if (!exited) worker.terminate().catch(() => {});
    };
    worker.once('message', (msg) => finish(msg as Probe));
    worker.once('error', (error) => finish({ error: error.message }));
    worker.once('exit', (code) => {
      if (done) return;
      finish(
        { error: code ? `worker exited with code ${code}` : 'worker exited without result' },
        true
      );
    });
  });
const measure = async (jsFile: string): Promise<Probe> => {
  const spec = pathToFileURL(jsFile).href;
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const res = await measureOnce(spec);
    if (res.error) return res;
    if (typeof res.ms !== 'number' || !Number.isFinite(res.ms))
      return { error: `invalid import time result for ${jsFile}` };
    samples.push(res.ms);
  }
  return { ms: median(samples) };
};
const fmt = (ms: number) => ms.toFixed(2);
const rowText = (item: Row, colorOn: boolean) => {
  const level = item.error || item.fail ? color.red : item.warn ? color.yellow : color.green;
  return [
    item.key,
    item.file,
    item.error
      ? paint('ERR', color.red, colorOn)
      : item.skip
        ? '-'
        : paint(fmt(item.ms || 0), level, colorOn),
    Number.isFinite(item.limit) ? fmt(item.limit) : '-',
    item.error || item.skip ? '-' : `x${item.ratio.toFixed(2)}`,
    item.skip
      ? paint('skip', color.yellow, colorOn)
      : item.error || item.fail
        ? paint('error', color.red, colorOn)
        : item.warn
          ? paint('slow', color.yellow, colorOn)
          : paint('ok', color.green, colorOn),
  ];
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; quiet?: boolean } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const ctx = resolveCtx(args, opts.cwd);
  const colorOn = opts.color ?? wantColor();
  const rows: Row[] = [];
  // Measure serially: parallel workers distort the very import cost we are trying to compare.
  for (const mod of listModules(ctx)) {
    rows.push({
      ...mod,
      file: relative(ctx.cwd, mod.jsFile) || basename(mod.jsFile),
      limit: Infinity,
      ratio: 1,
      warn: false,
      ...(await measure(mod.jsFile)),
    });
  }
  const okRows = rows.filter((item) => typeof item.ms === 'number') as (Row & { ms: number })[];
  const base = okRows.length ? Math.min(...okRows.map((item) => item.ms)) : Infinity;
  const limit = okRows.length < 2 ? Infinity : Math.max(base * WARN_FACTOR, base + WARN_GAP);
  for (const item of okRows) {
    item.limit = limit;
    item.ratio = base > 0 ? item.ms / base : 1;
    item.fail = item.ratio > ERROR_FACTOR;
    item.warn = !item.fail && Number.isFinite(limit) && item.ms > limit;
  }
  for (const item of rows)
    if (item.error && ROOT_TRAP.test(item.error)) {
      // Some noble packages intentionally make the root entry throw to force submodule imports.
      // Import-time checks should skip those trap entries instead of failing the whole package.
      item.skip = true;
      item.error = undefined;
    }
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  const sorted = rows
    .slice()
    .sort((a, b) => (b.ms || -1) - (a.ms || -1) || a.key.localeCompare(b.key));
  if (!opts.quiet) {
    const headers = ['module', 'file', 'ms', 'limit', 'x', 'result'];
    const values = sorted.map((item) => rowText(item, colorOn));
    const sizes = headers.map((head, i) =>
      Math.max(head.length, ...values.map((row) => stripAnsi(row[i]).length))
    );
    const print = table(console.log);
    print.drawHeader(sizes, headers);
    let prev: string[] | undefined;
    for (const row of values) prev = print.printRow(row, prev, sizes, ['module']);
  }
  const logs: LogIssue[] = [];
  for (const item of sorted) {
    if (item.skip) {
      out.skipped++;
      continue;
    }
    if (item.error) {
      out.failures++;
      logs.push({
        level: 'ERROR',
        ref: { file: item.file, issue: 'failed to import ' + item.error, sym: 'import' },
      });
      continue;
    }
    if (item.fail) {
      out.failures++;
      logs.push({
        level: 'ERROR',
        ref: {
          file: item.file,
          issue: `${fmt(item.ms || 0)}ms (x${item.ratio.toFixed(2)} from baseline)`,
          sym: 'import',
        },
      });
      continue;
    }
    if (item.warn) {
      out.warnings++;
      logs.push({
        level: 'WARNING',
        ref: {
          file: item.file,
          issue: `${fmt(item.ms || 0)}ms (x${item.ratio.toFixed(2)} from baseline)`,
          sym: 'import',
        },
      });
      continue;
    }
    out.passed++;
  }
  for (const line of groupIssues('importtime', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('Import time check found issues');
  }
  if (out.warnings) return console.error(`${status('warn', colorOn)} summary: ${summary(out)}`);
  console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
