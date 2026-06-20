#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src/jsbt`, then run it after a fresh build.
Like `jsbt bundle`, it runs `npm install` in the selected run/build directory before checking.
File writes/deletes log through `fs-modify.ts` outside the OS temp directory.

All writes and any other modifications from this script MUST stay under the selected run/build directory.
This checker takes only a package.json path, uses `test/build` next to it as the default run
directory or a dispatcher-provided temp run directory, and MUST fail if the fixture template is
missing or if `test/build/package.json` does not install the checked package name as `"file:../.."`.
 */
import { basename, resolve } from 'node:path';
import { npmInstall, sweepTemps } from '../fs-modify.ts';
import {
  compact,
  emptyResult,
  err,
  execText,
  firstText,
  guardChild,
  loadTypeScriptApi,
  makeTypeCheck,
  pkgArgs,
  readJson,
  readText,
  recordIssue,
  reportIssues,
  runSelf,
  runTempImport,
  usageText,
  wantColor,
  withRunDir,
  type ExecRes,
  type Issue as LogIssue,
  type PkgArgs,
  type Result,
  type TsCheck,
  type TypeCheck,
} from './utils.ts';

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
type TestApi = {
  compact: typeof compact;
  decide: typeof decide;
  explicitKind: typeof explicitKind;
  firstText: typeof firstText;
  blockMode: typeof blockMode;
  parseArgs: typeof pkgArgs;
  parseReadme: typeof parseReadme;
  readPkg: typeof readPkg;
  resolveCtx: typeof resolveCtx;
  shortHead: typeof shortHead;
  sweepTemps: typeof sweepTemps;
  wantColor: typeof wantColor;
};

const usage = usageText('readme', 'check-readme.ts');

const JS = new Set(['cjs', 'javascript', 'js', 'mjs', 'node']);
const SKIP = new Set(['kotlin', 'md', 'markdown', 'plaintext', 'text', 'txt']);
const TS = new Set(['cts', 'mts', 'ts', 'tsx', 'typescript']);

const readPkg = (pkgFile: string): Pkg => {
  const raw = readJson<RawPkg>(pkgFile);
  const name = typeof raw.name === 'string' ? raw.name : '';
  return { name };
};
const resolveCtx = (args: PkgArgs, cwd: string = process.cwd(), runDir?: string): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  const readmeFile = resolve(base, 'README.md');
  guardChild(base, pkgFile, 'package');
  guardChild(base, readmeFile, 'readme');
  const pkg = readPkg(pkgFile);
  if (!pkg.name) err(`expected package name in ${pkgFile}`);
  return withRunDir({ cwd: base, pkg, pkgFile, readmeFile }, runDir);
};
const blockLabel = (info: string) => (info.trim().split(/\s+/, 1)[0] || '').toLowerCase();
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
    const label = blockLabel(info);
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
const loadTs = (pkgFile: string): TsCheck => {
  return loadTypeScriptApi<TsCheck>(pkgFile, 'TypeScript compiler API', ['createProgram']);
};
const blockMode = (label: string, kind: Kind): Mode => {
  if (kind === 'ts') return 'ts';
  if (label === 'cjs') return 'cjs';
  if (label === 'mjs') return 'mjs';
  return 'js';
};
const runCode = async (code: string, cwd: string, mode: Mode): Promise<ExecRes> => {
  return runTempImport(cwd, {
    code,
    execArgv: mode === 'ts' ? ['--experimental-strip-types'] : [],
    ext: mode,
    prefix: '.__readme-check-',
  });
};
const recordBlockIssue = (
  out: Result,
  issues: LogIssue[],
  level: 'error' | 'warn',
  file: string,
  block: Block,
  text: string,
  kind: string
): void =>
  recordIssue(
    out,
    issues,
    level,
    basename(file),
    block.head ? `${block.line}/${block.head}` : String(block.line),
    text,
    kind
  );
export const runCli = async (
  argv: string[],
  opts: {
    checkTypes?: (code: string, cwd: string, pkgFile: string) => string[];
    color?: boolean;
    cwd?: string;
    loadTs?: (pkgFile: string) => TsCheck;
    runCode?: (code: string, cwd: string, mode: Mode) => ExecRes | Promise<ExecRes>;
    runDir?: string;
  } = {}
): Promise<void> => {
  const args = pkgArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  const colorOn = opts.color ?? wantColor();
  const ctx = resolveCtx(args, opts.cwd, opts.runDir);
  npmInstall(ctx.runDir);
  const text = readText(ctx.readmeFile);
  const blocks = parseReadme(text);
  const out = emptyResult();
  const issues: LogIssue[] = [];
  let ts: TsCheck | undefined;
  let typeCheck: TypeCheck | undefined;
  const checkBlockTypes =
    opts.checkTypes ||
    ((code: string, cwd: string, pkgFile: string): string[] => {
      ts ||= (opts.loadTs || loadTs)(pkgFile);
      typeCheck ||= makeTypeCheck(ts, cwd, '.__readme-check.ts');
      return typeCheck(code);
    });
  for (const block of blocks) {
    if (!block.runnable || !block.kind) {
      out.skipped += 1;
      continue;
    }
    let failed = false;
    if (block.kind === 'ts') {
      const errs = checkBlockTypes(block.code, ctx.runDir, ctx.pkgFile);
      if (errs.length) {
        failed = true;
        recordBlockIssue(out, issues, 'error', ctx.readmeFile, block, compact(errs), 'type');
      }
      const exec = await Promise.resolve((opts.runCode || runCode)(block.code, ctx.runDir, 'ts'));
      if (!exec.ok) {
        failed = true;
        recordBlockIssue(out, issues, 'error', ctx.readmeFile, block, execText(exec), 'exec');
      }
      if (!failed) out.passed += 1;
      continue;
    }
    const js = await Promise.resolve(
      (opts.runCode || runCode)(block.code, ctx.runDir, blockMode(block.label, block.kind))
    );
    if (!js.ok) {
      // A js fence is only "actually ts" when plain JS fails, but the same snippet both
      // typechecks and runs under strip-types. Otherwise keep the original JS exec failure.
      const errs = checkBlockTypes(block.code, ctx.runDir, ctx.pkgFile);
      const tsExec = !errs.length
        ? await Promise.resolve((opts.runCode || runCode)(block.code, ctx.runDir, 'ts'))
        : undefined;
      if (!errs.length && tsExec?.ok) {
        recordBlockIssue(
          out,
          issues,
          'warn',
          ctx.readmeFile,
          block,
          `${block.label || 'js'}->ts`,
          'fence-mismatch'
        );
      } else {
        failed = true;
        recordBlockIssue(out, issues, 'error', ctx.readmeFile, block, execText(js), 'exec');
      }
    }
    if (!failed) out.passed += 1;
  }
  reportIssues('readme', issues, out, colorOn, 'README check found issues', 'error');
};

export const __TEST: TestApi = {
  compact: compact,
  decide: decide,
  explicitKind: explicitKind,
  firstText: firstText,
  blockMode: blockMode,
  parseArgs: pkgArgs,
  parseReadme: parseReadme,
  readPkg: readPkg,
  resolveCtx: resolveCtx,
  shortHead: shortHead,
  sweepTemps: sweepTemps,
  wantColor: wantColor,
};

runSelf(import.meta.url, runCli);
