#!/usr/bin/env -S node
/**
Checks root/source TypeScript files for comment lines over 100 chars.
Rules:
  - comment-only lines should be reworded
  - code + inline comments should move above the code
  - comment-only lines are exempt when they mainly contain a URL or other long unbroken token
  - purity pragmas such as @__PURE__ / #__PURE__ block markers are ignored
  - report at most one issue per file/line/kind
 */
import { cliArgs, collectIssues, lineIndex, loadTypeScriptApi, makeIssue, readText, relName, reportIssues, runSelf, sourceCtx, usageText, } from "./utils.js";
const usage = usageText('comments', 'check-comments.ts');
const LIMIT = 100;
const LONG = /\S{40,}/;
const PURE = /^(?:@|#)__PURE__$/;
const URL = /\b[a-z]+:\/\/\S+/i;
const loadTS = (pkgFile) => {
    return loadTypeScriptApi(pkgFile, 'TypeScript scanner API', ['createScanner']);
};
const clean = (text, multi, first, last) => {
    let out = text;
    if (!multi)
        return out.replace(/^\s*\/\/+\s?/, '').trim();
    if (first)
        out = out.replace(/^\s*\/\*+\s?/, '');
    else
        out = out.replace(/^\s*\*\s?/, '');
    if (last)
        out = out.replace(/\s*\*\/\s*$/, '');
    return out.trim();
};
const skip = (text) => PURE.test(text) || URL.test(text) || LONG.test(text);
const scan = (ts, cwd, file) => {
    const text = readText(file);
    const index = lineIndex(text);
    const { lines, starts } = index;
    const scanner = ts.createScanner(ts.ScriptTarget.ESNext, false, ts.LanguageVariant.Standard, text);
    const out = [];
    const seen = new Set();
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        if (kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
            kind !== ts.SyntaxKind.MultiLineCommentTrivia) {
            continue;
        }
        const start = scanner.getTokenPos();
        const end = scanner.getTextPos();
        const first = index.lineOf(start);
        const last = index.lineOf(Math.max(start, end - 1));
        const multi = kind === ts.SyntaxKind.MultiLineCommentTrivia;
        for (let i = first; i <= last; i++) {
            const line = lines[i];
            if (line.length <= LIMIT)
                continue;
            const lineStart = starts[i];
            const lineEnd = lineStart + line.length;
            const segStart = Math.max(start, lineStart);
            const segEnd = Math.min(end, lineEnd);
            if (segStart >= segEnd)
                continue;
            const body = line.slice(segStart - lineStart, segEnd - lineStart);
            const lead = line.slice(0, segStart - lineStart);
            const tail = line.slice(segEnd - lineStart);
            const inline = /\S/.test(lead) || /\S/.test(tail);
            const textOnly = clean(body, multi, i === first, i === last);
            if (!inline && skip(textOnly))
                continue;
            if (inline && PURE.test(textOnly))
                continue;
            const issue = inline
                ? 'line exceeds 100 chars with inline comment; move comment above the code'
                : 'comment line exceeds 100 chars; reword comment';
            const tag = `${file}:${i + 1}:${inline ? 'inline-comment' : 'comment'}:${issue}`;
            if (seen.has(tag))
                continue;
            seen.add(tag);
            out.push({
                file: relName(cwd, file),
                issue,
                kind: inline ? 'inline-comment' : 'comment',
                line: i + 1,
            });
        }
    }
    return out;
};
export const runCli = async (argv, opts = {}) => {
    const cli = cliArgs(argv, usage, opts.color);
    if (!cli)
        return;
    const { args, colorOn } = cli;
    const ctx = sourceCtx(args.pkgArg, opts.cwd);
    const ts = (opts.loadTS || loadTS)(ctx.pkgFile);
    const { issues, result } = collectIssues(ctx.files, (file) => scan(ts, ctx.cwd, file), (item) => makeIssue('error', item.file, `${item.line}/${item.kind}`, item.issue, item.kind));
    reportIssues('comments', issues, result, colorOn, 'Comments check found issues');
};
runSelf(import.meta.url, runCli);
