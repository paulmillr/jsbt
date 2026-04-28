#!/usr/bin/env -S node --experimental-strip-types
/**
Checks root/source TypeScript files for raw bigint literals.
Rules:
  - runtime bigint literals are not allowed because older JS engines we still support cannot parse them
  - simple values should become helper consts such as `_1n = BigInt(1)` with a `@__PURE__` annotation
  - specific values should become named consts near use, still using `BigInt(...)` with a `@__PURE__` annotation
  - comments, strings, and type-only bigint literals are ignored
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundled,
  groupIssues,
  guardChild,
  status,
  summary,
  type Issue as LogIssue,
  type Result,
  wantColor,
  pickTSFiles,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type Ctx = { cwd: string; files: string[]; pkgFile: string };
type Issue = { col: number; detail: string; file: string; line: number };
type NodeLike = { end: number; kind: number; operator?: number; operand?: NodeLike };
type FileLike = {
  end: number;
  getLineAndCharacterOfPosition: (pos: number) => { character: number; line: number };
  getStart: (src?: FileLike) => number;
  kind: number;
};
type TsLike = {
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: { BigIntLiteral: number; MinusToken: number };
  createSourceFile: (file: string, text: string, target: unknown, setParentNodes?: boolean) => FileLike;
  forEachChild: (node: NodeLike | FileLike, cb: (node: NodeLike) => void) => void;
  isPrefixUnaryExpression?: (node: NodeLike) => boolean;
  isTypeNode?: (node: NodeLike) => boolean;
};

const usage = `usage:
  jsbt bigint <package.json>

examples:
  jsbt bigint package.json
  node /path/to/jsbt/bigint.ts package.json`;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ACTION =
  'replace raw bigint literal with helper const; use const _1n = /* @__PURE__ */ BigInt(1) for simple values, or const NAME = /* @__PURE__ */ BigInt(...) for specific ones (bigint)';

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const loadTS = (pkgFile: string): TsLike => {
  const req = createRequire(pkgFile);
  const rawTs = (() => {
    try {
      return req('typescript') as TsLike | { default?: TsLike };
    } catch {
      return err(`missing typescript near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const ts = ('default' in rawTs && rawTs.default ? rawTs.default : rawTs) as TsLike;
  if (typeof ts.createSourceFile !== 'function' || typeof ts.forEachChild !== 'function')
    err(`expected TypeScript AST API near ${pkgFile}`);
  return ts;
};
const resolveCtx = (args: Args, cwd: string = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  return { cwd: base, files: pickTSFiles(base), pkgFile };
};
const clean = (raw: string): string => raw.replace(/_/g, '');
const safe = (raw: string): boolean => {
  try {
    const body = raw.startsWith('-') ? raw.slice(1) : raw;
    return BigInt(body) <= MAX_SAFE;
  } catch {
    return false;
  }
};
const render = (raw: string): string => {
  const lit = clean(raw).replace(/n$/, '');
  const neg = lit.startsWith('-');
  const body = neg ? lit.slice(1) : lit;
  const expr = safe(lit)
    ? `BigInt(${neg ? '-' : ''}${body})`
    : neg
      ? `-BigInt('${body}')`
      : `BigInt('${body}')`;
  return `/* @__PURE__ */ ${expr}`;
};
const bigintText = (text: string, start: number, end: number): string => clean(text.slice(start, end));
const scan = (ts: TsLike, cwd: string, file: string): Issue[] => {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const out: Issue[] = [];
  const push = (node: NodeLike) => {
    const start = (node as any).getStart ? (node as any).getStart(src) : 0;
    const { character, line } = src.getLineAndCharacterOfPosition(start);
    const raw = bigintText(text, start, node.end);
    out.push({
      col: character + 1,
      detail: `${raw} -> ${render(raw)}`,
      file: relative(cwd, file) || basename(file),
      line: line + 1,
    });
  };
  const visit = (node: NodeLike) => {
    if (ts.isTypeNode?.(node)) return;
    if (
      (ts.isPrefixUnaryExpression?.(node) || false) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      node.operand?.kind === ts.SyntaxKind.BigIntLiteral
    ) {
      push(node);
      return;
    }
    if (node.kind === ts.SyntaxKind.BigIntLiteral) {
      push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src as any, visit);
  return out;
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; loadTS?: (pkgFile: string) => TsLike } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const ctx = resolveCtx(args, opts.cwd);
  const colorOn = opts.color ?? wantColor();
  const ts = (opts.loadTS || loadTS)(ctx.pkgFile);
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  const logs: LogIssue[] = [];
  for (const file of ctx.files) {
    const issues = scan(ts, ctx.cwd, file);
    if (!issues.length) {
      out.passed++;
      continue;
    }
    for (const item of issues)
      logs.push({
        level: 'ERROR',
        ref: {
          file: item.file,
          issue: `${ACTION}\n${item.detail}`,
          sym: `${item.line}:${item.col}/bigint`,
        },
      });
    out.failures += issues.length;
  }
  for (const line of groupIssues('bigint', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('BigInt check found issues');
  }
  console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
