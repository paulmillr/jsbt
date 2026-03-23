#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src`, then run it after a fresh build.
Like `jsbt esbuild`, it runs `npm install` in the selected run/build directory before checking.
File writes/deletes log through `fs-modify.ts` and honor `JSBT_LOG_LEVEL`.

It audits the built public `.d.ts` export surface, requires JSDoc on every public export,
checks callable `@param` / `@returns` tags against the exported type shape,
and verifies examples for callable runtime exports.

Plain data constants do not need forced `@example` blocks,
and low-level callback / constructor factories may rely on prose instead of forced examples,
but any examples that exist are still executed.

Exported `type` / `interface` docs must explain the shape directly and must not use `@example`;
object members inside those types need their own JSDoc, typed members must not keep an old inline
trailing comment next to new JSDoc, and callable members need `@param` / `@returns` docs too.

Tagged JSDoc must use multiline blocks, and plain tagless JSDoc must use short one-line form instead of
a multiline block. Runtime examples should show real public usage: reject placeholders like `void Symbol;`, `{} as any`, or alias-only `type Example = Foo;`.

All writes and any other modifications from this script MUST stay under the selected run/build directory.
This checker takes only a package.json path, uses `test/build` next to it as the run directory,
and MUST fail if that fixture directory is missing or if `test/build/package.json`
does not install the checked package name as `"file:../.."`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { npmInstall, rm, sweep, write } from './fs-modify.ts';

declare const __JSBT_BUNDLE__: boolean | undefined;

type Args = { help: boolean; pkgArg: string };
type RawBuildPkg = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};
type RawPkg = {
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  name?: unknown;
  types?: unknown;
};
type Pkg = { exports: Record<string, unknown>; name: string; types: string };
type Ctx = { cwd: string; pkg: Pkg; pkgFile: string; runDir: string };
type Disp = { kind?: string; text: string };
type Tag = { name: string; paramName?: string; prose?: string; text?: string };
type Sym = {
  declarations?: any[];
  flags: number;
  getDocumentationComment: (checker: unknown) => Disp[];
  getJsDocTags: (checker: unknown) => Tag[];
  getName: () => string;
  valueDeclaration?: any;
};
type CheckerLike = {
  getAliasedSymbol: (sym: Sym) => Sym;
  getExportsOfModule: (sym: Sym) => Sym[];
  getPropertiesOfType?: (type: unknown) => Sym[];
  getSignaturesOfType: (type: unknown, kind: unknown) => SigLike[];
  getSymbolAtLocation: (node: unknown) => Sym | undefined;
  getTypeOfSymbolAtLocation: (sym: Sym, node: unknown) => unknown;
  getTypeAtLocation?: (node: unknown) => unknown;
  typeToString: (type: unknown) => string;
};
type HostLike = {
  fileExists?: (file: string) => boolean;
  getCurrentDirectory?: () => string;
  getDirectories?: (dir: string) => string[];
  getSourceFile?: (file: string, target: unknown, onError?: (msg: string) => void) => unknown;
  readFile?: (file: string) => string | undefined;
  realpath?: (file: string) => string;
  useCaseSensitiveFileNames?: () => boolean;
  writeFile?: () => void;
};
type ProgLike = {
  getSourceFile: (file: string) => any;
  getTypeChecker: () => CheckerLike;
};
type SigLike = { getReturnType: () => unknown; parameters: Sym[] };
type TsLike = {
  ModuleKind: { ESNext?: unknown; NodeNext?: unknown };
  ModuleResolutionKind?: { Bundler?: unknown; NodeNext?: unknown };
  ScriptTarget: { ESNext: unknown };
  SignatureKind: { Call: unknown; Construct: unknown };
  SymbolFlags: { Alias: number };
  createCompilerHost: (opts: Record<string, unknown>) => HostLike;
  createProgram: (files: string[], opts: Record<string, unknown>, host?: HostLike) => ProgLike;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => unknown;
  displayPartsToString?: (parts: Disp[]) => string;
  findConfigFile?: (
    dir: string,
    exists: (file: string) => boolean,
    name?: string
  ) => string | undefined;
  flattenDiagnosticMessageText?: (msg: Msg, newLine: string) => string;
  getPreEmitDiagnostics: (prog: unknown) => DiagnosticLike[];
  parseJsonConfigFileContent?: (
    config: unknown,
    host: unknown,
    base: string
  ) => { options: Record<string, unknown> };
  readConfigFile?: (
    file: string,
    read: (file: string) => string | undefined
  ) => { config?: unknown; error?: DiagnosticLike };
  sys: {
    fileExists: (file: string) => boolean;
    getDirectories: (dir: string) => string[];
    readFile: (file: string) => string | undefined;
    realpath?: (file: string) => string;
    useCaseSensitiveFileNames: boolean;
  };
};
type Msg = string | { messageText?: Msg; next?: Msg[] };
type DiagnosticLike = {
  file?: { fileName: string };
  messageText: Msg;
};
type TSDocLike = {
  TSDocConfiguration: new () => {
    addTagDefinitions: (defs: unknown[]) => void;
  };
  TSDocParser: new (cfg?: unknown) => {
    parseString: (text: string) => {
      docComment?: {
        customBlocks?: any[];
        params?: { blocks?: any[] };
        returnsBlock?: { content?: any };
        summarySection?: any;
      };
      log?: { messages?: { messageId?: unknown; unformattedText?: string }[] };
    };
  };
  TSDocTagDefinition: new (opts: { syntaxKind: unknown; tagName: string }) => unknown;
  TSDocTagSyntaxKind: { ModifierTag: unknown };
};
type ExecRes = {
  error?: Error;
  ok: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
};
type Mod = { dtsFile: string; jsFile: string; key: string; runtime: Set<string>; spec: string };
type Item = {
  bind: string;
  dtsFile: string;
  key: string;
  line: number;
  name: string;
  runtime: boolean;
  spec: string;
  sym: Sym;
};
type RefDoc = { docs: string; docProse: string; hasDocs: boolean; info: CallInfo; tags: Tag[] };
type DocItem = {
  bagRefs: Map<string, string>;
  docs: string;
  docProse: string;
  errors: string[];
  info: CallInfo;
  inline: string;
  name: string;
  plainLongSingle: boolean;
  ref?: RefDoc;
  single: boolean;
  tags: Tag[];
};
type Result = { failures: number; passed: number; skipped: number; warnings: number };
type CallInfo = {
  bagRefs: Record<string, string>;
  bags: Record<string, string[]>;
  fnParams: string[];
  kind: string;
  params: string[];
  returns: boolean;
};
type TypedDecl = { decl: any; kind: 'interface' | 'type'; members: any[] };
type DeclMeta = {
  docs: string;
  docProse: string;
  errors: string[];
  examples: Example[];
  hasDocs: boolean;
  plainLongSingle: boolean;
  single: boolean;
  tagNames: string[];
  tags: Tag[];
};
type SrcIndex = Map<string, Map<string, Map<string, string>>>;
type DocShape = { plainLongSingle: boolean; taggedSingle: boolean };
type Example = { code: string; errors: string[]; prose: string[] };
type ParsedDoc = {
  docProse: string;
  docs: string;
  errors: string[];
  examples: Example[];
  hasDocs: boolean;
  tags: Tag[];
};
type TestApi = {
  bindOf: typeof bindOf;
  dtsPathOf: typeof dtsPathOf;
  docShape: typeof docShape;
  exampleDoc: typeof exampleDoc;
  inject: typeof inject;
  isIgnored: typeof isIgnored;
  isTrivial: typeof isTrivial;
  jsPathOf: typeof jsPathOf;
  normalizeDoc: typeof normalizeDoc;
  parseParam: typeof parseParam;
  parseReturn: typeof parseReturn;
  placeholderExample: typeof placeholderExample;
  prototypeThrows: typeof prototypeThrows;
  prototypeThrowsRaw: typeof prototypeThrowsRaw;
  shouldInject: typeof shouldInject;
  sweepTemps: typeof sweepTemps;
};
type ThrowInfo = { direct: Set<string>; thrown: Set<string>; unknown: boolean };
type ThrowRawReport = {
  direct: string[];
  docs: string[];
  dtsFile: string;
  key: string;
  name: string;
  thrown: string[];
  unknown: boolean;
};
type ThrowReport = ThrowRawReport & { issues: string[] };
type AbsBool =
  | { kind: 'and'; items: AbsBool[] }
  | { kind: 'atom'; id: string }
  | { kind: 'const'; value: boolean }
  | { kind: 'not'; item: AbsBool }
  | { kind: 'or'; items: AbsBool[] };
type AbsVal =
  | { kind: 'bigint'; value: bigint }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'undefined' }
  | { kind: 'unknown' };
type EnvEntry = { bool?: AbsBool; value?: AbsVal };
type Env = Map<string, EnvEntry>;
type Facts = Map<string, boolean>;
type Flow = { env: Env; facts: Facts };

const usage = `usage:
  jsbt tsdoc <package.json>

examples:
  jsbt tsdoc package.json
  node /path/to/check-jsdoc.ts package.json`;

const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;

const color = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
};

const err = (msg: string): never => {
  throw new Error(msg);
};
const flatten = (msg: Msg): string => {
  if (typeof msg === 'string') return msg;
  const head = msg.messageText ? flatten(msg.messageText) : '';
  const tail = (msg.next || []).map(flatten).filter(Boolean).join(' ');
  return [head, tail].filter(Boolean).join(' ');
};
const partsText = (parts?: Disp[]) => parts?.map((part) => part.text).join('') || '';
const tagText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? partsText(value as Disp[]) : '';
};
const paint = (text: string, code: string, on: boolean) =>
  on ? `${code}${text}${color.reset}` : text;
