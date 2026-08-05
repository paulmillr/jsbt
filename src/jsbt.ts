#!/usr/bin/env node
/**
The `jsbt` binary: single-file bundles (`jsbt bundle`) and size stats (`jsbt size`),
plus the package/module helpers shared with `jsbt-check`. Minimal by design: no audits,
no budgets, no test/build integration — see `jsbt-check` for those. Writes only into
jsbt temp dirs. Destructive ops and `npm install` go through `fs-modify.ts` only.
@module
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { color, csvEnabled, csvRow, paint, wantColor } from './env.ts';
import {
  esbuildCacheModules,
  npmInstall,
  rmTempDir,
  tempDir,
  write,
  writePkg,
} from './fs-modify.ts';

export { color, csvEnabled, csvRow, paint, wantColor };

declare const __JSBT_BUNDLE__: boolean | undefined;
// Which binary this file was bundled into; both bins bundle jsbt.ts.
declare const __JSBT_BIN__: string | undefined;
export type PkgTarget = { cwd: string; pkgFile: string };
export type TsSourceApi<T> = {
  ScriptTarget: { ESNext: unknown };
  // TypeScript exposes a narrower ScriptTarget parameter; any keeps typeof ts assignable.
  createSourceFile: (file: string, text: string, target: any, setParents?: boolean) => T;
};
export type LocalImportOpts = {
  accept: (file: string) => boolean;
  exts?: readonly string[];
  indexExts?: readonly string[];
  jsToTs?: boolean;
};

const TS_IMPORT_EXTS = ['.ts', '.mts', '.cts', '.tsx'];
export const err = (msg: string): never => {
  throw new Error(msg);
};
export const camelParts = (parts: string[]): string =>
  parts.map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part)).join('');
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const ident = (name: string): boolean => !!name.length && IDENT.test(name);
export const kb = (bytes: number): string => (bytes / 1024).toFixed(2);
export const readText = (file: string): string => readFileSync(file, 'utf8');
export const readJson = <T>(file: string): T => JSON.parse(readText(file)) as T;
let sourceFileCaches = new WeakMap<
  object,
  Map<string, { parents: boolean; source: unknown; target: unknown; text: string }>
>();
let sourceFileCacheDepth = 0;
export const withSourceFileCache = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  sourceFileCacheDepth += 1;
  try {
    return await fn();
  } finally {
    sourceFileCacheDepth -= 1;
    if (sourceFileCacheDepth === 0) sourceFileCaches = new WeakMap();
  }
};
export const createCachedSourceFile = <T>(
  ts: TsSourceApi<T>,
  file: string,
  text: string,
  target: unknown = ts.ScriptTarget.ESNext,
  setParents = true
): T => {
  if (sourceFileCacheDepth <= 0) return ts.createSourceFile(file, text, target, setParents);
  const key = `${resolve(file)}\0${String(target)}\0${setParents ? '1' : '0'}`;
  let cache = sourceFileCaches.get(ts as object);
  if (!cache) {
    cache = new Map();
    sourceFileCaches.set(ts as object, cache);
  }
  const prev = cache.get(key);
  if (prev && prev.text === text && prev.target === target && prev.parents === setParents)
    return prev.source as T;
  const source = ts.createSourceFile(file, text, target, setParents);
  cache.set(key, { parents: setParents, source, target, text });
  return source;
};
export const readSource = <T>(ts: TsSourceApi<T>, file: string): { source: T; text: string } => {
  const text = readText(file);
  return { source: createCachedSourceFile(ts, file, text), text };
};
export const relName = (cwd: string, file: string): string => relative(cwd, file) || basename(file);
export const nodeText = (node: any): string => (typeof node?.text === 'string' ? node.text : '');
const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;
export const runSelf = (metaUrl: string, fn: (argv: string[]) => Promise<void>): void => {
  const entry = process.argv[1];
  const self = fileURLToPath(metaUrl);
  if (bundled() || !entry || realpathSync(resolve(entry)) !== realpathSync(self)) return;
  void (async () => {
    try {
      await fn(process.argv.slice(2));
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    }
  })();
};
export const loadNear = <T>(
  pkgFile: string,
  name: string,
  api: string,
  check: (mod: T) => boolean
): T => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req(name) as T | { default?: T };
    } catch {
      throw new Error(`missing ${name} near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const mod = raw && typeof raw === 'object' && 'default' in raw && raw.default ? raw.default : raw;
  if (!check(mod as T)) throw new Error(`expected ${api} near ${pkgFile}`);
  return mod as T;
};
const hasFns = (mod: unknown, keys: readonly string[]): boolean =>
  !!mod &&
  typeof mod === 'object' &&
  keys.every((key) => typeof (mod as Record<string, unknown>)[key] === 'function');
export const loadModuleApi = <T>(
  pkgFile: string,
  name: string,
  api: string,
  keys: readonly string[]
): T => loadNear<T>(pkgFile, name, api, (mod) => hasFns(mod, keys));
export const loadTypeScriptApi = <T>(pkgFile: string, api: string, keys: readonly string[]): T =>
  loadModuleApi<T>(pkgFile, 'typescript', api, keys);

// Error-message grammar: `<problem>: <offender>; <hint>` — the offending user input is
// painted red, and listings of valid choices are one selector per line via listLines.
export const bad = (text: string): string => paint(text, color.red, wantColor());
// Selector painting: package part (npm ref label or scoped package name) violet,
// module yellow, export blue; slashes stay uncolored. One rule for --list output,
// error listings, and human-mode size lines.
// `leaf` marks what the final segment is: single-file packages put exports right
// after the package (`npm:pkg/Point`), which position alone cannot distinguish
// from a module. Default 'auto' infers: two+ segments after the package = export.
export type IdLeaf = 'auto' | 'export' | 'module';
export const paintId = (id: string, on: boolean = wantColor(), leaf: IdLeaf = 'auto'): string => {
  if (!on) return id;
  const pre = id.startsWith('npm:') ? 'npm:' : '';
  const segs = id.slice(pre.length).split('/');
  const scoped = segs[0].startsWith('@') && segs.length > 1;
  // An npm: prefix always names a package first; bare ids only when name@version-like.
  const pkgCount = scoped ? 2 : pre || segs[0].includes('@') ? 1 : 0;
  const parts: string[] = [];
  if (pkgCount) parts.push(paint(segs.slice(0, pkgCount).join('/'), color.violet));
  const rest = segs.slice(pkgCount);
  const blueLeaf = leaf === 'export' || (leaf === 'auto' && rest.length > 1);
  for (const [idx, seg] of rest.entries())
    parts.push(paint(seg, blueLeaf && idx === rest.length - 1 ? color.blue : color.yellow));
  return pre + parts.join('/');
};
export const listLines = (ids: Iterable<string>, leaf: IdLeaf = 'auto'): string =>
  [...ids].map((id) => paintId(id, wantColor(), leaf)).join('\n');
export const sorted = (items: Iterable<string>): string[] => [...items].sort();
export const guardChild = (cwd: string, file: string, label: string): void => {
  const rel = relative(cwd, file);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
export const pkgTarget = (pkgArg: string, cwd: string = process.cwd()): PkgTarget => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, pkgArg);
  guardChild(base, pkgFile, 'package');
  return { cwd: base, pkgFile };
};
export const resolveLocalImport = (
  from: string,
  spec: string,
  opts: LocalImportOpts
): string | undefined => {
  if (!spec.startsWith('.')) return;
  const raw = resolve(dirname(from), spec);
  const exts = opts.exts || TS_IMPORT_EXTS;
  const indexExts = opts.indexExts || exts;
  const tries = [
    raw,
    ...exts.map((ext) => `${raw}${ext}`),
    ...indexExts.map((ext) => join(raw, `index${ext}`)),
  ];
  if (opts.jsToTs !== false && /\.[cm]?js$/.test(raw)) {
    tries.push(
      raw.replace(/\.js$/, '.ts'),
      raw.replace(/\.js$/, '.mts'),
      raw.replace(/\.js$/, '.cts'),
      raw.replace(/\.mjs$/, '.mts'),
      raw.replace(/\.cjs$/, '.cts')
    );
  }
  for (const file of tries) if (opts.accept(file)) return file;
  return;
};

type RawPkg = {
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  name?: unknown;
  types?: unknown;
  version?: unknown;
};
export type Pkg = {
  exports: Record<string, unknown>;
  name: string;
  self: boolean;
  types: string;
  version: string;
};
export type PublicCtx = { cwd: string; pkg: Pkg; pkgFile: string };
export type PublicEntry = { jsRel: string; key: string; spec: string; value: unknown };
export type PublicMod = { dtsFile: string; jsFile: string; key: string; spec: string };
export type PublicRow<T extends object = {}> = PublicMod & { file: string } & T;

export const readPkg = (pkgFile: string): Pkg => {
  const raw = ((): RawPkg => {
    try {
      return readJson<RawPkg>(pkgFile);
    } catch (error) {
      // Raw ENOENT/SyntaxError leaks read poorly; say what is wrong and where.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return err(`missing package.json in ${dirname(pkgFile)}`);
      return err(`invalid package.json in ${pkgFile}: ${(error as Error).message}`);
    }
  })();
  if (typeof raw.name !== 'string' || !raw.name) err(`missing name in ${pkgFile}`);
  let exports = raw.exports;
  let self = true;
  // `exports: "./index.js"` is valid sugar for `{".": "./index.js"}`.
  if (typeof exports === 'string') exports = { '.': exports };
  // An exports object with no `.`-prefixed keys is a conditions object for the root
  // (e.g. chalk's `{types, default}`); wrap it so consumers see a subpath map.
  if (
    exports &&
    typeof exports === 'object' &&
    !Object.keys(exports).some((k) => k.startsWith('.'))
  )
    exports = { '.': exports };
  if (!exports || typeof exports !== 'object') {
    const entry =
      typeof raw.module === 'string' ? raw.module : typeof raw.main === 'string' ? raw.main : '';
    if (entry) exports = { '.': entry };
    // No entry fields at all: node's legacy resolution defaults to ./index.js (express).
    else if (existsSync(resolve(dirname(pkgFile), 'index.js'))) exports = { '.': './index.js' };
    else err(`missing exports or main/module entry in ${pkgFile}`);
    self = false;
  }
  return {
    exports: exports as Record<string, unknown>,
    name: raw.name as string,
    self,
    types: typeof raw.types === 'string' ? raw.types : '',
    version: typeof raw.version === 'string' ? raw.version : '',
  };
};
// Exported helpers need explicit annotations for isolated declaration emit.
export const publicCtx = (pkgArg: string, cwd: string = process.cwd()): PublicCtx => {
  const { pkgFile } = pkgTarget(pkgArg, cwd);
  const root = dirname(pkgFile);
  return { cwd: root, pkg: readPkg(pkgFile), pkgFile };
};
const EXPORT_KEYS = ['default', 'import', 'node', 'require'];
export const exportPath = (
  value: unknown,
  leaf: (path: string) => string,
  types = false
): string => {
  if (typeof value === 'string') return leaf(value);
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  const typed = obj.types;
  if (types && typeof typed === 'string') return typed;
  for (const key of EXPORT_KEYS) {
    const res = exportPath(obj[key], leaf, types);
    if (res) return res;
  }
  for (const entry of Object.values(obj)) {
    const res = exportPath(entry, leaf, types);
    if (res) return res;
  }
  return '';
};
const JS_EXT = /\.[cm]?js$/;
export const jsPath = (value: unknown): string =>
  exportPath(value, (path) => (JS_EXT.test(path) ? path : ''));
export const dtsPath = (value: unknown): string =>
  exportPath(
    value,
    (path) => {
      if (/\.d\.[cm]?ts$/.test(path)) return path;
      return JS_EXT.test(path) ? path.replace(JS_EXT, '.d.ts') : '';
    },
    true
  );
const publicSpec = (pkg: Pkg, key: string) =>
  key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
export const publicEntries = (ctx: PublicCtx): PublicEntry[] =>
  Object.entries(ctx.pkg.exports)
    .flatMap(([key, value]) => {
      if (!key.startsWith('.')) return [];
      const jsRel = jsPath(value);
      return jsRel ? [{ jsRel, key, spec: publicSpec(ctx.pkg, key), value }] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key));
export const listModules = (ctx: PublicCtx): PublicMod[] => {
  const mods: PublicMod[] = [];
  for (const { jsRel, key, spec, value } of publicEntries(ctx)) {
    const dtsRel =
      key === '.' && ctx.pkg.types
        ? ctx.pkg.types
        : dtsPath(value) || jsRel.replace(JS_EXT, '.d.ts');
    const jsFile = resolve(ctx.cwd, jsRel);
    const dtsFile = resolve(ctx.cwd, dtsRel);
    if (!existsSync(jsFile)) err(`missing public JS entry ${jsRel} for ${key} in ${ctx.pkgFile}`);
    if (!existsSync(dtsFile))
      err(`missing public declaration file ${dtsRel} for ${key} in ${ctx.pkgFile}`);
    mods.push({ dtsFile, jsFile, key, spec });
  }
  if (!mods.length) err(`no public modules found in ${ctx.pkgFile}`);
  return mods;
};
export const publicRows = async <T extends object>(
  ctx: PublicCtx,
  probe: (mod: PublicMod) => Promise<T> | T
): Promise<PublicRow<T>[]> => {
  const rows: PublicRow<T>[] = [];
  for (const mod of listModules(ctx)) {
    rows.push({
      ...mod,
      file: relName(ctx.cwd, mod.jsFile),
      ...(await probe(mod)),
    } as PublicRow<T>);
  }
  return rows;
};

type TsLike = {
  ModuleKind: { ESNext: unknown };
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: Record<string, number>;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => any;
  createProgram: (
    files: string[],
    opts: {
      allowJs: boolean;
      checkJs?: boolean;
      module: unknown;
      noEmit?: boolean;
      noUnusedLocals?: boolean;
      skipLibCheck?: boolean;
      target: unknown;
    }
  ) => {};
  isClassDeclaration: (node: any) => boolean;
  isExportDeclaration: (node: any) => boolean;
  isFunctionDeclaration: (node: any) => boolean;
  isIdentifier: (node: any) => boolean;
  isNamedExports: (node: any) => boolean;
  isNamespaceExport?: (node: any) => boolean;
  isStringLiteral: (node: any) => boolean;
  isVariableStatement: (node: any) => boolean;
  getPreEmitDiagnostics: (prog: unknown) => {
    code: number;
    file?: {
      fileName: string;
      getLineAndCharacterOfPosition: (pos: number) => { character: number; line: number };
      text: string;
    };
    length?: number;
    start?: number;
  }[];
};
type BuildLike = (opts: {
  bundle: true;
  external: string[];
  format: 'iife';
  globalName: string;
  logLevel: 'silent';
  metafile: true;
  minify: boolean;
  platform?: 'node';
  stdin: { contents: string; resolveDir: string; sourcefile: string };
  write: false;
}) => Promise<{
  outputFiles?: { contents: Uint8Array }[];
  warnings?: { location?: { file: string } | null; text: string }[];
}>;
type Ctx = { cwd: string; outDir: string; pkg: Pkg; pkgDir: string; pkgFile: string };
type Mod = {
  dir: string;
  exports: string[];
  file: string;
  key: string;
  module: string;
  spec: string;
};
type Item = {
  absSource?: string;
  dir: string;
  export: string;
  global: string;
  module: string;
  out: string;
  resolveDir?: string;
  // Set when a bare name fell back to a root-module export: on failure the error lists
  // the package's modules, since the name may have meant either a module or an export.
  rootModules?: string[];
  source: string;
};
export type Built = Item & { min: Uint8Array; plain: Uint8Array };
const decoder = new TextDecoder();
const ALL = 'all';
const camel = (s: string) => camelParts(s.split(/[^a-zA-Z0-9]+/).filter(Boolean));
const slug = (s: string): string =>
  s
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const resolveCtx = (cwd: string | undefined, outDir: string): Ctx => {
  const base = resolve(cwd ?? process.cwd());
  if (!isAbsolute(outDir)) err(`expected absolute out dir: ${outDir}`);
  const pkgFile = join(base, 'package.json');
  return { cwd: base, outDir, pkg: readPkg(pkgFile), pkgDir: base, pkgFile };
};
const loadEsbuild = (pkgFile: string): BuildLike =>
  loadModuleApi<{ build?: BuildLike }>(pkgFile, 'esbuild', 'esbuild.build', ['build'])
    .build as BuildLike;
export const loadTs = (pkgFile: string): TsLike =>
  loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript compiler API', ['createProgram']);
// `jsbt size` on projects without a local esbuild falls back to the globally installed
// one (npm root -g); nothing is ever auto-installed. Returns a require anchor one level
// above the global node_modules so module resolution finds packages inside it.
const globalEsbuildPkg = (): string | undefined => {
  // Probe well-known global roots first; `npm root -g` spawns npm (~100ms+), keep it last.
  const prefixes = [process.env.npm_config_prefix, dirname(dirname(process.execPath))];
  for (const prefix of prefixes) {
    if (!prefix) continue;
    for (const root of [join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules')])
      if (existsSync(join(root, 'esbuild'))) return join(dirname(root), 'package.json');
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    if (!root || !existsSync(join(root, 'esbuild'))) return undefined;
    return join(dirname(root), 'package.json');
  } catch {
    return undefined;
  }
};
const loadSizeBuild = (pkgFile: string): BuildLike => {
  try {
    return loadEsbuild(pkgFile);
  } catch (error) {
    if (!/missing esbuild near /.test((error as Error).message)) throw error;
    const globalPkg = globalEsbuildPkg();
    if (globalPkg) return loadEsbuild(globalPkg);
    // Last resort: the machine-level jsbt cache (primed by npm on first-ever use).
    return loadEsbuild(join(dirname(esbuildCacheModules()), 'package.json'));
  }
};
const isPkgAll = (item: Pick<Item, 'dir' | 'out'>) => !item.dir && item.out === ALL;
const itemId = (pkg: Pkg, item: Pick<Item, 'dir' | 'export' | 'module' | 'out'>): string =>
  isPkgAll(item) ? pkg.name : `${item.module}/${item.export || ALL}`;
// The `_tree_shaking_` prefix marks files as jsbt-owned so sweeps of in-repo out dirs
// (jsbt check) can never delete user files. `jsbt size` writes into its own temp dir,
// so it drops the prefix for readable bundle names.
const outPath = (pkg: Pkg, item: Pick<Item, 'dir' | 'out'>, ext: string, prefix = ''): string =>
  isPkgAll(item) ? `${prefix}${slug(pkg.name)}.${ext}` : `${item.dir}/${prefix}${item.out}.${ext}`;
const relSpec = (file: string) => (file.startsWith('.') ? file : `./${file}`);
const exportSpec = (pkg: Pkg, key: string, file: string) =>
  pkg.self ? publicSpec(pkg, key) : relSpec(file);
// `sub/index.js` reads better as `sub` — but a root-level `./index.js` key has no
// parent dir to borrow, so it stays `index` instead of degenerating into `.`.
const parentName = (path: string): string => {
  const parent = basename(dirname(path));
  return parent && parent !== '.' && parent !== '..' ? parent : 'index';
};
// An `index` basename borrows its parent dir: the exports key for display labels,
// the real file for out dirs (they only differ on extensionless legacy mains).
const moduleName = (key: string, indexParent: string): string => {
  if (key === '.') return 'index';
  const base = basename(key, extname(key));
  return base === 'index' ? parentName(indexParent) : base;
};
const exported = (ts: TsLike, node: any): boolean =>
  !!node.modifiers?.some((mod: any) => mod.kind === ts.SyntaxKind.ExportKeyword);
// `existsSync` alone would accept a directory (e.g. `./beta/` next to `beta.js`).
const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
const localSpec = (from: string, spec: string): string | undefined =>
  resolveLocalImport(from, spec, {
    accept: isFile,
    exts: ['.js', '.mjs', '.cjs'],
    indexExts: [],
    jsToTs: false,
  });
const runtimeExports = (ts: TsLike, file: string, seen = new Set<string>()): string[] => {
  if (seen.has(file)) return [];
  seen.add(file);
  const { source: sf } = readSource(ts, file);
  const out = new Set<string>();
  const add = (name: string): void => {
    // `_underscore`-prefixed exports are internal by convention (covers `__esModule` too).
    if (name && name !== 'default' && !name.startsWith('_')) out.add(name);
  };
  for (const stmt of sf.statements || []) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && exported(ts, stmt))
      add(nodeText(stmt.name));
    else if (ts.isVariableStatement(stmt) && exported(ts, stmt)) {
      for (const decl of stmt.declarationList?.declarations || [])
        if (ts.isIdentifier(decl.name)) add(nodeText(decl.name));
    } else if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements || []) if (!el.isTypeOnly) add(nodeText(el.name));
      } else if (clause && ts.isNamespaceExport?.(clause)) add(nodeText(clause.name));
      else if (
        !stmt.isTypeOnly &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const next = localSpec(file, stmt.moduleSpecifier.text);
        if (next) for (const name of runtimeExports(ts, next, seen)) add(name);
      }
    }
  }
  return [...out].sort();
};
const readModules = (ctx: Ctx, ts: TsLike | undefined): Mod[] => {
  const res: Mod[] = [];
  // Alias keys (`./bind` + `./bind.js`, dotenv/classnames) and per-condition variants
  // (react-dom's `./server` family) share a label; the first exports-map entry wins.
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    // Wildcard subpath patterns (`./_types/*`) name no concrete file; skip them.
    if (key.includes('*')) continue;
    // `_underscore`-prefixed subpath exports are internal by convention, like export names.
    if (key !== '.' && basename(key, extname(key)).startsWith('_')) continue;
    let file = jsPath(value);
    // Legacy mains may be extensionless (`"main": "./index"`, ms); resolve node-style.
    if (!file && typeof value === 'string' && !extname(value))
      for (const tail of ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'])
        if (isFile(resolve(ctx.pkgDir, value + tail))) {
          file = value + tail;
          break;
        }
    if (!file) continue;
    const abs = resolve(ctx.pkgDir, file);
    // Published exports maps can point at files absent from the tarball (ramda's
    // ./dist); measure the modules that exist instead of dying on the broken one.
    if (!isFile(abs)) continue;
    const module = moduleName(key, key);
    if (seen.has(module)) continue;
    seen.add(module);
    res.push({
      dir: moduleName(key, file),
      exports: [],
      file: abs,
      key,
      module,
      spec: exportSpec(ctx.pkg, key, file),
    });
  }
  if (ts) for (const mod of res) mod.exports = runtimeExports(ts, mod.file);
  return res;
};
const fullSource = (mods: Mod[], spec: (mod: Mod) => string): string => {
  // Exports-map keys like `./actions` and `./celo/actions` share a basename; uniquify
  // the namespace aliases so the package-wide bundle stays valid ESM.
  const seen = new Map<string, number>();
  const lines = mods.map((mod) => {
    const base = camel(mod.dir) || 'mod';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return `export * as ${count ? `${base}_${count}` : base} from '${spec(mod)}';`;
  });
  return lines.join('\n') || 'export {};';
};
const exportSource = (spec: string, name: string) =>
  name === 'default' ? `export { default } from '${spec}';` : `export { ${name} } from '${spec}';`;
// Absolute-path spec (forward slashes): resolvable from any resolveDir, used when a
// selection bundle mixes local exports with external npm refs.
const absSpec = (mod: Mod): string => mod.file.split('\\').join('/');
const inputCtx = (cwd: string | undefined, outArg: string | undefined, input: string): Ctx => {
  const base = resolve(cwd ?? process.cwd());
  const file = resolve(base, input);
  if (!isFile(file)) err(`missing input file: ${bad(input)}`);
  if (!outArg || !isAbsolute(outArg)) throw new Error('expected absolute out dir for --input');
  const name = slug(basename(file, extname(file))) || 'input';
  const pkg: Pkg = { exports: {}, name, self: false, types: '', version: '' };
  return {
    cwd: base,
    outDir: outArg,
    pkg,
    pkgDir: dirname(file),
    pkgFile: join(base, 'package.json'),
  };
};
const inputMods = (ctx: Ctx, ts: TsLike, input: string): Mod[] => {
  const file = resolve(ctx.cwd, input);
  return [
    {
      dir: ctx.pkg.name,
      exports: runtimeExports(ts, file),
      file,
      key: '.',
      module: ctx.pkg.name,
      spec: relSpec(relative(ctx.cwd, file).split('\\').join('/')),
    },
  ];
};
// Selectors accept what users actually see: `sha3/sha3_384`, `sha3.js/sha3_384`,
// `sha3.ts/...`, `./sha3.js/...`, or `@scope/pkg/sha3.js/...` all mean module `sha3`.
const ONLY_EXT = /\.(?:[cm]?[jt]s)$/;
const normalizeOnlyPath = (pkgName: string, raw: string): string => {
  // Slash slips are harmless: `index/` means the module, `index//add` means `index/add`.
  let path = raw.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (path.startsWith(`${pkgName}/`)) path = path.slice(pkgName.length + 1).replace(/^\.\//, '');
  const parts = path.split('/');
  if (parts.length > 1) parts[parts.length - 2] = parts[parts.length - 2].replace(ONLY_EXT, '');
  return parts.join('/');
};
// Re-export under unique per-pick aliases: two picks exporting the same name (e.g.
// sha256 from two packages) would otherwise collide inside the combined bundle.
const selReexport = (src: string, index: number): string =>
  src
    .split('\n')
    .map((line) =>
      line
        .replace(/^export \* as (\w+) from/, `export * as sel${index}_$1 from`)
        .replace(/^export \* from/, `export * as sel${index} from`)
        .replace(
          /^export \{ (\w+) \} from/,
          (_, name) => `export { ${name} as sel${index}_${name} } from`
        )
    )
    .join('\n');
const selection = (picked: Item[], resolveDir?: string): Item => ({
  // With external refs in the mix, one resolveDir cannot serve every relative spec, so
  // the combined bundle uses absolute specs (and real-name deep paths) throughout.
  dir: 'selection',
  export: ALL,
  // Content-derived name: hashing the picked selector ids keeps the emitted global
  // independent of the working directory (versionless refs hash as their pinned form).
  global: `bundle_${createHash('sha256')
    .update(picked.map((item) => `${item.module}/${item.export}`).join(' '))
    .digest('hex')
    .slice(0, 8)}`,
  module: 'selection',
  out: ALL,
  resolveDir,
  source: picked
    .map((item, index) =>
      selReexport(resolveDir ? (item.absSource ?? item.source) : item.source, index)
    )
    .join('\n'),
});
const exportItem = (pkg: Pkg, mod: Mod, name: string): Item => ({
  absSource: exportSource(absSpec(mod), name),
  dir: mod.dir,
  export: name,
  global: camel(`${pkg.name}-${mod.module}-${name}`),
  module: mod.module,
  out: name,
  source: exportSource(mod.spec, name),
});
const cases = (pkg: Pkg, mods: Mod[], pkgRow = true): Item[] => {
  const res: Item[] = [];
  if (pkgRow)
    res.push({
      absSource: fullSource(mods, absSpec),
      dir: '',
      export: '',
      global: camel(pkg.name),
      module: pkg.name,
      out: ALL,
      source: fullSource(mods, (mod) => mod.spec),
    });
  for (const mod of mods) {
    // A single-export module's ALL bundle duplicates that export's bundle; skip it.
    if (mod.exports.length !== 1)
      res.push({
        absSource: `export * from '${absSpec(mod)}';`,
        dir: mod.dir,
        export: ALL,
        global: camel(`${pkg.name}-${mod.module}`),
        module: mod.module,
        out: ALL,
        source: `export * from '${mod.spec}';`,
      });
    for (const name of mod.exports) res.push(exportItem(pkg, mod, name));
  }
  return res;
};
const bundle = async (
  build: BuildLike,
  source: string,
  globalName: string,
  cwd: string,
  minify: boolean
) => {
  // Runtime-provided node builtins cost zero shipped bytes; leave them external.
  const external = [...builtinModules, 'node:*'];
  // The entry is named after globalName; esbuild may display it resolveDir-relative.
  const entry = `${globalName}.js`;
  const atEntry = (file: string | undefined) =>
    file === entry || (file ?? '').endsWith(`/${entry}`);
  let platform: 'node' | undefined;
  let res: Awaited<ReturnType<BuildLike>>;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await build({
        bundle: true,
        external,
        format: 'iife',
        globalName,
        logLevel: 'silent',
        metafile: true,
        minify,
        platform,
        stdin: {
          contents: source,
          resolveDir: cwd,
          sourcefile: `${globalName}.js`,
        },
        write: false,
      });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      // Undeclared optional imports (preact's compat/server pulls preact-render-to-string)
      // are absent by design after a plain install; treat bare unresolvable packages as
      // external so the rest of the package still measures. Relative paths stay fatal.
      const missing = [...(error as Error).message.matchAll(/Could not resolve "([^"']+)"/g)]
        .map((match) => match[1])
        .filter((spec) => spec && !/^[./#]/.test(spec) && !external.includes(spec));
      if (missing.length) {
        for (const spec of new Set(missing)) {
          // The minified twin build retries the same specs; one note per bundle is enough.
          if (!minify) console.error(`note: treating unresolvable import ${spec} as external`);
          external.push(spec);
        }
        continue;
      }
      // Node-only dependency graphs can need node conditions: execa's unicorn-magic
      // exports toPath only under `node`; concurrently default-imports rxjs, which only
      // interops via its CJS build. Retry once — but never when the failing import is in
      // our generated entry (that's a genuinely unknown export, reported friendly).
      const failed = (error as { errors?: { location?: { file?: string } | null }[] }).errors;
      const depOnly =
        /No matching export/.test((error as Error).message) &&
        !!failed?.length &&
        failed.every((one) => !atEntry(one.location?.file));
      if (!platform && depOnly) {
        platform = 'node';
        if (!minify) console.error('note: retrying with node conditions (conditional exports)');
        continue;
      }
      throw error;
    }
  }
  // CommonJS targets defeat esbuild's static export validation: a bogus name builds
  // "successfully" as a permanently-undefined property read. esbuild still warns when it
  // can prove the target has no exports at all; scoped to our generated entry, that
  // warning IS a missing export (the entry only re-exports), so fail like ESM would.
  const dead = res.warnings?.find(
    (warning) =>
      atEntry(warning.location?.file) && warning.text.includes('will always be undefined')
  );
  if (dead) err(`No matching export: ${dead.text}`);
  const maybeOutFiles = res.outputFiles;
  if (!maybeOutFiles?.length) err(`missing esbuild output for ${globalName}`);
  const outFiles = maybeOutFiles as { contents: Uint8Array }[];
  const out = outFiles[0];
  if (!out) err(`missing esbuild output for ${globalName}`);
  return out.contents;
};
// Bundling is fully in-memory; nothing is ever written for measurement.
const buildCase = async (ctx: Ctx, build: BuildLike, item: Item): Promise<Built> => {
  const resolveDir = item.resolveDir ?? ctx.cwd;
  const [plain, min] = await Promise.all([
    bundle(build, item.source, item.global, resolveDir, false),
    bundle(build, item.source, item.global, resolveDir, true),
  ]);
  return { ...item, min, plain };
};
type RowData = {
  export: string;
  gzBytes: number;
  loc: number;
  minBytes: number;
  module: string;
};
const rowData = (item: Item, out: Built): RowData => {
  const gz = gzipSync(out.min, { level: 9 });
  return {
    export: item.export,
    gzBytes: gz.length,
    loc: decoder.decode(out.plain).split('\n').length,
    minBytes: out.min.length,
    module: item.module,
  };
};
// The whole-module row carries no export token at all: bare `sha3.js` (or the bare
// package name) means "the module itself"; only real exports get a `/name` suffix.
// A big bundle that gzip barely shrinks is dominated by high-entropy content (precomputed
// tables, embedded constants) rather than code; flag it. Small bundles always compress
// poorly because of gzip's fixed overhead, so they are exempt.
const DATA_HEAVY_TAG = 'data-heavy';
const dataHeavy = (data: RowData): boolean =>
  data.minBytes > 2048 && data.gzBytes / data.minBytes > 0.6;
const exportLabel = (name: string): string => (name === ALL ? '' : name);
// Table-less human mode (jsbt size on a TTY): one line per bundle, e.g.
// `ml-kem.js/ml_kem1024 - 120 LOC, 5.61kb, 3.30kb`
const LINE_LABEL_MAX = 40;
// External refs: `npm:@noble/hashes@2.2.0/sha2.js/sha256` measures another package
// (or another version of this one). Each distinct ref installs into its own
// `<tmp>/.refs/<slug>` dir under its real name, so self-referencing imports resolve
// and two versions of one package can coexist side by side.
type ExternalRef = { bare: string; label: string; path: string; version: string };
const parseNpmRef = (raw: string): ExternalRef => {
  const body = raw.slice('npm:'.length);
  const parts = body.split('/');
  const nameParts = body.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  const name = nameParts.join('/');
  const at = name.lastIndexOf('@');
  const version = at > 0 ? name.slice(at + 1) : '';
  const bare = at > 0 ? name.slice(0, at) : name;
  // Registry specs only: file/git specs would resolve paths or run scripts.
  const validName = /^(@[\w.-]+\/)?[\w.-]+$/.test(bare);
  if (!validName || (body.startsWith('@') && parts.length < 2) || /[:+]/.test(version))
    err(`invalid npm ref: ${bad(raw)}; use npm:name@version/module/export`);
  return { bare, label: name, path: parts.slice(nameParts.length).join('/'), version };
};
// Exact pinned versions are immutable on the registry, so their installs live in a
// machine-level cache (like the esbuild cache; the OS reclaims it on reboot) and warm
// queries skip npm entirely. Ranges, dist-tags, and versionless refs resolve per run.
const PINNED = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const installRef = (outDir: string, ref: ExternalRef): string => {
  const pinned = PINNED.test(ref.version);
  const dir = pinned
    ? join(tmpdir(), 'jsbt-refs', slug(ref.label))
    : join(outDir, '.refs', slug(ref.label));
  const installed = join(dir, 'node_modules', ref.bare, 'package.json');
  if (pinned && existsSync(installed)) return dir;
  writePkg(
    join(dir, 'package.json'),
    `${JSON.stringify(
      { dependencies: { [ref.bare]: ref.version || 'latest' }, private: true },
      null,
      2
    )}\n`
  );
  try {
    npmInstall(dir);
  } catch (error) {
    // A concurrent prime may have won the race; only fail when the ref is truly absent.
    if (pinned && existsSync(installed)) return dir;
    // The two everyday registry failures get one-liners; anything else keeps npm's story.
    const msg = (error as Error).message;
    if (msg.includes('code ETARGET'))
      err(`no such version: ${bad(ref.label)}; check the version on npmjs.com`);
    if (msg.includes('code E404'))
      err(`package not found: ${bad(ref.bare)}; check the name on npmjs.com`);
    err(`installing npm ref ${ref.label} failed: ${msg}`);
  }
  return dir;
};
// Uniform unknown-thing error: offender red, choices listed as selectors (leaf blue),
// or a --list hint when nothing can be enumerated.
// A foreign `@scope/name/...` selector can only mean a package (local module labels
// never start with `@`), so the npm: prefix is optional there. The local package's own
// name stays a local-selector spelling.
const refSugar = (raw: string, pkgName: string): string =>
  raw.startsWith('@') && raw !== pkgName && !raw.startsWith(`${pkgName}/`) ? `npm:${raw}` : raw;
// Pinned ref installs are immutable, so their export enumeration caches alongside
// them (`jsbt.db.json`); a warm `--list` then skips TypeScript entirely. Unversioned
// or invalid dbs are recomputed and rewritten, never trusted.
const REF_DB = 'jsbt.db.json';
type RefDbMod = { exports: string[]; module: string };
const readRefDb = (refDir: string): RefDbMod[] | undefined => {
  try {
    const db = JSON.parse(readText(join(refDir, REF_DB))) as { modules?: RefDbMod[]; v?: number };
    if (db.v === 1 && Array.isArray(db.modules)) return db.modules;
  } catch {
    // Missing or corrupt: recompute below.
  }
  return undefined;
};
// Display label for a ref: versionless refs (`npm:qr`) adopt the installed version
// (`qr@0.6.0`), so output is pinned and copy-pasteable.
const refLabel = (ref: ExternalRef, pkg: Pkg): string =>
  ref.version || !pkg.version ? ref.label : `${ref.bare}@${pkg.version}`;
// Install a ref and read its package.json: the shared setup for listing and measuring.
const refContext = (ctx: Ctx, ref: ExternalRef): { label: string; refCtx: Ctx; refDir: string } => {
  const refDir = installRef(ctx.outDir, ref);
  const pkgFile = join(refDir, 'node_modules', ref.bare, 'package.json');
  const refCtx: Ctx = {
    cwd: refDir,
    outDir: ctx.outDir,
    pkg: readPkg(pkgFile),
    pkgDir: dirname(pkgFile),
    pkgFile,
  };
  return { label: refLabel(ref, refCtx.pkg), refCtx, refDir };
};
// Selector-form id for a ref module: the npm: prefix rides along everywhere a ref
// surfaces — size rows, CSV, error ids, listings — so output stays copy-pasteable.
// Single-file packages drop the redundant /index segment; the package-wide row
// (module === pkg name, measurement only) collapses the same way.
const soleIndexOf = (mods: { module: string }[]): boolean =>
  mods.length === 1 && mods[0].module === 'index';
const refRename =
  (label: string, soleIndex: boolean, pkgName = '') =>
  (module: string): string =>
    (!!pkgName && module === pkgName) || (soleIndex && module === 'index')
      ? `npm:${label}`
      : `npm:${label}/${module}`;
const firstModule = (pkgName: string, path: string): string =>
  normalizeOnlyPath(pkgName, path).split('/')[0].replace(ONLY_EXT, '');
const unknownErr = (
  what: string,
  offender: string,
  ids: string[],
  leaf: IdLeaf = 'module'
): never =>
  err(
    `${what}: ${bad(offender)}; ${
      ids.length ? `use one of:\n${listLines(ids, leaf)}` : 'use --list to see modules and exports'
    }`
  );
const lineLabel = (modFile: Map<string, string>, module: string, exp: string): string => {
  const mod = modFile.get(module) || module;
  return exp && exp !== ALL ? `${mod}/${exp}` : mod;
};
const sizeLine = (
  data: RowData,
  modFile: Map<string, string>,
  width: number,
  on: boolean
): string => {
  const plain = lineLabel(modFile, data.module, data.export);
  // The combined multi-selector row is jsbt-made, not a selectable module: pink, not yellow.
  const painted =
    data.module === 'selection'
      ? paint(plain, color.pink, on)
      : paintId(plain, on, exportLabel(data.export) ? 'export' : 'module');
  // Pad by the uncolored width so colored labels still line up.
  const label = painted + ' '.repeat(Math.max(0, width - plain.length));
  const tag = dataHeavy(data) ? ` ${paint(DATA_HEAVY_TAG, color.dim, on)}` : '';
  return `${label} ${data.loc} LOC, ${kb(data.minBytes)}kb min, ${kb(data.gzBytes)}kb gzip${tag}`;
};
const CSV_HEADERS = ['module', 'export', 'loc', 'minified_bytes', 'gzipped_bytes'];
const csvCells = (data: RowData) => [
  data.module,
  exportLabel(data.export),
  data.loc,
  data.minBytes,
  data.gzBytes,
];
// `--list`: print selectable module/export ids without bundling; optional args filter
// by module, and npm: refs list the external package's ids in selector form.
const runList = (
  ctx: Ctx,
  mods: Mod[],
  items: Item[],
  only: string[],
  ts: TsLike | undefined
): void => {
  const wanted = new Set<string>();
  const refs = new Map<string, ExternalRef>();
  for (const bare of only) {
    const raw = refSugar(bare, ctx.pkg.name);
    if (raw.startsWith('npm:')) {
      const ref = parseNpmRef(raw);
      if (!refs.has(ref.label)) refs.set(ref.label, ref);
    } else wanted.add(firstModule(ctx.pkg.name, raw));
  }
  if (wanted.size || !refs.size) {
    // A filter that matches nothing is a typo, not an empty package; never go silent.
    const known = new Set(mods.map((mod) => mod.module));
    const missing = [...wanted].filter((want) => !known.has(want));
    if (missing.length) unknownErr('unknown module', missing.join(', '), sorted(known));
    const ids = items
      .filter((item) => item.export && item.export !== ALL)
      .filter((item) => !wanted.size || wanted.has(item.module))
      .map((item) => `${item.module}/${item.export}`);
    if (ids.length) console.log(listLines(ids, 'export'));
  }
  for (const ref of refs.values()) {
    const { label, refCtx, refDir } = refContext(ctx, ref);
    const want = ref.path ? firstModule(refCtx.pkg.name, ref.path) : '';
    let refMods = readRefDb(refDir);
    if (!refMods) {
      ts ??= loadTs(ctx.pkgFile);
      refMods = readModules(refCtx, ts).map((mod) => ({
        exports: mod.exports,
        module: mod.module,
      }));
      // Only pinned installs live outside the run dir and outlast it; cache there.
      if (!refDir.startsWith(ctx.outDir))
        write(join(refDir, REF_DB), `${JSON.stringify({ modules: refMods, v: 1 })}\n`);
    }
    const modId = refRename(label, soleIndexOf(refMods));
    if (want && !refMods.some((mod) => mod.module === want))
      unknownErr('unknown module', want, sorted(refMods.map((mod) => modId(mod.module))));
    const lines = refMods
      .filter((mod) => !want || mod.module === want)
      // CJS entries defeat export enumeration; at least surface the module itself.
      .flatMap((mod) =>
        mod.exports.length
          ? mod.exports.map((name) =>
              paintId(`${modId(mod.module)}/${name}`, wantColor(), 'export')
            )
          : [paintId(modId(mod.module), wantColor(), 'module')]
      );
    if (lines.length) console.log(lines.join('\n'));
  }
};
export type SizeOpts = {
  cwd?: string;
  input?: string;
  listOnly?: boolean;
  onBuilt?: (bundle: Built, meta: { id: string; name: string }) => void;
  only?: string[];
  outDir: string;
  silent?: boolean;
  single?: boolean;
  sort?: boolean;
};
export const runSize = async (opts: SizeOpts): Promise<void> => {
  const ctx = opts.input
    ? inputCtx(opts.cwd, opts.outDir, opts.input)
    : resolveCtx(opts.cwd, opts.outDir);
  let build: BuildLike | undefined;
  let ts: TsLike | undefined;
  // Never touches test/build and never installs the project: everything happens in a
  // fresh jsbt temp dir; deps resolve near the project (node_modules chain) or globally.
  if (!opts.listOnly) build = loadSizeBuild(ctx.pkgFile);
  // TypeScript only enumerates exports for full tables and listings; explicit selectors
  // skip it entirely (faster startup) and let esbuild validate names while bundling.
  const refOnly =
    !!opts.only?.length && opts.only.every((raw) => refSugar(raw, ctx.pkg.name).startsWith('npm:'));
  if (opts.input || (opts.listOnly && !refOnly) || !opts.only?.length) ts = loadTs(ctx.pkgFile);
  const mods = opts.input ? inputMods(ctx, ts as TsLike, opts.input) : readModules(ctx, ts);
  // Zero modules would silently measure an empty entry (a ~400-byte interop shim) and
  // list nothing; whatever shape caused it, an error beats a meaningless number.
  if (!mods.length) err(`no importable JS modules found in ${ctx.pkg.name}`);
  // A bare --input run measures just the file; no package-wide row exists to add.
  let items = cases(ctx.pkg, mods, !opts.input);
  if (opts.listOnly) return runList(ctx, mods, items, opts.only || [], ts);
  // Enumerates a module's export ids on demand (error paths only; needs TypeScript).
  const exportIds = (mod: Mod): string[] => {
    const names = mod.exports.length
      ? mod.exports
      : runtimeExports((ts ??= loadTs(ctx.pkgFile)), mod.file);
    return names.map((name) => `${mod.module}/${name}`);
  };
  // Ref modules by branded name, so build failures list ref exports as friendly errors.
  const extMods = new Map<string, Mod>();
  if (opts.only?.length) {
    type Picker = (raw: string, path: string) => Item;
    type PickerOpts = {
      brand: (item: Item) => Item;
      items: Item[];
      // Selector-form module label for error messages: refs get their npm: prefix back.
      modLabel?: (module: string) => string;
      mods: Mod[];
      pkg: Pkg;
      rootExportFallback: boolean;
    };
    const makePicker = ({
      brand,
      items: pkgItems,
      modLabel = (module) => module,
      mods: pkgMods,
      pkg,
      rootExportFallback,
    }: PickerOpts): Picker => {
      const rows = pkgItems.filter((item) => item.export);
      const byId = new Map(rows.map((item) => [`${item.module}/${item.export}`, item]));
      const modsByName = new Map(pkgMods.map((mod) => [mod.module, mod]));
      return (raw, rawPath) => {
        if (!rawPath) {
          const row =
            pkgItems.find((item) => !item.export) || err(`no bundles found in ${bad(raw)}`);
          return brand(row);
        }
        const path = normalizeOnlyPath(pkg.name, rawPath);
        const direct = byId.get(path);
        if (direct) return brand(direct);
        const slash = path.indexOf('/');
        const seg = slash < 0 ? path : path.slice(0, slash);
        let modName = seg.replace(ONLY_EXT, '');
        // An explicit `.js`/`.ts` extension names a module; never retry it as an export.
        const hadExt = seg !== modName;
        // Mistyped extensions (`secp256k1.t2`) survive the ONLY_EXT strip and would
        // otherwise be treated as export names or unknown modules; catch them early.
        const extTypo = modName.replace(/\.\w+$/, '');
        if (!modsByName.has(modName) && extTypo !== modName && modsByName.has(extTypo)) {
          const rest = slash < 0 ? '' : `/${path.slice(slash + 1)}`;
          return err(`unknown module: ${bad(modName)}; did you mean ${modLabel(extTypo)}${rest}?`);
        }
        // A bare module name selects the whole module (its ALL bundle); on single-root
        // external packages it falls back to an export of the root module.
        let name = slash < 0 ? ALL : path.slice(slash + 1);
        let fellBack = false;
        if (
          slash < 0 &&
          rootExportFallback &&
          !hadExt &&
          !modsByName.has(modName) &&
          modsByName.has('index')
        ) {
          name = path;
          modName = 'index';
          fellBack = true;
        }
        const mod = modsByName.get(modName);
        if (!mod)
          return unknownErr('unknown module', modName, sorted(modsByName.keys()).map(modLabel));
        const known = byId.get(`${mod.module}/${name}`);
        if (known) return brand(known);
        if (mod.exports.length || name === ALL)
          return unknownErr(
            `${modLabel(mod.module)} has no export`,
            name,
            exportIds({ ...mod, module: modLabel(mod.module) }),
            'export'
          );
        // The name is spliced into `export { name } from ...`, so it must be an identifier;
        // catching it here beats a cryptic esbuild parse error against the generated file.
        if (!ident(name)) {
          const fixed = name.replace(/-/g, '_');
          const hint = ident(fixed) ? `; did you mean ${mod.module}/${fixed}?` : '';
          return err(`invalid export name: ${bad(name)} (exports are JS identifiers)${hint}`);
        }
        // Fast mode skipped export enumeration; esbuild validates the name during bundling.
        return brand({
          ...exportItem(pkg, mod, name),
          // Failed fallbacks report unknown-module style: the raw name may have meant either.
          rootModules: fellBack ? sorted(modsByName.keys()).map(modLabel) : undefined,
        });
      };
    };
    const localPick = makePicker({
      brand: (item) => item,
      items,
      mods,
      pkg: ctx.pkg,
      rootExportFallback: false,
    });
    const refPickers = new Map<string, Picker>();
    const refPicker = (ref: ExternalRef): Picker => {
      const cached = refPickers.get(ref.label);
      if (cached) return cached;
      const { label, refCtx, refDir } = refContext(ctx, ref);
      const refMods = readModules(refCtx, ts);
      const rename = refRename(label, soleIndexOf(refMods), refCtx.pkg.name);
      for (const mod of refMods) {
        // Deep paths by real name keep self-referencing imports resolvable.
        if (!mod.spec.startsWith(refCtx.pkg.name))
          mod.spec = `${ref.bare}/${mod.spec.replace(/^\.\//, '')}`;
        extMods.set(rename(mod.module), { ...mod, module: rename(mod.module) });
      }
      // Absolute-path sources bundle identically from any resolveDir, which the combined
      // selection row relies on when it mixes refs and local exports.
      const brand = (item: Item): Item => ({
        ...item,
        absSource: item.absSource,
        dir: `${slug(ref.label)}${item.dir ? `/${item.dir}` : ''}`,
        module: rename(item.module),
        resolveDir: refDir,
        source: item.absSource ?? item.source,
      });
      // Items stay unbranded for id lookups; the brand applies to whatever gets picked.
      const picker = makePicker({
        brand,
        items: cases(refCtx.pkg, refMods, true),
        modLabel: rename,
        mods: refMods,
        pkg: refCtx.pkg,
        rootExportFallback: true,
      });
      refPickers.set(ref.label, picker);
      return picker;
    };
    let hasRefs = false;
    const picked = opts.only.map((bare) => {
      const raw = refSugar(bare, ctx.pkg.name);
      if (!raw.startsWith('npm:')) return localPick(raw, raw);
      hasRefs = true;
      // Re-parse per selector: two selectors may share a ref but name different paths.
      const parsed = parseNpmRef(raw);
      return refPicker(parsed)(raw, parsed.path);
    });
    // Multiple picks also get a combined ALL bundle: their cost when imported together.
    items =
      picked.length > 1 ? [selection(picked, hasRefs ? ctx.cwd : undefined), ...picked] : picked;
  }
  // `jsbt bundle` emits one artifact: the first item is always the widest bundle —
  // package row, selection row, the --input file's ALL row, or the single pick.
  if (opts.single) items = items.slice(0, 1);
  // `sizeOnly` (jsbt size) always shows the table, even with JSBT_QUIET;
  // non-interactive environments (LLM agents, pipes, CI logs) get CSV instead of a table.
  const show = !opts.silent;
  const csv = csvEnabled();
  const colorOn = wantColor();
  // Human mode renders plain lines; non-interactive environments (LLM agents, pipes,
  // CI logs) get CSV. Module names show the real export file (`ml-kem.js`), matching
  // accepted selector spellings.
  const modFile = new Map(
    mods.map((mod) => [mod.module, basename(mod.key === '.' ? mod.file : mod.key)])
  );
  // Rare overlong labels overflow on their own instead of inflating everyone's padding.
  const labelWidth = Math.min(
    LINE_LABEL_MAX,
    Math.max(...items.map((item) => lineLabel(modFile, item.module, item.export).length))
  );
  const built: Built[] = [];
  const results: RowData[] = [];
  for (const item of items) {
    const out = await buildCase(ctx, build as BuildLike, item).catch((error) => {
      // Esbuild messages reference temp work files by long relative paths; strip them
      // so the remaining raw errors point at the package's own files only.
      const msg = (error as Error).message
        .replaceAll(`${relative(process.cwd(), ctx.outDir)}/`, '')
        .replaceAll(`${ctx.outDir}/`, '');
      const mod = /No matching export/.test(msg)
        ? (mods.find((entry) => entry.module === item.module) ?? extMods.get(item.module))
        : undefined;
      if (mod) {
        const ids = exportIds(mod);
        // A bare name that fell back to an export-less root was likely a module typo.
        if (!ids.length && item.rootModules)
          return unknownErr('unknown module or export', item.export, item.rootModules);
        return unknownErr(`${mod.module} has no export`, item.export, ids, 'export');
      }
      return err(`bundling ${itemId(ctx.pkg, item)} failed: ${msg}`);
    });
    built.push(out);
    opts.onBuilt?.(out, { id: itemId(ctx.pkg, item), name: outPath(ctx.pkg, item, 'js') });
    if (show) results.push(rowData(item, out));
  }
  // --sort emits two ascending gzip-size groups: module bundles first, then individual
  // exports; the heaviest of each group lands next to the prompt. Default is unsorted.
  if (opts.sort) {
    const rank = (data: RowData): number => (data.export && data.export !== ALL ? 1 : 0);
    results.sort((a, b) => rank(a) - rank(b) || a.gzBytes - b.gzBytes);
  }
  if (show && results.length) {
    if (csv) console.log(csvRow(CSV_HEADERS));
    for (const data of results) {
      if (csv) console.log(csvRow(csvCells(data)));
      else console.log(sizeLine(data, modFile, labelWidth, colorOn));
    }
  }
};

type SizeArgs = {
  help: boolean;
  input?: string;
  list: boolean;
  paths: string[];
  sort: boolean;
};
const sizeUsage = `usage:
  jsbt size [--list] [--sort] [--input=<file.js>] [<module/export> ...]

examples:
  jsbt size
  jsbt size sha3/sha3_384 utils/bytesToHex
  jsbt size sha2.js/sha256 npm:@noble/hashes@1.8.0/sha2.js/sha256
  jsbt size @noble/curves@2.2.0/secp256k1.js/secp256k1
  jsbt size sha2.js/sha256 npm:hash-wasm/sha256
  jsbt size --input=./input.js
  jsbt size --list sha3`;
// Both commands share one selector-style command line; only the boolean flags differ.
type CliArgs = { flags: Set<string>; help: boolean; input?: string; paths: string[] };
const cliArgs = (argv: string[], cmd: string, bools: readonly string[]): CliArgs => {
  const flags = new Set<string>();
  const paths: string[] = [];
  let input: string | undefined;
  if (argv.includes('--help') || argv.includes('-h')) return { flags, help: true, input, paths };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (bools.includes(arg)) {
      flags.add(arg);
      continue;
    }
    if (arg === '--input' || arg.startsWith('--input=')) {
      input = arg === '--input' ? argv[++i] : arg.slice('--input='.length);
      if (!input) err(`expected file after ${arg}`);
      continue;
    }
    if (arg.startsWith('-')) err(`unknown ${cmd} option: ${bad(arg)}; run jsbt ${cmd} --help`);
    paths.push(arg);
  }
  return { flags, help: false, input, paths };
};
const sizeArgs = (argv: string[]): SizeArgs => {
  const { flags, help, input, paths } = cliArgs(argv, 'size', ['--list', '--sort']);
  return { help, input, list: flags.has('--list'), paths, sort: flags.has('--sort') };
};
export const runSizeCli = async (argv: string[], opts: { cwd?: string } = {}): Promise<void> => {
  const args = sizeArgs(argv);
  if (args.help) return console.log(sizeUsage);
  // The temp dir only hosts npm ref installs; measurement itself is in-memory.
  const tmp = tempDir('size');
  try {
    await runSize({
      cwd: opts.cwd,
      input: args.input,
      listOnly: args.list,
      only: args.paths,
      outDir: tmp,
      sort: args.sort,
    });
  } finally {
    rmTempDir(tmp);
  }
};

/**
 * `jsbt bundle` writes a single-file bundle to stdout — nothing else.
 *
 * Selectors mirror `jsbt size`: whole package by default, or one `module/export`
 * path, `npm:` ref, or `--input` file; several selectors emit their combined bundle.
 * `--minify` emits the minified variant; `--checksum` emits its sha256 hex instead.
 * @module
 */

