import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { rm, write, writePkg } from '../fs-modify.ts';

declare const __JSBT_BUNDLE__: boolean | undefined;

export type Result = { failures: number; passed: number; skipped: number; warnings: number };
export type PkgArgs = { help: boolean; pkgArg: string };
export type CliArgs = { args: PkgArgs; colorOn: boolean };
export type PkgTarget = { cwd: string; pkgFile: string };
export type RunDirCtx = { cwd: string; pkg: { name: string } };
export type SourceCtx = { cwd: string; files: string[]; pkgFile: string };
export type Level = 'ERROR' | 'INFO' | 'WARN';
export type Ref = { file: string; issue: string; sym: string };
export type Issue = { level: Level; ref: Ref };
export type IssueLevel = Level | 'error' | 'info' | 'warn';
// README treats fence warnings as fatal errors; TSDoc keeps a warning tag but still exits nonzero.
export type WarnMode = 'pass' | 'warn' | 'fail' | 'error';
export type WorkerOpts<T> = {
  data: unknown;
  error: (msg: string) => T;
  execArgv?: string[];
  timeout?: { ms: number; result: () => T };
  terminate?: boolean;
};
export type WorkerExecOpts = { cwd?: string; data: unknown; execArgv?: string[] };
export type WorkerImportOpts = { cwd?: string; execArgv?: string[] };
export type TempFileOpts = { code: string; ext: string; prefix: string };
export type TempImportOpts = TempFileOpts & { execArgv?: string[] };
export type BuildPkg = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};
export type ExecRes = {
  error?: Error;
  ok: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
};
export type TsMsg = string | { messageText?: TsMsg; next?: TsMsg[] };
export type TsDiagnostic = { file?: { fileName: string }; messageText: TsMsg };
export type AstSource = {
  getLineAndCharacterOfPosition: (pos: number) => { character?: number; line: number };
};
export type AstNode = { getStart?: (source?: any) => number; pos?: number };
export type TsWalkApi = { forEachChild: (node: any, cb: (node: any) => void) => void };
export type LineIndex = { lines: string[]; lineOf: (pos: number) => number; starts: number[] };
export type TsSourceApi<T> = {
  ScriptTarget: { ESNext: unknown };
  // TypeScript exposes a narrower ScriptTarget parameter; any keeps typeof ts assignable.
  createSourceFile: (file: string, text: string, target: any, setParents?: boolean) => T;
};
export type TsTextApi = {
  isLiteralTypeNode?: (node: any) => boolean;
  isNoSubstitutionTemplateLiteral?: (node: any) => boolean;
  isStringLiteral: (node: any) => boolean;
};
export type ImportTrapRow = { error?: string; skip?: boolean };
export type TableApi = {
  drawHeader: (sizes: number[], fields: string[]) => void;
  drawSeparator: (sizes: number[], changed: boolean[]) => void;
  printRow: (
    values: string[],
    prev: string[] | undefined,
    sizes: number[],
    selected: string[]
  ) => string[];
};
export type LocalImportOpts = {
  accept: (file: string) => boolean;
  exts?: readonly string[];
  indexExts?: readonly string[];
  jsToTs?: boolean;
};
export type TsHost = {
  fileExists?: (file: string) => boolean;
  getCurrentDirectory?: () => string;
  getDirectories?: (dir: string) => string[];
  getSourceFile?: (file: string, target: unknown, onError?: (msg: string) => void) => unknown;
  readFile?: (file: string) => string | undefined;
  realpath?: (file: string) => string;
  useCaseSensitiveFileNames?: () => boolean;
  writeFile?: () => void;
};
export type TsCheck = {
  ModuleKind: { ESNext?: unknown; NodeNext?: unknown };
  ModuleResolutionKind?: { Bundler?: unknown; NodeNext?: unknown };
  ScriptTarget: { ESNext: unknown };
  createCompilerHost: (opts: Record<string, unknown>) => TsHost;
  createProgram: (
    files: string[],
    opts: Record<string, unknown>,
    host?: TsHost,
    oldProgram?: unknown
  ) => unknown;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => unknown;
  findConfigFile?: (
    dir: string,
    exists: (file: string) => boolean,
    name?: string
  ) => string | undefined;
  flattenDiagnosticMessageText?: (msg: TsMsg, newLine: string) => string;
  getPreEmitDiagnostics: (prog: unknown) => TsDiagnostic[];
  parseJsonConfigFileContent?: (
    config: unknown,
    host: unknown,
    base: string
  ) => { options: Record<string, unknown> };
  readConfigFile?: (
    file: string,
    read: (file: string) => string | undefined
  ) => { config?: unknown; error?: TsDiagnostic };
  sys: {
    fileExists: (file: string) => boolean;
    getDirectories: (dir: string) => string[];
    readFile: (file: string) => string | undefined;
    realpath?: (file: string) => string;
    useCaseSensitiveFileNames: boolean;
  };
};
export type TypeCheck = (code: string) => string[];
type Action = { detail?: string; key: string; text: string };
type GroupRef = { detail?: string; ref: Ref };

