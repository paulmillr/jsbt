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
import { publicCtx, publicRows, type PublicRow } from './public.ts';
import {
  cliArgs,
  color,
  emptyResult,
  fileUrl,
  paint,
  recordIssue,
  reportIssues,
  runWorker,
  runSelf,
  skipRootImportTrap,
  stripAnsi,
  table,
  type Issue as LogIssue,
  usageText,
} from './utils.ts';

type Probe = { error?: string; ms?: number };
type RowData = Probe & {
  fail?: boolean;
  limit: number;
  ratio: number;
  skip?: boolean;
  warn: boolean;
};
type Row = PublicRow<RowData>;

const usage = usageText('importtime', 'check-importtime.ts');

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

const median = (items: number[]) => {
  const sorted = items.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const measureOnce = (spec: string): Promise<Probe> =>
  runWorker<Probe>(WORKER, {
    data: { spec },
    error: (error) => ({ error }),
  });
const measure = async (jsFile: string): Promise<Probe> => {
  const spec = fileUrl(jsFile);
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
const slowText = (item: Row): string =>
  `${fmt(item.ms || 0)}ms (x${item.ratio.toFixed(2)} from baseline)`;

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; quiet?: boolean } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const ctx = publicCtx(args.pkgArg, opts.cwd);
  // Measure serially: parallel workers distort the very import cost we are trying to compare.
  const rows: Row[] = await publicRows<RowData>(ctx, async (mod) => ({
    limit: Infinity,
    ratio: 1,
    warn: false,
    ...(await measure(mod.jsFile)),
  }));
  const okRows = rows.filter((item) => typeof item.ms === 'number') as (Row & { ms: number })[];
  const base = okRows.length ? Math.min(...okRows.map((item) => item.ms)) : Infinity;
  const limit = okRows.length < 2 ? Infinity : Math.max(base * WARN_FACTOR, base + WARN_GAP);
  for (const item of okRows) {
    item.limit = limit;
    item.ratio = base > 0 ? item.ms / base : 1;
    item.fail = item.ratio > ERROR_FACTOR;
    item.warn = !item.fail && Number.isFinite(limit) && item.ms > limit;
  }
  for (const item of rows) skipRootImportTrap(item);
  const out = emptyResult();
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
      recordIssue(out, logs, 'error', item.file, 'import', 'failed to import ' + item.error);
      continue;
    }
    if (item.fail) {
      recordIssue(out, logs, 'error', item.file, 'import', slowText(item));
      continue;
    }
    if (item.warn) {
      recordIssue(out, logs, 'warn', item.file, 'import', slowText(item));
      continue;
    }
    out.passed++;
  }
  reportIssues('importtime', logs, out, colorOn, 'Import time check found issues', 'warn');
};

runSelf(import.meta.url, runCli);
