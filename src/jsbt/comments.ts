#!/usr/bin/env -S node --experimental-strip-types
/**
Checks root/source TypeScript files for comment lines over 100 chars.
Rules:
  - comment-only lines should be reworded
  - code + inline comments should move above the code
  - comment-only lines are exempt when they mainly contain a URL or other long unbroken token
  - purity pragmas such as @__PURE__ / #__PURE__ block markers are ignored
  - report at most one issue per file/line/kind
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundled,
  groupIssues,
  guardChild,
  issueKind,
  pickTSFiles,
  status,
  summary,
  type Issue as LogIssue,
  type Result,
  wantColor,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type Ctx = { cwd: string; files: string[]; pkgFile: string };
type Issue = { file: string; issue: string; kind: 'comment' | 'inline-comment'; line: number };
type ScannerLike = { getTextPos: () => number; getTokenPos: () => number; scan: () => number };
type TsLike = {
  LanguageVariant: { Standard: unknown };
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: {
    EndOfFileToken: number;
    MultiLineCommentTrivia: number;
    SingleLineCommentTrivia: number;
  };
  createScanner: (target: unknown, skipTrivia: boolean, lang: unknown, text: string) => ScannerLike;
};

const usage = `usage:
  jsbt comments <package.json>

examples:
  jsbt comments package.json
  node /path/to/check-comments.ts package.json`;

const LIMIT = 100;
const LONG = /\S{40,}/;
const PURE = /^(?:@|#)__PURE__$/;
const URL = /\b[a-z]+:\/\/\S+/i;

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
  if (typeof ts.createScanner !== 'function')
    err(`expected TypeScript scanner API near ${pkgFile}`);
  return ts;
};
const resolveCtx = (args: Args, cwd: string = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  return { cwd: base, files: pickTSFiles(base), pkgFile };
};
const splitText = (text: string): { lines: string[]; starts: number[] } => {
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
  return { lines, starts };
};
const lineOf = (starts: number[], pos: number): number => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};
const clean = (text: string, multi: boolean, first: boolean, last: boolean): string => {
  let out = text;
  if (!multi) return out.replace(/^\s*\/\/+\s?/, '').trim();
  if (first) out = out.replace(/^\s*\/\*+\s?/, '');
  else out = out.replace(/^\s*\*\s?/, '');
  if (last) out = out.replace(/\s*\*\/\s*$/, '');
  return out.trim();
};
const skip = (text: string): boolean => PURE.test(text) || URL.test(text) || LONG.test(text);
const scan = (ts: TsLike, cwd: string, file: string): Issue[] => {
  const text = readFileSync(file, 'utf8');
  const { lines, starts } = splitText(text);
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    false,
    ts.LanguageVariant.Standard,
    text
  );
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
      kind !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    const first = lineOf(starts, start);
    const last = lineOf(starts, Math.max(start, end - 1));
    const multi = kind === ts.SyntaxKind.MultiLineCommentTrivia;
    for (let i = first; i <= last; i++) {
      const line = lines[i];
      if (line.length <= LIMIT) continue;
      const lineStart = starts[i];
      const lineEnd = lineStart + line.length;
      const segStart = Math.max(start, lineStart);
      const segEnd = Math.min(end, lineEnd);
      if (segStart >= segEnd) continue;
      const body = line.slice(segStart - lineStart, segEnd - lineStart);
      const lead = line.slice(0, segStart - lineStart);
      const tail = line.slice(segEnd - lineStart);
      const inline = /\S/.test(lead) || /\S/.test(tail);
      const textOnly = clean(body, multi, i === first, i === last);
      if (!inline && skip(textOnly)) continue;
      if (inline && PURE.test(textOnly)) continue;
      const issue = inline
        ? 'line exceeds 100 chars with inline comment; move comment above the code'
        : 'comment line exceeds 100 chars; reword comment';
      const tag = `${file}:${i + 1}:${inline ? 'inline-comment' : 'comment'}:${issue}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push({
        file: relative(cwd, file) || basename(file),
        issue,
        kind: inline ? 'inline-comment' : 'comment',
        line: i + 1,
      });
    }
  }
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
          issue: issueKind(item.issue, item.kind),
          sym: `${item.line}/${item.kind}`,
        },
      });
    out.failures += issues.length;
  }
  for (const line of groupIssues('comments', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('Comments check found issues');
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