type BundleArgs = {
  checksum: boolean;
  help: boolean;
  input?: string;
  list: boolean;
  minify: boolean;
  paths: string[];
};
type Bundle = { min: Uint8Array; plain: Uint8Array };
type TestApi = { parseArgs: typeof parseArgs };

const bundleUsage = `usage:
  jsbt bundle [--minify] [--checksum] [--list] [--input=<file.js>] [<module/export> ...]

examples:
  jsbt bundle > out.js
  jsbt bundle --minify sha2.js/sha256 > sha256.min.js
  jsbt bundle --checksum sha2.js/sha256
  jsbt bundle npm:@noble/hashes@1.8.0/sha2.js/sha256
  jsbt bundle --input=./input.js
  jsbt bundle --list`;

const parseArgs = (argv: string[]): BundleArgs => {
  const { flags, help, input, paths } = cliArgs(argv, 'bundle', [
    '--checksum',
    '--list',
    '--minify',
  ]);
  return {
    checksum: flags.has('--checksum'),
    help,
    input,
    list: flags.has('--list'),
    minify: flags.has('--minify'),
    paths,
  };
};

const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

export const runBundleCli = async (argv: string[], opts: { cwd?: string } = {}): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(bundleUsage);
  const tmp = tempDir('bundle');
  try {
    let bundle: Bundle | undefined;
    await runSize({
      cwd: opts.cwd,
      input: args.input,
      listOnly: args.list,
      onBuilt: (built) => {
        bundle ??= built;
      },
      only: args.paths,
      outDir: tmp,
      silent: true,
      single: true,
    });
    if (args.list) return;
    if (!bundle) return err('no bundles found');
    const buf = args.minify ? bundle.min : bundle.plain;
    if (args.checksum) console.log(sha256(buf));
    else process.stdout.write(buf);
  } finally {
    // Content goes to stdout; the temp work dir has nothing left to offer.
    rmTempDir(tmp);
  }
};

