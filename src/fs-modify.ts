// Only shipped place allowed to run `npm install`, write temp files, or delete them.
// Mutations outside the OS temp directory are always logged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const EXTS = ['.cjs', '.js', '.mjs', '.ts'];
const PREFIXES = ['.__errors-check-', '.__readme-check-', '.__jsdoc-check-', '_tree_shaking_'];
const BUNDLE_PREFIX = 'jsbt-bundle-';
const err = (msg: string): never => {
  throw new Error(msg);
};
const inOsTmpDir = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  const rel = relative(tmpdir(), path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const shouldLog = (path: string): boolean => !inOsTmpDir(path);
const inBuild = (path: string): boolean =>
  path.endsWith('/test/build') || path.includes('/test/build/');
const inBundleTmp = (path: string): boolean => {
  if (!inOsTmpDir(path)) return false;
  const rel = relative(tmpdir(), path);
  return (rel.split(/[\\/]/)[0] || '').startsWith(BUNDLE_PREFIX);
};
const inWorkDir = (path: string): boolean => inBuild(path) || inBundleTmp(path);
export const assertAllowed = (file: string): string => {
  if (!isAbsolute(file)) err(`expected absolute path: ${file}`);
  if (!inWorkDir(file)) err(`expected test/build or jsbt bundle temp path: ${file}`);
  const name = basename(file);
  if (!EXTS.some((ext) => name.endsWith(ext))) err(`refusing unexpected extension: ${file}`);
  if (!PREFIXES.some((prefix) => name.startsWith(prefix)))
    err(`refusing unexpected prefix: ${file}`);
  return file;
};
export const write = (file: string, data: string | Uint8Array): string => (
  mkdirSync(dirname(assertAllowed(file)), { recursive: true }),
  writeFileSync(file, data),
  shouldLog(file) && console.log(`write\t${file}`),
  file
);
export const writePkg = (file: string, data: string | Uint8Array): string => {
  if (!isAbsolute(file)) err(`expected absolute path: ${file}`);
  if (basename(file) !== 'package.json') err(`expected package.json path: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  if (shouldLog(file)) console.log(`write\t${file}`);
  return file;
};
export const writeBundleInput = (file: string, data: string | Uint8Array): string => {
  if (!isAbsolute(file)) err(`expected absolute path: ${file}`);
  if (!inWorkDir(file)) err(`expected test/build or jsbt bundle temp path: ${file}`);
  if (basename(file) !== 'input.js') err(`expected input.js path: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  if (shouldLog(file)) console.log(`write\t${file}`);
  return file;
};
export const rm = (file: string): boolean => (
  rmSync(assertAllowed(file), { force: true }),
  shouldLog(file) && console.log(`delete\t${file}`),
  true
);
export const npmInstall = (dir: string): void => {
  if (!isAbsolute(dir)) err(`expected absolute path: ${dir}`);
  if (!inWorkDir(dir)) err(`expected test/build or jsbt bundle temp path: ${dir}`);
  const log = shouldLog(dir);
  if (log) console.log(`install\t${dir}`);
  execFileSync('npm', ['install'], {
    cwd: dir,
    stdio: log ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
};
export const sweep = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  if (!isAbsolute(dir)) err(`expected absolute path: ${dir}`);
  if (!inWorkDir(dir)) err(`expected test/build or jsbt bundle temp path: ${dir}`);
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
      ) {
        out.push(file);
      }
    }
  };
  walk(dir);
  for (const file of out) rm(file);
  return out;
};
export const sweepTemps = (cwd: string): void => {
  sweep(cwd);
};
export const bundleTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), BUNDLE_PREFIX));
  if (shouldLog(dir)) console.log(`mkdir\t${dir}`);
  return dir;
};
export const rmBundleTempDir = (dir: string): boolean => {
  if (!isAbsolute(dir)) err(`expected absolute path: ${dir}`);
  if (!inBundleTmp(dir)) err(`expected jsbt bundle temp path: ${dir}`);
  rmSync(dir, { force: true, recursive: true });
  if (shouldLog(dir)) console.log(`delete\t${dir}`);
  return true;
};
export const __TEST: {
  inOsTmpDir: (path: string) => boolean;
  shouldLogPath: (path: string) => boolean;
} = {
  inOsTmpDir: inOsTmpDir,
  shouldLogPath: shouldLog,
};
