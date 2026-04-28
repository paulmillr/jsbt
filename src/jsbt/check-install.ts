#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

`check-install` rewrites package.json check scripts to the current `jsbt` layout.
It owns the `check` / `check:*` block so repos can pick up new checks without hand editing scripts.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePkg } from '../fs-modify.ts';
import { bundled, guardChild } from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type RawPkg = Record<string, unknown> & { scripts?: Record<string, unknown> };

const usage = `usage:
  jsbt check-install <package.json>

examples:
  jsbt check-install package.json
  node /path/to/jsbt/check-install.ts package.json`;
const CHECK_MAIN = 'npx --no @paulmillr/jsbt check package.json';
const LEGACY_MAIN = 'npm run check:readme && npm run check:treeshake && npm run check:jsdoc';
const CHECK = [
  ['check', CHECK_MAIN],
  ['check:install', 'npx --no @paulmillr/jsbt check-install package.json'],
  ['check:readme', 'npx --no @paulmillr/jsbt readme package.json'],
  ['check:treeshake', 'npx --no @paulmillr/jsbt treeshake package.json test/build/out-treeshake'],
  ['check:jsdoc', 'npx --no @paulmillr/jsbt tsdoc package.json'],
  ['check:comments', 'npx --no @paulmillr/jsbt comments package.json'],
  ['check:errors', 'npx --no @paulmillr/jsbt errors package.json'],
  ['check:bigint', 'npx --no @paulmillr/jsbt bigint package.json'],
  ['check:bytes', 'npx --no @paulmillr/jsbt bytes package.json'],
  ['check:mutate', 'npx --no @paulmillr/jsbt mutate package.json'],
  ['check:tests', 'npx --no @paulmillr/jsbt tests package.json'],
  ['check:importtime', 'npx --no @paulmillr/jsbt importtime package.json'],
  ['check:typeimport', 'npx --no @paulmillr/jsbt typeimport package.json'],
  ['check:jsr', 'npx --no @paulmillr/jsbt jsr package.json'],
  ['check:jsrpublish', 'npx --no @paulmillr/jsbt jsrpublish package.json'],
] as const;

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const isCheck = (key: string) => key === 'check' || key.startsWith('check:');
const checkPrefix = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  for (const tail of [CHECK_MAIN, LEGACY_MAIN]) if (value.endsWith(tail)) return value.slice(0, -tail.length);
  return '';
};
const insertCheck = (out: Record<string, unknown>, prefix = '') => {
  out.check = `${prefix}${CHECK_MAIN}`;
  for (const [key, value] of CHECK.slice(1)) out[key] = value;
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
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const cwd = resolve(opts.cwd || process.cwd());
  const pkgFile = resolve(cwd, args.pkgArg);
  guardChild(cwd, pkgFile, 'package');
  const text = readFileSync(pkgFile, 'utf8');
  const next = `${JSON.stringify(patchPkg(JSON.parse(text) as RawPkg), undefined, 2)}\n`;
  if (text === next) return;
  writePkg(pkgFile, next);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
