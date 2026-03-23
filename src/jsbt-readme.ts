#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src`, then run it after a fresh build.
Like `jsbt esbuild`, it runs `npm install` in the selected run/build directory before checking.
File writes/deletes log through `fs-modify.ts` and honor `JSBT_LOG_LEVEL`.

All writes and any other modifications from this script MUST stay under the selected run/build directory.
This checker takes only a package.json path, uses `test/build` next to it as the run directory, and
MUST fail if that fixture directory is missing or if `test/build/package.json` does not install the
checked package name as `"file:../.."`.
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
type RawPkg = { exports?: unknown; name?: unknown };
type Pkg = { name: string };
type Ctx = { cwd: string; pkg: Pkg; pkgFile: string; readmeFile: string; runDir: string };
type Kind = 'js' | 'ts';
type Mode = 'cjs' | 'js' | 'mjs' | 'ts';
type Block = {
  code: string;
  endLine: number;
  head: string;
  headRaw: string;
  info: string;
  issue: string;
  kind: Kind | '';
  label: string;
  line: number;
  runnable: boolean;
};
type ExecRes = {
  error?: Error;
  ok: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
};
type Log = (line: string) => void;
type Msg = string | { messageText?: Msg; next?: Msg[] };
type DiagnosticLike = {
  file?: { getLineAndCharacterOfPosition: (pos: number) => { line: number }; fileName: string };
  messageText: Msg;
  start?: number;
};
type CompilerHostLike = {
  fileExists?: (file: string) => boolean;
  getCurrentDirectory?: () => string;
  getDirectories?: (dir: string) => string[];
  getSourceFile?: (file: string, target: unknown, onError?: (msg: string) => void) => unknown;
  readFile?: (file: string) => string | undefined;
  realpath?: (file: string) => string;
  useCaseSensitiveFileNames?: () => boolean;
  writeFile?: () => void;
};
type TsLike = {
  ModuleKind: { ESNext?: unknown; NodeNext?: unknown };
  ModuleResolutionKind?: { Bundler?: unknown; NodeNext?: unknown };
  ScriptTarget: { ESNext: unknown };
  createCompilerHost: (opts: Record<string, unknown>) => CompilerHostLike;
  createProgram: (
    files: string[],
    opts: Record<string, unknown>,
    host?: CompilerHostLike
  ) => unknown;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => unknown;
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
    getCurrentDirectory?: () => string;
    getDirectories: (dir: string) => string[];
    readDirectory?: (
      dir: string,
      ext?: readonly string[],
      excl?: readonly string[],
      incl?: readonly string[],
      depth?: number
    ) => string[];
    readFile: (file: string) => string | undefined;
    realpath?: (file: string) => string;
    useCaseSensitiveFileNames: boolean;
  };
};
type Result = { failures: number; passed: number; skipped: number; warnings: number };
type TestApi = {
  compact: typeof compact;
  decide: typeof decide;
  explicitKind: typeof explicitKind;
  firstText: typeof firstText;
  modeOf: typeof modeOf;
  parseArgs: typeof parseArgs;
  parseReadme: typeof parseReadme;
  readPkg: typeof readPkg;
  resolveCtx: typeof resolveCtx;
  shortHead: typeof shortHead;
  sweepTemps: typeof sweepTemps;
  wantColor: typeof wantColor;
};

const usage = `usage:
  jsbt readme <package.json>

examples:
  jsbt readme package.json
  node /path/to/check-readme.ts package.json`;

const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;

const color = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
};
const JS = new Set(['cjs', 'javascript', 'js', 'mjs', 'node']);
const SKIP = new Set(['kotlin', 'md', 'markdown', 'plaintext', 'text', 'txt']);
const TS = new Set(['cts', 'mts', 'ts', 'tsx', 'typescript']);

