// Only shipped place allowed to write temp files, assemble run-dir node_modules, or delete
// them. Mutations outside the OS temp directory are always logged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const EXTS = ['.cjs', '.js', '.mjs', '.ts'];
const PREFIXES = ['.__errors-check-', '.__readme-check-', '.__jsdoc-check-', '_tree_shaking_'];
const CHECK_PREFIX = 'jsbt-check-';
const BARE_PKG_NAME = /^(@[\w.-]+\/)?[\w.-]+$/;
const err = (msg: string): never => {
  throw new Error(msg);
};
const inOsTmpDir = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  const rel = relative(tmpdir(), path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const shouldLog = (path: string): boolean => !inOsTmpDir(path);
const inCheckTmp = (path: string): boolean => {
  if (!inOsTmpDir(path)) return false;
  const rel = relative(tmpdir(), path);
  return (rel.split(/[\\/]/)[0] || '').startsWith(CHECK_PREFIX);
};
export const assertTemp = (path: string): string => {
  if (!isAbsolute(path)) err(`expected absolute path: ${path}`);
  if (!inCheckTmp(path)) err(`expected jsbt temp path: ${path}`);
  return path;
};
export const assertAllowed = (file: string): string => {
  assertTemp(file);
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
export const rm = (file: string): boolean => (
  rmSync(assertAllowed(file), { force: true }),
  shouldLog(file) && console.log(`delete\t${file}`),
  true
);
// Global npm roots are probed once per process; the global install is user-managed
// (`npm install -g esbuild`), jsbt never installs anything itself. `npm root -g` output
// alone is not trusted blindly (npm redacts UUID-like path segments), so prefix-derived
// candidates are checked too; each candidate is verified with existsSync.
let globalRootCache: string[] | undefined;
const npmGlobalRoots = (): string[] => {
  if (globalRootCache) return globalRootCache;
  const roots: string[] = [];
  const addPrefix = (prefix?: string) => {
    if (prefix) roots.push(join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules'));
  };
  addPrefix(process.env.npm_config_prefix);
  try {
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) roots.push(out);
  } catch {}
  // npm's default global prefix derives from the running node binary.
  addPrefix(dirname(dirname(process.execPath)));
  return (globalRootCache = roots);
};
const globalEsbuildDir = (): string | undefined => {
  for (const root of npmGlobalRoots()) {
    const dir = join(root, 'esbuild');
    if (existsSync(dir)) return dir;
  }
  return undefined;
};
// `esbuild` is provided automatically: examples and treeshake never declare it. Prefer
// the checked project's own install, then the copy resolvable next to jsbt itself, then
// a global `npm install -g esbuild`.
const esbuildDir = (cwd: string): string | undefined => {
  const local = join(cwd, 'node_modules', 'esbuild');
  if (existsSync(local)) return local;
  try {
    return dirname(createRequire(import.meta.url).resolve('esbuild/package.json'));
  } catch {
    return globalEsbuildDir();
  }
};
const linkDep = (target: string, link: string): void => {
  // Shared run dirs are re-prepared by every checker; the first symlink wins.
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, 'dir');
};
// Assembles the isolated run dir: a manifest plus node_modules symlinked from the
// project's own installed deps. Nothing is fetched — the import surface is fixed by
// reviewed committed files (package.json dependencies and .jsbtrc.json), never by
// example content.
export const installRunDeps = (cwd: string, name: string, dir: string, deps: string[]): void => {
  assertTemp(dir);
  if (!isAbsolute(cwd)) err(`expected absolute path: ${cwd}`);
  if (!BARE_PKG_NAME.test(name)) err(`invalid package name: ${name}`);
  mkdirSync(dir, { recursive: true });
  const manifest = { dependencies: { [name]: `file:${cwd}` }, private: true, type: 'module' };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const nodeModules = join(dir, 'node_modules');
  linkDep(cwd, join(nodeModules, name));
  for (const dep of deps) {
    if (!BARE_PKG_NAME.test(dep)) err(`invalid dependency name: ${dep}`);
    linkDep(join(cwd, 'node_modules', dep), join(nodeModules, dep));
  }
  const esbuild = esbuildDir(cwd);
  if (esbuild) linkDep(esbuild, join(nodeModules, 'esbuild'));
};
export const checkTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), CHECK_PREFIX));
  if (shouldLog(dir)) console.log(`mkdir\t${dir}`);
  return dir;
};
export const rmCheckTempDir = (dir: string): boolean => {
  if (!isAbsolute(dir)) err(`expected absolute path: ${dir}`);
  if (!inCheckTmp(dir)) err(`expected jsbt check temp path: ${dir}`);
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
