// The only shipped place allowed to mutate the filesystem or run `npm install`.
// Every mutation happens inside a `jsbt-*` OS temp dir, assembled here — mostly via
// symlinks; npm runs only on a cold esbuild cache. jsbt never writes into user repos.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const EXTS = ['.cjs', '.js', '.json', '.mjs', '.ts'];
// Never lifecycle scripts or lockfiles: installs land in throwaway jsbt temp dirs.
const NPM_INSTALL_ARGS = [
  'install',
  '--prefer-offline',
  '--ignore-scripts',
  '--no-package-lock',
] as const;
// Kept in sync with the esbuild devDependency of @paulmillr/jsbt.
const RUN_ESBUILD_SPEC = '^0.28.1';

const err = (msg: string): never => {
  throw new Error(msg);
};
const inJsbtTmp = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  const rel = relative(tmpdir(), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return (rel.split(/[\\/]/)[0] || '').startsWith('jsbt-');
};
export const assertTemp = (path: string, checkExt = false): string => {
  if (!isAbsolute(path)) err(`expected absolute path: ${path}`);
  if (!inJsbtTmp(path)) err(`expected jsbt temp path: ${path}`);
  if (checkExt && !EXTS.some((ext) => basename(path).endsWith(ext)))
    err(`refusing unexpected extension: ${path}`);
  return path;
};

export type TempKind = 'bundle' | 'check' | 'size';
export const tempDir = (kind: TempKind): string => mkdtempSync(join(tmpdir(), `jsbt-${kind}-`));
export const rmTempDir = (dir: string): boolean => (
  rmSync(assertTemp(dir), { force: true, recursive: true }),
  true
);

export const write = (file: string, data: string | Uint8Array): string => (
  mkdirSync(dirname(assertTemp(file, true)), { recursive: true }),
  writeFileSync(file, data),
  file
);
export const writePkg = (file: string, data: string | Uint8Array): string => {
  if (basename(file) !== 'package.json') err(`expected package.json path: ${file}`);
  mkdirSync(dirname(assertTemp(file)), { recursive: true });
  writeFileSync(file, data);
  return file;
};
export const rm = (file: string): boolean => (
  rmSync(assertTemp(file, true), { force: true }),
  true
);

export const npmInstall = (dir: string): void => {
  assertTemp(dir);
  try {
    // --loglevel=error beats the quiet npm_config_loglevel env, so failures stay explained.
    execFileSync('npm', [...NPM_INSTALL_ARGS, '--loglevel=error'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '').trim();
    err(`npm install failed${stderr ? `:\n${stderr}` : ''}`);
  }
};

// Creates a directory symlink inside a jsbt temp dir; existing links are left alone.
const linkDir = (target: string, linkPath: string): void => {
  assertTemp(linkPath);
  if (existsSync(linkPath)) return;
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};
// One esbuild install per machine and pinned version, primed by npm on first use.
export const esbuildCacheModules = (): string => {
  const dir = join(tmpdir(), `jsbt-esbuild-${RUN_ESBUILD_SPEC.replace(/[^\w.]+/g, '')}`);
  const modules = join(dir, 'node_modules');
  if (existsSync(join(modules, 'esbuild'))) return modules;
  writePkg(
    join(dir, 'package.json'),
    `${JSON.stringify({ dependencies: { esbuild: RUN_ESBUILD_SPEC }, private: true }, null, 2)}\n`
  );
  try {
    npmInstall(dir);
  } catch (error) {
    // A concurrent prime may have won the race; only fail when esbuild is truly absent.
    if (!existsSync(join(modules, 'esbuild'))) throw error;
  }
  return modules;
};
// Assembles the run dir's node_modules via symlinks (matching how npm links `file:`
// deps), so the hot path never spawns npm. Falls back to a real install on any failure.
export const installRunDeps = (cwd: string, name: string, dir: string): void => {
  writePkg(
    join(assertTemp(dir), 'package.json'),
    `${JSON.stringify(
      {
        dependencies: { [name]: `file:${cwd}`, esbuild: RUN_ESBUILD_SPEC },
        private: true,
        type: 'module',
      },
      null,
      2
    )}\n`
  );
  const modules = join(dir, 'node_modules');
  if (existsSync(join(modules, name)) && existsSync(join(modules, 'esbuild'))) return;
  try {
    const cache = esbuildCacheModules();
    linkDir(cwd, join(modules, name));
    linkDir(join(cache, 'esbuild'), join(modules, 'esbuild'));
    const scoped = join(cache, '@esbuild');
    if (existsSync(scoped))
      for (const ent of readdirSync(scoped))
        linkDir(join(scoped, ent), join(modules, '@esbuild', ent));
  } catch {
    npmInstall(dir);
  }
};

export const __TEST: {
  inJsbtTmp: (path: string) => boolean;
  npmInstallArgs: () => string[];
} = {
  inJsbtTmp: inJsbtTmp,
  npmInstallArgs: () => [...NPM_INSTALL_ARGS],
};
