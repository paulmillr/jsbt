#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src`, then run it after a fresh build.
Like `jsbt esbuild`, it runs `npm install` in the selected build directory before checking.
File writes/deletes log through `fs-modify.ts` and honor `JSBT_LOG_LEVEL`.

It prints `unused\t...` lines for locals that still survive bundling.
All writes and any other modifications from this script MUST stay under the selected build/output directories.
Cleanup rule: keep diffs minimal. Prefer `/* @__PURE__ *\/` on the exact offending call/expression
first, instead of structural refactors. In practice esbuild can keep parents alive through
nested object-property builders, inline arithmetic args, and object literals whose member
initializers still look non-pure, so place the PURE marker as close as possible to the offender;
if a computed arg or top-level value still survives, a tiny pure IIFE is the next-smallest fix.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';
import { npmInstall, sweep, write } from './fs-modify.ts';

declare const __JSBT_BUNDLE__: boolean | undefined;

type Args = { help: boolean; pkgArg: string; outArg: string };
type RawPkg = { exports?: Record<string, unknown>; main?: string; module?: string; name?: string };
type Pkg = { exports: Record<string, unknown>; name: string; self: boolean };
type Log = (line: string) => void;
type TsLike = {
  ModuleKind: { ESNext: unknown };
  ScriptTarget: { ESNext: unknown };
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
  ) => {
    getSourceFile: (
      file: string
    ) => { fileName: string; symbol?: unknown; text: string } | undefined;
    getTypeChecker: () => {
      getExportsOfModule: (sym: unknown) => { getName: () => string }[];
      getSymbolAtLocation: (node: unknown) => unknown;
    };
  };
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
  format: 'iife';
  globalName: string;
  logLevel: 'silent';
  metafile: true;
  minify: boolean;
  stdin: { contents: string; resolveDir: string; sourcefile: string };
  write: false;
}) => Promise<{ outputFiles?: { contents: Uint8Array }[] }>;
type Deps = { build: BuildLike; ts: TsLike };
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
  dir: string;
  export: string;
  global: string;
  module: string;
  out: string;
  source: string;
};
type Built = Item & { file: string; min: Uint8Array; minFile: string; plain: Uint8Array };
type AuditItem = { code: number; line: number; text: string };
type TableApi = {
  drawHeader: (sizes: number[], fields: string[]) => void;
  drawSeparator: (sizes: number[], changed: boolean[]) => void;
  printRow: (
    values: string[],
    prev: string[] | undefined,
    sizes: number[],
    selected: string[]
  ) => string[];
};
type TestApi = {
  esbuildPkg: typeof esbuildPkg;
  exportPath: typeof exportPath;
  itemId: typeof itemId;
  loadDeps: typeof loadDeps;
  outPath: typeof outPath;
  parseArgs: typeof parseArgs;
  resolveCtx: typeof resolveCtx;
  slug: typeof slug;
  sweepTemps: typeof sweepTemps;
};

const usage = `usage:
  jsbt treeshake <package.json> <out-dir>

examples:
  jsbt treeshake package.json test/build/out-treeshake`;

const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;

const decoder = new TextDecoder();
const color = {
  dim: '\x1b[2m',
  green: '\x1b[32m',
  reset: '\x1b[0m',
};
const CH = '─';
const NN = '│';
const LR = '┼';
const RN = '├';
const NL = '┤';
const ALL = 'all';
const UNUSED = new Set([6133, 6198]); // TS6133, TS6198 typescript errors
const UNUSED_IGNORE = new Set(['__require', '__toESM']);

const err = (msg: string): never => {
  throw new Error(msg);
};
const paint = (s: string, c = color.green) => `${c}${s}${color.reset}`;
const kb = (bytes: number) => (bytes / 1024).toFixed(2);
const diff = (cur: number, base: number) => `${((cur / base - 1) * 100).toFixed(2)}%`;
const size = (cur: number, base: number) =>
  `${paint(kb(cur))} ${paint(`(${diff(cur, base)})`, color.dim)}`;
const camel = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
const stripAnsi = (str: string) => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
const sweepTemps = (cwd: string): void => {
  sweep(cwd);
};
const joinBorders = (str: string) =>
  str
    .replaceAll(`${CH}${NN}${CH}`, `${CH}${LR}${CH}`)
    .replaceAll(`${CH}${NN}`, `${CH}${NL}`)
    .replaceAll(`${NN}${CH}`, `${RN}${CH}`);