const wantColor = (env: NodeJS.ProcessEnv = process.env, tty = !!process.stdout.isTTY) => {
  if (env.NO_COLOR) return false;
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
};
const status = (name: 'error' | 'pass' | 'warn', on: boolean) => {
  const word = paint(
    name,
    name === 'error' ? color.red : name === 'warn' ? color.yellow : color.green,
    on
  );
  return `[${word}]`;
};
const guardChild = (cwd: string, file: string, label: string) => {
  const rel = relative(cwd, file);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel))
    err(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const readPkg = (pkgFile: string): Pkg => {
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
const pickRunDir = (cwd: string, pkg: Pkg): string => {
  const dir = join(cwd, 'test', 'build');
  const buildPkgFile = join(dir, 'package.json');
  if (!existsSync(buildPkgFile))
    err(`expected test/build/package.json next to ${pkg.name || 'package.json'}`);
  const buildPkg = JSON.parse(readFileSync(buildPkgFile, 'utf8')) as RawBuildPkg;
  const dep =
    buildPkg.dependencies?.[pkg.name] ||
    buildPkg.devDependencies?.[pkg.name] ||
    buildPkg.optionalDependencies?.[pkg.name];
  if (dep !== 'file:../..')
    err(
      `expected test/build/package.json to install ${pkg.name} as "file:../.."; got ${JSON.stringify(dep)}`
    );
  return dir;
};
const sweepTemps = (cwd: string): void => {
  sweep(cwd);
};
const resolveCtx = (args: Args, cwd = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  const root = dirname(pkgFile);
  const pkg = readPkg(pkgFile);
  return { cwd: root, pkg, pkgFile, runDir: pickRunDir(root, pkg) };
};
const jsPathOf = (value: unknown): string => {
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
const dtsPathOf = (value: unknown): string => {
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
const listModules = (ctx: Ctx): Mod[] => {
  const mods: Mod[] = [];
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
    mods.push({ dtsFile, jsFile, key, runtime: new Set(), spec: exportSpec(ctx.pkg, key) });
  }
  if (!mods.length) err(`no public modules found in ${ctx.pkgFile}`);
  return mods.sort((a, b) => a.key.localeCompare(b.key));
};
const loadTs = (pkgFile: string): TsLike => {
  const req = createRequire(pkgFile);
  const rawTs = (() => {
    try {
      return req('typescript') as TsLike | { default?: TsLike };
    } catch {
      return err(`missing typescript near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const ts = ('default' in rawTs && rawTs.default ? rawTs.default : rawTs) as TsLike;
  if (typeof ts.createProgram !== 'function')
    err(`expected TypeScript compiler API near ${pkgFile}`);
  return ts;
};
const loadTSDoc = (pkgFile: string): TSDocLike => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req('@microsoft/tsdoc') as TSDocLike | { default?: TSDocLike };
    } catch {}
    try {
      const jsbtPkg = req.resolve('@paulmillr/jsbt/package.json');
      const jsbtReq = createRequire(jsbtPkg);
      return jsbtReq('@microsoft/tsdoc') as TSDocLike | { default?: TSDocLike };
    } catch {
      return err(
        `missing @microsoft/tsdoc near ${pkgFile}; reinstall @paulmillr/jsbt or run npm install in the target repo first`
      );
    }
  })();
  const tsdoc = ('default' in raw && raw.default ? raw.default : raw) as TSDocLike;
  if (typeof tsdoc.TSDocParser !== 'function') err(`expected TSDoc parser API near ${pkgFile}`);
  return tsdoc;
};
const tsOpts = (ts: TsLike, cwd: string) => {
  const file = ts.findConfigFile?.(cwd, ts.sys.fileExists, 'tsconfig.json');
  const base = (() => {
    if (!file || !ts.readConfigFile || !ts.parseJsonConfigFileContent) return {};
    const res = ts.readConfigFile(file, ts.sys.readFile);
    if (res.error) return {};
    return ts.parseJsonConfigFileContent(res.config || {}, ts.sys, dirname(file)).options || {};
  })();
  return {
    ...base,
    allowImportingTsExtensions: true,
    module: base.module || ts.ModuleKind.NodeNext || ts.ModuleKind.ESNext,
    moduleResolution:
      base.moduleResolution ||
      ts.ModuleResolutionKind?.NodeNext ||
      ts.ModuleResolutionKind?.Bundler,
    noEmit: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    rootDir: cwd,
    skipLibCheck: true,
    target: base.target || ts.ScriptTarget.ESNext,
  };
};
const checkTypes = (ts: TsLike, cwd: string, code: string) => {
  const file = join(cwd, '.__jsdoc-check.ts');
  const opts = tsOpts(ts, cwd);
  const host = ts.createCompilerHost(opts);
  const fileExists = host.fileExists?.bind(host) || ts.sys.fileExists;
  const readFile = host.readFile?.bind(host) || ts.sys.readFile;
  const getSourceFile = host.getSourceFile?.bind(host);
  const sys = ts.sys;
  host.fileExists = (name) => (resolve(name) === file ? true : fileExists(name));
  host.readFile = (name) => (resolve(name) === file ? code : readFile(name));
  host.getCurrentDirectory = () => cwd;
  host.getDirectories = (dir) => sys.getDirectories(dir);
  host.realpath = (name) => sys.realpath?.(name) || name;
  host.useCaseSensitiveFileNames = () => sys.useCaseSensitiveFileNames;
  host.writeFile = () => {};
  host.getSourceFile = (name, target, onError) => {
    if (resolve(name) === file) return ts.createSourceFile(name, code, target, true);
    if (!getSourceFile) return undefined;
    return getSourceFile(name, target, onError);
  };
  const prog = ts.createProgram([file], opts, host);
  return ts
    .getPreEmitDiagnostics(prog)
    .filter((diag) => !diag.file || diag.file.fileName === file)
    .map((diag) =>
      ts.flattenDiagnosticMessageText
        ? ts.flattenDiagnosticMessageText(diag.messageText, '\n')
        : flatten(diag.messageText)
    )
    .filter(Boolean);
};
let nextId = 0;
const workerCode = `
import { parentPort, workerData } from 'node:worker_threads';
try {
  await import(workerData.file);
  parentPort?.postMessage({ ok: true });
} catch (err_) {
  console.error(err_);
  parentPort?.postMessage({ ok: false });
}
`;
const runCode = async (code: string, cwd: string): Promise<ExecRes> => {
  const file = join(cwd, `.__jsdoc-check-${process.pid}-${++nextId}.ts`);
  write(file, code);
  try {
    return await new Promise<ExecRes>((resolveRes) => {
      const prev = process.cwd();
      process.chdir(cwd);
      let done = false;
      let result: { ok?: boolean } | undefined;
      let stdout = '';
      let stderr = '';
      const finish = (res: ExecRes) => {
        if (done) return;
        done = true;
        process.chdir(prev);
        resolveRes({ ...res, stderr, stdout });
      };
      const stop = async (res: ExecRes) => {
        try {
          const code = await worker.terminate();
          if (res.status === null) res.status = code;
        } catch {}
        finish(res);
      };
      let worker: Worker;
      try {
        worker = new Worker(workerCode, {
          eval: true,
          execArgv: ['--experimental-strip-types'],
          stderr: true,
          stdout: true,
          type: 'module',
          workerData: { file: pathToFileURL(file).href },
        } as any);
      } catch (error) {
        finish({ error: error as Error, ok: false, status: null, stderr: '', stdout: '' });
        return;
      }
      const out = worker.stdout as any;
      const err2 = worker.stderr as any;
      out?.setEncoding?.('utf8');
      err2?.setEncoding?.('utf8');
      out?.on?.('data', (chunk: string) => (stdout += chunk));
      err2?.on?.('data', (chunk: string) => (stderr += chunk));
      worker.once('message', (msg: { ok?: boolean }) => {
        result = msg;
        if (msg?.ok) return void stop({ ok: true, status: 0, stderr: '', stdout: '' });
        return void stop({ ok: false, status: 1, stderr: '', stdout: '' });
      });
      worker.once(
        'error',
        (error) => void stop({ error, ok: false, status: null, stderr: '', stdout: '' })
      );
      worker.once('exit', (code) => {
        if (done) return;
        setImmediate(() => {
          if (done || result) return;
          finish({
            error: code === 0 ? undefined : new Error(`exit ${code}`),
            ok: code === 0,
            status: code,
            stderr: '',
            stdout: '',
          });
        });
      });
    });
  } finally {
    rm(file);
  }
};
const firstText = (text = '') =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
const compact = (items: string[]) => {
  const list = items.map((item) => item.trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, 3).join('; ')}${list.length > 3 ? `; +${list.length - 3} more` : ''}`;
};
const loadProgram = (ts: TsLike, files: string[], allowJs = false) =>
  ts.createProgram(files, {
    allowJs,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
const moduleExports = (checker: CheckerLike, sf: any, file: string) => {
  const sym = sf?.symbol || checker.getSymbolAtLocation(sf);
  if (!sf || !sym) err(`cannot inspect exports of ${file}`);
  return checker.getExportsOfModule(sym);
};
const idOf = (item: Pick<Item, 'dtsFile' | 'name'>) => `${basename(item.dtsFile)}:${item.name}`;
const lineOf = (sym: Sym): number => {
  const node = sym.valueDeclaration || sym.declarations?.[0];
  const sf = node?.getSourceFile?.();
  if (!node || !sf?.getLineAndCharacterOfPosition) return 0;
  const pos = node.getStart ? node.getStart(sf) : node.pos || 0;
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
};
const isTrivial = (text: string, name = ''): boolean => {
  const norm = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[`*_()[\]{}<>,.:;'"/\\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const value = norm(text);
  if (!value) return true;
  if (name && value === norm(name)) return true;
  return value === 'return' || value === 'returns';
};
const normalizeDoc = (raw: string): string =>
  raw.replace(/(^|\n)(\s*\*\s*)@return\b/g, '$1$2@returns');
const todoTag = /(^|\n)\s*\*\s*@todo\b/;
const parseParam = (tag: Tag): { desc: string; name: string } => ({
  desc: (tag.text || '').replace(/^\s*-\s*/, '').trim(),
  name: (tag.paramName || '').replace(/^\[|\]$/g, ''),
});
const parseReturn = (tag: Tag): string => (tag.text || '').replace(/^\s*-\s*/, '').trim();
const hasLink = (text: string): boolean => /\{@link\b/.test(text);
const isTsLibDecl = (decl: any): boolean =>
  /(?:^|\/)lib\.[^/]+\.d\.ts$/.test(decl?.getSourceFile?.()?.fileName || '');
const declOf = (sym: Sym) => sym.valueDeclaration || sym.declarations?.[0];
const docNode = (node: any): any => {
  let cur = node;
  while (cur) {
    if (cur?.jsDoc?.length) return cur;
    cur = cur.parent;
  }
  return node;
};
const mdLink = /\[[^\]\n]+\]\([^)]+\)/;
const rawLink = /\bhttps?:\/\/\S+/i;
const proseLinkIssues = (text: string): string[] => {
  const issues: string[] = [];
  if (mdLink.test(text)) issues.push('markdown links are not allowed; use {@link ...}');
  if (rawLink.test(text)) issues.push('plain URLs are not allowed; use {@link ...}');
  return issues;
};
const linkIssues = (docs: string, tags: Tag[]): string[] => {
  const issues: string[] = [];
  issues.push(...proseLinkIssues(docs));
  for (const tag of tags) {
    if (tag.name === 'example') continue;
    for (const issue of proseLinkIssues(tag.prose || tag.text || ''))
      issues.push(issue.replace(' are not allowed', ` are not allowed in @${tag.name}`));
  }
  return issues;
};
const throwsIssues = (tags: Tag[]): string[] => {
  const issues: string[] = [];
  for (const tag of tags) {
    if (tag.name !== 'throws') continue;
    const text = [tag.text || '', tag.prose || ''].filter(Boolean).join('\n');
    const first = firstText(tag.text || tag.prose || '');
    if (!hasLink(text)) issues.push('@throws should include a linked thrown type with {@link ...}');
    if (first.startsWith('{@link'))
      issues.push('@throws should explain the failure first and move {@link ...} after the prose');
  }
  return issues;
};
const throwTagTypes = (tags: Tag[]): Set<string> => {
  const out = new Set<string>();
  for (const tag of tags) {
    if (tag.name !== 'throws') continue;
    const text = [tag.text || '', tag.prose || ''].filter(Boolean).join('\n');
    for (const match of text.matchAll(/\{@link\s+([^\s}|]+)/g)) {
      const raw = (match[1] || '').trim();
      const tail = /([A-Z][A-Za-z0-9_]*)$/.exec(raw)?.[1] || raw.split(/[.#/]/).at(-1) || raw;
      if (tail) out.add(tail);
    }
  }
  return out;
};
const throwsExample = (name: string): string => {
  if (name === 'TypeError') return '@throws On wrong argument types. {@link TypeError}';
  if (name === 'RangeError')
    return '@throws On wrong argument ranges or values. {@link RangeError}';
  if (name === 'Error')
    return '@throws If a documented runtime validation or state check fails. {@link Error}';
  return `@throws If a documented ${name} condition is hit. {@link ${name}}`;
};
const throwsCoverageIssues = (tags: Tag[], info: ThrowInfo): string[] => {
  const throwTags = tags.filter((tag) => tag.name === 'throws');
  const issues: string[] = [];
  const docs = throwTagTypes(tags);
  if (!info.thrown.size) {
    if (throwTags.length && !info.unknown)
      return ['remove @throws; no thrown errors were inferred from the current implementation'];
    return [];
  }
  if (!info.unknown) {
    for (const name of [...info.thrown].sort()) {
      if (!docs.has(name))
        issues.push(`missing @throws for ${name}; e.g. "${throwsExample(name)}"`);
    }
    for (const name of [...docs].sort()) {
      if (!info.thrown.has(name))
        issues.push(
          `remove stale @throws for ${name}; it is not inferred from the current implementation`
        );
    }
    return issues;
  }
  if (info.direct.size) {
    for (const name of [...info.direct].sort()) {
      if (docs.has(name)) continue;
      issues.push(`missing @throws for ${name}; e.g. "${throwsExample(name)}"`);
    }
    return issues;
  }
  if (throwTags.length) {
    if (info.thrown.size === 1 && !info.unknown) {
      const [name] = [...info.thrown];
      if (!docs.has(name))
        issues.push(`missing @throws for ${name}; e.g. "${throwsExample(name)}"`);
    }
    return issues;
  }
  if (info.thrown.size === 1 && !info.unknown) {
    const [name] = [...info.thrown];
    issues.push(`missing @throws for ${name}; e.g. "${throwsExample(name)}"`);
    return issues;
  }
  issues.push(
    'missing @throws; document the known thrown conditions with prose first and a linked error type'
  );
  return issues;
};
const emptyThrows = (): ThrowInfo => ({
  direct: new Set<string>(),
  thrown: new Set<string>(),
  unknown: false,
});
const mergeThrows = (...infos: ThrowInfo[]): ThrowInfo => {
  const out = emptyThrows();
  for (const info of infos) {
    out.unknown ||= info.unknown;
    for (const name of info.direct) out.direct.add(name);
    for (const name of info.thrown) out.thrown.add(name);
  }
  return out;
};
const mergeThrownOnly = (base: ThrowInfo, info: ThrowInfo): ThrowInfo => {
  base.unknown ||= info.unknown;
  for (const name of info.thrown) base.thrown.add(name);
  return base;
};
const isLocalDecl = (root: string, decl: any): boolean => {
  const file = decl?.getSourceFile?.()?.fileName || '';
  if (!file) return false;
  if (/(?:^|\/)node_modules\//.test(file)) return false;
  if (/\.d\.(?:c|m)?ts$/.test(file)) return false;
  const rel = relative(root, file);
  return !!rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel);
};
const throwClassLike = (name: string): boolean => /^[A-Z][A-Za-z0-9_$.]*$/.test(name);
const throwName = (checker: CheckerLike, expr: any): string => {
  if (!expr) return '';
  const sym = checker.getSymbolAtLocation(expr.expression || expr);
  if (sym) {
    const name = sym.getName();
    return throwClassLike(name) ? name : '';
  }
  const type = checker.getTypeAtLocation?.(expr);
  const text = type ? checker.typeToString(type).trim() : '';
  if (!text || text === 'never' || text === 'unknown' || text === 'any') return '';
  return throwClassLike(text) ? text : '';
};
const bodyOfDecl = (ts: TsLike, decl: any): any => {
  const api = ts as any;
  if (decl?.body) return decl.body;
  if (api.isVariableDeclaration?.(decl)) {
    const init = decl.initializer;
    if (api.isArrowFunction?.(init) || api.isFunctionExpression?.(init)) return init.body;
  }
  return undefined;
};
const absUndef = (): AbsVal => ({ kind: 'undefined' });
const absUnknown = (): AbsVal => ({ kind: 'unknown' });
const boolConst = (value: boolean): AbsBool => ({ kind: 'const', value });
const boolAtom = (id: string): AbsBool => ({ kind: 'atom', id });
const boolNot = (item: AbsBool): AbsBool => {
  if (item.kind === 'const') return boolConst(!item.value);
  if (item.kind === 'not') return item.item;
  return { kind: 'not', item };
};
const boolAnd = (...raw: AbsBool[]): AbsBool => {
  const items: AbsBool[] = [];
  for (const cur of raw) {
    if (cur.kind === 'const') {
      if (!cur.value) return cur;
      continue;
    }
    if (cur.kind === 'and') items.push(...cur.items);
    else items.push(cur);
  }
  if (!items.length) return boolConst(true);
  if (items.length === 1) return items[0];
  return { kind: 'and', items };
};
const boolOr = (...raw: AbsBool[]): AbsBool => {
  const items: AbsBool[] = [];
  for (const cur of raw) {
    if (cur.kind === 'const') {
      if (cur.value) return cur;
      continue;
    }
    if (cur.kind === 'or') items.push(...cur.items);
    else items.push(cur);
  }
  if (!items.length) return boolConst(false);
  if (items.length === 1) return items[0];
  return { kind: 'or', items };
};
const exprText = (node: any): string => {
  const sf = node?.getSourceFile?.();
  if (node?.getText) return node.getText(sf).trim();
  const text = sf?.text;
  const start = node?.getStart?.(sf) ?? node?.pos;
  const end = node?.end;
  return typeof text === 'string' && typeof start === 'number' && typeof end === 'number'
    ? text.slice(start, end).trim()
    : '';
};
const boolValue = (expr: AbsBool, facts: Facts): boolean | undefined => {
  switch (expr.kind) {
    case 'const':
      return expr.value;
    case 'atom':
      return facts.get(expr.id);
    case 'not': {
      const value = boolValue(expr.item, facts);
      return value === undefined ? undefined : !value;
    }
    case 'and': {
      let unknown = false;
      for (const item of expr.items) {
        const value = boolValue(item, facts);
        if (value === false) return false;
        if (value === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case 'or': {
      let unknown = false;
      for (const item of expr.items) {
        const value = boolValue(item, facts);
        if (value === true) return true;
        if (value === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
  }
};
const applyFacts = (facts: Facts, expr: AbsBool, value: boolean): Facts[] => {
  const current = boolValue(expr, facts);
  if (current !== undefined) return current === value ? [new Map(facts)] : [];
  if (expr.kind === 'atom') {
    const next = new Map(facts);
    next.set(expr.id, value);
    return [next];
  }
  if (expr.kind === 'not') return applyFacts(facts, expr.item, !value);
  if (expr.kind === 'and') {
    if (!value) return expr.items.flatMap((item) => applyFacts(new Map(facts), item, false));
    let states: Facts[] = [new Map(facts)];
    for (const item of expr.items) {
      states = states.flatMap((state) => applyFacts(state, item, true));
      if (!states.length) return [];
    }
    return states;
  }
  if (expr.kind === 'or') {
    if (value) return expr.items.flatMap((item) => applyFacts(new Map(facts), item, true));
    let states: Facts[] = [new Map(facts)];
    for (const item of expr.items) {
      states = states.flatMap((state) => applyFacts(state, item, false));
      if (!states.length) return [];
    }
    return states;
  }
  return [];
};
const truthyVal = (value: AbsVal): boolean | undefined => {
  switch (value.kind) {
    case 'bool':
      return value.value;
    case 'undefined':
    case 'null':
      return false;
    case 'number':
      return !!value.value;
    case 'string':
      return !!value.value;
    case 'bigint':
      return value.value !== 0n;
    default:
      return;
  }
};
const typeOfVal = (value: AbsVal): string | undefined => {
  switch (value.kind) {
    case 'bool':
      return 'boolean';
    case 'undefined':
      return 'undefined';
    case 'null':
      return 'object';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'bigint':
      return 'bigint';
    default:
      return;
  }
};
const eqVal = (a: AbsVal, b: AbsVal): boolean | undefined => {
  if (a.kind === 'unknown' || b.kind === 'unknown') return;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'undefined':
    case 'null':
      return true;
    case 'bool':
    case 'number':
    case 'string':
    case 'bigint':
      return a.value === (b as any).value;
    default:
      return;
  }
};
const envGet = (env: Env, name: string): EnvEntry => env.get(name) || {};
const bindParams = (
  ts: TsLike,
  decl: any,
  args: any[],
  evalValue: (node: any, env: Env, facts: Facts) => AbsVal,
  evalBool: (node: any, env: Env, facts: Facts) => AbsBool,
  env: Env,
  facts: Facts
): Env => {
  const api = ts as any;
  const next = new Map<string, EnvEntry>();
  const params = decl?.parameters || decl?.initializer?.parameters || [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (!api.isIdentifier?.(param.name)) continue;
    const arg = i < args.length ? args[i] : param.initializer;
    if (!arg) {
      next.set(param.name.text, { value: absUndef(), bool: boolConst(false) });
      continue;
    }
    next.set(param.name.text, {
      value: evalValue(arg, env, facts),
      bool: evalBool(arg, env, facts),
    });
  }
  return next;
};
const inferThrows = (() => {
  const cache = new WeakMap<object, ThrowInfo>();
  const active = new WeakSet<object>();
  return (ts: TsLike, checker: CheckerLike, root: string, decl: any, seedEnv?: Env): ThrowInfo => {
    if (!decl || typeof decl !== 'object') return emptyThrows();
    if (!seedEnv) {
      const hit = cache.get(decl);
      if (hit) return hit;
    }
    if (active.has(decl)) return emptyThrows();
    active.add(decl);
    const api = ts as any;
    const evalValue = (node: any, env: Env, facts: Facts): AbsVal => {
      if (!node || typeof node !== 'object') return absUnknown();
      if (api.isParenthesizedExpression?.(node)) return evalValue(node.expression, env, facts);
      if (api.isIdentifier?.(node)) {
        if (node.text === 'undefined') return absUndef();
        const hit = envGet(env, node.text);
        return hit.value || absUnknown();
      }
      if (api.isStringLiteralLike?.(node)) return { kind: 'string', value: node.text };
      if (api.isNumericLiteral?.(node)) return { kind: 'number', value: Number(node.text) };
      if (api.isBigIntLiteral?.(node))
        return { kind: 'bigint', value: BigInt(node.text.slice(0, -1)) };
      if (node.kind === api.SyntaxKind?.TrueKeyword) return { kind: 'bool', value: true };
      if (node.kind === api.SyntaxKind?.FalseKeyword) return { kind: 'bool', value: false };
      if (node.kind === api.SyntaxKind?.NullKeyword) return { kind: 'null' };
      if (api.isPrefixUnaryExpression?.(node)) {
        const value = evalValue(node.operand, env, facts);
        if (value.kind === 'number' && node.operator === api.SyntaxKind?.MinusToken)
          return { kind: 'number', value: -value.value };
        if (value.kind === 'number' && node.operator === api.SyntaxKind?.PlusToken) return value;
      }
      const question = node.questionDotToken !== undefined;
      if (
        (api.isPropertyAccessExpression?.(node) || api.isPropertyAccessChain?.(node)) &&
        node.name?.text === 'length'
      ) {
        const base = evalValue(node.expression, env, facts);
        if (question && (base.kind === 'undefined' || base.kind === 'null')) return absUndef();
        if (base.kind === 'string') return { kind: 'number', value: base.value.length };
        return absUnknown();
      }
      if (api.isConditionalExpression?.(node)) {
        const cond = boolValue(evalBool(node.condition, env, facts), facts);
        if (cond === true) return evalValue(node.whenTrue, env, facts);
        if (cond === false) return evalValue(node.whenFalse, env, facts);
      }
      if (api.isTypeOfExpression?.(node)) {
        const value = evalValue(node.expression, env, facts);
        const text = typeOfVal(value);
        return text === undefined ? absUnknown() : { kind: 'string', value: text };
      }
      return absUnknown();
    };
    const evalBool = (node: any, env: Env, facts: Facts): AbsBool => {
      if (!node || typeof node !== 'object') return boolAtom('unknown');
      if (api.isParenthesizedExpression?.(node)) return evalBool(node.expression, env, facts);
      if (api.isCallExpression?.(node)) {
        const callee = node.expression?.getText?.() || '';
        if (callee === 'Number.isSafeInteger') {
          const value = evalValue(node.arguments?.[0], env, facts);
          if (value.kind === 'number') return boolConst(Number.isSafeInteger(value.value));
          if (value.kind !== 'unknown') return boolConst(false);
        }
      }
      if (api.isIdentifier?.(node)) {
        const hit = envGet(env, node.text);
        if (hit.bool) return hit.bool;
        if (hit.value?.kind === 'bool') return boolConst(hit.value.value);
        return boolAtom(node.text);
      }
      if (node.kind === api.SyntaxKind?.TrueKeyword) return boolConst(true);
      if (node.kind === api.SyntaxKind?.FalseKeyword) return boolConst(false);
      if (
        api.isPrefixUnaryExpression?.(node) &&
        node.operator === api.SyntaxKind?.ExclamationToken
      ) {
        const value = truthyVal(evalValue(node.operand, env, facts));
        if (value !== undefined) return boolConst(!value);
        return boolNot(evalBool(node.operand, env, facts));
      }
      if (api.isBinaryExpression?.(node)) {
        const op = node.operatorToken.kind;
        if (op === api.SyntaxKind?.AmpersandAmpersandToken)
          return boolAnd(evalBool(node.left, env, facts), evalBool(node.right, env, facts));
        if (op === api.SyntaxKind?.BarBarToken)
          return boolOr(evalBool(node.left, env, facts), evalBool(node.right, env, facts));
        const left = evalValue(node.left, env, facts);
        const right = evalValue(node.right, env, facts);
        const eq = eqVal(left, right);
        if (
          op === api.SyntaxKind?.EqualsEqualsEqualsToken ||
          op === api.SyntaxKind?.EqualsEqualsToken
        )
          return eq === undefined ? boolAtom(exprText(node)) : boolConst(eq);
        if (
          op === api.SyntaxKind?.ExclamationEqualsEqualsToken ||
          op === api.SyntaxKind?.ExclamationEqualsToken
        )
          return eq === undefined ? boolAtom(exprText(node)) : boolConst(!eq);
        if (left.kind !== 'unknown' && right.kind !== 'unknown') {
          const a = (left as any).value;
          const b = (right as any).value;
          if (op === api.SyntaxKind?.LessThanToken) return boolConst(a < b);
          if (op === api.SyntaxKind?.LessThanEqualsToken) return boolConst(a <= b);
          if (op === api.SyntaxKind?.GreaterThanToken) return boolConst(a > b);
          if (op === api.SyntaxKind?.GreaterThanEqualsToken) return boolConst(a >= b);
        }
        return boolAtom(exprText(node));
      }
      const value = truthyVal(evalValue(node, env, facts));
      if (value !== undefined) return boolConst(value);
      return boolAtom(exprText(node));
    };
    const callThrows = (expr: any, env: Env, facts: Facts): ThrowInfo => {
      const sym0 = checker.getSymbolAtLocation(expr?.expression || expr);
      if (!sym0) return emptyThrows();
      const sym = sym0.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym0) : sym0;
      const infos: ThrowInfo[] = [];
      for (const next of sym.declarations || (sym.valueDeclaration ? [sym.valueDeclaration] : [])) {
        if (!isLocalDecl(root, next)) continue;
        const body = bodyOfDecl(ts, next);
        if (!body) continue;
        const args = expr?.arguments ? Array.from(expr.arguments) : [];
        infos.push(
          inferThrows(
            ts,
            checker,
            root,
            next,
            bindParams(ts, next, args, evalValue, evalBool, env, facts)
          )
        );
      }
      return infos.length ? mergeThrows(...infos) : emptyThrows();
    };
    const throwExpr = (
      expr: any,
      env: Env,
      facts: Facts,
      caught?: { name: string; info: ThrowInfo }
    ): ThrowInfo => {
      if (!expr || typeof expr !== 'object') return emptyThrows();
      if (caught && api.isIdentifier?.(expr) && expr.text === caught.name) return caught.info;
      if (api.isParenthesizedExpression?.(expr))
        return throwExpr(expr.expression, env, facts, caught);
      if (api.isConditionalExpression?.(expr)) {
        const cond = boolValue(evalBool(expr.condition, env, facts), facts);
        if (cond === true) return throwExpr(expr.whenTrue, env, facts, caught);
        if (cond === false) return throwExpr(expr.whenFalse, env, facts, caught);
        return mergeThrows(
          throwExpr(expr.whenTrue, env, facts, caught),
          throwExpr(expr.whenFalse, env, facts, caught)
        );
      }
      const out = emptyThrows();
      const name = throwName(checker, expr);
      if (name) {
        out.direct.add(name);
        out.thrown.add(name);
      } else out.unknown = true;
      return out;
    };
    const walkExpr = (
      node: any,
      env: Env,
      facts: Facts,
      caught?: { name: string; info: ThrowInfo }
    ): ThrowInfo => {
      if (!node || typeof node !== 'object') return emptyThrows();
      if (api.isFunctionLike?.(node) && node !== decl) return emptyThrows();
      if (api.isThrowStatement?.(node)) return throwExpr(node.expression, env, facts, caught);
      let out = emptyThrows();
      if (api.isCallExpression?.(node) || api.isNewExpression?.(node))
        out = mergeThrownOnly(out, callThrows(node, env, facts));
      api.forEachChild(node, (child: any) => {
        out = mergeThrows(out, walkExpr(child, env, facts, caught));
      });
      return out;
    };
    const walkStmt = (
      node: any,
      env: Env,
      facts: Facts,
      caught?: { name: string; info: ThrowInfo }
    ): { flows: Flow[]; info: ThrowInfo } => {
      if (!node || typeof node !== 'object')
        return { flows: [{ env, facts }], info: emptyThrows() };
      if (api.isBlock?.(node))
        return walkList(node.statements || [], [{ env: new Map(env), facts }], caught);
      if (api.isVariableStatement?.(node)) {
        const nextEnv = new Map(env);
        let out = emptyThrows();
        for (const decl0 of node.declarationList?.declarations || []) {
          if (decl0.initializer)
            out = mergeThrows(out, walkExpr(decl0.initializer, nextEnv, facts, caught));
          if (api.isIdentifier?.(decl0.name)) {
            const init = decl0.initializer;
            nextEnv.set(
              decl0.name.text,
              init
                ? { value: evalValue(init, nextEnv, facts), bool: evalBool(init, nextEnv, facts) }
                : { value: absUndef(), bool: boolConst(false) }
            );
          }
        }
        return { flows: [{ env: nextEnv, facts }], info: out };
      }
      if (api.isExpressionStatement?.(node))
        return { flows: [{ env, facts }], info: walkExpr(node.expression, env, facts, caught) };
      if (api.isReturnStatement?.(node))
        return { flows: [], info: walkExpr(node.expression, env, facts, caught) };
      if (api.isThrowStatement?.(node))
        return { flows: [], info: walkExpr(node, env, facts, caught) };
      if (api.isIfStatement?.(node)) {
        const condInfo = walkExpr(node.expression, env, facts, caught);
        const cond = evalBool(node.expression, env, facts);
        const thenFacts = applyFacts(facts, cond, true);
        const elseFacts = applyFacts(facts, cond, false);
        const walkStates = (stmt: any, states: Facts[]): { flows: Flow[]; info: ThrowInfo } => {
          const flows: Flow[] = [];
          let info = emptyThrows();
          for (const state of states) {
            const cur = walkStmt(stmt, new Map(env), state, caught);
            info = mergeThrows(info, cur.info);
            flows.push(...cur.flows);
          }
          return { flows, info };
        };
        const thenRes = thenFacts.length
          ? walkStates(node.thenStatement, thenFacts)
          : { flows: [], info: emptyThrows() };
        const elseRes = node.elseStatement
          ? elseFacts.length
            ? walkStates(node.elseStatement, elseFacts)
            : { flows: [], info: emptyThrows() }
          : {
              flows: elseFacts.map((state) => ({ env: new Map(env), facts: state })),
              info: emptyThrows(),
            };
        return {
          flows: [...thenRes.flows, ...elseRes.flows],
          info: mergeThrows(condInfo, thenRes.info, elseRes.info),
        };
      }
      if (api.isTryStatement?.(node)) {
        const inside = walkStmt(node.tryBlock, new Map(env), facts, caught).info;
        const finalInfo = node.finallyBlock
          ? walkStmt(node.finallyBlock, new Map(env), facts, caught).info
          : emptyThrows();
        if (!node.catchClause)
          return { flows: [{ env, facts }], info: mergeThrows(inside, finalInfo) };
        const catchName = node.catchClause.variableDeclaration?.name;
        const name = catchName && api.isIdentifier?.(catchName) ? catchName.text : '';
        const handled = walkStmt(
          node.catchClause.block,
          new Map(env),
          facts,
          name ? { name, info: inside } : undefined
        ).info;
        return { flows: [{ env, facts }], info: mergeThrows(handled, finalInfo) };
      }
      return { flows: [{ env, facts }], info: walkExpr(node, env, facts, caught) };
    };
    const walkList = (
      list: any[],
      flows: Flow[],
      caught?: { name: string; info: ThrowInfo }
    ): { flows: Flow[]; info: ThrowInfo } => {
      let nextFlows = flows;
      let out = emptyThrows();
      for (const node of list) {
        const curFlows: Flow[] = [];
        for (const flow of nextFlows) {
          const cur = walkStmt(node, flow.env, flow.facts, caught);
          out = mergeThrows(out, cur.info);
          curFlows.push(...cur.flows);
        }
        nextFlows = curFlows;
        if (!nextFlows.length) break;
      }
      return { flows: nextFlows, info: out };
    };
    const body = bodyOfDecl(ts, decl);
    const out = body
      ? api.isBlock?.(body)
        ? walkList(body.statements || [], [{ env: new Map(seedEnv || []), facts: new Map() }]).info
        : walkExpr(body, new Map(seedEnv || []), new Map())
      : emptyThrows();
    if (!seedEnv) cache.set(decl, out);
    active.delete(decl);
    return out;
  };
})();
const docRaw = (doc: any): string => {
  const sf = doc?.getSourceFile?.();
  const text = sf?.text;
  if (typeof text !== 'string') return '';
  const start = doc.getStart ? doc.getStart(sf) : doc.pos || 0;
  const end = doc.end || start;
  return text.slice(start, end);
};
const docLines = (doc: any) => {
  return docRaw(doc)
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*\/\*\*?\s?/, '')
        .replace(/\s*\*\/\s*$/, '')
        .replace(/^\s*\*\s?/, '')
        .trim()
    )
    .filter(Boolean);
};
const nodeKids = (node: any): any[] => {
  if (Array.isArray(node?.nodes)) return node.nodes;
  if (Array.isArray(node?._nodes)) return node._nodes;
  return [];
};
const linkDest = (node: any): string => {
  if (!node || node.kind !== 'LinkTag') return '';
  if (typeof node.urlDestination === 'string' && node.urlDestination.trim())
    return node.urlDestination.trim();
  const refs = node.codeDestination?.memberReferences;
  if (!Array.isArray(refs) || !refs.length) return '';
  return refs
    .map(
      (ref: any) => ref?.memberIdentifier?.identifier || ref?.memberSymbol?.symbolReference || ''
    )
    .filter(Boolean)
    .join('.');
};
const nodeText = (node: any): string => {
  if (!node) return '';
  if (node.kind === 'SoftBreak') return '\n';
  if (typeof node.text === 'string') return node.text;
  if (typeof node.code === 'string') return node.code;
  if (node.kind === 'LinkTag') {
    const dest = linkDest(node);
    return dest ? `{@link ${dest}}` : '{@link}';
  }
  const kids = nodeKids(node);
  if (kids.length) return kids.map(nodeText).join('');
  if (node.content) return nodeText(node.content);
  return '';
};
const proseText = (node: any): string => {
  if (!node) return '';
  if (node.kind === 'SoftBreak') return '\n';
  if (node.kind === 'CodeSpan' || node.kind === 'FencedCode' || node.kind === 'LinkTag') return '';
  if (typeof node.text === 'string') return node.text;
  const kids = nodeKids(node);
  if (kids.length) return kids.map(proseText).join('');
  if (node.content) return proseText(node.content);
  return '';
};
const proseComment = (text: string): boolean => /(?:^|\n)\s*(?:\/\/|\/\*)/.test(text);
const codeTopComment = (code: string): boolean => {
  const first = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return !!first && /^(?:\/\/|\/\*)/.test(first);
};
const exampleDoc = (block: any): Example => {
  const prose: string[] = [];
  const codes: string[] = [];
  const errors: string[] = [];
  for (const node of nodeKids(block?.content)) {
    if (node?.kind === 'FencedCode') {
      if (typeof node.code === 'string') codes.push(node.code.trim());
      continue;
    }
    const text = nodeText(node).trim();
    if (!text) continue;
    prose.push(text);
  }
  if (!codes.length) errors.push('example must contain a fenced code block');
  for (const text of prose) {
    if (proseComment(text))
      errors.push('example prose must not use code comments; move the explanation into prose text');
    errors.push(...proseLinkIssues(text));
  }
  const code = codes.filter(Boolean).join('\n\n').trim();
  if (code && codeTopComment(code))
    errors.push('example code must not start with a comment; move the explanation into prose text');
  if (codes.length && !code) errors.push('example fenced code block is empty');
  return { code, errors, prose };
};
const messageText = (msg: { messageId?: unknown; unformattedText?: string }): string => {
  const id = String(msg.messageId || '');
  const text = msg.unformattedText?.trim() || id;
  return id ? `${id}: ${text}` : text;
};
const docParseText = (raw: string): string =>
  raw.replace(/(^|\n)(\s*\*\s*)@__NO_SIDE_EFFECTS__(?=\s|$)/g, '$1$2@nosideeffects');
const docParser = (() => {
  const cache = new WeakMap<object, { parseString: (text: string) => any }>();
  return (tsdoc: TSDocLike) => {
    const hit = cache.get(tsdoc as unknown as object);
    if (hit) return hit;
    const cfg = new tsdoc.TSDocConfiguration();
    cfg.addTagDefinitions([
      new tsdoc.TSDocTagDefinition({
        tagName: '@module',
        syntaxKind: tsdoc.TSDocTagSyntaxKind.ModifierTag,
      }),
      new tsdoc.TSDocTagDefinition({
        tagName: '@nosideeffects',
        syntaxKind: tsdoc.TSDocTagSyntaxKind.ModifierTag,
      }),
    ]);
    const parser = new tsdoc.TSDocParser(cfg);
    cache.set(tsdoc as unknown as object, parser);
    return parser;
  };
})();
const docInfo = (() => {
  const cache = new WeakMap<object, ParsedDoc>();
  return (tsdoc: TSDocLike, decl: any): ParsedDoc => {
    if (!decl || typeof decl !== 'object')
      return { docProse: '', docs: '', errors: [], examples: [], hasDocs: false, tags: [] };
    const hit = cache.get(decl);
    if (hit) return hit;
    const parser = docParser(tsdoc);
    const docs: string[] = [];
    const proseDocs: string[] = [];
    const errors: string[] = [];
    const examples: Example[] = [];
    const tags: Tag[] = [];
    for (const doc of decl?.jsDoc || []) {
      const raw = normalizeDoc(docRaw(doc));
      if (!raw) continue;
      const res = parser.parseString(docParseText(raw));
      const parsed = res.docComment;
      const summary = nodeText(parsed?.summarySection).trim();
      const summaryProse = proseText(parsed?.summarySection).trim();
      if (summary) docs.push(summary);
      if (summaryProse) proseDocs.push(summaryProse);
      for (const block of parsed?.params?.blocks || []) {
        tags.push({
          name: 'param',
          paramName: typeof block?.parameterName === 'string' ? block.parameterName : '',
          prose: proseText(block?.content).trim(),
          text: nodeText(block?.content).trim(),
        });
      }
      if (parsed?.returnsBlock)
        tags.push({
          name: 'returns',
          prose: proseText(parsed.returnsBlock.content).trim(),
          text: nodeText(parsed.returnsBlock.content).trim(),
        });
      for (const block of parsed?.customBlocks || []) {
        const name = String(block?.blockTag?.tagName || '').replace(/^@/, '');
        if (!name) continue;
        if (name === 'example') {
          const example = exampleDoc(block);
          examples.push(example);
          tags.push({ name, text: example.prose.join('\n').trim() });
          continue;
        }
        tags.push({
          name,
          prose: proseText(block?.content).trim(),
          text: nodeText(block?.content).trim(),
        });
      }
      const hasTodo = todoTag.test(raw);
      for (const msg of res.log?.messages || []) {
        if (hasTodo && String(msg.messageId || '') === 'tsdoc-undefined-tag') {
          errors.push('use @privateRemarks TODO: ... instead of @todo');
          continue;
        }
        errors.push(messageText(msg));
      }
    }
    const out = {
      docProse: proseDocs.join('\n').trim(),
      docs: docs.join('\n').trim(),
      errors,
      examples,
      hasDocs: !!docs.join('').trim() || !!tags.length,
      tags,
    };
    cache.set(decl, out);
    return out;
  };
})();
const docShape = (decl: any): DocShape => {
  let plainLongSingle = false;
  let taggedSingle = false;
  for (const doc of decl?.jsDoc || []) {
    const sf = doc.getSourceFile?.();
    if (!sf?.getLineAndCharacterOfPosition) continue;
    const start = doc.getStart ? doc.getStart(sf) : doc.pos || 0;
    const end = Math.max(start, (doc.end || start) - 1);
    const single =
      sf.getLineAndCharacterOfPosition(start).line === sf.getLineAndCharacterOfPosition(end).line;
    if (doc?.tags?.length) {
      if (single) taggedSingle = true;
    } else if (!single && docLines(doc).length === 1) plainLongSingle = true;
  }
  return { plainLongSingle, taggedSingle };
};
const declMeta = (tsdoc: TSDocLike, decl: any): DeclMeta => {
  const info = docInfo(tsdoc, decl);
  const shape = docShape(decl);
  return {
    docs: info.docs,
    docProse: info.docProse,
    errors: info.errors,
    examples: info.examples,
    hasDocs: info.hasDocs,
    plainLongSingle: shape.plainLongSingle,
    single: shape.taggedSingle,
    tags: info.tags,
    tagNames: info.tags.map((tag) => tag.name),
  };
};
const typedMeta = (tsdoc: TSDocLike, decls: TypedDecl[]): DeclMeta => {
  const docs: string[] = [];
  const docProse: string[] = [];
  const errors: string[] = [];
  const examples: Example[] = [];
  const tagNames: string[] = [];
  const tags: Tag[] = [];
  let hasDocs = false;
  let plainLongSingle = false;
  let single = false;
  for (const decl of decls) {
    const meta = declMeta(tsdoc, decl.decl);
    if (meta.hasDocs) hasDocs = true;
    if (meta.plainLongSingle) plainLongSingle = true;
    if (meta.single) single = true;
    if (meta.docs) docs.push(meta.docs);
    if (meta.docProse) docProse.push(meta.docProse);
    errors.push(...meta.errors);
    examples.push(...meta.examples);
    tagNames.push(...meta.tagNames);
    tags.push(...meta.tags);
  }
  return {
    docs: docs.join('\n').trim(),
    docProse: docProse.join('\n').trim(),
    errors,
    examples,
    hasDocs,
    plainLongSingle,
    single,
    tagNames,
    tags,
  };
};
const trailingInline = (node: any) => {
  const sf = node?.getSourceFile?.();
  const text = sf?.text;
  if (typeof text !== 'string') return '';
  const end = node?.getEnd?.(sf) || node?.end || 0;
  const next = text.indexOf('\n', end);
  const tail = text.slice(end, next === -1 ? text.length : next);
  const line = tail.match(/^\s*(\/\/.*|\/\*.*\*\/)\s*$/)?.[1];
  if (!line) return '';
  if (line.startsWith('//')) return line.slice(2).trim();
  return line
    .replace(/^\/\*+\s*/, '')
    .replace(/\s*\*\/$/, '')
    .trim();
};
const sourceFilesOf = (dtsFile: string) => {
  const mapFile = `${dtsFile}.map`;
  if (!existsSync(mapFile)) return [] as string[];
  const raw = JSON.parse(readFileSync(mapFile, 'utf8')) as { sources?: unknown };
  if (!Array.isArray(raw.sources)) return [] as string[];
  return raw.sources
    .filter((src): src is string => typeof src === 'string' && !!src)
    .map((src) => resolve(dirname(mapFile), src))
    .filter((file) => existsSync(file));
};
const exportedDecl = (ts: TsLike, node: any) => {
  const kind = (ts as any).SyntaxKind?.ExportKeyword;
  if (kind === undefined) return false;
  return (node?.modifiers || []).some((mod: any) => mod?.kind === kind);
};
const sourceIndex = (ts: TsLike, mods: Mod[]): SrcIndex => {
  const out: SrcIndex = new Map();
  for (const mod of mods) {
    const fileMap = new Map<string, Map<string, string>>();
    for (const file of sourceFilesOf(mod.dtsFile)) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.ESNext,
        true
      );
      for (const stmt of (sf as any).statements || []) {
        if (!exportedDecl(ts, stmt)) continue;
        const isIface = (ts as any).isInterfaceDeclaration?.(stmt);
        const isType =
          (ts as any).isTypeAliasDeclaration?.(stmt) && (ts as any).isTypeLiteralNode?.(stmt.type);
        if (!isIface && !isType) continue;
        const name = stmt.name?.text;
        if (!name) continue;
        const members = isIface ? [...stmt.members] : [...stmt.type.members];
        const memberMap = fileMap.get(name) || new Map<string, string>();
        for (const member of members) {
          const memberName = member.name?.getText?.();
          const inline = memberName ? trailingInline(member) : '';
          if (memberName && inline) memberMap.set(memberName, inline);
        }
        if (memberMap.size) fileMap.set(name, memberMap);
      }
    }
    out.set(mod.dtsFile, fileMap);
  }
  return out;
};
const sourceInline = (index: SrcIndex, dtsFile: string, typeName: string, memberName: string) =>
  index.get(dtsFile)?.get(typeName)?.get(memberName) || '';
const placeholderExample = (code: string): string => {
  const text = code
    .trim()
    .split(/\r?\n/)
    .filter((line) => {
      const trim = line.trim();
      return trim && !/^import(?:\s+type)?\b/.test(trim);
    })
    .join('\n')
    .trim();
  if (!text) return '';
  if (/^void\s+[A-Za-z_$][\w$.]*;?$/.test(text)) return 'placeholder example: void reference';
  if (/\{\}\s+as\s+any\b/.test(text)) return 'placeholder example: {} as any';
  if (/^type\s+\w+\s*=\s*[A-Za-z_$][\w$.<>,[\]|&?()\s]*;?$/.test(text))
    return 'placeholder example: alias-only type';
  return '';
};
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shouldInject = (code: string, bind: string): boolean => {
  if (/^\s*import\s/m.test(code)) return false;
  const pat = new RegExp(
    `\\b(?:const|let|var|function|class|type|interface|enum)\\s+${esc(bind)}\\b`
  );
  return !pat.test(code);
};
const bagParam = (name: string) =>
  /(?:^|.*(?:opts?|options?|params?|config|cfg|settings?))$/i.test(name);
const bagTypeRefs = (ts: TsLike, checker: CheckerLike, decl: any): Record<string, string> => {
  const api = ts as any;
  const out: Record<string, string> = Object.create(null);
  for (const param of decl?.parameters || []) {
    const name = param.name?.getText?.();
    if (!name || !bagParam(name) || !api.isTypeReferenceNode?.(param.type)) continue;
    const ref = param.type.typeName?.getText?.();
    if (!ref) continue;
    const sym = checker.getSymbolAtLocation(param.type.typeName);
    const decls = sym?.declarations || [];
    if (decls.length && decls.every((d: any) => api.isTypeParameterDeclaration?.(d))) continue;
    if (decls.length && decls.every((d: any) => isTsLibDecl(d))) continue;
    out[name] = ref;
  }
  return out;
};
const callInfo = (ts: TsLike, checker: CheckerLike, type: unknown, decl: any): CallInfo => {
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call) || [];
  const bagRefs = bagTypeRefs(ts, checker, decl);
  if (calls.length) {
    const params = [
      ...new Set(calls.flatMap((sig) => sig.parameters.map((param) => param.getName()))),
    ];
    const bags: Record<string, string[]> = Object.create(null);
    const fnParams = new Set<string>();
    for (const sig of calls) {
      for (const param of sig.parameters) {
        const name = param.getName();
        const at = param.valueDeclaration || param.declarations?.[0] || decl;
        const type = checker.getTypeOfSymbolAtLocation(param, at);
        if (
          checker.getSignaturesOfType(type, ts.SignatureKind.Call)?.length ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Construct)?.length
        )
          fnParams.add(name);
        if (!bagParam(name)) continue;
        const fields = checker.getPropertiesOfType?.(type) || [];
        const names = fields.map((field) => field.getName()).filter((field) => !isIgnored(field));
        if (!names.length) continue;
        bags[name] = [...new Set([...(bags[name] || []), ...names])];
      }
    }
    const returns = calls.some((sig) => {
      const out = checker.typeToString(sig.getReturnType()).replace(/\s+/g, '');
      return (
        out !== 'void' &&
        out !== 'undefined' &&
        out !== 'Promise<void>' &&
        out !== 'Promise<undefined>'
      );
    });
    return { bagRefs, bags, fnParams: [...fnParams], kind: 'call', params, returns };
  }
  const constructs = checker.getSignaturesOfType(type, ts.SignatureKind.Construct) || [];
  if (constructs.length) {
    const params = [
      ...new Set(constructs.flatMap((sig) => sig.parameters.map((param) => param.getName()))),
    ];
    const bags: Record<string, string[]> = Object.create(null);
    const fnParams = new Set<string>();
    for (const sig of constructs) {
      for (const param of sig.parameters) {
        const name = param.getName();
        const at = param.valueDeclaration || param.declarations?.[0] || decl;
        const type = checker.getTypeOfSymbolAtLocation(param, at);
        if (
          checker.getSignaturesOfType(type, ts.SignatureKind.Call)?.length ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Construct)?.length
        )
          fnParams.add(name);
        if (!bagParam(name)) continue;
        const fields = checker.getPropertiesOfType?.(type) || [];
        const names = fields.map((field) => field.getName()).filter((field) => !isIgnored(field));
        if (!names.length) continue;
        bags[name] = [...new Set([...(bags[name] || []), ...names])];
      }
    }
    return { bagRefs, bags, fnParams: [...fnParams], kind: 'construct', params, returns: false };
  }
  return { bagRefs: {}, bags: {}, fnParams: [], kind: '', params: [], returns: false };
};
const typeOfExport = (ts: TsLike, checker: CheckerLike, sym: Sym) => {
  const decl = sym.valueDeclaration || sym.declarations?.[0];
  if (!decl)
    return {
      bagRefs: {},
      bags: {},
      fnParams: [],
      kind: '',
      params: [] as string[],
      returns: false,
    };
  return callInfo(ts, checker, checker.getTypeOfSymbolAtLocation(sym, decl), decl);
};
const typeDecls = (ts: TsLike, sym: Sym) => {
  const api = ts as any;
  const decls = sym.declarations || (sym.valueDeclaration ? [sym.valueDeclaration] : []);
  const out: TypedDecl[] = [];
  for (const decl of decls) {
    if (api.isInterfaceDeclaration?.(decl))
      out.push({ decl, kind: 'interface', members: [...decl.members] });
    else if (api.isTypeAliasDeclaration?.(decl))
      out.push({
        decl,
        kind: 'type',
        members: api.isTypeLiteralNode?.(decl.type) ? [...decl.type.members] : [],
      });
  }
  return out;
};
const refDoc = (
  ts: TsLike,
  tsdoc: TSDocLike,
  checker: CheckerLike,
  member: any
): RefDoc | undefined => {
  const api = ts as any;
  const type = member?.type;
  const refNode = api.isTypeReferenceNode?.(type) ? type.typeName : undefined;
  if (!refNode) return;
  const base = checker.getSymbolAtLocation(refNode);
  if (!base) return;
  const sym = base.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(base) : base;
  const decl = declOf(sym) || declOf(base);
  if (!decl) return;
  const infoDoc = docInfo(tsdoc, decl);
  const info = callInfo(ts, checker, checker.getTypeOfSymbolAtLocation(sym, decl), decl);
  return {
    docs: infoDoc.docs,
    docProse: infoDoc.docProse,
    hasDocs: infoDoc.hasDocs,
    info,
    tags: infoDoc.tags,
  };
};
const docItems = (ts: TsLike, tsdoc: TSDocLike, checker: CheckerLike, sym: Sym): DocItem[] => {
  const api = ts as any;
  const out: DocItem[] = [];
  const seen = new Set<string>();
  for (const decl of typeDecls(ts, sym)) {
    for (const member of decl.members) {
      const nameNode = (member as any).name;
      if (!nameNode?.getText) continue;
      const name = nameNode.getText();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const msym = (member as any).symbol || checker.getSymbolAtLocation(nameNode);
      const meta = docInfo(tsdoc, member);
      const type = msym
        ? checker.getTypeOfSymbolAtLocation(msym, member)
        : checker.getTypeAtLocation?.(member);
      const fn = api.isMethodSignature?.(member)
        ? member
        : api.isPropertySignature?.(member) && api.isFunctionTypeNode?.(member.type)
          ? member.type
          : undefined;
      const bagRefs = new Map<string, string>();
      for (const param of fn?.parameters || []) {
        const paramName = param.name?.getText?.();
        if (!paramName || !bagParam(paramName)) continue;
        const ref = api.isTypeReferenceNode?.(param.type) ? param.type.typeName?.getText?.() : '';
        if (ref) bagRefs.set(paramName, ref);
      }
      out.push({
        bagRefs,
        docs: meta.docs,
        docProse: meta.docProse,
        errors: meta.errors,
        info: callInfo(ts, checker, type, member),
        inline: trailingInline(member),
        name,
        plainLongSingle: docShape(member).plainLongSingle,
        ref: refDoc(ts, tsdoc, checker, member),
        single: docShape(member).taggedSingle,
        tags: meta.tags,
      });
    }
  }
  return out;
};
const bindOf = (name: string, sym: Sym): string => {
  const value = name === 'default' ? sym.getName() || 'value' : name;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : 'value';
};
const isIgnored = (name: string): boolean => name.startsWith('_');
const inject = (item: Item, code: string): string => {
  const spec = JSON.stringify(item.spec);
  if (item.runtime) {
    if (item.name === 'default') return `import ${item.bind} from ${spec};\n${code}`;
    return `import { ${item.name} as ${item.bind} } from ${spec};\n${code}`;
  }
  if (item.name === 'default') return `import type ${item.bind} from ${spec};\n${code}`;
  return `import type { ${item.name} as ${item.bind} } from ${spec};\n${code}`;
};
const describeAttempt = (errs: string[], exec?: ExecRes): string => {
  if (errs.length) return compact(errs);
  if (!exec) return '';
  return (
    exec.error?.message || firstText(exec.stderr) || firstText(exec.stdout) || `exit ${exec.status}`
  );
};
const tryExample = async (
  code: string,
  item: Item,
  ctx: Ctx,
  ts: TsLike,
  opts: {
    checkTypes?: (ts: TsLike, cwd: string, code: string) => string[];
    runCode?: (code: string, cwd: string) => ExecRes | Promise<ExecRes>;
  } = {}
) => {
  const attempts = [code, ...(shouldInject(code, item.bind) ? [inject(item, code)] : [])];
  const seen = new Set<string>();
  const fails: string[] = [];
  for (const cur of attempts) {
    if (!cur.trim() || seen.has(cur)) continue;
    seen.add(cur);
    const placeholder = placeholderExample(cur);
    if (placeholder) {
      fails.push(placeholder);
      continue;
    }
    const errs = (opts.checkTypes || checkTypes)(ts, ctx.runDir, cur);
    if (errs.length) {
      fails.push(describeAttempt(errs));
      continue;
    }
    if (!item.runtime) return '';
    const exec = await Promise.resolve((opts.runCode || runCode)(cur, ctx.runDir));
    if (exec.ok) return '';
    fails.push(describeAttempt([], exec));
  }
  return compact(fails);
};
const summary = (res: Result) =>
  `${res.passed} passed, ${res.warnings} warning${res.warnings === 1 ? '' : 's'}, ${res.failures} failure${res.failures === 1 ? '' : 's'}, ${res.skipped} skipped`;
const logIssue = (
  _log: unknown,
  colorOn: boolean,
  level: 'error' | 'warn',
  item: Pick<Item, 'dtsFile' | 'line' | 'name'>,
  text: string,
  kind: string
) => console.error(`${status(level, colorOn)} ${idOf(item)} (${item.line}): ${text} (${kind})`);
const docSource = (checker: CheckerLike, exported: Sym, resolved: Sym): Sym => {
  const docs = partsText(exported.getDocumentationComment(checker));
  const tags = exported.getJsDocTags(checker);
  return docs.trim() || tags.length ? exported : resolved;
};
const throwReportIssues = (item: ThrowRawReport): string[] => {
  const docs = new Set<string>();
  for (const tag of item.docs)
    for (const match of tag.matchAll(/\{@link\s+([^\s}|]+)/g)) {
      const raw = (match[1] || '').trim();
      const tail = /([A-Z][A-Za-z0-9_]*)$/.exec(raw)?.[1] || raw.split(/[.#/]/).at(-1) || raw;
      if (tail) docs.add(tail);
    }
  const thrown = new Set(item.thrown);
  const direct = new Set(item.direct);
  const issues: string[] = [];
  if (!thrown.size) {
    if (docs.size && !item.unknown)
      issues.push('remove @throws; no thrown errors were inferred from the current implementation');
    return issues;
  }
  if (!item.unknown) {
    for (const name of [...thrown].sort())
      if (!docs.has(name))
        issues.push(`missing @throws for ${name}; e.g. "${throwsExample(name)}"`);
    for (const name of [...docs].sort())
      if (!thrown.has(name))
        issues.push(
          `remove stale @throws for ${name}; it is not inferred from the current implementation`
        );
    return issues;
  }
  if (direct.size) {
    for (const name of [...direct].sort())
      if (!docs.has(name))
        issues.push(`missing @throws for ${name}; e.g. "${throwsExample(name)}"`);
    return issues;
  }
  if (docs.size) return issues;
  issues.push(
    'missing @throws; document the known thrown conditions with prose first and a linked error type'
  );
  return issues;
};
const prototypeThrowsRaw = (pkgFile: string): ThrowRawReport[] => {
  const ctx = resolveCtx({ help: false, pkgArg: pkgFile }, dirname(resolve(pkgFile)));
  const ts = loadTs(ctx.pkgFile);
  const mods = listModules(ctx);
  const dtsProg = loadProgram(
    ts,
    mods.map((mod) => mod.dtsFile)
  );
  const jsProg = loadProgram(
    ts,
    mods.map((mod) => mod.jsFile),
    true
  );
  return collectPrototypeThrows(ctx, ts, mods, dtsProg, jsProg);
};
const prototypeThrows = (pkgFile: string): ThrowReport[] =>
  prototypeThrowsRaw(pkgFile)
    .map((item) => ({ ...item, issues: throwReportIssues(item) }))
    .filter((item) => item.issues.length);
const collectPrototypeThrows = (
  ctx: Ctx,
  ts: TsLike,
  mods: Mod[],
  dtsProg: ProgLike,
  jsProg: ProgLike
): ThrowRawReport[] => {
  const dtsChecker = dtsProg.getTypeChecker();
  const jsChecker = jsProg.getTypeChecker();
  const out: ThrowRawReport[] = [];
  for (const mod of mods) {
    const jsMap = new Map<string, Sym>();
    for (const sym of moduleExports(jsChecker, jsProg.getSourceFile(mod.jsFile), mod.jsFile))
      jsMap.set(sym.getName(), sym);
    const symbols = moduleExports(dtsChecker, dtsProg.getSourceFile(mod.dtsFile), mod.dtsFile).sort(
      (a, b) => a.getName().localeCompare(b.getName())
    );
    for (const exported of symbols) {
      if (isIgnored(exported.getName())) continue;
      const resolved =
        exported.flags & ts.SymbolFlags.Alias ? dtsChecker.getAliasedSymbol(exported) : exported;
      const src = docSource(dtsChecker, exported, resolved);
      const docs = src
        .getJsDocTags(dtsChecker)
        .filter((tag) => tag.name === 'throws')
        .map((tag) => tagText(tag.text));
      const jsSym0 = jsMap.get(exported.getName());
      if (!jsSym0) continue;
      const jsSym =
        jsSym0.flags & ts.SymbolFlags.Alias ? jsChecker.getAliasedSymbol(jsSym0) : jsSym0;
      const decl = declOf(jsSym);
      if (!decl || !isLocalDecl(ctx.cwd, decl)) continue;
      const info = inferThrows(ts, jsChecker, ctx.cwd, decl);
      if (!info.thrown.size && !docs.length) continue;
      out.push({
        direct: [...info.direct].sort(),
        docs,
        dtsFile: mod.dtsFile,
        key: mod.key,
        name: exported.getName(),
        thrown: [...info.thrown].sort(),
        unknown: info.unknown,
      });
    }
  }
  return out;
};

export const runCli = async (
  argv: string[],
  opts: {
    checkTypes?: (ts: TsLike, cwd: string, code: string) => string[];
    color?: boolean;
    cwd?: string;
    loadTSDoc?: (pkgFile: string) => TSDocLike;
    loadTs?: (pkgFile: string) => TsLike;
    runCode?: (code: string, cwd: string) => ExecRes | Promise<ExecRes>;
  } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  const colorOn = opts.color ?? wantColor();
  const ctx = resolveCtx(args, opts.cwd);
  npmInstall(ctx.runDir);
  const log = console.error;
  const ts = (opts.loadTs || loadTs)(ctx.pkgFile);
  const tsdoc = (opts.loadTSDoc || loadTSDoc)(ctx.pkgFile);
  const mods = listModules(ctx);
  const dtsProg = loadProgram(
    ts,
    mods.map((mod) => mod.dtsFile)
  );
  const jsProg = loadProgram(
    ts,
    mods.map((mod) => mod.jsFile),
    true
  );
  const srcIndex = sourceIndex(ts, mods);
  const dtsChecker = dtsProg.getTypeChecker();
  const jsChecker = jsProg.getTypeChecker();
  const throwReports = collectPrototypeThrows(ctx, ts, mods, dtsProg, jsProg);
  const throwMap = new Map(throwReports.map((item) => [`${item.key}:${item.name}`, item]));
  for (const mod of mods) {
    mod.runtime = new Set(
      moduleExports(jsChecker, jsProg.getSourceFile(mod.jsFile), mod.jsFile).map((sym) =>
        sym.getName()
      )
    );
  }
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  for (const mod of mods) {
    const symbols = moduleExports(dtsChecker, dtsProg.getSourceFile(mod.dtsFile), mod.dtsFile).sort(
      (a, b) => a.getName().localeCompare(b.getName())
    );
    for (const exported of symbols) {
      if (isIgnored(exported.getName())) continue;
      const resolved =
        exported.flags & ts.SymbolFlags.Alias ? dtsChecker.getAliasedSymbol(exported) : exported;
      const ownDocs = partsText(exported.getDocumentationComment(dtsChecker));
      const ownTags = exported.getJsDocTags(dtsChecker);
      const resolvedDocs = partsText(resolved.getDocumentationComment(dtsChecker));
      const resolvedTags = resolved.getJsDocTags(dtsChecker);
      const resolvedFile = declOf(resolved)?.getSourceFile?.()?.fileName;
      if (exported.flags & ts.SymbolFlags.Alias && !ownDocs.trim() && !ownTags.length)
        if (
          (resolvedDocs.trim() || resolvedTags.length) &&
          (!resolvedFile ||
            resolvedFile === mod.dtsFile ||
            mods.some((item) => item.dtsFile === resolvedFile))
        )
          continue;
      const src = docSource(dtsChecker, exported, resolved);
      const sourceDecl = docNode(declOf(src));
      const typed = typeDecls(ts, resolved);
      const smeta = declMeta(tsdoc, sourceDecl);
      const tmeta = typedMeta(tsdoc, typed);
      const item: Item = {
        bind: bindOf(exported.getName(), resolved),
        dtsFile: mod.dtsFile,
        key: mod.key,
        line: lineOf(resolved) || lineOf(exported),
        name: exported.getName(),
        runtime: mod.runtime.has(exported.getName()),
        spec: mod.spec,
        sym: resolved,
      };
      let failed = false;
      const info = typeOfExport(ts, dtsChecker, resolved);
      if (typed.length) {
        for (const err of tmeta.errors) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, `invalid TSDoc: ${err}`, 'tsdoc');
        }
        for (const err of linkIssues(tmeta.docProse, tmeta.tags)) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, err, 'link');
        }
        for (const err of throwsIssues(tmeta.tags)) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, err, 'throws');
        }
        if (!tmeta.hasDocs) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'missing JSDoc', 'docs');
        }
        if (tmeta.tagNames.length && tmeta.single) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'tagged JSDoc must be multiline', 'format');
        }
        if (!tmeta.tagNames.length && tmeta.plainLongSingle) {
          failed = true;
          out.failures += 1;
          logIssue(
            log,
            colorOn,
            'error',
            item,
            'single-line plain JSDoc must use short form',
            'format'
          );
        }
        if (tmeta.tagNames.includes('example')) {
          failed = true;
          out.failures += 1;
          logIssue(
            log,
            colorOn,
            'error',
            item,
            'types/interfaces must not use @example',
            'example'
          );
        }
      } else {
        for (const err of smeta.errors) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, `invalid TSDoc: ${err}`, 'tsdoc');
        }
        for (const err of linkIssues(smeta.docProse, smeta.tags)) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, err, 'link');
        }
        for (const err of throwsIssues(smeta.tags)) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, err, 'throws');
        }
        if (!smeta.docs.trim() && !smeta.tags.length) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'missing JSDoc', 'docs');
        }
        if (smeta.tags.length && docShape(sourceDecl).taggedSingle) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'tagged JSDoc must be multiline', 'format');
        }
        if (!smeta.tags.length && smeta.plainLongSingle) {
          failed = true;
          out.failures += 1;
          logIssue(
            log,
            colorOn,
            'error',
            item,
            'single-line plain JSDoc must use short form',
            'format'
          );
        }
      }
      const needsValueDocs = item.runtime || !typed.length;
      const inferredThrows = throwMap.get(`${item.key}:${item.name}`);
      const paramTags = needsValueDocs
        ? smeta.tags
            .filter((tag) => tag.name === 'param')
            .map(parseParam)
            .filter((tag) => tag.name)
        : [];
      if (info.params.length) {
        const paramMap = new Map(paramTags.map((tag) => [tag.name, tag.desc]));
        for (const name of info.params) {
          const desc = paramMap.get(name);
          if (desc === undefined) {
            failed = true;
            out.failures += 1;
            logIssue(log, colorOn, 'error', item, `missing @param ${name}`, 'param');
            continue;
          }
          if (info.bagRefs[name] && !hasLink(desc)) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `@param ${name} should link to {@link ${info.bagRefs[name]}}`,
              'param'
            );
          }
          if (isTrivial(desc, name)) {
            failed = true;
            out.failures += 1;
            logIssue(log, colorOn, 'error', item, `trivial @param ${name} description`, 'param');
          }
        }
        for (const tag of paramTags) {
          if (!info.params.includes(tag.name)) {
            failed = true;
            out.failures += 1;
            logIssue(log, colorOn, 'error', item, `unknown @param ${tag.name}`, 'param');
          }
        }
      }
      const ret = needsValueDocs ? smeta.tags.find((tag) => tag.name === 'returns') : undefined;
      if (needsValueDocs && !!info.kind && inferredThrows) {
        for (const err of throwsCoverageIssues(smeta.tags, {
          direct: new Set(inferredThrows.direct),
          thrown: new Set(inferredThrows.thrown),
          unknown: inferredThrows.unknown,
        })) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, err, 'throws');
        }
      }
      if (info.returns) {
        if (!ret) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'missing @returns', 'return');
        } else if (isTrivial(parseReturn(ret))) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'trivial @returns description', 'return');
        }
      }
      if (typed.length) {
        for (const member of docItems(ts, tsdoc, dtsChecker, resolved)) {
          for (const err of member.errors) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `invalid TSDoc for ${member.name}: ${err}`,
              'tsdoc'
            );
          }
          for (const err of linkIssues(member.docProse, member.tags)) {
            failed = true;
            out.failures += 1;
            logIssue(log, colorOn, 'error', item, `${member.name}: ${err}`, 'link');
          }
          for (const err of throwsIssues(member.tags)) {
            failed = true;
            out.failures += 1;
            logIssue(log, colorOn, 'error', item, `${member.name}: ${err}`, 'throws');
          }
          const inline =
            member.inline || sourceInline(srcIndex, mod.dtsFile, item.name, member.name);
          if ((member.docs.trim() || member.tags.length) && inline) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `member ${member.name} must not mix JSDoc with inline comment`,
              'member'
            );
          }
          if (!member.docs.trim() && !member.tags.length) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `missing member JSDoc for ${member.name}`,
              'member'
            );
            continue;
          }
          if (member.tags.length && member.single) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `tagged member JSDoc for ${member.name} must be multiline`,
              'format'
            );
          }
          if (!member.tags.length && member.plainLongSingle) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `single-line plain member JSDoc for ${member.name} must use short form`,
              'format'
            );
          }
          if (member.tags.some((tag) => tag.name === 'example')) {
            failed = true;
            out.failures += 1;
            logIssue(
              log,
              colorOn,
              'error',
              item,
              `typed member ${member.name} must not use @example`,
              'example'
            );
          }
          const memberTags = member.tags
            .filter((tag) => tag.name === 'param')
            .map(parseParam)
            .filter((tag) => tag.name);
          const memberMap = new Map(memberTags.map((tag) => [tag.name, tag.desc]));
          const memberRet = member.tags.find(
            (tag) => tag.name === 'returns' || tag.name === 'return'
          );
          const viaRef = member.ref?.hasDocs && !memberTags.length && !memberRet;
          for (const name of member.info.params) {
            if (viaRef) break;
            const desc = memberMap.get(name);
            if (desc === undefined) {
              failed = true;
              out.failures += 1;
              logIssue(
                log,
                colorOn,
                'error',
                item,
                `missing @param ${member.name}.${name}`,
                'param'
              );
              continue;
            }
            const ref = member.bagRefs.get(name);
            if (ref && !hasLink(desc)) {
              failed = true;
              out.failures += 1;
              logIssue(
                log,
                colorOn,
                'error',
                item,
                `@param ${member.name}.${name} should link to {@link ${ref}}`,
                'param'
              );
            }
            if (isTrivial(desc, name)) {
              failed = true;
              out.failures += 1;
              logIssue(
                log,
                colorOn,
                'error',
                item,
                `trivial @param ${member.name}.${name} description`,
                'param'
              );
            }
          }
          for (const tag of memberTags) {
            if (!member.info.params.includes(tag.name)) {
              failed = true;
              out.failures += 1;
              logIssue(
                log,
                colorOn,
                'error',
                item,
                `unknown @param ${member.name}.${tag.name}`,
                'param'
              );
            }
          }
          if (member.info.returns && !viaRef) {
            if (!memberRet) {
              failed = true;
              out.failures += 1;
              logIssue(
                log,
                colorOn,
                'error',
                item,
                `missing @returns for ${member.name}`,
                'return'
              );
            } else if (isTrivial(parseReturn(memberRet))) {
              failed = true;
              out.failures += 1;
              logIssue(
                log,
                colorOn,
                'error',
                item,
                `trivial @returns for ${member.name}`,
                'return'
              );
            }
          }
        }
      }
      const examples = needsValueDocs ? smeta.examples : [];
      const needsExample = needsValueDocs && !!info.kind && !info.fnParams.length;
      if (needsExample) {
        if (!examples.length) {
          failed = true;
          out.failures += 1;
          logIssue(log, colorOn, 'error', item, 'missing @example', 'example');
        }
      }
      if (examples.length) {
        for (let i = 0; i < examples.length; i++) {
          for (const err of examples[i].errors) {
            failed = true;
            out.failures += 1;
            logIssue(log, colorOn, 'error', item, `example ${i + 1}: ${err}`, 'example');
          }
          if (!examples[i].code) continue;
          const msg = await tryExample(examples[i].code, item, ctx, ts, {
            checkTypes: opts.checkTypes,
            runCode: opts.runCode,
          });
          if (!msg) continue;
          failed = true;
          out.failures += 1;
          logIssue(
            log,
            colorOn,
            'error',
            item,
            `example ${i + 1}: ${msg}`,
            item.runtime ? 'exec' : 'type'
          );
        }
      }
      if (!failed) out.passed += 1;
    }
  }
  if (out.failures || out.warnings) {
    console.error(`${status(out.failures ? 'error' : 'warn', colorOn)} summary: ${summary(out)}`);
    err('JSDoc check found issues');
  }
  console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
};

export const __TEST: TestApi = {
  bindOf: bindOf,
  dtsPathOf: dtsPathOf,
  docShape: docShape,
  exampleDoc: exampleDoc,
  inject: inject,
  isIgnored: isIgnored,
  isTrivial: isTrivial,
  jsPathOf: jsPathOf,
  normalizeDoc: normalizeDoc,
  parseParam: parseParam,
  parseReturn: parseReturn,
  placeholderExample: placeholderExample,
  prototypeThrows: prototypeThrows,
  prototypeThrowsRaw: prototypeThrowsRaw,
  shouldInject: shouldInject,
  sweepTemps: sweepTemps,
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