export const color = {
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
} as const;
export const emptyResult = (): Result => ({ failures: 0, passed: 0, skipped: 0, warnings: 0 });
const TS = new Set(['.cts', '.mts', '.ts', '.tsx']);
const TS_IMPORT_EXTS = ['.ts', '.mts', '.cts', '.tsx'];
const ROOT_IMPORT_TRAP = /root module cannot be imported: import submodules instead\./i;
const IMPORT_FILE_WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
try {
  await import(workerData.file);
  parentPort?.postMessage({ ok: true });
} catch (err_) {
  console.error(err_);
  parentPort?.postMessage({ ok: false });
}
`;

export const stripAnsi = (line: string): string => line.replace(/\x1b\[\d+(;\d+)*m/g, '');
export const err = (msg: string): never => {
  throw new Error(msg);
};
export const parseFast = (str: string | number | undefined): number => {
  const raw = String(str || '')
    .trim()
    .toLowerCase();
  if (raw === 'true') return 1;
  const val = Number.parseFloat(raw);
  const ratio = val > 0 && val < 1;
  if (!Number.isFinite(val) || val === 0 || Math.abs(val) > 256) return 0;
  if (!ratio && !Number.isSafeInteger(val)) return 0;
  return val;
};
export const jsbtWorkerLimit = (defaultCount: number): number => {
  const fast = parseFast(process.env.JSBT_FAST);
  const max = cpus().length;
  if (!fast) return Math.max(1, Math.min(defaultCount, 256));
  const count = fast === 1 ? max : fast < 0 ? max + fast : fast < 1 ? Math.floor(max * fast) : fast;
  return Math.max(1, Math.min(count, 256));
};
export const camelParts = (parts: string[]): string =>
  parts.map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part)).join('');
export const fileUrl = (file: string): string => pathToFileURL(file).href;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const ident = (name: string): boolean => !!name.length && IDENT.test(name);
export const kb = (bytes: number): string => (bytes / 1024).toFixed(2);
// `isolatedDeclarations` cannot infer the Dirent overload for exported wrappers.
export const dirEntries = (dir: string): Dirent[] =>
  readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
export const tsSourceRel = (rel: string): string =>
  rel
    .replace(/\.d\.(?:c|m)?ts$/, '.ts')
    .replace(/\.(?:c|m)?js$/, '.ts')
    .replace(/^\.\//, '');
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
export const textLines = (text = '', trimEnd = false): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => (trimEnd ? line.trimEnd() : line.trim()))
    .filter(Boolean);
export const lineIndex = (text: string): LineIndex => {
  const lines: string[] = [];
  const starts = [0];
  let pos = 0;
  for (const hit of text.matchAll(/\r?\n/g)) {
    const end = hit.index || 0;
    lines.push(text.slice(pos, end));
    pos = end + hit[0].length;
    starts.push(pos);
  }
  lines.push(text.slice(pos));
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { lines, lineOf: lineAt, starts };
};
export const docCommentLines = (raw: string, trim = true): string[] =>
  raw
    .replace(/^\/\*\*|\*\/$/g, '')
    .split(/\r?\n/)
    .map((line) => {
      const text = line
        .replace(/^\s*\/\*\*?\s?/, '')
        .replace(/\s*\*\/\s*$/, '')
        .replace(/^\s*\*\s?/, '');
      return trim ? text.trim() : text.trimEnd();
    });
export const firstText = (text = ''): string => textLines(text)[0] || '';
export const execText = (exec: ExecRes): string =>
  exec.error?.message || firstText(exec.stderr) || firstText(exec.stdout) || `exit ${exec.status}`;
export const compact = (items: string[]): string => {
  const list = items.map((item) => item.trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, 3).join('; ')}${list.length > 3 ? `; +${list.length - 3} more` : ''}`;
};
export const relFile = (cwd: string | undefined, file: string, insideOnly = false): string => {
  const rel = cwd ? relative(cwd, file) : file;
  // Deno publish locations can point outside cwd; keep those absolute.
  const out =
    rel && rel !== '.' && (!insideOnly || (!rel.startsWith('..') && !isAbsolute(rel))) ? rel : file;
  return out.split('\\').join('/');
};
export const relName = (cwd: string, file: string): string => relative(cwd, file) || basename(file);
export const nodeText = (node: any): string => (typeof node?.text === 'string' ? node.text : '');
export const nodeStart = (source: any, node: AstNode): number =>
  typeof node.getStart === 'function' ? node.getStart(source) : node.pos || 0;