const pad = (s: string, len: number, end = true) => {
  const extra = len - stripAnsi(s).length;
  if (extra <= 0) return s;
  const fill = ' '.repeat(extra);
  return end ? s + fill : fill + s;
};
const table = (log: Log): TableApi => {
  const drawHeader = (sizes: number[], fields: string[]) =>
    log(fields.map((name, i) => `${name.padEnd(sizes[i])} `).join(NN));
  const drawSeparator = (sizes: number[], changed: boolean[]) => {
    const sep = sizes.map((size, i) => (changed[i] ? CH : ' ').repeat(size + 1));
    log(joinBorders(sep.join(NN)));
  };
  const printRow = (
    values: string[],
    prev: string[] | undefined,
    sizes: number[],
    selected: string[]
  ) => {
    const changed = values.map(() => true);
    for (let i = 0, parentChanged = false; i < selected.length; i++) {
      const curChanged = parentChanged || !prev || values[i] !== prev[i];
      changed[i] = curChanged;
      if (curChanged) parentChanged = true;
    }
    const head = changed.slice(0, selected.length);
    const skip = head.length < 2 ? true : head.slice(0, -1).every((v) => !v) && !!head.at(-1);
    if (!skip) drawSeparator(sizes, changed);
    log(
      values
        .map((val, i) => pad(!changed[i] ? ' ' : val, sizes[i] + 1, i < selected.length))
        .join(NN)
    );
    return values;
  };
  return { drawHeader, drawSeparator, printRow };
};
const slug = (s: string): string =>
  s
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, outArg: '', pkgArg: '' };
  if (argv.length !== 2) err('expected <package.json> and <out-dir>');
  return { help: false, outArg: argv[1], pkgArg: argv[0] };
};
const readPkg = (pkgFile: string): Pkg => {
  const raw = JSON.parse(readFileSync(pkgFile, 'utf8')) as RawPkg;
  if (!raw.name) err(`missing name in ${pkgFile}`);
  const name = raw.name as string;
  let exports = raw.exports as Record<string, unknown> | undefined;
  let self = true;
  if (!exports || typeof exports !== 'object') {
    // Older packages publish a single ESM/CJS entry without an exports map; treat that as one root module.
    const entry = raw.module || raw.main;
    if (!entry) err(`missing exports or main/module entry in ${pkgFile}`);
    exports = { '.': entry };
    self = false;
  }
  return { exports, name, self };
};
const resolveCtx = (args: Args, cwd: string = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  const outDir = resolve(base, args.outArg);
  const outRel = relative(base, outDir);
  if (!outRel || outRel === '.' || outRel.startsWith('..'))
    err(`refusing unsafe out dir ${args.outArg}; expected a child dir of ${base}`);
  return { cwd: base, outDir, pkg: readPkg(pkgFile), pkgDir: dirname(pkgFile), pkgFile };
};
const esbuildPkg = (pkgFile: string): string => {
  const file = resolve(dirname(pkgFile), 'test', 'build', 'package.json');
  return existsSync(file) ? file : pkgFile;
};
const loadDeps = (pkgFile: string): Deps => {
  // `esbuild` usually lives under `test/build`; TypeScript lives at the repo root.
  const esReq = createRequire(esbuildPkg(pkgFile));
  const tsReq = createRequire(pkgFile);
  const esbuild = (() => {
    try {
      return esReq('esbuild') as { build?: BuildLike };
    } catch {
      return err(`missing esbuild near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const rawTs = (() => {
    try {
      return tsReq('typescript') as TsLike | { default?: TsLike };
    } catch {
      return err(`missing typescript near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const ts = ('default' in rawTs && rawTs.default ? rawTs.default : rawTs) as TsLike;
  const build = esbuild.build;
  if (typeof build !== 'function') err(`expected esbuild.build near ${pkgFile}`);
  if (typeof ts.createProgram !== 'function')
    err(`expected TypeScript compiler API near ${pkgFile}`);
  return { build: build as BuildLike, ts };
};
const isPkgAll = (item: Pick<Item, 'dir' | 'out'>) => !item.dir && item.out === ALL;
const itemId = (pkg: Pkg, item: Pick<Item, 'dir' | 'export' | 'module' | 'out'>): string =>
  isPkgAll(item) ? pkg.name : `${item.module}/${item.export || ALL}`;
const outPath = (pkg: Pkg, item: Pick<Item, 'dir' | 'out'>, ext: string): string =>
  isPkgAll(item)
    ? `_tree_shaking_${slug(pkg.name)}.${ext}`
    : `${item.dir}/_tree_shaking_${item.out}.${ext}`;
const relSpec = (file: string) => (file.startsWith('.') ? file : `./${file}`);
const exportSpec = (pkg: Pkg, key: string, file: string) =>
  !pkg.self ? relSpec(file) : key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
const dirOf = (key: string, file: string) => {
  if (key === '.') return 'index';
  const base = basename(key, extname(key));
  return base === 'index' ? basename(dirname(file)) : base;
};
const labelOf = (key: string, file: string) => {
  if (key === '.') return 'index';
  const src = key === '.' ? file : key;
  const base = basename(src, extname(src));
  return base === 'index' ? basename(dirname(src)) : base;
};
const exportPath = (value: unknown): string => {
  if (typeof value === 'string') return value.endsWith('.js') ? value : '';
  if (!value || typeof value !== 'object') return '';
  for (const key of ['default', 'import', 'node']) {
    const path = exportPath((value as Record<string, unknown>)[key]);
    if (path) return path;
  }
  for (const path of Object.values(value)) {
    const res = exportPath(path);
    if (res) return res;
  }
  return '';
};
const listExports = (ts: TsLike, files: string[]) => {
  const prog = ts.createProgram(files, {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = prog.getTypeChecker();
  const res = new Map<string, string[]>();
  for (const file of files) {
    const sf = prog.getSourceFile(file);
    const sym = sf?.symbol || (sf && checker.getSymbolAtLocation(sf));
    if (!sf || !sym) err(`cannot inspect exports of ${file}`);
    res.set(
      file,
      checker
        .getExportsOfModule(sym)
        .map((entry) => entry.getName())
        .filter((name) => name !== 'default' && name !== '__esModule')
        .sort()
    );
  }
  return res;
};
const readModules = (ctx: Ctx, ts: TsLike): Mod[] => {
  const res: Mod[] = [];
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    const file = exportPath(value);
    if (!file) continue;
    const abs = resolve(ctx.pkgDir, file);
    readFileSync(abs, 'utf8');
    res.push({
      dir: dirOf(key, file),
      exports: [],
      file: abs,
      key,
      module: labelOf(key, file),
      spec: exportSpec(ctx.pkg, key, file),
    });
  }
  const names = listExports(
    ts,
    res.map((mod) => mod.file)
  );
  for (const mod of res) mod.exports = names.get(mod.file) || [];
  return res;
};
const fullSource = (mods: Mod[]) =>
  mods.map((mod) => `export * as ${camel(mod.dir)} from '${mod.spec}';`).join('\n') || 'export {};';
const exportSource = (spec: string, name: string) => `export { ${name} } from '${spec}';`;
const audit = (ts: TsLike, files: string[]) => {
  const prog = ts.createProgram(files, {
    allowJs: true,
    checkJs: true,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    noUnusedLocals: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const res = new Map<string, AuditItem[]>();
  for (const diag of ts.getPreEmitDiagnostics(prog).filter((diag) => UNUSED.has(diag.code))) {
    const sf = diag.file;
    if (!sf || diag.start === undefined) continue;
    const end = diag.start + (diag.length || 0);
    const { line } = sf.getLineAndCharacterOfPosition(diag.start);
    const text = sf.text
      .slice(diag.start, end || diag.start + 1)
      .split('\n')[0]
      .trim();
    if (UNUSED_IGNORE.has(text)) continue;
    const list = res.get(sf.fileName) || [];
    if (!list.some((item) => item.line === line + 1 && item.text === text))
      list.push({ code: diag.code, line: line + 1, text });
    res.set(sf.fileName, list);
  }
  return res;
};
const cases = (pkg: Pkg, mods: Mod[]): Item[] => {
  const res: Item[] = [
    {
      dir: '',
      export: '',
      global: camel(`${pkg.name}-full`),
      module: pkg.name,
      out: ALL,
      source: fullSource(mods),
    },
  ];
  for (const mod of mods) {
    res.push({
      dir: mod.dir,
      export: ALL,
      global: camel(`${pkg.name}-${mod.module}-full`),
      module: mod.module,
      out: ALL,
      source: `export * from '${mod.spec}';`,
    });
    for (const name of mod.exports) {
      res.push({
        dir: mod.dir,
        export: name,
        global: camel(`${pkg.name}-${mod.module}-${name}`),
        module: mod.module,
        out: name,
        source: exportSource(mod.spec, name),
      });
    }
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
  const res = await build({
    bundle: true,
    format: 'iife',
    globalName,
    logLevel: 'silent',
    metafile: true,
    minify,
    stdin: {
      contents: source,
      resolveDir: cwd,
      sourcefile: `${globalName}.js`,
    },
    write: false,
  });
  const maybeOutFiles = res.outputFiles;
  if (!maybeOutFiles?.length) err(`missing esbuild output for ${globalName}`);
  const outFiles = maybeOutFiles as { contents: Uint8Array }[];
  const out = outFiles[0];
  if (!out) err(`missing esbuild output for ${globalName}`);
  return out.contents;
};
const writeCase = async (ctx: Ctx, build: BuildLike, item: Item): Promise<Built> => {
  const file = join(ctx.outDir, outPath(ctx.pkg, item, 'js'));
  const minFile = join(ctx.outDir, outPath(ctx.pkg, item, 'min.js'));
  const [plain, min] = await Promise.all([
    bundle(build, item.source, item.global, ctx.cwd, false),
    bundle(build, item.source, item.global, ctx.cwd, true),
  ]);
  write(file, plain);
  write(minFile, min);
  return { ...item, file, min, minFile, plain };
};
const row = (ctx: Ctx, item: Item, out: Pick<Built, 'min' | 'minFile' | 'plain'>) => {
  const gz = gzipSync(out.min, { level: 9 });
  const zstd = zstdCompressSync(out.min, {
    params: { [constants.ZSTD_c_compressionLevel]: 22 },
  });
  return [
    item.module,
    item.export,
    relative(ctx.outDir, out.minFile) || basename(out.minFile),
    paint(String(decoder.decode(out.plain).split('\n').length)),
    paint(kb(out.min.length)),
    size(gz.length, out.min.length),
    size(zstd.length, out.min.length),
  ];
};

export const runCli = async (
  argv: string[],
  opts: { cwd?: string; load?: (pkgFile: string) => Deps } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  const ctx = resolveCtx(args, opts.cwd);
  npmInstall(dirname(esbuildPkg(ctx.pkgFile)));
  sweep(ctx.outDir);
  sweepTemps(dirname(ctx.outDir));
  const { build, ts } = (opts.load || loadDeps)(ctx.pkgFile);
  const mods = readModules(ctx, ts);
  const items = cases(ctx.pkg, mods);
  const headers = ['module', 'export', 'min bundle', 'LOC', 'min KB', 'gzip KB (%)', 'zstd KB (%)'];
  const sizes = [
    Math.max(headers[0].length, ...items.map((item) => item.module.length)),
    Math.max(headers[1].length, ...items.map((item) => item.export.length)),
    Math.max(headers[2].length, ...items.map((item) => outPath(ctx.pkg, item, 'min.js').length)),
    Math.max(headers[3].length, 5),
    Math.max(headers[4].length, 6),
    Math.max(headers[5].length, 18),
    Math.max(headers[6].length, 18),
  ];
  const print = table(console.log);
  print.drawHeader(sizes, headers);
  let prev: string[] | undefined;
  const built: Built[] = [];
  for (const item of items) {
    const out = await writeCase(ctx, build, item);
    built.push(out);
    prev = print.printRow(row(ctx, item, out), prev, sizes, headers.slice(0, 2));
  }
  print.drawSeparator(
    sizes,
    sizes.map(() => true)
  );
  const issues = audit(
    ts,
    built.map((item) => item.file)
  );
  if (!issues.size) return;
  for (const item of built) {
    const list = issues.get(item.file);
    if (!list?.length) continue;
    const names = list
      .slice(0, 6)
      .map((entry) => `${entry.text}@L${entry.line}`)
      .join(', ');
    const more = list.length > 6 ? `, +${list.length - 6} more` : '';
    console.error(`unused\t${itemId(ctx.pkg, item)}\t${names}${more}`);
  }
  err(`found unused locals in ${issues.size} release bundles`);
};

export const __TEST: TestApi = {
  esbuildPkg: esbuildPkg,
  exportPath: exportPath,
  itemId: itemId,
  loadDeps: loadDeps,
  outPath: outPath,
  parseArgs: parseArgs,
  resolveCtx: resolveCtx,
  slug: slug,
  sweepTemps: sweepTemps,
};

const main = async () => {
  try {
    await runCli(process.argv.slice(2));
  } catch (erro) {
    console.error((erro as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
