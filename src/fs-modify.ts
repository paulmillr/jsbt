// Only shipped place allowed to run `npm install`, write temp files, or delete them.
// JSBT_LOG_LEVEL: 0 = silent, 1 = delete logs, 2 = write + delete logs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const LOG_LEVEL = +(process.env.JSBT_LOG_LEVEL || 1);
const EXTS = ['.cjs', '.js', '.mjs', '.ts'];
const PREFIXES = ['.__readme-check-', '.__jsdoc-check-', '_tree_shaking_'];
const err = (msg: string): never => {
  throw new Error(msg);
};
const inBuild = (path: string): boolean =>
  path.endsWith('/test/build') || path.includes('/test/build/');
export const assertAllowed = (file: string): string => {
  if (!isAbsolute(file)) err(`expected absolute path: ${file}`);
  if (!inBuild(file)) err(`expected test/build path: ${file}`);
  const name = basename(file);
  if (!EXTS.some((ext) => name.endsWith(ext))) err(`refusing unexpected extension: ${file}`);
  if (!PREFIXES.some((prefix) => name.startsWith(prefix)))
    err(`refusing unexpected prefix: ${file}`);
  return file;
};
export const write = (file: string, data: string | Uint8Array): string => (
  mkdirSync(dirname(assertAllowed(file)), { recursive: true }),
  writeFileSync(file, data),
  LOG_LEVEL > 1 && console.log(`write\t${file}`),
  file
);
export const rm = (file: string): boolean => (
  rmSync(assertAllowed(file), { force: true }),
  LOG_LEVEL > 0 && console.log(`delete\t${file}`),
  true
);
export const npmInstall = (dir: string): void => {
  if (!isAbsolute(dir)) err(`expected absolute path: ${dir}`);
  if (!inBuild(dir)) err(`expected test/build path: ${dir}`);
  if (LOG_LEVEL > 0) console.log(`> cd ${dir}`);
  if (LOG_LEVEL > 0) console.log('> npm install');
  execFileSync('npm', ['install'], { cwd: dir, stdio: 'inherit' });
};
export const sweep = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  if (!isAbsolute(dir)) err(`expected absolute path: ${dir}`);
  if (!inBuild(dir)) err(`expected test/build path: ${dir}`);
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const ent of readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const file = join(cur, ent.name);
      if (ent.isDirectory()) walk(file);
      else if (
        EXTS.some((ext) => ent.name.endsWith(ext)) &&
        PREFIXES.some((prefix) => ent.name.startsWith(prefix))
      )
        out.push(file);
    }
  };
  walk(dir);
  for (const file of out) rm(file);
  return out;
};