export const nodeLine = (source: AstSource, node: AstNode): number =>
  source.getLineAndCharacterOfPosition(nodeStart(source, node)).line + 1;
export const walkAst = (ts: TsWalkApi, node: any, visit: (node: any) => boolean | void): void => {
  // Visitors return false to keep consumed nodes from being traversed again.
  if (visit(node) === false) return;
  ts.forEachChild(node, (child) => walkAst(ts, child, visit));
};
export const literalText = (ts: TsTextApi, node: any): string => {
  // Re-export-only declarations have no moduleSpecifier; keep those as empty specs.
  if (!node) return '';
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral?.(node)
    ? node.text || ''
    : '';
};
export const importTypeText = (ts: TsTextApi, node: any): string => {
  if (!ts.isLiteralTypeNode?.(node?.argument)) return '';
  return literalText(ts, node.argument.literal);
};
export const skipRootImportTrap = <T extends ImportTrapRow>(row: T): boolean => {
  if (!row.error || !ROOT_IMPORT_TRAP.test(row.error)) return false;
  // Some noble packages intentionally make the root entry throw to force submodule imports.
  row.skip = true;
  row.error = undefined;
  return true;
};
const CH = '\u2500';
const NN = '\u2502';
const LR = '\u253c';
const RN = '\u251c';
const NL = '\u2524';
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
export const table = (log: (line: string) => void): TableApi => {
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
const flattenDiagnostic = (msg: TsMsg): string => {
  if (typeof msg === 'string') return msg;
  const head = msg.messageText ? flattenDiagnostic(msg.messageText) : '';
  const tail = (msg.next || []).map(flattenDiagnostic).filter(Boolean).join(' ');
  return [head, tail].filter(Boolean).join(' ');
};
const tsOpts = (ts: TsCheck, cwd: string): Record<string, unknown> => {
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
export const makeTypeCheck = (
  ts: TsCheck,
  cwd: string,
  fileName: string = '.__jsbt-check.ts'
): TypeCheck => {
  const file = join(cwd, fileName);
  const opts = tsOpts(ts, cwd);
  const host = ts.createCompilerHost(opts);
  const fileExists = host.fileExists?.bind(host) || ts.sys.fileExists;
  const readFile = host.readFile?.bind(host) || ts.sys.readFile;
  const getSourceFile = host.getSourceFile?.bind(host);
  const sys = ts.sys;
  const cache = new Map<string, unknown>();
  let code = '';
  let oldProgram: unknown;
  host.fileExists = (name) => (resolve(name) === file ? true : fileExists(name));
  host.readFile = (name) => (resolve(name) === file ? code : readFile(name));
  host.getCurrentDirectory = () => cwd;
  host.getDirectories = (dir) => sys.getDirectories(dir);
  host.realpath = (name) => sys.realpath?.(name) || name;
  host.useCaseSensitiveFileNames = () => sys.useCaseSensitiveFileNames;
  host.writeFile = () => {};
  host.getSourceFile = (name, target, onError) => {
    if (resolve(name) === file) return ts.createSourceFile(name, code, target, true);
    const key = `${resolve(name)}:${String(target)}`;
    if (cache.has(key)) return cache.get(key);
    if (!getSourceFile) return undefined;
    const sf = getSourceFile(name, target, onError);
    if (sf) cache.set(key, sf);
    return sf;
  };
  return (value) => {
    code = value;
    const prog = ts.createProgram([file], opts, host, oldProgram);
    oldProgram = prog;
    return ts
      .getPreEmitDiagnostics(prog)
      .filter((diag) => !diag.file || diag.file.fileName === file)
      .map((diag) =>
        ts.flattenDiagnosticMessageText
          ? ts.flattenDiagnosticMessageText(diag.messageText, '\n')
          : flattenDiagnostic(diag.messageText)
      )
      .filter(Boolean);
  };
};
export const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;
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
export const pkgArgs = (argv: string[]): PkgArgs => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) throw new Error('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
export const usageText = (cmd: string, file: string): string => `usage:
  jsbt ${cmd} <package.json>

examples:
  jsbt ${cmd} package.json
  node /path/to/${file} package.json`;
export const cliArgs = (argv: string[], usage: string, color?: boolean): CliArgs | undefined => {
  const args = pkgArgs(argv);
  if (args.help) {
    console.log(usage);
    return undefined;
  }
  return { args, colorOn: color ?? wantColor() };
};
export const pickRunDir = (cwd: string, name: string): string => {
  const dir = join(cwd, 'test', 'build');
  const file = join(dir, 'package.json');
  if (!existsSync(file))
    throw new Error(`expected test/build/package.json next to ${name || 'package.json'}`);
  const pkg = readJson<BuildPkg>(file);
  const dep =
    pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name];
  if (dep !== 'file:../..') {
    throw new Error(
      [
        `expected test/build/package.json to install ${name} as "file:../.."`,
        `got ${JSON.stringify(dep)}`,
      ].join('; ')
    );
  }
  return dir;
};
export const prepareRunDir = (cwd: string, name: string, dir: string): string => {
  if (!isAbsolute(dir)) err(`expected absolute run dir: ${dir}`);
  const template = join(pickRunDir(cwd, name), 'package.json');
  const pkg = readJson<BuildPkg>(template);
  let rewrote = false;
  for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
    if (deps?.[name] !== 'file:../..') continue;
    deps[name] = `file:${cwd}`;
    rewrote = true;
  }
  if (!rewrote) err(`expected ${template} to install ${name} as "file:../.."`);
  writePkg(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
};
export const withRunDir = <T extends RunDirCtx>(
  ctx: T,
  runDir?: string
): T & { runDir: string } => ({
  ...ctx,
  runDir: runDir ? prepareRunDir(ctx.cwd, ctx.pkg.name, runDir) : pickRunDir(ctx.cwd, ctx.pkg.name),
});
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
export const loadTypeScript = <T>(pkgFile: string, api: string, check: (ts: T) => boolean): T =>
  loadNear<T>(pkgFile, 'typescript', api, check);
export const loadTypeScriptApi = <T>(pkgFile: string, api: string, keys: readonly string[]): T =>
  loadModuleApi<T>(pkgFile, 'typescript', api, keys);
type WorkerBase = { data: unknown; execArgv?: string[]; stderr?: boolean; stdout?: boolean };
const workerOpts = (opts: WorkerBase) =>
  // `@types/node` rejects `type: 'module'` on eval workers; runtime supports it.
  ({
    eval: true,
    execArgv: opts.execArgv,
    stderr: opts.stderr,
    stdout: opts.stdout,
    type: 'module',
    workerData: opts.data,
  }) as any;
export const runWorker = <T>(code: string, opts: WorkerOpts<T>): Promise<T> =>
  new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(code, workerOpts(opts));
    } catch (error) {
      resolve(opts.error((error as Error).message));
      return;
    }
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (res: T, exited = false, force = false) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(res);
      if ((force || opts.terminate !== false) && !exited) worker.terminate().catch(() => {});
    };
    if (opts.timeout)
      timer = setTimeout(() => finish(opts.timeout!.result(), false, true), opts.timeout.ms);
    worker.once('message', (msg) => finish(msg as T));
    worker.once('error', (error) => finish(opts.error(error.message)));
    worker.once('exit', (code) => {
      if (done) return;
      finish(
        opts.error(code ? `worker exited with code ${code}` : 'worker exited without result'),
        true
      );
    });
  });