export const __TEST: TestApi = { parseArgs: parseArgs };

/**
 * `jsbt` is the small, fast half of the toolkit: single-file bundles and size stats.
 * The heavy audit machinery lives in the separate `jsbt-check` binary.
 *
 * Usage:
 *   `jsbt bundle`
 *   `jsbt size`
 * @module
 */

type Opts = { cwd?: string };
type CmdRun = (argv: string[], opts: Opts) => Promise<void>;

const usage = `usage:
  jsbt bundle [--minify] [--checksum] [--list] [--input=<file.js>] [<module/export> ...]
  jsbt size [--list] [--sort] [--input=<file.js>] [<module/export> ...]

run jsbt <command> --help for details`;

const cmdRun = {
  bundle: runBundleCli,
  size: runSizeCli,
} satisfies Record<string, CmdRun>;
type Cmd = keyof typeof cmdRun;
const COMMANDS = new Set<Cmd>(Object.keys(cmdRun) as Cmd[]);
const cmd = (name: string): Cmd | undefined =>
  COMMANDS.has(name as Cmd) ? (name as Cmd) : undefined;

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const [head, ...rest] = argv;
  if (!head || head === '--help' || head === '-h') return console.log(usage);
  if (head === 'check')
    throw new Error(`jsbt check moved to the jsbt-check binary; run jsbt-check instead`);
  const sub = cmd(head);
  if (!sub) throw new Error(`unknown jsbt command: ${bad(head)}\n\n${usage}`);
  return cmdRun[sub](rest, opts);
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
// Inside jsbt-check.bin.js this whole file is bundled along; only the owning
// binary may treat entry === self as "run the jsbt dispatcher".
const ownBin = typeof __JSBT_BIN__ === 'undefined' || __JSBT_BIN__ === 'jsbt';
if (ownBin && entry && realpathSync(resolve(entry)) === realpathSync(self)) await main();
