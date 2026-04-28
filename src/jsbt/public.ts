import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type RawPkg = {
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  name?: unknown;
  types?: unknown;
};
export type Pkg = { exports: Record<string, unknown>; name: string; types: string };
export type PublicMod = { dtsFile: string; jsFile: string; key: string; spec: string };

const err = (msg: string): never => {
  throw new Error(msg);
};
export const readPkg = (pkgFile: string): Pkg => {
  const raw = JSON.parse(readFileSync(pkgFile, 'utf8')) as RawPkg;
  if (typeof raw.name !== 'string' || !raw.name) err(`missing name in ${pkgFile}`);
  let exports = raw.exports;
  if (!exports || typeof exports !== 'object') {
    const entry =
      typeof raw.module === 'string' ? raw.module : typeof raw.main === 'string' ? raw.main : '';
    if (!entry) err(`missing exports or main/module entry in ${pkgFile}`);
    exports = { '.': entry };
  }
  return {
    exports: exports as Record<string, unknown>,
    name: raw.name as string,
    types: typeof raw.types === 'string' ? raw.types : '',
  };
};
export const jsPathOf = (value: unknown): string => {
  if (typeof value === 'string') return /\.(?:c|m)?js$/.test(value) ? value : '';
  if (!value || typeof value !== 'object') return '';
  for (const key of ['default', 'import', 'node', 'require']) {
    const res = jsPathOf((value as Record<string, unknown>)[key]);
    if (res) return res;
  }
  for (const entry of Object.values(value)) {
    const res = jsPathOf(entry);
    if (res) return res;
  }
  return '';
};
export const dtsPathOf = (value: unknown): string => {
  if (typeof value === 'string') {
    if (/\.d\.(?:c|m)?ts$/.test(value)) return value;
    return /\.(?:c|m)?js$/.test(value) ? value.replace(/\.(?:c|m)?js$/, '.d.ts') : '';
  }
  if (!value || typeof value !== 'object') return '';
  const types = (value as Record<string, unknown>).types;
  if (typeof types === 'string') return types;
  for (const key of ['default', 'import', 'node', 'require']) {
    const res = dtsPathOf((value as Record<string, unknown>)[key]);
    if (res) return res;
  }
  for (const entry of Object.values(value)) {
    const res = dtsPathOf(entry);
    if (res) return res;
  }
  return '';
};
const exportSpec = (pkg: Pkg, key: string) =>
  key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
export const listModules = (ctx: { cwd: string; pkg: Pkg; pkgFile: string }): PublicMod[] => {
  const mods: PublicMod[] = [];
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    if (!key.startsWith('.')) continue;
    const jsRel = jsPathOf(value);
    if (!jsRel) continue;
    const dtsRel =
      key === '.' && ctx.pkg.types
        ? ctx.pkg.types
        : dtsPathOf(value) || jsRel.replace(/\.(?:c|m)?js$/, '.d.ts');
    const jsFile = resolve(ctx.cwd, jsRel);
    const dtsFile = resolve(ctx.cwd, dtsRel);
    if (!existsSync(jsFile)) err(`missing public JS entry ${jsRel} for ${key} in ${ctx.pkgFile}`);
    if (!existsSync(dtsFile))
      err(`missing public declaration file ${dtsRel} for ${key} in ${ctx.pkgFile}`);
    mods.push({ dtsFile, jsFile, key, spec: exportSpec(ctx.pkg, key) });
  }
  if (!mods.length) err(`no public modules found in ${ctx.pkgFile}`);
  return mods.sort((a, b) => a.key.localeCompare(b.key));
};
