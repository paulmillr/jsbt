#!/usr/bin/env -S node --experimental-strip-types
/**
Checks public JS exports for mutable object/array constants.
Goal:
  - find unfrozen public objects/arrays that let users mutate shared package state
  - tell humans/LLMs where to add Object.freeze around exported constants
What it does:
  - goes over every public package export
  - imports the JS entry
  - tries to add a property or mutate an existing writable property on exported values
  - walks into nested own-value object/array properties so shallow Object.freeze is not enough
Rules:
  - each public entry is imported in a fresh worker so mutation probes do not leak into this process
  - object and array exports are probed by trying to add or change properties
  - typed-array / ArrayBuffer exports are ignored because Object.freeze does not fix their byte mutability
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { listModules, readPkg, type Pkg, type PublicMod } from './public.ts';
import {
  bundled,
  groupIssues,
  guardChild,
  issueKind,
  status,
  summary,
  type Issue as LogIssue,
  type Result,
  wantColor,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type Ctx = { cwd: string; pkg: Pkg; pkgFile: string };
type Probe = { error?: string; issues?: { issue: string; name: string }[] };
type Row = PublicMod & {
  error?: string;
  file: string;
  issues: { issue: string; name: string }[];
  skip?: boolean;
};

const usage = `usage:
  jsbt mutate <package.json>

examples:
  jsbt mutate package.json
  node /path/to/check-mutate.ts package.json`;

const WORKER = `import { parentPort, workerData } from 'node:worker_threads';
const isIgnored = (value) =>
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
const isTarget = (value) => value !== null && typeof value === 'object' && !isIgnored(value);
const tryAdd = (value) => {
  const key = Symbol('jsbt_mutate');
  try {
    value[key] = true;
    if (value[key] === true) {
      delete value[key];
      return true;
    }
  } catch {}
  return false;
};
const tryWrite = (value) => {
  const mark = Symbol('jsbt_mutate_value');
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || !desc.writable) continue;
    const prev = value[key];
    try {
      value[key] = mark;
      if (value[key] === mark) {
        value[key] = prev;
        return true;
      }
    } catch {}
  }
  return false;
};
const mutable = (value) => {
  if (!isTarget(value) || Object.isFrozen(value)) return false;
  return tryAdd(value) || tryWrite(value) || !Object.isFrozen(value);
};
const pathOf = (base, value, key) => {
  if (Array.isArray(value) && /^[0-9]+$/.test(String(key))) return base + '[' + key + ']';
  if (typeof key === 'symbol') return base + '[' + String(key) + ']';
  if (/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(key)) return base + '.' + key;
  return base + '[' + JSON.stringify(key) + ']';
};
const scan = (name, value, issues, seen) => {
  if (!isTarget(value) || seen.has(value)) return;
  seen.add(value);
  if (mutable(value))
    issues.push({
      name,
      issue: Array.isArray(value)
        ? 'mutable array export; add Object.freeze around it'
        : 'mutable object export; add Object.freeze around it',
    });
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || !isTarget(desc.value)) continue;
    scan(pathOf(name, value, key), desc.value, issues, seen);
  }
};
try {
  const mod = await import(workerData.spec);
  const issues = [];
  for (const [name, value] of Object.entries(mod)) scan(name, value, issues, new WeakSet());
  parentPort.postMessage({ issues });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}`;
const ROOT_TRAP = /root module cannot be imported: import submodules instead\./i;

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const resolveCtx = (args: Args, cwd = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  const root = dirname(pkgFile);
  return { cwd: root, pkg: readPkg(pkgFile), pkgFile };
};
const probe = (jsFile: string): Promise<Probe> =>
  new Promise((resolve) => {
    const spec = pathToFileURL(jsFile).href;
    // Run probes in a worker so successful writes cannot affect later checks in this process.
    const worker = new Worker(WORKER, { eval: true, type: 'module', workerData: { spec } } as any);
    let done = false;
    const finish = (res: Probe, exited = false) => {
      if (done) return;
      done = true;
      resolve(res);
      // Public modules can leave handles open; mutation probing is complete once results arrive.
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

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const ctx = resolveCtx(args, opts.cwd);
  const colorOn = opts.color ?? wantColor();
  const rows: Row[] = [];
  for (const mod of listModules(ctx)) {
    const res = await probe(mod.jsFile);
    rows.push({
      ...mod,
      error: res.error,
      file: relative(ctx.cwd, mod.jsFile) || basename(mod.jsFile),
      issues: (res.issues || []).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  for (const row of rows)
    if (row.error && ROOT_TRAP.test(row.error)) {
      row.skip = true;
      row.error = undefined;
    }
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  const logs: LogIssue[] = [];
  for (const row of rows) {
    if (row.skip) {
      out.skipped++;
      continue;
    }
    if (row.error) {
      out.failures++;
      logs.push({
        level: 'ERROR',
        ref: { file: row.file, issue: 'failed to import ' + row.error, sym: 'import' },
      });
      continue;
    }
    if (!row.issues.length) {
      out.passed++;
      continue;
    }
    for (const item of row.issues) {
      out.failures++;
      logs.push({
        level: 'ERROR',
        ref: { file: row.file, issue: issueKind(item.issue, 'mutate'), sym: item.name },
      });
    }
  }
  for (const line of groupIssues('mutate', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('Mutate check found issues');
  }
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