export const runWorkerExec = (code: string, opts: WorkerExecOpts): Promise<ExecRes> =>
  new Promise((resolve) => {
    const prev = opts.cwd ? process.cwd() : undefined;
    if (opts.cwd) process.chdir(opts.cwd);
    let done = false;
    let result: { ok?: boolean } | undefined;
    let stdout = '';
    let stderr = '';
    const finish = (res: ExecRes) => {
      if (done) return;
      done = true;
      if (prev) process.chdir(prev);
      resolve({ ...res, stderr, stdout });
    };
    let worker: Worker;
    const stop = async (res: ExecRes) => {
      try {
        const code = await worker.terminate();
        if (res.status === null) res.status = code;
      } catch {}
      finish(res);
    };
    try {
      worker = new Worker(code, workerOpts({ ...opts, stderr: true, stdout: true }));
    } catch (error) {
      finish({ error: error as Error, ok: false, status: null, stderr: '', stdout: '' });
      return;
    }
    const out = worker.stdout as any;
    const err = worker.stderr as any;
    out?.setEncoding?.('utf8');
    err?.setEncoding?.('utf8');
    out?.on?.('data', (chunk: string) => (stdout += chunk));
    err?.on?.('data', (chunk: string) => (stderr += chunk));
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
export const runImportFile = (file: string, opts: WorkerImportOpts = {}): Promise<ExecRes> =>
  runWorkerExec(IMPORT_FILE_WORKER, {
    cwd: opts.cwd,
    data: { file: fileUrl(file) },
    execArgv: opts.execArgv,
  });
let nextTemp = 0;
export const withTempFile = async <T>(
  cwd: string,
  opts: TempFileOpts,
  fn: (file: string) => T | Promise<T>
): Promise<T> => {
  const file = join(cwd, `${opts.prefix}${process.pid}-${++nextTemp}.${opts.ext}`);
  write(file, opts.code);
  try {
    return await fn(file);
  } finally {
    rm(file);
  }
};
export const runTempImport = async (cwd: string, opts: TempImportOpts): Promise<ExecRes> => {
  return withTempFile(cwd, opts, (file) => runImportFile(file, { cwd, execArgv: opts.execArgv }));
};
export const paint = (text: string, code: string, on: boolean = true): string =>
  on ? `${code}${text}${color.reset}` : text;
export const wantColor = (
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = !!process.stderr.isTTY || !!process.stdout.isTTY
): boolean => {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  // Explicit force flags must win so one-shot debug runs can override a global NO_COLOR shell.
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
};
export const status = (name: 'error' | 'pass' | 'warn', on: boolean): string => {
  const code = name === 'error' ? color.red : name === 'warn' ? color.yellow : color.green;
  return `[${paint(name, code, on)}]`;
};
export const tag = (name: Level, on: boolean): string => {
  const code = name === 'ERROR' ? color.red : name === 'WARN' ? color.yellow : color.green;
  return `[${paint(name, code, on)}]`;
};
export const formatIssue = (level: Level, head: string, ref: Ref, on: boolean): string =>
  `${tag(level, on)} ${head}: ${ref.file}:${ref.sym} ${ref.issue}`;
export const issueKind = (text: string, kind: string): string => {
  const [first, ...rest] = text.split('\n');
  return [`${first} (${kind})`, ...rest].join('\n');
};
const issueLevel = (level: IssueLevel): Level =>
  level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : level === 'info' ? 'INFO' : level;
export const makeIssue = (
  level: IssueLevel,
  file: string,
  sym: string,
  text: string,
  kind = ''
): Issue => ({
  level: issueLevel(level),
  ref: { file, issue: kind ? issueKind(text, kind) : text, sym },
});
export const countIssue = (res: Result, issues: Issue[], issue: Issue): void => {
  if (issue.level === 'ERROR') res.failures += 1;
  else if (issue.level === 'WARN') res.warnings += 1;
  else res.skipped += 1;
  issues.push(issue);
};
export const recordIssue = (
  res: Result,
  issues: Issue[],
  level: IssueLevel,
  file: string,
  sym: string,
  text: string,
  kind = ''
): void => countIssue(res, issues, makeIssue(level, file, sym, text, kind));
export const sorted = (items: Iterable<string>): string[] => [...items].sort();
const refLoc = (ref: Ref): string => `${ref.file}:${ref.sym}`;
const action = (text: string, detail?: string): Action =>
  detail ? { detail, key: text, text } : { key: text, text };
const matchedAction = (
  issue: string,
  items: [RegExp, (match: RegExpMatchArray) => Action | undefined][]
): Action | undefined => {
  for (const [re, fn] of items) {
    const match = issue.match(re);
    if (!match) continue;
    const out = fn(match);
    if (out) return out;
  }
  // noImplicitReturns requires the no-match path to be explicit for this matcher helper.
  return undefined;
};
const refAction = (head: string, ref: Ref): Action => {
  if (head === 'bigint') {
    const [text, detail] = ref.issue.split('\n');
    if (detail) return action(text, detail);
  }
  if (head === 'bytes') {
    const hit = matchedAction(ref.issue, [
      [
        /^wrap (input|output) type with (TArg|TRet)<(.+)> \((bytes-(?:input|return))\)$/,
        ([, mode, name, type, kind]) =>
          action(`wrap ${mode} type with ${name}<...> (${kind})`, `${name}<${type}>`),
      ],
      [
        /^wrap output type with Promise<TRet<(.+)>> \((bytes-return)\)$/,
        ([, type, kind]) =>
          action(`wrap output type with Promise<TRet<...>> (${kind})`, `Promise<TRet<${type}>>`),
      ],
      [
        /^use Promise<TRet<(.+)>> instead of TRet<Promise<(.+)>> \((bytes-return)\)$/,
        ([, good, bad, kind]) =>
          good === bad
            ? action(
                `use Promise<TRet<...>> instead of TRet<Promise<...>> (${kind})`,
                `Promise<TRet<${good}>>`
              )
            : undefined,
      ],
    ]);
    if (hit) return hit;
  }
  if (head === 'treeshake') {
    const hit = matchedAction(ref.issue, [
      [
        /^unused \((.+?)\)(?: \((treeshake)\))?$/,
        ([, detail, kind]) => action(`unused${kind ? ` (${kind})` : ''}`, `(${detail})`),
      ],
    ]);
    if (hit) return hit;
  }
  if (head === 'jsr') {
    const hit = matchedAction(ref.issue, [
      [
        /^(missing|fix) jsr export mapping; use (.+) -> (.+) \((jsr-export)\)$/,
        ([, mode, key, file, kind]) =>
          action(`${mode} jsr export mapping (${kind})`, `${key} -> ${file}`),
      ],
      [
        /^remove unexpected jsr export mapping; drop (.+) -> (.+) \((jsr-export-extra)\)$/,
        ([, key, file, kind]) =>
          action(`remove unexpected jsr export mapping (${kind})`, `${key} -> ${file}`),
      ],
      [
        /^fix jsr import mapping; use (.+) -> (.+) \((jsr-import)\)$/,
        ([, key, file, kind]) => action(`fix jsr import mapping (${kind})`, `${key} -> ${file}`),
      ],
      [
        /^remove unexpected jsr import mapping; drop (.+) -> (.+) \((jsr-import-extra)\)$/,
        ([, key, file, kind]) =>
          action(`remove unexpected jsr import mapping (${kind})`, `${key} -> ${file}`),
      ],
      [
        new RegExp(
          '^add (required publish entry|publish coverage for exported source graph); ' +
            'use (.+) \\((jsr-publish(?:-required)?)\\)$'
        ),
        ([, what, file, kind]) => action(`add ${what} (${kind})`, file),
      ],
      [
        /^remove non-source publish entry; drop (.+) \((jsr-publish-source)\)$/,
        ([, file, kind]) => action(`remove non-source publish entry (${kind})`, file),
      ],
    ]);
    if (hit) return hit;
  }
  return action(ref.issue);
};
const formatIssueGroup = (
  level: Level,
  head: string,
  issue: string,
  refs: GroupRef[],
  on: boolean
): string[] =>
  refs.length === 1 && (head === 'errors' || !refs[0].detail)
    ? [formatIssue(level, head, refs[0].ref, on)]
    : [
        `${tag(level, on)} ${head}: ${refs.length === 1 ? issue : `${refs.length}x ${issue}`}`,
        ...refs.map((item) => `  ${refLoc(item.ref)}${item.detail ? ` ${item.detail}` : ''}`),
      ];
export const groupIssues = (head: string, issues: Issue[], on: boolean): string[] => {
  const grouped = new Map<string, { issue: string; level: Level; refs: GroupRef[] }>();
  for (const item of issues) {
    const action = refAction(head, item.ref);
    const key = `${item.level}\0${action.key}`;
    const prev = grouped.get(key);
    const ref = { detail: action.detail, ref: item.ref };
    if (prev) prev.refs.push(ref);
    else grouped.set(key, { issue: action.text, level: item.level, refs: [ref] });
  }
  return [...grouped.values()].flatMap((item) =>
    formatIssueGroup(item.level, head, item.issue, item.refs, on)
  );
};
export const printIssues = (head: string, issues: Issue[], on: boolean): void => {
  for (const line of groupIssues(head, issues, on)) console.error(line);
};
export const summary = (res: Result): string =>
  [
    `${res.passed} passed`,
    `${res.warnings} warning${res.warnings === 1 ? '' : 's'}`,
    `${res.failures} failure${res.failures === 1 ? '' : 's'}`,
    `${res.skipped} skipped`,
  ].join(', ');
export const collectIssues = <T, I>(
  items: T[],
  scan: (item: T) => I[],
  ref: (issue: I) => Issue
): { issues: Issue[]; result: Result } => {
  const result = emptyResult();
  const issues: Issue[] = [];
  for (const item of items) {
    const hits = scan(item);
    if (!hits.length) {
      result.passed++;
      continue;
    }
    for (const hit of hits) issues.push(ref(hit));
    result.failures += hits.length;
  }
  return { issues, result };
};
export const reportIssues = (
  head: string,
  issues: Issue[],
  res: Result,
  on: boolean,
  fail: string,
  warn: WarnMode = 'pass'
): void => {
  printIssues(head, issues, on);
  if (res.failures) {
    console.error(`${status('error', on)} summary: ${summary(res)}`);
    throw new Error(fail);
  }
  if (res.warnings && (warn === 'error' || warn === 'fail')) {
    console.error(`${status(warn === 'error' ? 'error' : 'warn', on)} summary: ${summary(res)}`);
    throw new Error(fail);
  }
  if (res.warnings && warn === 'warn')
    return console.error(`${status('warn', on)} summary: ${summary(res)}`);
  console.log(`${status('pass', on)} summary: ${summary(res)}`);
};
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
export const wantTSFile = (file: string): boolean => {
  if (!TS.has(file.slice(file.lastIndexOf('.')))) return false;
  if (/\.d\.[cm]?ts$/.test(file)) return false;
  return true;
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
const listTSFiles = (dir: string): string[] =>
  dirEntries(dir).flatMap((ent) => {
    const file = join(dir, ent.name);
    if (ent.isDirectory()) return listTSFiles(file);
    return wantTSFile(file) ? [file] : [];
  });
export const pickTSFiles = (cwd: string): string[] => {
  const root = dirEntries(cwd).flatMap((ent) => {
    const file = join(cwd, ent.name);
    if (!ent.isFile()) return [];
    return wantTSFile(file) ? [file] : [];
  });
  const src = join(cwd, 'src');
  const files = existsSync(src) ? [...root, ...listTSFiles(src)] : root;
  if (!files.length)
    throw new Error(`expected root *.ts files or src/*.ts files next to ${basename(cwd)}`);
  return files;
};
export const sourceCtx = (pkgArg: string, cwd: string = process.cwd()): SourceCtx => {
  const target = pkgTarget(pkgArg, cwd);
  return { cwd: target.cwd, files: pickTSFiles(target.cwd), pkgFile: target.pkgFile };
};
