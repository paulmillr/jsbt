#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`.
Do not call raw fs delete/write helpers or raw `npm install` directly here.

`check-install` rewrites package.json check scripts to the current `jsbt` layout.
It owns the `check` / `check:*` block so repos can pick up new checks without hand editing scripts.
 */
import { writePkg } from '../fs-modify.ts';
import { pkgArgs, pkgTarget, readText, runSelf, usageText } from './utils.ts';

type RawPkg = Record<string, unknown> & { scripts?: Record<string, unknown> };

const usage = usageText('check-install', 'jsbt/check-install.ts');
const CHECK_MAIN = 'npx --no @paulmillr/jsbt check';
const CHECK_MAIN_OLD = 'npx --no @paulmillr/jsbt check package.json';
const LEGACY_MAIN = 'npm run check:readme && npm run check:treeshake && npm run check:jsdoc';

const isCheck = (key: string) => key === 'check' || key.startsWith('check:');
const checkPrefix = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  for (const tail of [CHECK_MAIN, CHECK_MAIN_OLD, LEGACY_MAIN])
    if (value.endsWith(tail)) return value.slice(0, -tail.length);
  return '';
};
const insertCheck = (out: Record<string, unknown>, prefix = '') => {
  // Selectors replaced per-check scripts, so stale aliases are removed here.
  out.check = `${prefix}${CHECK_MAIN}`;
};
const patchScripts = (scripts: Record<string, unknown> | undefined) => {
  const entries = Object.entries(scripts || {});
  const out: Record<string, unknown> = {};
  let inserted = false;
  let seen = false;
  for (const [key, value] of entries) {
    if (isCheck(key)) {
      seen = true;
      if (!inserted) {
        insertCheck(out, key === 'check' ? checkPrefix(value) : '');
        inserted = true;
      }
      continue;
    }
    out[key] = value;
  }
  if (seen) return out;
  const next: Record<string, unknown> = {};
  const lastBuild = entries.reduce((pos, [key], i) => (key.startsWith('build') ? i : pos), -1);
  for (const [i, [key, value]] of entries.entries()) {
    next[key] = value;
    if (i === lastBuild) insertCheck(next);
  }
  if (lastBuild < 0) insertCheck(next);
  return next;
};
const patchPkg = (raw: RawPkg): RawPkg => {
  const out: RawPkg = {};
  let seen = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'scripts') {
      out.scripts = patchScripts(value as Record<string, unknown>);
      seen = true;
      continue;
    }
    out[key] = value;
  }
  if (!seen) out.scripts = patchScripts(undefined);
  return out;
};

export const runCli = async (argv: string[], opts: { cwd?: string } = {}): Promise<void> => {
  const args = pkgArgs(argv);
  if (args.help) return console.log(usage);
  const { pkgFile } = pkgTarget(args.pkgArg, opts.cwd);
  const text = readText(pkgFile);
  const next = `${JSON.stringify(patchPkg(JSON.parse(text) as RawPkg), undefined, 2)}\n`;
  if (text === next) return;
  writePkg(pkgFile, next);
};

runSelf(import.meta.url, runCli);