const err = (msg: string): never => {
  throw new Error(msg);
};
const flatten = (msg: Msg): string => {
  if (typeof msg === 'string') return msg;
  const head = msg.messageText ? flatten(msg.messageText) : '';
  const tail = (msg.next || []).map(flatten).filter(Boolean).join(' ');
  return [head, tail].filter(Boolean).join(' ');
};
const guardChild = (cwd: string, file: string, label: string) => {
  const rel = relative(cwd, file);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel))
    err(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
const paint = (text: string, code: string, on: boolean) =>
  on ? `${code}${text}${color.reset}` : text;
const wantColor = (
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = !!process.stdout.isTTY
): boolean => {
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
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const readPkg = (pkgFile: string): Pkg => {
  const raw = JSON.parse(readFileSync(pkgFile, 'utf8')) as RawPkg;
  const name = typeof raw.name === 'string' ? raw.name : '';
  return { name };
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
const resolveCtx = (args: Args, cwd: string = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  const readmeFile = resolve(base, 'README.md');
  guardChild(base, pkgFile, 'package');
  guardChild(base, readmeFile, 'readme');
  const pkg = readPkg(pkgFile);
  if (!pkg.name) err(`expected package name in ${pkgFile}`);
  return { cwd: base, pkg, pkgFile, readmeFile, runDir: pickRunDir(base, pkg) };
};
const labelOf = (info: string) => (info.trim().split(/\s+/, 1)[0] || '').toLowerCase();
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[:].*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const shortHead = (raw: string): string => slug(raw) || 'top';
const explicitKind = (label: string): Kind | '' =>
  JS.has(label) ? 'js' : TS.has(label) ? 'ts' : '';
// Fence metadata is the contract; don't guess runnable language from snippet text.
const decide = (label: string): Pick<Block, 'issue' | 'kind' | 'runnable'> => {
  const explicit = explicitKind(label);
  if (explicit) return { issue: '', kind: explicit, runnable: true };
  if (SKIP.has(label)) return { issue: '', kind: '', runnable: false };
  return { issue: '', kind: '', runnable: false };
};
const parseReadme = (text: string): Block[] => {
  const lines = text.split(/\r?\n/);
  const out: Block[] = [];
  let headRaw = '';
  let buf: string[] = [];
  let fence = '';
  let info = '';
  let line = 0;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (!fence) {
      const head = cur.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
      if (head) {
        headRaw = head[1].trim();
        continue;
      }
      const open = cur.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!open) continue;
      fence = open[1];
      info = open[2].trim();
      buf = [];
      line = i + 2;
      continue;
    }
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    if (!close.test(cur)) {
      buf.push(cur);
      continue;
    }
    const code = buf.join('\n');
    const label = labelOf(info);
    const res = decide(label);
    out.push({
      code,
      endLine: i,
      head: shortHead(headRaw),
      headRaw,
      info,
      issue: res.issue,
      kind: res.kind,
      label,
      line,
      runnable: res.runnable,
    });
    fence = '';
    info = '';
    buf = [];
  }
  return out;
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
const tsOpts = (ts: TsLike, cwd: string): Record<string, unknown> => {
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
const checkTypes = (ts: TsLike, cwd: string, code: string): string[] => {
  const file = join(cwd, '.__readme-check.ts');
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
const firstText = (text = ''): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
const compact = (items: string[]): string => {
  const list = items.map((item) => item.trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, 3).join('; ')}${list.length > 3 ? `; +${list.length - 3} more` : ''}`;
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
const modeOf = (label: string, kind: Kind): Mode => {
  if (kind === 'ts') return 'ts';
  if (label === 'cjs') return 'cjs';
  if (label === 'mjs') return 'mjs';
  return 'js';
};
const runCode = async (code: string, cwd: string, mode: Mode): Promise<ExecRes> => {
  const file = join(cwd, `.__readme-check-${process.pid}-${++nextId}.${mode}`);
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
          execArgv: mode === 'ts' ? ['--experimental-strip-types'] : [],
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
      const _err = worker.stderr as any;
      out?.setEncoding?.('utf8');
      _err?.setEncoding?.('utf8');
      out?.on?.('data', (chunk: string) => (stdout += chunk));
      _err?.on?.('data', (chunk: string) => (stderr += chunk));
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
const ref = (file: string, block: Block): string =>
  `${basename(file)}:${block.head} (${block.line})`;
const logIssue = (
  log: Log,
  colorOn: boolean,
  level: 'error' | 'warn',
  file: string,
  block: Block,
  text: string,
  kind: string
) => log(`${status(level, colorOn)} ${ref(file, block)}: ${text} (${kind})`);
const summary = (res: Result) =>
  `${res.passed} passed, ${res.warnings} warning${res.warnings === 1 ? '' : 's'}, ${res.failures} failure${res.failures === 1 ? '' : 's'}, ${res.skipped} skipped`;

export const runCli = async (
  argv: string[],
  opts: {
    checkTypes?: (code: string, cwd: string, pkgFile: string) => string[];
    color?: boolean;
    cwd?: string;
    loadTs?: (pkgFile: string) => TsLike;
    runCode?: (code: string, cwd: string, mode: Mode) => ExecRes | Promise<ExecRes>;
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
  const text = readFileSync(ctx.readmeFile, 'utf8');
  const blocks = parseReadme(text);
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  let ts: TsLike | undefined;
  for (const block of blocks) {
    if (!block.runnable || !block.kind) {
      out.skipped += 1;
      continue;
    }
    let failed = false;
    if (block.kind === 'ts') {
      const errs = (
        opts.checkTypes ||
        ((code, cwd, pkgFile) => checkTypes((ts ||= (opts.loadTs || loadTs)(pkgFile)), cwd, code))
      )(block.code, ctx.runDir, ctx.pkgFile);
      if (errs.length) {
        failed = true;
        out.failures += 1;
        logIssue(console.error, colorOn, 'error', ctx.readmeFile, block, compact(errs), 'type');
      }
      const exec = await Promise.resolve((opts.runCode || runCode)(block.code, ctx.runDir, 'ts'));
      if (!exec.ok) {
        failed = true;
        out.failures += 1;
        const msg =
          exec.error?.message ||
          firstText(exec.stderr) ||
          firstText(exec.stdout) ||
          `exit ${exec.status}`;
        logIssue(console.error, colorOn, 'error', ctx.readmeFile, block, msg, 'exec');
      }
      if (!failed) out.passed += 1;
      continue;
    }
    const js = await Promise.resolve(
      (opts.runCode || runCode)(block.code, ctx.runDir, modeOf(block.label, block.kind))
    );
    if (!js.ok) {
      // A js fence is only "actually ts" when plain JS fails, but the same snippet both
      // typechecks and runs under strip-types. Otherwise keep the original JS exec failure.
      const errs = (
        opts.checkTypes ||
        ((code, cwd, pkgFile) => checkTypes((ts ||= (opts.loadTs || loadTs)(pkgFile)), cwd, code))
      )(block.code, ctx.runDir, ctx.pkgFile);
      const tsExec = !errs.length
        ? await Promise.resolve((opts.runCode || runCode)(block.code, ctx.runDir, 'ts'))
        : undefined;
      if (!errs.length && tsExec?.ok) {
        out.warnings += 1;
        logIssue(
          console.error,
          colorOn,
          'warn',
          ctx.readmeFile,
          block,
          `${block.label || 'js'}->ts`,
          'fence-mismatch'
        );
      } else {
        failed = true;
        out.failures += 1;
        const msg =
          js.error?.message || firstText(js.stderr) || firstText(js.stdout) || `exit ${js.status}`;
        logIssue(console.error, colorOn, 'error', ctx.readmeFile, block, msg, 'exec');
      }
    }
    if (!failed) out.passed += 1;
  }
  (out.failures || out.warnings ? console.error : console.log)(
    `${status(out.failures || out.warnings ? 'error' : 'pass', colorOn)} summary: ${summary(out)}`
  );
  if (out.failures || out.warnings) err('README check found issues');
};

export const __TEST: TestApi = {
  compact: compact,
  decide: decide,
  explicitKind: explicitKind,
  firstText: firstText,
  modeOf: modeOf,
  parseArgs: parseArgs,
  parseReadme: parseReadme,
  readPkg: readPkg,
  resolveCtx: resolveCtx,
  shortHead: shortHead,
  sweepTemps: sweepTemps,
  wantColor: wantColor,
};

const main = async () => {
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
