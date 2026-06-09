#!/usr/bin/env -S node --experimental-strip-types
/**
Checks package test and benchmark entry scripts.
Goal:
  - catch broken test/benchmark imports and immediate crashes before a full human review run
  - treat scripts that survive until timeout as OK because the smoke check only targets startup failure
Rules:
  - run direct `test/*.test.ts`, `test/benchmark/*.ts`, and `benchmark/*.ts` files
  - skip underscore-prefixed benchmark helpers because they are usually imported, not executed
  - run test files from the package root and benchmark files from their benchmark directory
  - execute scripts in parallel with a small worker limit and a per-file timeout
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import {
  cliArgs,
  collectIssues,
  dirEntries,
  makeIssue,
  pkgTarget,
  readText,
  reportIssues,
  runSelf,
  textLines,
  type PkgArgs,
  usageText,
  wantTSFile,
} from './utils.ts';

type Kind = 'benchmark' | 'test';
type Item = { cwd: string; file: string; kind: Kind; rel: string };
type Probe = {
  code?: number;
  error?: string;
  signal?: NodeJS.Signals;
  stderr: string;
  stdout: string;
  timeout?: boolean;
};
type Row = Item & Probe;
type Bad = { bad: { detail: string; sym: string }; row: Row };

const usage = usageText('tests', 'check-tests.ts');

const LIMIT = 8;
const TIMEOUT = 10_000;
const MAX_OUTPUT = 8192;
const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] as const;

const resolvePkg = (args: PkgArgs, cwd = process.cwd()): { cwd: string; pkgFile: string } => {
  const { pkgFile } = pkgTarget(args.pkgArg, cwd);
  readText(pkgFile);
  return { cwd: dirname(pkgFile), pkgFile };
};
const keep = (prev: string, chunk: Buffer): string => {
  const next = prev + chunk.toString('utf8');
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
};
const messageLine = (text: string): string => {
  const lines = textLines(text);
  // Node ESM stack traces usually print the source location before the actual Error line.
  return lines.find((line) => /^[A-Za-z]*Error\b/.test(line)) || lines[0] || '';
};
const listDir = (cwd: string, relDir: string, kind: Kind): Item[] => {
  const dir = join(cwd, relDir);
  if (!existsSync(dir)) return [];
  return dirEntries(dir).flatMap((ent) => {
    if (!ent.isFile()) return [];
    const file = join(dir, ent.name);
    if (!wantTSFile(file)) return [];
    if (kind === 'test' && !ent.name.endsWith('.test.ts')) return [];
    if (kind === 'benchmark' && ent.name.startsWith('_')) return [];
    return [{ cwd: kind === 'benchmark' ? dir : cwd, file, kind, rel: relative(cwd, file) }];
  });
};
const list = (cwd: string): Item[] =>
  [
    ...listDir(cwd, 'test', 'test'),
    ...listDir(cwd, 'test/benchmark', 'benchmark'),
    ...listDir(cwd, 'benchmark', 'benchmark'),
  ].sort((a, b) => a.rel.localeCompare(b.rel));
const runOne = (item: Item, timeoutMs: number): Promise<Probe> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [...NODE_ARGS, item.file], {
      cwd: item.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    let stderr = '';
    let stdout = '';
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (res: Probe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keep(stderr, chunk);
    });
    child.once('error', (error) => finish({ error: error.message, stderr, stdout }));
    child.once('close', (code, signal) =>
      finish({
        code: code === null ? undefined : code,
        signal: signal || undefined,
        stderr,
        stdout,
        timeout,
      })
    );
  });
const runLimit = async (
  items: Item[],
  limit: number,
  fn: (item: Item) => Promise<Probe>
): Promise<Row[]> => {
  const out = new Array<Row>(items.length);
  let pos = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = pos++;
      if (i >= items.length) return;
      const item = items[i];
      out[i] = { ...item, ...(await fn(item)) };
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
};
const issue = (row: Row): { detail: string; sym: string } | undefined => {
  const note = messageLine(row.stderr) || messageLine(row.stdout);
  if (row.timeout) return undefined;
  if (row.error) return { detail: row.error, sym: 'exec' };
  if (row.code && row.code !== 0)
    return { detail: `exited ${row.code}${note ? ` ${note}` : ''}`, sym: 'exec' };
  if (row.signal)
    return { detail: `terminated by signal ${row.signal}${note ? ` ${note}` : ''}`, sym: 'exec' };
  return undefined;
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; limit?: number; timeoutMs?: number } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const ctx = resolvePkg(args, opts.cwd);
  const timeoutMs = opts.timeoutMs || TIMEOUT;
  const rows = await runLimit(list(ctx.cwd), opts.limit || LIMIT, (item) =>
    runOne(item, timeoutMs)
  );
  const { issues, result } = collectIssues(
    rows,
    (row): Bad[] => {
      const bad = issue(row);
      return bad ? [{ bad, row }] : [];
    },
    (item) => makeIssue('error', item.row.rel, item.bad.sym, item.bad.detail, 'tests')
  );
  reportIssues('tests', issues, result, colorOn, 'Tests check found issues');
};

runSelf(import.meta.url, runCli);
