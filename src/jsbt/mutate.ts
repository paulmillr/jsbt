#!/usr/bin/env -S node
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
import { publicCtx, publicRows, type PublicRow } from './public.ts';
import {
  cliArgs,
  emptyResult,
  fileUrl,
  recordIssue,
  reportIssues,
  runSelf,
  runWorker,
  skipRootImportTrap,
  usageText,
  type Issue as LogIssue,
} from './utils.ts';

type Probe = { error?: string; issues?: { issue: string; name: string }[] };
type Row = PublicRow<{
  error?: string;
  issues: { issue: string; name: string }[];
  skip?: boolean;
}>;

const usage = usageText('mutate', 'check-mutate.ts');

const WORKER = `import { parentPort, workerData } from 'node:worker_threads';
const isIgnored = (value) =>
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
const isTarget = (value) => value !== null && typeof value === 'object' && !isIgnored(value);
const trySet = (value, key, next, restore) => {
  try {
    value[key] = next;
    if (value[key] === next) {
      restore();
      return true;
    }
  } catch {}
  return false;
};
const tryAdd = (value) => {
  const key = Symbol('jsbt_mutate');
  return trySet(value, key, true, () => delete value[key]);
};
const tryWrite = (value) => {
  const mark = Symbol('jsbt_mutate_value');
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || !desc.writable) continue;
    const prev = value[key];
    if (trySet(value, key, mark, () => (value[key] = prev))) return true;
  }
  return false;
};
const mutable = (value) => {
  if (!isTarget(value) || Object.isFrozen(value)) return false;
  return tryAdd(value) || tryWrite(value) || !Object.isFrozen(value);
};
const propPath = (base, value, key) => {
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
    scan(propPath(name, value, key), desc.value, issues, seen);
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

const probe = (jsFile: string): Promise<Probe> =>
  runWorker<Probe>(WORKER, {
    data: { spec: fileUrl(jsFile) },
    error: (error) => ({ error }),
  });

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const ctx = publicCtx(args.pkgArg, opts.cwd);
  const rows: Row[] = await publicRows(ctx, async (mod) => {
    const res = await probe(mod.jsFile);
    return {
      error: res.error,
      issues: (res.issues || []).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
  for (const row of rows) skipRootImportTrap(row);
  const out = emptyResult();
  const logs: LogIssue[] = [];
  for (const row of rows) {
    if (row.skip) {
      out.skipped++;
      continue;
    }
    if (row.error) {
      recordIssue(out, logs, 'error', row.file, 'import', 'failed to import ' + row.error);
      continue;
    }
    if (!row.issues.length) {
      out.passed++;
      continue;
    }
    for (const item of row.issues) {
      recordIssue(out, logs, 'error', row.file, item.name, item.issue, 'mutate');
    }
  }
  reportIssues('mutate', logs, out, colorOn, 'Mutate check found issues');
};

runSelf(import.meta.url, runCli);
