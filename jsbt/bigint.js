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
import { cliArgs, collectIssues, loadTypeScriptApi, makeIssue, nodeStart, readSource, relName, reportIssues, runSelf, sourceCtx, usageText, walkAst, } from "./utils.js";
const usage = usageText('bigint', 'jsbt/bigint.ts');
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ACTION = [
    'replace raw bigint literal with helper const;',
    'use const _1n = /* @__PURE__ */ BigInt(1) for simple values,',
    'or const NAME = /* @__PURE__ */ BigInt(...) for specific ones (bigint)',
].join(' ');
const loadTS = (pkgFile) => {
    return loadTypeScriptApi(pkgFile, 'TypeScript AST API', [
        'createSourceFile',
        'forEachChild',
    ]);
};
const clean = (raw) => raw.replace(/_/g, '');
const safe = (raw) => {
    try {
        const body = raw.startsWith('-') ? raw.slice(1) : raw;
        return BigInt(body) <= MAX_SAFE;
    }
    catch {
        return false;
    }
};
const render = (raw) => {
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
const bigintText = (text, start, end) => clean(text.slice(start, end));
const scan = (ts, cwd, file) => {
    const { source: src, text } = readSource(ts, file);
    const out = [];
    const push = (node) => {
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
    walkAst(ts, src, (node) => {
        if (ts.isTypeNode?.(node))
            return;
        if ((ts.isPrefixUnaryExpression?.(node) || false) &&
            node.operator === ts.SyntaxKind.MinusToken &&
            node.operand?.kind === ts.SyntaxKind.BigIntLiteral) {
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
export const runCli = async (argv, opts = {}) => {
    const cli = cliArgs(argv, usage, opts.color);
    if (!cli)
        return;
    const { args, colorOn } = cli;
    const ctx = sourceCtx(args.pkgArg, opts.cwd);
    const ts = (opts.loadTS || loadTS)(ctx.pkgFile);
    const { issues, result } = collectIssues(ctx.files, (file) => scan(ts, ctx.cwd, file), (item) => makeIssue('error', item.file, `${item.line}:${item.col}/bigint`, `${ACTION}\n${item.detail}`));
    reportIssues('bigint', issues, result, colorOn, 'BigInt check found issues');
};
runSelf(import.meta.url, runCli);
