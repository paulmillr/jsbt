#!/usr/bin/env -S node
/**
Checks root/source TypeScript files for raw bigint literals.
Rules:
  - runtime bigint literals are disallowed because older JS engines cannot parse them
  - simple values should become helper consts such as `_1n = BigInt(1)`
    with a `@__PURE__` annotation
  - specific values should become named consts near use, still using `BigInt(...)`
    with a `@__PURE__` annotation
  - comments, strings, and type-only bigint literals are ignored
 */
import {
  cliArgs,
  collectIssues,
  loadTypeScriptApi,
  makeIssue,
  nodeStart,
  readSource,
  relName,
  reportIssues,
  runSelf,
  sourceCtx,
  usageText,
  walkAst,
} from './utils.ts';

type Issue = { col: number; detail: string; file: string; line: number };
// TypeScript AST nodes expose positions even when our narrow scanner type omits most API.
type NodeLike = {
  end: number;
  getStart?: (src?: FileLike) => number;
  kind: number;
  operator?: number;
  operand?: NodeLike;
  pos?: number;
};
type FileLike = {
  end: number;
  getLineAndCharacterOfPosition: (pos: number) => { character: number; line: number };
  getStart: (src?: FileLike) => number;
  kind: number;
};
type TsLike = {
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: { BigIntLiteral: number; MinusToken: number };
  createSourceFile: (
    file: string,
    text: string,
    target: unknown,
    setParentNodes?: boolean
  ) => FileLike;
  forEachChild: (node: NodeLike | FileLike, cb: (node: NodeLike) => void) => void;
  isPrefixUnaryExpression?: (node: NodeLike) => boolean;
  isTypeNode?: (node: NodeLike) => boolean;
};

const usage = usageText('bigint', 'jsbt/bigint.ts');
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ACTION = [
  'replace raw bigint literal with helper const;',
  'use const _1n = /* @__PURE__ */ BigInt(1) for simple values,',
  'or const NAME = /* @__PURE__ */ BigInt(...) for specific ones (bigint)',
].join(' ');

const loadTS = (pkgFile: string): TsLike => {
  return loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript AST API', [
    'createSourceFile',
    'forEachChild',
  ]);
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
const bigintText = (text: string, start: number, end: number): string =>
  clean(text.slice(start, end));
const scan = (ts: TsLike, cwd: string, file: string): Issue[] => {
  const { source: src, text } = readSource(ts, file);
  const out: Issue[] = [];
  const push = (node: NodeLike) => {
    const start = nodeStart(src, node);
    const { character, line } = src.getLineAndCharacterOfPosition(start);
    const raw = bigintText(text, start, node.end);
    out.push({
      col: character + 1,
      detail: `${raw} -> ${render(raw)}`,
      file: relName(cwd, file),
      line: line + 1,
    });
  };
  walkAst(ts, src, (node: NodeLike) => {
    if (ts.isTypeNode?.(node)) return;
    if (
      (ts.isPrefixUnaryExpression?.(node) || false) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      node.operand?.kind === ts.SyntaxKind.BigIntLiteral
    ) {
      push(node);
      return false;
    }
    if (node.kind === ts.SyntaxKind.BigIntLiteral) {
      push(node);
      return false;
    }
    return true;
  });
  return out;
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; loadTS?: (pkgFile: string) => TsLike } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const ctx = sourceCtx(args.pkgArg, opts.cwd);
  const ts = (opts.loadTS || loadTS)(ctx.pkgFile);
  const { issues, result } = collectIssues(
    ctx.files,
    (file) => scan(ts, ctx.cwd, file),
    (item) =>
      makeIssue('error', item.file, `${item.line}:${item.col}/bigint`, `${ACTION}\n${item.detail}`)
  );
  reportIssues('bigint', issues, result, colorOn, 'BigInt check found issues');
};

runSelf(import.meta.url, runCli);
