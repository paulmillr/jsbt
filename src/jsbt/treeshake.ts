#!/usr/bin/env -S node
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src/jsbt`, then run it after a fresh build.
Like `jsbt bundle`, it runs `npm install` in the selected build directory before checking.
File writes/deletes log through `fs-modify.ts` outside the OS temp directory.

It prints grouped `unused` issues for locals that still survive bundling.
All writes and any other modifications from this script MUST stay under the selected build/output directories.
Cleanup rule: keep diffs minimal. Prefer `/* @__PURE__ *\/` on the exact offending call/expression
first, instead of structural refactors. In practice esbuild can keep parents alive through
nested object-property builders, inline arithmetic args, and object literals whose member
initializers still look non-pure, so place the PURE marker as close as possible to the offender;
if a computed arg or top-level value still survives, a tiny pure IIFE is the next-smallest fix.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { npmInstall, sweepTemps, write } from '../fs-modify.ts';
import { exportPath, readPkg, type Pkg } from './public.ts';
import {
  camelParts,
  color,
  err,
  groupIssues,
  kb,
  loadModuleApi,
  loadTypeScriptApi,
  makeIssue,
  nodeText,
  paint,
  prepareRunDir,
  readSource,
  readText,
  relFile,
  resolveLocalImport,
  runSelf,
  table,
  wantColor,
  type Issue as LogIssue,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string; outArg: string };
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
export type TreeIssue = { file: string; id: string; line: number; text: string };
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

const decoder = new TextDecoder();
const ALL = 'all';
const UNUSED = new Set([6133, 6198]); // TS6133, TS6198 typescript errors
const UNUSED_IGNORE = new Set(['__require', '__toESM']);

const diff = (cur: number, base: number) => `${((cur / base - 1) * 100).toFixed(2)}%`;
const size = (cur: number, base: number) =>
  `${paint(kb(cur), color.green)} ${paint(`(${diff(cur, base)})`, color.dim)}`;
const camel = (s: string) => camelParts(s.split(/[^a-zA-Z0-9]+/).filter(Boolean));
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
const resolveCtx = (args: Args, cwd: string = process.cwd(), outArg?: string): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  const outDir = outArg ? resolve(outArg) : resolve(base, args.outArg);
  if (outArg && !isAbsolute(outArg)) err(`expected absolute out dir: ${outArg}`);
  if (!outArg) {
    const outRel = relative(base, outDir);
    if (!outRel || outRel === '.' || outRel.startsWith('..'))
      err(`refusing unsafe out dir ${args.outArg}; expected a child dir of ${base}`);
  }
  return { cwd: base, outDir, pkg: readPkg(pkgFile), pkgDir: dirname(pkgFile), pkgFile };
};
const esbuildPkg = (pkgFile: string): string => {
  const file = resolve(dirname(pkgFile), 'test', 'build', 'package.json');
  return existsSync(file) ? file : pkgFile;
};
const loadDepsFrom = (pkgFile: string, esbuildPkgFile: string): Deps => {
  // `esbuild` usually lives under `test/build`; TypeScript lives at the repo root.
  const esbuild = loadModuleApi<{ build?: BuildLike }>(esbuildPkgFile, 'esbuild', 'esbuild.build', [
    'build',
  ]);
  const ts = loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript compiler API', ['createProgram']);
  return { build: esbuild.build as BuildLike, ts };
};
const loadDeps = (pkgFile: string): Deps => loadDepsFrom(pkgFile, esbuildPkg(pkgFile));
const loadRunDeps = (pkgFile: string, esbuildPkgFile: string, fallbackPkgFile?: string): Deps => {
  try {
    return loadDepsFrom(pkgFile, esbuildPkgFile);
  } catch (error) {
    if (!fallbackPkgFile || !/missing esbuild near /.test((error as Error).message)) throw error;
    return loadDepsFrom(pkgFile, fallbackPkgFile);
  }
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
const bundleDir = (key: string, file: string) => {
  if (key === '.') return 'index';
  const base = basename(key, extname(key));
  return base === 'index' ? basename(dirname(file)) : base;
};
const bundleLabel = (key: string, file: string) => {
  if (key === '.') return 'index';
  const src = key === '.' ? file : key;
  const base = basename(src, extname(src));
  return base === 'index' ? basename(dirname(src)) : base;
};
const jsExportPath = (value: unknown): string =>
  exportPath(value, (path) => (path.endsWith('.js') ? path : ''));
const exported = (ts: TsLike, node: any): boolean =>
  !!node.modifiers?.some((mod: any) => mod.kind === ts.SyntaxKind.ExportKeyword);
const localSpec = (from: string, spec: string): string | undefined =>
  resolveLocalImport(from, spec, {
    accept: existsSync,
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
    if (name && name !== 'default' && name !== '__esModule') out.add(name);
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
const readModules = (ctx: Ctx, ts: TsLike): Mod[] => {
  const res: Mod[] = [];
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    const file = jsExportPath(value);
    if (!file) continue;
    const abs = resolve(ctx.pkgDir, file);
    readText(abs);
    res.push({
      dir: bundleDir(key, file),
      exports: [],
      file: abs,
      key,
      module: bundleLabel(key, file),
      spec: exportSpec(ctx.pkg, key, file),
    });
  }
  for (const mod of res) mod.exports = runtimeExports(ts, mod.file);
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
  return [
    item.module,
    item.export,
    relative(ctx.outDir, out.minFile) || basename(out.minFile),
    paint(String(decoder.decode(out.plain).split('\n').length), color.green),
    paint(kb(out.min.length), color.green),
    size(gz.length, out.min.length),
  ];
};
const treeIssue = (pkg: Pkg, item: Built, entry: AuditItem): TreeIssue => ({
  file: item.file,
  id: itemId(pkg, item),
  line: entry.line,
  text: entry.text,
});
export const treeIssueLog = (cwd: string | undefined, item: TreeIssue): LogIssue =>
  makeIssue(
    'error',
    relFile(cwd, item.file),
    `${item.line}/${item.text}`,
    `unused (${item.id})`,
    'treeshake'
  );

export const runCli = async (
  argv: string[],
  opts: {
    cwd?: string;
    load?: (pkgFile: string) => Deps;
    onIssue?: (issue: TreeIssue) => void;
    outDir?: string;
    quiet?: boolean;
    runDir?: string;
  } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  const ctx = resolveCtx(args, opts.cwd, opts.outDir);
  const runDir = opts.runDir ? prepareRunDir(ctx.cwd, ctx.pkg.name, opts.runDir) : undefined;
  const esbuildPkgFile = runDir ? join(runDir, 'package.json') : esbuildPkg(ctx.pkgFile);
  const fallbackEsbuildPkgFile = runDir ? esbuildPkg(ctx.pkgFile) : undefined;
  npmInstall(dirname(esbuildPkgFile));
  sweepTemps(ctx.outDir);
  sweepTemps(dirname(ctx.outDir));
  const { build, ts } = opts.load
    ? opts.load(ctx.pkgFile)
    : loadRunDeps(ctx.pkgFile, esbuildPkgFile, fallbackEsbuildPkgFile);
  const mods = readModules(ctx, ts);
  const items = cases(ctx.pkg, mods);
  const headers = ['module', 'export', 'min bundle', 'LOC', 'min KB', 'gzip KB (%)'];
  const sizes = [
    Math.max(headers[0].length, ...items.map((item) => item.module.length)),
    Math.max(headers[1].length, ...items.map((item) => item.export.length)),
    Math.max(headers[2].length, ...items.map((item) => outPath(ctx.pkg, item, 'min.js').length)),
    Math.max(headers[3].length, 5),
    Math.max(headers[4].length, 6),
    Math.max(headers[5].length, 18),
  ];
  const print = table(console.log);
  if (!opts.quiet) print.drawHeader(sizes, headers);
  let prev: string[] | undefined;
  const built: Built[] = [];
  for (const item of items) {
    const out = await writeCase(ctx, build, item);
    built.push(out);
    if (!opts.quiet) prev = print.printRow(row(ctx, item, out), prev, sizes, headers.slice(0, 2));
  }
  if (!opts.quiet) {
    print.drawSeparator(
      sizes,
      sizes.map(() => true)
    );
  }
  const issues = audit(
    ts,
    built.map((item) => item.file)
  );
  if (!issues.size) return;
  const logs: LogIssue[] = [];
  for (const item of built) {
    const list = issues.get(item.file);
    if (!list?.length) continue;
    for (const entry of list) {
      const issue = treeIssue(ctx.pkg, item, entry);
      opts.onIssue?.(issue);
      logs.push(treeIssueLog(ctx.cwd, issue));
    }
  }
  if (!opts.quiet)
    for (const line of groupIssues('treeshake', logs, wantColor())) console.error(line);
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

runSelf(import.meta.url, runCli);
