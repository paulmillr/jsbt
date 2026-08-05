#!/usr/bin/env -S node
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`.
Do not call raw fs delete/write helpers or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src/jsbt`,
then run it after a fresh build.
Like `jsbt bundle`, it runs `npm install` in the selected run/build directory before checking.
File writes/deletes log through `fs-modify.ts` outside the OS temp directory.

It audits the built public `.d.ts` export surface, requires JSDoc on every public export,
checks callable `@param` / `@returns` tags against the exported type shape,
and verifies examples for callable runtime exports.

Plain data constants do not need forced `@example` blocks,
and low-level callback / constructor factories may rely on prose instead of forced examples,
but any examples that exist are still executed.

Exported `type` / `interface` docs must explain the shape directly and must not use `@example`;
object members inside those types need their own JSDoc, typed members must not keep an old inline
trailing comment next to new JSDoc, and callable members need `@param` / `@returns` docs too.

Tagged JSDoc must use multiline blocks, and plain tagless JSDoc must use short
one-line form instead of a multiline block. Runtime examples should show real
public usage: reject placeholders like `void Symbol;`, `{} as any`, or
alias-only `type Example = Foo;`.

All writes and other modifications MUST stay under the selected run/build directory.
This checker takes only a package.json path, uses `test/build` next to it as the default run
directory or a dispatcher-provided temp run directory, and MUST fail if the fixture template is
missing or if `test/build/package.json` does not install the checked package name as `"file:../.."`.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { npmInstall, sweepTemps } from "../fs-modify.js";
import { scanPatternText } from "./patterns.js";
import { dtsPath, jsPath, listModules as listPublicModules, publicCtx, } from "./public.js";
import { compact, docCommentLines, emptyResult, err, execText, firstText, jsbtWorkerLimit, loadTypeScriptApi, makeTypeCheck, nodeLine, nodeStart, pkgArgs, readJson, readSource, recordIssue, reportIssues, runImportFile, runSelf, runTempImport, sorted, usageText, wantColor, withRunDir, withTempFile, } from "./utils.js";
const usage = usageText('tsdoc', 'check-jsdoc.ts');
const partsText = (parts) => parts?.map((part) => part.text).join('') || '';
const tagText = (value) => {
    if (typeof value === 'string')
        return value;
    return Array.isArray(value) ? partsText(value) : '';
};
const resolveCtx = (args, cwd = process.cwd(), runDir) => {
    return withRunDir(publicCtx(args.pkgArg, cwd), runDir);
};
const loadTs = (pkgFile) => {
    return loadTypeScriptApi(pkgFile, 'TypeScript compiler API', ['createProgram']);
};
const loadTSDoc = (pkgFile) => {
    const req = createRequire(pkgFile);
    const raw = (() => {
        try {
            return req('@microsoft/tsdoc');
        }
        catch { }
        try {
            const jsbtPkg = req.resolve('@paulmillr/jsbt/package.json');
            const jsbtReq = createRequire(jsbtPkg);
            return jsbtReq('@microsoft/tsdoc');
        }
        catch {
            return err([
                `missing @microsoft/tsdoc near ${pkgFile};`,
                'reinstall @paulmillr/jsbt or run npm install in the target repo first',
            ].join(' '));
        }
    })();
    const tsdoc = ('default' in raw && raw.default ? raw.default : raw);
    if (typeof tsdoc.TSDocParser !== 'function')
        err(`expected TSDoc parser API near ${pkgFile}`);
    return tsdoc;
};
const runCode = async (code, cwd) => {
    return runTempImport(cwd, {
        code,
        execArgv: [],
        ext: 'ts',
        prefix: '.__jsdoc-check-',
    });
};
const runCodeInCurrentCwd = async (code, cwd) => {
    return withTempFile(cwd, {
        code,
        ext: 'ts',
        prefix: '.__jsdoc-check-',
    }, (file) => runImportFile(file, { execArgv: [] }));
};
const withCwd = async (cwd, fn) => {
    const prev = process.cwd();
    process.chdir(cwd);
    try {
        return await fn();
    }
    finally {
        process.chdir(prev);
    }
};
const EXAMPLE_WORKERS = 8;
const createLimit = (limit) => {
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < limit && queue.length) {
            active += 1;
            queue.shift()();
        }
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push(() => {
            void Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => {
                active -= 1;
                pump();
            });
        });
        pump();
    });
};
const loadProgram = (ts, files, allowJs = false) => ts.createProgram(files, {
    allowJs,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
});
const programs = (ts, mods) => ({
    dts: loadProgram(ts, mods.map((mod) => mod.dtsFile)),
    js: loadProgram(ts, mods.map((mod) => mod.jsFile), true),
});
const moduleExports = (checker, sf, file) => {
    const sym = sf?.symbol || checker.getSymbolAtLocation(sf);
    if (!sf || !sym)
        err(`cannot inspect exports of ${file}`);
    return checker.getExportsOfModule(sym);
};
const progExports = (checker, prog, file) => moduleExports(checker, prog.getSourceFile(file), file);
const sortedProgExports = (checker, prog, file) => progExports(checker, prog, file).sort((a, b) => a.getName().localeCompare(b.getName()));
const isAlias = (ts, sym) => !!(sym.flags & ts.SymbolFlags.Alias);
const resolveAlias = (ts, checker, sym) => isAlias(ts, sym) ? checker.getAliasedSymbol(sym) : sym;
const symLine = (sym) => {
    const node = symDecl(sym);
    return lineAt(node);
};
const lineAt = (node) => {
    const sf = node?.getSourceFile?.();
    if (!node || !sf?.getLineAndCharacterOfPosition)
        return 0;
    return nodeLine(sf, node);
};
const itemAt = (item, node, name = item.name) => ({
    dtsFile: node?.getSourceFile?.()?.fileName || item.dtsFile,
    line: lineAt(node) || item.line,
    name,
});
const isTrivial = (text, name = '') => {
    const norm = (value) => value
        .toLowerCase()
        .replace(/[`*_()[\]{}<>,.:;'"/\\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const value = norm(text);
    if (!value)
        return true;
    if (name && value === norm(name))
        return true;
    return value === 'return' || value === 'returns';
};
const normalizeDoc = (raw) => raw.replace(/(^|\n)(\s*\*\s*)@return\b/g, '$1$2@returns');
const todoTag = /(^|\n)\s*\*\s*@todo\b/;
const parseParam = (tag) => ({
    desc: (tag.text || '').replace(/^\s*-\s*/, '').trim(),
    name: (tag.paramName || '').replace(/^\[|\]$/g, ''),
});
const tagsNamed = (tags, name) => tags.filter((tag) => tag.name === name);
const hasTagName = (tags, name) => !!tagsNamed(tags, name).length;
const paramTagRows = (tags) => tagsNamed(tags, 'param')
    .map(parseParam)
    .filter((tag) => tag.name);
const tagDescMap = (tags) => new Map(tags.map((tag) => [tag.name, tag.desc]));
const returnTag = (tags, legacy = false) => tags.find((tag) => tag.name === 'returns' || (legacy && tag.name === 'return'));
const parseReturn = (tag) => (tag.text || '').replace(/^\s*-\s*/, '').trim();
const LINK_TAG = /\{@link\b/;
const linkTargets = (text) => [...text.matchAll(/\{@link\s+([^\s}|]+)/g)].map((match) => match[1] || '').filter(Boolean);
const linkTail = (target) => {
    const raw = target.trim();
    return /([A-Z][A-Za-z0-9_]*)$/.exec(raw)?.[1] || raw.split(/[.#/]/).at(-1) || raw;
};
const linkTypeNames = (texts) => {
    const out = new Set();
    for (const text of texts) {
        for (const target of linkTargets(text)) {
            const tail = linkTail(target);
            if (tail)
                out.add(tail);
        }
    }
    return out;
};
const sameLinkTarget = (actual, expected) => {
    const trim = (value) => value.replace(/^typeof\s+/, '').trim();
    return trim(actual) === trim(expected) || trim(actual).split(/[.#/]/).at(-1) === trim(expected);
};
const hasLinkTarget = (text, expected) => linkTargets(text).some((target) => sameLinkTarget(target, expected));
const hasAnyLinkTarget = (text, expected) => expected.some((ref) => hasLinkTarget(text, ref));
const linkTargetMsg = (refs) => refs.length <= 1
    ? `{@link ${refs[0]}}`
    : `one of ${refs.map((ref) => `{@link ${ref}}`).join(', ')}`;
const isTsLibDecl = (decl) => /(?:^|\/)lib\.[^/]+\.d\.ts$/.test(decl?.getSourceFile?.()?.fileName || '');
const symDecls = (sym) => sym?.declarations || (sym?.valueDeclaration ? [sym.valueDeclaration] : []);
const symDecl = (sym) => sym?.valueDeclaration || sym?.declarations?.[0];
const paramDecl = (sym, fallback) => sym.valueDeclaration || sym.declarations?.[0] || fallback;
const docNode = (node) => {
    let cur = node;
    while (cur) {
        if (cur?.jsDoc?.length)
            return cur;
        cur = cur.parent;
    }
    return node;
};
const mdLink = /\[[^\]\n]+\]\([^)]+\)/;
const rawLink = /\bhttps?:\/\/\S+/i;
const proseLinkIssues = (text) => {
    const issues = [];
    if (mdLink.test(text))
        issues.push('markdown links are not allowed; use {@link ...}');
    if (rawLink.test(text))
        issues.push('plain URLs are not allowed; use {@link ...}');
    return issues;
};
const linkIssues = (docs, tags) => {
    const issues = [];
    issues.push(...proseLinkIssues(docs));
    for (const tag of tags) {
        if (tag.name === 'example')
            continue;
        for (const issue of proseLinkIssues(tag.prose || tag.text || ''))
            issues.push(issue.replace(' are not allowed', ` are not allowed in @${tag.name}`));
    }
    return issues;
};
const tagBody = (tag) => [tag.text || '', tag.prose || ''].filter(Boolean).join('\n');
const throwsIssues = (tags) => {
    const issues = [];
    for (const tag of tagsNamed(tags, 'throws')) {
        const text = tagBody(tag);
        const first = firstText(text);
        if (!LINK_TAG.test(text))
            issues.push('@throws should include a linked thrown type with {@link ...}');
        if (first.startsWith('{@link'))
            issues.push('@throws should explain the failure first and move {@link ...} after the prose');
    }
    return issues;
};
const throwTagTypes = (tags) => linkTypeNames(tagsNamed(tags, 'throws').map(tagBody));
const throwsExample = (name) => {
    if (name === 'TypeError')
        return '@throws On wrong argument types. {@link TypeError}';
    if (name === 'RangeError')
        return '@throws On wrong argument ranges or values. {@link RangeError}';
    if (name === 'Error')
        return '@throws If a documented runtime validation or state check fails. {@link Error}';
    return `@throws If a documented ${name} condition is hit. {@link ${name}}`;
};
const missingThrowsMsg = (name) => `missing @throws for ${name}; e.g. "${throwsExample(name)}"`;
const throwDocIssues = (docs, info, hasThrowTags) => {
    const issues = [];
    if (!info.thrown.size) {
        if (hasThrowTags && !info.unknown)
            return ['remove @throws; no thrown errors were inferred from the current implementation'];
        return [];
    }
    if (!info.unknown) {
        for (const name of sorted(info.thrown)) {
            if (!docs.has(name))
                issues.push(missingThrowsMsg(name));
        }
        for (const name of sorted(docs)) {
            if (!info.thrown.has(name)) {
                issues.push(`remove stale @throws for ${name}; it is not inferred from the current implementation`);
            }
        }
        return issues;
    }
    if (info.direct.size) {
        for (const name of sorted(info.direct)) {
            if (docs.has(name))
                continue;
            issues.push(missingThrowsMsg(name));
        }
        return issues;
    }
    if (hasThrowTags)
        return issues;
    issues.push([
        'missing @throws; document the known thrown conditions with prose first',
        'and a linked error type',
    ].join(' '));
    return issues;
};
const throwsCoverageIssues = (tags, info) => throwDocIssues(throwTagTypes(tags), info, hasTagName(tags, 'throws'));
const throwInfo = (item) => ({
    direct: new Set(item.direct),
    thrown: new Set(item.thrown),
    unknown: item.unknown,
});
const emptyThrows = () => ({
    direct: new Set(),
    thrown: new Set(),
    unknown: false,
});
const mergeThrows = (...infos) => {
    const out = emptyThrows();
    for (const info of infos) {
        out.unknown ||= info.unknown;
        for (const name of info.direct)
            out.direct.add(name);
        for (const name of info.thrown)
            out.thrown.add(name);
    }
    return out;
};
const mergeThrownOnly = (base, info) => {
    base.unknown ||= info.unknown;
    for (const name of info.thrown)
        base.thrown.add(name);
    return base;
};
const isLocalDecl = (root, decl) => {
    const file = decl?.getSourceFile?.()?.fileName || '';
    if (!file)
        return false;
    if (/(?:^|\/)node_modules\//.test(file))
        return false;
    if (/\.d\.(?:c|m)?ts$/.test(file))
        return false;
    const rel = relative(root, file);
    return !!rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel);
};
const THROW_CLASS = /^[A-Z][A-Za-z0-9_$.]*$/;
const throwName = (checker, expr) => {
    if (!expr)
        return '';
    const sym = checker.getSymbolAtLocation(expr.expression || expr);
    if (sym) {
        const name = sym.getName();
        return THROW_CLASS.test(name) ? name : '';
    }
    const type = checker.getTypeAtLocation?.(expr);
    const text = type ? checker.typeToString(type).trim() : '';
    if (!text || text === 'never' || text === 'unknown' || text === 'any')
        return '';
    return THROW_CLASS.test(text) ? text : '';
};
const bodyOfDecl = (ts, decl) => {
    const api = ts;
    if (decl?.body)
        return decl.body;
    if (api.isVariableDeclaration?.(decl)) {
        const init = decl.initializer;
        if (api.isArrowFunction?.(init) || api.isFunctionExpression?.(init))
            return init.body;
    }
    return undefined;
};
const absUndef = () => ({ kind: 'undefined' });
const absUnknown = () => ({ kind: 'unknown' });
const boolConst = (value) => ({ kind: 'const', value });
const boolAtom = (id) => ({ kind: 'atom', id });
const boolNot = (item) => {
    if (item.kind === 'const')
        return boolConst(!item.value);
    if (item.kind === 'not')
        return item.item;
    return { kind: 'not', item };
};
const boolGroup = (kind, stop, empty, raw) => {
    const items = [];
    for (const cur of raw) {
        if (cur.kind === 'const') {
            if (cur.value === stop)
                return cur;
            continue;
        }
        if (cur.kind === kind)
            items.push(...cur.items);
        else
            items.push(cur);
    }
    if (!items.length)
        return boolConst(empty);
    if (items.length === 1)
        return items[0];
    return kind === 'and' ? { kind: 'and', items } : { kind: 'or', items };
};
const boolAnd = (...raw) => boolGroup('and', false, true, raw);
const boolOr = (...raw) => boolGroup('or', true, false, raw);
const exprText = (node) => {
    const sf = node?.getSourceFile?.();
    if (node?.getText)
        return node.getText(sf).trim();
    const text = sf?.text;
    const start = node?.getStart?.(sf) ?? node?.pos;
    const end = node?.end;
    return typeof text === 'string' && typeof start === 'number' && typeof end === 'number'
        ? text.slice(start, end).trim()
        : '';
};
const boolValue = (expr, facts) => {
    const group = (items, stop, full) => {
        let unknown = false;
        for (const item of items) {
            const value = boolValue(item, facts);
            if (value === stop)
                return stop;
            if (value === undefined)
                unknown = true;
        }
        return unknown ? undefined : full;
    };
    switch (expr.kind) {
        case 'const':
            return expr.value;
        case 'atom':
            return facts.get(expr.id);
        case 'not': {
            const value = boolValue(expr.item, facts);
            return value === undefined ? undefined : !value;
        }
        case 'and':
            return group(expr.items, false, true);
        case 'or':
            return group(expr.items, true, false);
    }
};
const applyGroupFacts = (facts, items, stop, value) => {
    if (value === stop)
        return items.flatMap((item) => applyFacts(new Map(facts), item, stop));
    let states = [new Map(facts)];
    for (const item of items) {
        states = states.flatMap((state) => applyFacts(state, item, !stop));
        if (!states.length)
            return [];
    }
    return states;
};
const applyFacts = (facts, expr, value) => {
    const current = boolValue(expr, facts);
    if (current !== undefined)
        return current === value ? [new Map(facts)] : [];
    if (expr.kind === 'atom') {
        const next = new Map(facts);
        next.set(expr.id, value);
        return [next];
    }
    if (expr.kind === 'not')
        return applyFacts(facts, expr.item, !value);
    if (expr.kind === 'and')
        return applyGroupFacts(facts, expr.items, false, value);
    if (expr.kind === 'or')
        return applyGroupFacts(facts, expr.items, true, value);
    return [];
};
const truthyVal = (value) => {
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
const typeOfVal = (value) => {
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
const eqVal = (a, b) => {
    if (a.kind === 'unknown' || b.kind === 'unknown')
        return;
    if (a.kind !== b.kind)
        return false;
    switch (a.kind) {
        case 'undefined':
        case 'null':
            return true;
        case 'bool':
        case 'number':
        case 'string':
        case 'bigint':
            return a.value === b.value;
        default:
            return;
    }
};
const envGet = (env, name) => env.get(name) || {};
const bindParams = (ts, decl, args, evalValue, evalBool, env, facts) => {
    const api = ts;
    const next = new Map();
    const params = decl?.parameters || decl?.initializer?.parameters || [];
    for (let i = 0; i < params.length; i++) {
        const param = params[i];
        if (!api.isIdentifier?.(param.name))
            continue;
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
    const cache = new WeakMap();
    const active = new WeakSet();
    return (ts, checker, root, decl, seedEnv) => {
        if (!decl || typeof decl !== 'object')
            return emptyThrows();
        if (!seedEnv) {
            const hit = cache.get(decl);
            if (hit)
                return hit;
        }
        if (active.has(decl))
            return emptyThrows();
        active.add(decl);
        const api = ts;
        const evalValue = (node, env, facts) => {
            if (!node || typeof node !== 'object')
                return absUnknown();
            if (api.isParenthesizedExpression?.(node))
                return evalValue(node.expression, env, facts);
            if (api.isIdentifier?.(node)) {
                if (node.text === 'undefined')
                    return absUndef();
                const hit = envGet(env, node.text);
                return hit.value || absUnknown();
            }
            if (api.isStringLiteralLike?.(node))
                return { kind: 'string', value: node.text };
            if (api.isNumericLiteral?.(node))
                return { kind: 'number', value: Number(node.text) };
            if (api.isBigIntLiteral?.(node))
                return { kind: 'bigint', value: BigInt(node.text.slice(0, -1)) };
            if (node.kind === api.SyntaxKind?.TrueKeyword)
                return { kind: 'bool', value: true };
            if (node.kind === api.SyntaxKind?.FalseKeyword)
                return { kind: 'bool', value: false };
            if (node.kind === api.SyntaxKind?.NullKeyword)
                return { kind: 'null' };
            if (api.isPrefixUnaryExpression?.(node)) {
                const value = evalValue(node.operand, env, facts);
                if (value.kind === 'number' && node.operator === api.SyntaxKind?.MinusToken)
                    return { kind: 'number', value: -value.value };
                if (value.kind === 'number' && node.operator === api.SyntaxKind?.PlusToken)
                    return value;
            }
            const question = node.questionDotToken !== undefined;
            if ((api.isPropertyAccessExpression?.(node) || api.isPropertyAccessChain?.(node)) &&
                node.name?.text === 'length') {
                const base = evalValue(node.expression, env, facts);
                if (question && (base.kind === 'undefined' || base.kind === 'null'))
                    return absUndef();
                if (base.kind === 'string')
                    return { kind: 'number', value: base.value.length };
                return absUnknown();
            }
            if (api.isConditionalExpression?.(node)) {
                const cond = boolValue(evalBool(node.condition, env, facts), facts);
                if (cond === true)
                    return evalValue(node.whenTrue, env, facts);
                if (cond === false)
                    return evalValue(node.whenFalse, env, facts);
            }
            if (api.isTypeOfExpression?.(node)) {
                const value = evalValue(node.expression, env, facts);
                const text = typeOfVal(value);
                return text === undefined ? absUnknown() : { kind: 'string', value: text };
            }
            return absUnknown();
        };
        const evalBool = (node, env, facts) => {
            if (!node || typeof node !== 'object')
                return boolAtom('unknown');
            if (api.isParenthesizedExpression?.(node))
                return evalBool(node.expression, env, facts);
            if (api.isCallExpression?.(node)) {
                const callee = node.expression?.getText?.() || '';
                if (callee === 'Number.isSafeInteger') {
                    const value = evalValue(node.arguments?.[0], env, facts);
                    if (value.kind === 'number')
                        return boolConst(Number.isSafeInteger(value.value));
                    if (value.kind !== 'unknown')
                        return boolConst(false);
                }
            }
            if (api.isIdentifier?.(node)) {
                const hit = envGet(env, node.text);
                if (hit.bool)
                    return hit.bool;
                if (hit.value?.kind === 'bool')
                    return boolConst(hit.value.value);
                return boolAtom(node.text);
            }
            if (node.kind === api.SyntaxKind?.TrueKeyword)
                return boolConst(true);
            if (node.kind === api.SyntaxKind?.FalseKeyword)
                return boolConst(false);
            if (api.isPrefixUnaryExpression?.(node) &&
                node.operator === api.SyntaxKind?.ExclamationToken) {
                const value = truthyVal(evalValue(node.operand, env, facts));
                if (value !== undefined)
                    return boolConst(!value);
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
                if (op === api.SyntaxKind?.EqualsEqualsEqualsToken ||
                    op === api.SyntaxKind?.EqualsEqualsToken) {
                    return eq === undefined ? boolAtom(exprText(node)) : boolConst(eq);
                }
                if (op === api.SyntaxKind?.ExclamationEqualsEqualsToken ||
                    op === api.SyntaxKind?.ExclamationEqualsToken) {
                    return eq === undefined ? boolAtom(exprText(node)) : boolConst(!eq);
                }
                if (left.kind !== 'unknown' && right.kind !== 'unknown') {
                    const a = left.value;
                    const b = right.value;
                    if (op === api.SyntaxKind?.LessThanToken)
                        return boolConst(a < b);
                    if (op === api.SyntaxKind?.LessThanEqualsToken)
                        return boolConst(a <= b);
                    if (op === api.SyntaxKind?.GreaterThanToken)
                        return boolConst(a > b);
                    if (op === api.SyntaxKind?.GreaterThanEqualsToken)
                        return boolConst(a >= b);
                }
                return boolAtom(exprText(node));
            }
            const value = truthyVal(evalValue(node, env, facts));
            if (value !== undefined)
                return boolConst(value);
            return boolAtom(exprText(node));
        };
        const callThrows = (expr, env, facts) => {
            const sym0 = checker.getSymbolAtLocation(expr?.expression || expr);
            if (!sym0)
                return emptyThrows();
            const sym = resolveAlias(ts, checker, sym0);
            const infos = [];
            for (const next of symDecls(sym)) {
                if (!isLocalDecl(root, next))
                    continue;
                const body = bodyOfDecl(ts, next);
                if (!body)
                    continue;
                const args = expr?.arguments ? Array.from(expr.arguments) : [];
                infos.push(inferThrows(ts, checker, root, next, bindParams(ts, next, args, evalValue, evalBool, env, facts)));
            }
            return infos.length ? mergeThrows(...infos) : emptyThrows();
        };
        const throwExpr = (expr, env, facts, caught) => {
            if (!expr || typeof expr !== 'object')
                return emptyThrows();
            if (caught && api.isIdentifier?.(expr) && expr.text === caught.name)
                return caught.info;
            if (api.isParenthesizedExpression?.(expr))
                return throwExpr(expr.expression, env, facts, caught);
            if (api.isConditionalExpression?.(expr)) {
                const cond = boolValue(evalBool(expr.condition, env, facts), facts);
                if (cond === true)
                    return throwExpr(expr.whenTrue, env, facts, caught);
                if (cond === false)
                    return throwExpr(expr.whenFalse, env, facts, caught);
                return mergeThrows(throwExpr(expr.whenTrue, env, facts, caught), throwExpr(expr.whenFalse, env, facts, caught));
            }
            const out = emptyThrows();
            const name = throwName(checker, expr);
            if (name) {
                out.direct.add(name);
                out.thrown.add(name);
            }
            else
                out.unknown = true;
            return out;
        };
        const walkExpr = (node, env, facts, caught) => {
            if (!node || typeof node !== 'object')
                return emptyThrows();
            if (api.isFunctionLike?.(node) && node !== decl)
                return emptyThrows();
            if (api.isThrowStatement?.(node))
                return throwExpr(node.expression, env, facts, caught);
            let out = emptyThrows();
            if (api.isCallExpression?.(node) || api.isNewExpression?.(node))
                out = mergeThrownOnly(out, callThrows(node, env, facts));
            api.forEachChild(node, (child) => {
                out = mergeThrows(out, walkExpr(child, env, facts, caught));
            });
            return out;
        };
        const cloneEnv = (env) => new Map(env);
        const flow = (env, facts) => ({ env, facts });
        const fork = (env, facts) => flow(cloneEnv(env), facts);
        const walkOut = (flows, info) => ({ flows, info });
        const walkKeep = (env, facts, info = emptyThrows()) => walkOut([flow(env, facts)], info);
        const walkStop = (info) => walkOut([], info);
        const walkStmt = (node, env, facts, caught) => {
            if (!node || typeof node !== 'object')
                return walkKeep(env, facts);
            if (api.isBlock?.(node))
                return walkList(node.statements || [], [fork(env, facts)], caught);
            if (api.isVariableStatement?.(node)) {
                const nextEnv = cloneEnv(env);
                let out = emptyThrows();
                for (const decl0 of node.declarationList?.declarations || []) {
                    if (decl0.initializer)
                        out = mergeThrows(out, walkExpr(decl0.initializer, nextEnv, facts, caught));
                    if (api.isIdentifier?.(decl0.name)) {
                        const init = decl0.initializer;
                        nextEnv.set(decl0.name.text, init
                            ? { value: evalValue(init, nextEnv, facts), bool: evalBool(init, nextEnv, facts) }
                            : { value: absUndef(), bool: boolConst(false) });
                    }
                }
                return walkKeep(nextEnv, facts, out);
            }
            if (api.isExpressionStatement?.(node))
                return walkKeep(env, facts, walkExpr(node.expression, env, facts, caught));
            if (api.isReturnStatement?.(node))
                return walkStop(walkExpr(node.expression, env, facts, caught));
            if (api.isThrowStatement?.(node))
                return walkStop(walkExpr(node, env, facts, caught));
            if (api.isIfStatement?.(node)) {
                const condInfo = walkExpr(node.expression, env, facts, caught);
                const cond = evalBool(node.expression, env, facts);
                const thenFacts = applyFacts(facts, cond, true);
                const elseFacts = applyFacts(facts, cond, false);
                const walkStates = (stmt, states) => {
                    const flows = [];
                    let info = emptyThrows();
                    for (const state of states) {
                        const cur = walkStmt(stmt, cloneEnv(env), state, caught);
                        info = mergeThrows(info, cur.info);
                        flows.push(...cur.flows);
                    }
                    return walkOut(flows, info);
                };
                const thenRes = thenFacts.length
                    ? walkStates(node.thenStatement, thenFacts)
                    : walkStop(emptyThrows());
                const elseRes = node.elseStatement
                    ? elseFacts.length
                        ? walkStates(node.elseStatement, elseFacts)
                        : walkStop(emptyThrows())
                    : walkOut(elseFacts.map((state) => fork(env, state)), emptyThrows());
                return walkOut([...thenRes.flows, ...elseRes.flows], mergeThrows(condInfo, thenRes.info, elseRes.info));
            }
            if (api.isTryStatement?.(node)) {
                const inside = walkStmt(node.tryBlock, cloneEnv(env), facts, caught).info;
                const finalInfo = node.finallyBlock
                    ? walkStmt(node.finallyBlock, cloneEnv(env), facts, caught).info
                    : emptyThrows();
                if (!node.catchClause)
                    return walkKeep(env, facts, mergeThrows(inside, finalInfo));
                const catchName = node.catchClause.variableDeclaration?.name;
                const name = catchName && api.isIdentifier?.(catchName) ? catchName.text : '';
                const handled = walkStmt(node.catchClause.block, cloneEnv(env), facts, name ? { name, info: inside } : undefined).info;
                return walkKeep(env, facts, mergeThrows(handled, finalInfo));
            }
            return walkKeep(env, facts, walkExpr(node, env, facts, caught));
        };
        const walkList = (list, flows, caught) => {
            let nextFlows = flows;
            let out = emptyThrows();
            for (const node of list) {
                const curFlows = [];
                for (const flow of nextFlows) {
                    const cur = walkStmt(node, flow.env, flow.facts, caught);
                    out = mergeThrows(out, cur.info);
                    curFlows.push(...cur.flows);
                }
                nextFlows = curFlows;
                if (!nextFlows.length)
                    break;
            }
            return walkOut(nextFlows, out);
        };
        const body = bodyOfDecl(ts, decl);
        const out = body
            ? api.isBlock?.(body)
                ? walkList(body.statements || [], [flow(new Map(seedEnv || []), new Map())]).info
                : walkExpr(body, new Map(seedEnv || []), new Map())
            : emptyThrows();
        if (!seedEnv)
            cache.set(decl, out);
        active.delete(decl);
        return out;
    };
})();
const docRaw = (doc) => {
    const sf = doc?.getSourceFile?.();
    const text = sf?.text;
    if (typeof text !== 'string')
        return '';
    const start = nodeStart(sf, doc);
    const end = doc.end || start;
    return text.slice(start, end);
};
const docLines = (doc) => {
    return docCommentLines(docRaw(doc)).filter(Boolean);
};
const nodeKids = (node) => {
    if (Array.isArray(node?.nodes))
        return node.nodes;
    if (Array.isArray(node?._nodes))
        return node._nodes;
    return [];
};
const linkDest = (node) => {
    if (!node || node.kind !== 'LinkTag')
        return '';
    if (typeof node.urlDestination === 'string' && node.urlDestination.trim())
        return node.urlDestination.trim();
    const refs = node.codeDestination?.memberReferences;
    if (!Array.isArray(refs) || !refs.length)
        return '';
    return refs
        .map((ref) => ref?.memberIdentifier?.identifier || ref?.memberSymbol?.symbolReference || '')
        .filter(Boolean)
        .join('.');
};
const docNodeText = (node, prose = false) => {
    if (!node)
        return '';
    if (node.kind === 'SoftBreak')
        return '\n';
    if (prose && (node.kind === 'CodeSpan' || node.kind === 'FencedCode' || node.kind === 'LinkTag'))
        return '';
    if (typeof node.text === 'string')
        return node.text;
    if (!prose && typeof node.code === 'string')
        return node.code;
    if (!prose && node.kind === 'LinkTag') {
        const dest = linkDest(node);
        return dest ? `{@link ${dest}}` : '{@link}';
    }
    const kids = nodeKids(node);
    if (kids.length)
        return kids.map((kid) => docNodeText(kid, prose)).join('');
    if (node.content)
        return docNodeText(node.content, prose);
    return '';
};
const proseText = (node) => docNodeText(node, true);
const PROSE_COMMENT = /(?:^|\n)\s*(?:\/\/|\/\*)/;
const codeTopComment = (code) => {
    const first = firstText(code);
    return !!first && /^(?:\/\/|\/\*)/.test(first);
};
const exampleDoc = (block) => {
    const prose = [];
    const codes = [];
    const errors = [];
    for (const node of nodeKids(block?.content)) {
        if (node?.kind === 'FencedCode') {
            if (typeof node.code === 'string')
                codes.push(node.code.trim());
            continue;
        }
        const text = docNodeText(node).trim();
        if (!text)
            continue;
        prose.push(text);
    }
    if (!codes.length)
        errors.push('example must contain a fenced code block');
    for (const text of prose) {
        if (PROSE_COMMENT.test(text)) {
            errors.push('example prose must not use code comments; move the explanation into prose text');
        }
        errors.push(...proseLinkIssues(text));
    }
    const code = codes.filter(Boolean).join('\n\n').trim();
    if (code && codeTopComment(code)) {
        errors.push('example code must not start with a comment; move the explanation into prose text');
    }
    if (codes.length && !code)
        errors.push('example fenced code block is empty');
    return { code, errors, prose };
};
const messageText = (msg) => {
    const id = String(msg.messageId || '');
    const text = msg.unformattedText?.trim() || id;
    return id ? `${id}: ${text}` : text;
};
const docTag = (name, content, paramName) => ({
    name,
    ...(paramName === undefined ? {} : { paramName }),
    prose: proseText(content).trim(),
    text: docNodeText(content).trim(),
});
const docParseText = (raw) => raw.replace(/(^|\n)(\s*\*\s*)@__NO_SIDE_EFFECTS__(?=\s|$)/g, '$1$2@nosideeffects');
const emptyDocShape = () => ({ plainLongSingle: false, taggedSingle: false });
const addDocShape = (shape, doc) => {
    const sf = doc?.getSourceFile?.();
    if (!sf?.getLineAndCharacterOfPosition)
        return;
    const start = nodeStart(sf, doc);
    const end = Math.max(start, (doc.end || start) - 1);
    const single = sf.getLineAndCharacterOfPosition(start).line === sf.getLineAndCharacterOfPosition(end).line;
    if (doc?.tags?.length) {
        if (single)
            shape.taggedSingle = true;
        return;
    }
    if (!single && docLines(doc).length === 1)
        shape.plainLongSingle = true;
};
const docParser = (() => {
    const cache = new WeakMap();
    return (tsdoc) => {
        const hit = cache.get(tsdoc);
        if (hit)
            return hit;
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
        cache.set(tsdoc, parser);
        return parser;
    };
})();
const docInfo = (() => {
    const cache = new WeakMap();
    return (tsdoc, decl) => {
        if (!decl || typeof decl !== 'object') {
            return {
                docProse: '',
                docs: '',
                errors: [],
                examples: [],
                hasDocs: false,
                plainLongSingle: false,
                taggedSingle: false,
                tags: [],
            };
        }
        const hit = cache.get(decl);
        if (hit)
            return hit;
        const parser = docParser(tsdoc);
        const docs = [];
        const proseDocs = [];
        const errors = [];
        const examples = [];
        const shape = emptyDocShape();
        const tags = [];
        for (const doc of decl?.jsDoc || []) {
            addDocShape(shape, doc);
            const raw = normalizeDoc(docRaw(doc));
            if (!raw)
                continue;
            const res = parser.parseString(docParseText(raw));
            const parsed = res.docComment;
            const summary = docNodeText(parsed?.summarySection).trim();
            const summaryProse = proseText(parsed?.summarySection).trim();
            if (summary)
                docs.push(summary);
            if (summaryProse)
                proseDocs.push(summaryProse);
            for (const block of parsed?.params?.blocks || []) {
                tags.push(docTag('param', block?.content, typeof block?.parameterName === 'string' ? block.parameterName : ''));
            }
            if (parsed?.returnsBlock)
                tags.push(docTag('returns', parsed.returnsBlock.content));
            for (const block of parsed?.customBlocks || []) {
                const name = String(block?.blockTag?.tagName || '').replace(/^@/, '');
                if (!name)
                    continue;
                if (name === 'example') {
                    const example = exampleDoc(block);
                    examples.push(example);
                    tags.push({ name, text: example.prose.join('\n').trim() });
                    continue;
                }
                tags.push(docTag(name, block?.content));
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
            plainLongSingle: shape.plainLongSingle,
            taggedSingle: shape.taggedSingle,
            tags,
        };
        cache.set(decl, out);
        return out;
    };
})();
const docShape = (decl) => {
    const shape = emptyDocShape();
    for (const doc of decl?.jsDoc || [])
        addDocShape(shape, doc);
    return shape;
};
const declMeta = (tsdoc, decl) => {
    const { taggedSingle, ...info } = docInfo(tsdoc, decl);
    return {
        ...info,
        single: taggedSingle,
    };
};
const typedMeta = (tsdoc, decls) => {
    const docs = [];
    const docProse = [];
    const errors = [];
    const examples = [];
    const tags = [];
    let hasDocs = false;
    let plainLongSingle = false;
    let single = false;
    for (const decl of decls) {
        const meta = declMeta(tsdoc, decl.decl);
        if (meta.hasDocs)
            hasDocs = true;
        if (meta.plainLongSingle)
            plainLongSingle = true;
        if (meta.single)
            single = true;
        if (meta.docs)
            docs.push(meta.docs);
        if (meta.docProse)
            docProse.push(meta.docProse);
        errors.push(...meta.errors);
        examples.push(...meta.examples);
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
        tags,
    };
};
const trailingInline = (node) => {
    const sf = node?.getSourceFile?.();
    const text = sf?.text;
    if (typeof text !== 'string')
        return '';
    const end = node?.getEnd?.(sf) || node?.end || 0;
    const next = text.indexOf('\n', end);
    const tail = text.slice(end, next === -1 ? text.length : next);
    const line = tail.match(/^\s*(\/\/.*|\/\*.*\*\/)\s*$/)?.[1];
    if (!line)
        return '';
    if (line.startsWith('//'))
        return line.slice(2).trim();
    return line
        .replace(/^\/\*+\s*/, '')
        .replace(/\s*\*\/$/, '')
        .trim();
};
const sourceFiles = (dtsFile) => {
    const mapFile = `${dtsFile}.map`;
    if (!existsSync(mapFile))
        return [];
    const raw = readJson(mapFile);
    if (!Array.isArray(raw.sources))
        return [];
    return raw.sources
        .filter((src) => typeof src === 'string' && !!src)
        .map((src) => resolve(dirname(mapFile), src))
        .filter((file) => existsSync(file));
};
const exportedDecl = (ts, node) => {
    const kind = ts.SyntaxKind?.ExportKeyword;
    if (kind === undefined)
        return false;
    return (node?.modifiers || []).some((mod) => mod?.kind === kind);
};
const typedDecl = (ts, decl) => {
    const api = ts;
    if (api.isInterfaceDeclaration?.(decl))
        return { decl, kind: 'interface', members: [...decl.members] };
    if (!api.isTypeAliasDeclaration?.(decl))
        return;
    return {
        decl,
        kind: 'type',
        members: api.isTypeLiteralNode?.(decl.type) ? [...decl.type.members] : [],
    };
};
const sourceIndex = (ts, mods) => {
    const out = new Map();
    for (const mod of mods) {
        const fileMap = new Map();
        for (const file of sourceFiles(mod.dtsFile)) {
            const { source: sf } = readSource(ts, file);
            for (const stmt of sf.statements || []) {
                if (!exportedDecl(ts, stmt))
                    continue;
                const typed = typedDecl(ts, stmt);
                if (!typed)
                    continue;
                const name = stmt.name?.text;
                if (!name)
                    continue;
                const memberMap = fileMap.get(name) || new Map();
                for (const member of typed.members) {
                    const memberName = member.name?.getText?.();
                    const inline = memberName ? trailingInline(member) : '';
                    if (memberName && inline)
                        memberMap.set(memberName, inline);
                }
                if (memberMap.size)
                    fileMap.set(name, memberMap);
            }
        }
        out.set(mod.dtsFile, fileMap);
    }
    return out;
};
const sourceInline = (index, dtsFile, typeName, memberName) => index.get(dtsFile)?.get(typeName)?.get(memberName) || '';
const placeholderExample = (code) => {
    const text = code
        .trim()
        .split(/\r?\n/)
        .filter((line) => {
        const trim = line.trim();
        return trim && !/^import(?:\s+type)?\b/.test(trim);
    })
        .join('\n')
        .trim();
    if (!text)
        return '';
    if (/^void\s+[A-Za-z_$][\w$.]*;?$/.test(text))
        return 'placeholder example: void reference';
    if (/\{\}\s+as\s+any\b/.test(text))
        return 'placeholder example: {} as any';
    if (/^type\s+\w+\s*=\s*[A-Za-z_$][\w$.<>,[\]|&?()\s]*;?$/.test(text))
        return 'placeholder example: alias-only type';
    return '';
};
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shouldInject = (code, bind) => {
    if (/^\s*import\s/m.test(code))
        return false;
    const pat = new RegExp(`\\b(?:const|let|var|function|class|type|interface|enum)\\s+${esc(bind)}\\b`);
    return !pat.test(code);
};
const BAG_PARAM = /(?:^|.*(?:opts?|options?|params?|config|cfg|settings?))$/i;
const typeRefName = (node) => node?.typeName?.getText?.() || '';
const typeRefTail = (node) => typeRefName(node).split('.').pop() || '';
const wrappedRef = (node) => {
    const name = typeRefTail(node);
    return name === 'TArg' || name === 'TRet';
};
const typeRefInfo = (ts, checker, node) => {
    const base = checker.getSymbolAtLocation(node?.typeName);
    if (!base)
        return;
    const sym = resolveAlias(ts, checker, base);
    return { base, decl: symDecl(sym) || symDecl(base), sym };
};
const wrapperInner = (ts, node) => {
    const api = ts;
    let cur = node;
    const seen = new Set();
    while (api.isTypeReferenceNode?.(cur) && !seen.has(cur)) {
        seen.add(cur);
        if (!wrappedRef(cur))
            break;
        const next = cur.typeArguments?.[0];
        if (!next)
            break;
        cur = next;
    }
    return cur;
};
const functionTypeNode = (ts, node) => {
    const api = ts;
    const type = wrapperInner(ts, node);
    if (api.isFunctionTypeNode?.(type))
        return type;
    if (api.isParenthesizedTypeNode?.(type))
        return functionTypeNode(ts, type.type);
    if (api.isUnionTypeNode?.(type) || api.isIntersectionTypeNode?.(type)) {
        for (const item of type.types || []) {
            const fn = functionTypeNode(ts, item);
            if (fn)
                return fn;
        }
    }
};
const uniq = (items) => [...new Set(items)];
const bagRef = (refs, name) => refs instanceof Map ? refs.get(name) : refs[name];
const setBagRef = (refs, name, values) => {
    if (!values.length || bagRef(refs, name))
        return;
    if (refs instanceof Map)
        refs.set(name, values);
    else
        refs[name] = values;
};
const addBagFields = (bags, name, fields) => {
    if (!fields.length)
        return;
    bags[name] = uniq([...(bags[name] || []), ...fields]);
};
const namedBagRefs = (ts, checker, node) => {
    const api = ts;
    const type = wrapperInner(ts, node);
    if (!api.isTypeReferenceNode?.(type))
        return [];
    const childRefs = uniq((type.typeArguments || []).flatMap((arg) => namedBagRefs(ts, checker, arg)));
    const ref = typeRefName(type);
    if (!ref)
        return childRefs;
    const decls = typeRefInfo(ts, checker, type)?.base.declarations || [];
    if (decls.length && decls.every((d) => api.isTypeParameterDeclaration?.(d)))
        return childRefs;
    if (decls.length && decls.every((d) => isTsLibDecl(d)))
        return childRefs;
    return childRefs.length ? uniq([...childRefs, ref]) : [ref];
};
const addParamBagRefs = (refs, ts, checker, params) => {
    for (const param of params) {
        const name = param.name?.getText?.();
        if (!name || !BAG_PARAM.test(name))
            continue;
        setBagRef(refs, name, namedBagRefs(ts, checker, param.type));
    }
};
const bagTypeRefs = (ts, checker, decl) => {
    const out = Object.create(null);
    addParamBagRefs(out, ts, checker, decl?.parameters || []);
    return out;
};
const paramTypeNode = (param) => paramDecl(param, param)?.type;
const wrapperAnnotation = (ts, decl) => {
    const api = ts;
    // Re-export-only doc paths can probe wrapper helpers without a direct declaration node.
    if (!decl)
        return;
    const ok = api.isVariableDeclaration?.(decl) ||
        api.isPropertySignature?.(decl) ||
        api.isPropertyDeclaration?.(decl) ||
        api.isTypeAliasDeclaration?.(decl);
    // Function and method `.type` nodes are return types, not callable annotations.
    if (!ok)
        return;
    const type = decl?.type;
    if (!type || !api.isTypeReferenceNode?.(type))
        return;
    if (!wrappedRef(type))
        return;
    return type;
};
const unwrapDocType = (ts, checker, decl) => {
    const type = wrapperAnnotation(ts, decl);
    if (!type || !checker.getTypeAtLocation)
        return;
    // The checker API exposes transformed wrapper signatures as `...args`;
    // unwrap for doc-tag validation so original parameter names are checked.
    const inner = type.typeArguments?.[0];
    if (!inner)
        return;
    const doc = docCallableType(ts, checker, inner);
    return doc.type || checker.getTypeAtLocation(inner);
};
const docCallScore = (ts, checker, type) => {
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call) || [];
    if (!calls.length)
        return -1;
    const params = sigParamNames(calls);
    return params.length === 1 && params[0] === 'args' ? 1 : 10 + params.length;
};
const betterDocType = (ts, checker, best, node, seen) => {
    const next = docCallableType(ts, checker, node, seen);
    return next.score > best.score ? next : best;
};
const betterDocTypes = (ts, checker, best, nodes, seen) => {
    for (const node of nodes)
        best = betterDocType(ts, checker, best, node, seen);
    return best;
};
const docCallableType = (ts, checker, node, seen = new Set()) => {
    const api = ts;
    if (!node || seen.has(node) || !checker.getTypeAtLocation)
        return { score: -1 };
    seen.add(node);
    const type = checker.getTypeAtLocation(node);
    let best = { score: docCallScore(ts, checker, type), type };
    if (api.isTypeReferenceNode?.(node)) {
        if (wrappedRef(node) && node.typeArguments?.length === 1)
            best = betterDocType(ts, checker, best, node.typeArguments[0], seen);
        // Helpers such as Asyncify<F> commonly erase names into ...args; prefer F when it is callable.
        best = betterDocTypes(ts, checker, best, node.typeArguments || [], seen);
        // Keep the declaration local so TypeScript narrows alias-body access below.
        const decl = typeRefInfo(ts, checker, node)?.decl;
        if (api.isTypeAliasDeclaration?.(decl) && decl.type)
            best = betterDocType(ts, checker, best, decl.type, seen);
    }
    if (api.isIntersectionTypeNode?.(node) || api.isUnionTypeNode?.(node))
        best = betterDocTypes(ts, checker, best, node.types || [], seen);
    return best;
};
const unwrapDocDecl = (ts, checker, decl) => {
    const api = ts;
    const type = wrapperAnnotation(ts, decl);
    if (!type)
        return;
    const inner = type.typeArguments?.[0];
    if (!api.isTypeReferenceNode?.(inner))
        return;
    const decl0 = typeRefInfo(ts, checker, inner)?.decl;
    return decl0 ? docNode(decl0) : undefined;
};
const sigParamNames = (sigs) => [
    ...new Set(sigs.flatMap((sig) => sig.parameters.map((param) => param.getName()))),
];
const hasValueReturn = (checker, sig) => {
    const out = checker.typeToString(sig.getReturnType()).replace(/\s+/g, '');
    return (out !== 'void' && out !== 'undefined' && out !== 'Promise<void>' && out !== 'Promise<undefined>');
};
const emptyCallInfo = () => ({
    bagRefs: {},
    bags: {},
    fnParams: [],
    kind: '',
    params: [],
    returns: false,
});
const signatureInfo = (ts, checker, decl, sigs, bagRefs, kind, checkReturn) => {
    const params = sigParamNames(sigs);
    const bags = Object.create(null);
    const fnParams = new Set();
    for (const sig of sigs) {
        for (const param of sig.parameters) {
            const name = param.getName();
            const at = paramDecl(param, decl);
            const type = checker.getTypeOfSymbolAtLocation(param, at);
            if (checker.getSignaturesOfType(type, ts.SignatureKind.Call)?.length ||
                checker.getSignaturesOfType(type, ts.SignatureKind.Construct)?.length) {
                fnParams.add(name);
            }
            if (!BAG_PARAM.test(name))
                continue;
            setBagRef(bagRefs, name, namedBagRefs(ts, checker, paramTypeNode(param)));
            const fields = checker.getPropertiesOfType?.(type) || [];
            const names = fields.map((field) => field.getName()).filter((field) => !isIgnored(field));
            addBagFields(bags, name, names);
        }
    }
    return {
        bagRefs,
        bags,
        fnParams: [...fnParams],
        kind,
        params,
        returns: checkReturn && sigs.some((sig) => hasValueReturn(checker, sig)),
    };
};
const callInfo = (ts, checker, type, decl) => {
    const docType = unwrapDocType(ts, checker, decl) || type;
    const calls = checker.getSignaturesOfType(docType, ts.SignatureKind.Call) || [];
    const bagRefs = bagTypeRefs(ts, checker, decl);
    if (calls.length)
        return signatureInfo(ts, checker, decl, calls, bagRefs, 'call', true);
    const constructs = checker.getSignaturesOfType(type, ts.SignatureKind.Construct) || [];
    if (constructs.length)
        return signatureInfo(ts, checker, decl, constructs, bagRefs, 'construct', false);
    return emptyCallInfo();
};
const typeOfExport = (ts, checker, sym) => {
    const decl = symDecl(sym);
    if (!decl)
        return emptyCallInfo();
    return callInfo(ts, checker, checker.getTypeOfSymbolAtLocation(sym, decl), decl);
};
const typeDecls = (ts, sym) => {
    const out = [];
    for (const decl of symDecls(sym)) {
        const typed = typedDecl(ts, decl);
        if (typed)
            out.push(typed);
    }
    return out;
};
const refDoc = (ts, tsdoc, checker, member) => {
    const api = ts;
    const type = wrapperInner(ts, member?.type);
    const refNode = api.isTypeReferenceNode?.(type) ? type.typeName : undefined;
    if (!refNode)
        return;
    const ref = typeRefInfo(ts, checker, type);
    if (!ref?.decl)
        return;
    const meta = declMeta(tsdoc, ref.decl);
    const info = callInfo(ts, checker, checker.getTypeOfSymbolAtLocation(ref.sym, ref.decl), ref.decl);
    return {
        docs: meta.docs,
        docProse: meta.docProse,
        hasDocs: meta.hasDocs,
        info,
        tags: meta.tags,
    };
};
const docItems = (ts, tsdoc, checker, sym) => {
    const api = ts;
    const out = [];
    const seen = new Set();
    for (const decl of typeDecls(ts, sym)) {
        const ownerName = decl.decl.name?.getText?.() || sym.getName();
        for (const member of decl.members) {
            const nameNode = member.name;
            if (!nameNode?.getText)
                continue;
            const name = nameNode.getText();
            if (!name || seen.has(name))
                continue;
            seen.add(name);
            const msym = member.symbol || checker.getSymbolAtLocation(nameNode);
            const meta = declMeta(tsdoc, member);
            const type = msym
                ? checker.getTypeOfSymbolAtLocation(msym, member)
                : checker.getTypeAtLocation?.(member);
            const fn = api.isMethodSignature?.(member)
                ? member
                : api.isPropertySignature?.(member)
                    ? functionTypeNode(ts, member.type)
                    : undefined;
            const bagRefs = new Map();
            addParamBagRefs(bagRefs, ts, checker, fn?.parameters || []);
            const info = fn
                ? callInfo(ts, checker, checker.getTypeAtLocation?.(fn) || type, fn)
                : callInfo(ts, checker, type, member);
            for (const [param, ref] of Object.entries(info.bagRefs))
                setBagRef(bagRefs, param, ref);
            out.push({
                ...meta,
                bagRefs,
                info,
                inline: trailingInline(member),
                name,
                owner: decl.decl,
                ownerName,
                ref: refDoc(ts, tsdoc, checker, member),
            });
        }
    }
    return out;
};
const bindName = (name, sym) => {
    const value = name === 'default' ? sym.getName() || 'value' : name;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : 'value';
};
const isIgnored = (name) => name.startsWith('_');
const inject = (item, code) => {
    const spec = JSON.stringify(item.spec);
    if (item.runtime) {
        if (item.name === 'default')
            return `import ${item.bind} from ${spec};\n${code}`;
        return `import { ${item.name} as ${item.bind} } from ${spec};\n${code}`;
    }
    if (item.name === 'default')
        return `import type ${item.bind} from ${spec};\n${code}`;
    return `import type { ${item.name} as ${item.bind} } from ${spec};\n${code}`;
};
const describeAttempt = (errs, exec) => {
    if (errs.length)
        return compact(errs);
    if (!exec)
        return '';
    return execText(exec);
};
const examplePatternErrors = (ts, code) => scanPatternText(ts, 'example.ts', code)
    .filter((item) => item.level === 'error')
    .map((item) => `pattern ${item.line}:${item.col}: ${item.issue}`);
const tryExample = async (code, item, ctx, ts, opts = {}) => {
    const attempts = [code, ...(shouldInject(code, item.bind) ? [inject(item, code)] : [])];
    const seen = new Set();
    const fails = [];
    const check = opts.checkTypes || makeTypeCheck(ts, ctx.runDir, '.__jsdoc-check.ts');
    for (const cur of attempts) {
        if (!cur.trim() || seen.has(cur))
            continue;
        seen.add(cur);
        const patterns = examplePatternErrors(ts, cur);
        if (patterns.length) {
            fails.push(compact(patterns));
            continue;
        }
        const placeholder = placeholderExample(cur);
        if (placeholder) {
            fails.push(placeholder);
            continue;
        }
        const errs = check(cur);
        if (errs.length) {
            fails.push(describeAttempt(errs));
            continue;
        }
        if (!item.runtime)
            return '';
        const exec = await Promise.resolve((opts.runCode || runCode)(cur, ctx.runDir));
        if (exec.ok)
            return '';
        fails.push(describeAttempt([], exec));
    }
    return compact(fails);
};
const recordDocIssue = (out, log, level, item, text, kind) => recordIssue(out, log, level, basename(item.dtsFile), `${item.line}/${item.name}`, text, kind);
const recordUniqueDocIssue = (out, log, seen, level, item, text, kind) => {
    const key = `${level}\0${item.dtsFile}\0${item.line}\0${item.name}\0${kind}\0${text}`;
    if (seen.has(key))
        return false;
    seen.add(key);
    recordDocIssue(out, log, level, item, text, kind);
    return true;
};
const hasDocText = (meta) => !!(meta.docs.trim() || meta.tags.length);
const DOC_MSG = {
    invalid: (err) => `invalid TSDoc: ${err}`,
    link: (err) => err,
    missing: 'missing JSDoc',
    plain: 'single-line plain JSDoc must use short form',
    tagged: 'tagged JSDoc must be multiline',
    throws: (err) => err,
};
const TYPE_DOC_MSG = {
    ...DOC_MSG,
    example: 'types/interfaces must not use @example',
};
const memberDocMsg = (name) => ({
    example: `typed member ${name} must not use @example`,
    invalid: (err) => `invalid TSDoc for ${name}: ${err}`,
    link: (err) => `${name}: ${err}`,
    missing: `missing member JSDoc for ${name}`,
    missingKind: 'member',
    plain: `single-line plain member JSDoc for ${name} must use short form`,
    tagged: `tagged member JSDoc for ${name} must be multiline`,
    throws: (err) => `${name}: ${err}`,
});
const reportDocMeta = (fail, at, meta, msg, beforeShape) => {
    for (const err of meta.errors)
        fail(at, msg.invalid(err), 'tsdoc');
    for (const err of linkIssues(meta.docProse, meta.tags))
        fail(at, msg.link(err), 'link');
    for (const err of throwsIssues(meta.tags))
        fail(at, msg.throws(err), 'throws');
    beforeShape?.();
    if (!hasDocText(meta))
        fail(at, msg.missing, msg.missingKind || 'docs');
    if (meta.tags.length && meta.single)
        fail(at, msg.tagged, 'format');
    if (!meta.tags.length && meta.plainLongSingle)
        fail(at, msg.plain, 'format');
    if (msg.example && hasTagName(meta.tags, 'example'))
        fail(at, msg.example, 'example');
};
const reportParamDocs = (fail, at, params, tags, refs, owner = '') => {
    const pTags = paramTagRows(tags);
    const paramMap = tagDescMap(pTags);
    const label = (name) => (owner ? `${owner}.${name}` : name);
    for (const name of params) {
        const desc = paramMap.get(name);
        const full = label(name);
        if (desc === undefined) {
            fail(at, `missing @param ${full}`, 'param');
            continue;
        }
        const ref = bagRef(refs, name);
        if (ref && !hasAnyLinkTarget(desc, ref))
            fail(at, `@param ${full} should link to ${linkTargetMsg(ref)}`, 'param');
        if (isTrivial(desc, name))
            fail(at, `trivial @param ${full} description`, 'param');
    }
    for (const tag of pTags)
        if (!params.includes(tag.name))
            fail(at, `unknown @param ${label(tag.name)}`, 'param');
};
const reportReturnDoc = (fail, at, returns, tag, owner = '') => {
    if (!returns)
        return;
    const suffix = owner ? ` for ${owner}` : '';
    if (!tag)
        fail(at, `missing @returns${suffix}`, 'return');
    else if (isTrivial(parseReturn(tag)))
        fail(at, `trivial @returns${suffix}`, 'return');
};
const symDocs = (checker, sym) => ({
    docs: partsText(sym.getDocumentationComment(checker)),
    tags: sym.getJsDocTags(checker),
});
const exportInfo = (ts, checker, exported) => {
    const resolved = resolveAlias(ts, checker, exported);
    const own = symDocs(checker, exported);
    const resolvedDoc = symDocs(checker, resolved);
    const decl = symDecl(resolved);
    return {
        decl,
        own,
        resolved,
        resolvedDoc,
        resolvedFile: decl?.getSourceFile?.()?.fileName,
        src: hasDocText(own) ? exported : resolved,
    };
};
const forwardedAliasDocs = (ts, mods, mod, exported, info) => {
    if (!isAlias(ts, exported) || hasDocText(info.own) || !hasDocText(info.resolvedDoc))
        return false;
    const file = info.resolvedFile;
    return !file || file === mod.dtsFile || mods.some((item) => item.dtsFile === file);
};
const runtimeExports = (checker, prog, mod) => {
    const out = new Map();
    for (const sym of progExports(checker, prog, mod.jsFile))
        out.set(sym.getName(), sym);
    return out;
};
const exportRows = (ts, mods, dtsChecker, dtsProg, jsChecker, jsProg) => {
    const out = [];
    for (const mod of mods) {
        const runtime = runtimeExports(jsChecker, jsProg, mod);
        for (const exported of sortedProgExports(dtsChecker, dtsProg, mod.dtsFile)) {
            const name = exported.getName();
            if (isIgnored(name))
                continue;
            const ex = exportInfo(ts, dtsChecker, exported);
            const jsSym0 = runtime.get(name);
            out.push({
                ex,
                exported,
                item: {
                    bind: bindName(name, ex.resolved),
                    dtsFile: mod.dtsFile,
                    key: mod.key,
                    line: symLine(ex.resolved) || symLine(exported),
                    name,
                    runtime: !!jsSym0,
                    spec: mod.spec,
                    sym: ex.resolved,
                },
                jsSym: jsSym0 ? resolveAlias(ts, jsChecker, jsSym0) : undefined,
                mod,
            });
        }
    }
    return out;
};
const analyzeDocs = (ts, mods) => {
    const progs = programs(ts, mods);
    const dtsProg = progs.dts;
    const jsProg = progs.js;
    const dtsChecker = dtsProg.getTypeChecker();
    const jsChecker = jsProg.getTypeChecker();
    return {
        dtsChecker,
        jsChecker,
        rows: exportRows(ts, mods, dtsChecker, dtsProg, jsChecker, jsProg),
    };
};
const throwReportIssues = (item) => {
    const docs = linkTypeNames(item.docs);
    return throwDocIssues(docs, throwInfo(item), !!docs.size);
};
const prototypeThrowsRaw = (pkgFile) => {
    const ctx = resolveCtx({ help: false, pkgArg: pkgFile }, dirname(resolve(pkgFile)));
    const ts = loadTs(ctx.pkgFile);
    const mods = listPublicModules(ctx);
    const analysis = analyzeDocs(ts, mods);
    return collectPrototypeThrows(ctx, ts, analysis.rows, analysis.dtsChecker, analysis.jsChecker);
};
const prototypeThrows = (pkgFile) => prototypeThrowsRaw(pkgFile)
    .map((item) => ({ ...item, issues: throwReportIssues(item) }))
    .filter((item) => item.issues.length);
const collectPrototypeThrows = (ctx, ts, rows, dtsChecker, jsChecker) => {
    const out = [];
    for (const row of rows) {
        const docs = tagsNamed(row.ex.src.getJsDocTags(dtsChecker), 'throws').map((tag) => tagText(tag.text));
        if (!row.jsSym)
            continue;
        const decl = symDecl(row.jsSym);
        if (!decl || !isLocalDecl(ctx.cwd, decl))
            continue;
        const info = inferThrows(ts, jsChecker, ctx.cwd, decl);
        if (!info.thrown.size && !docs.length)
            continue;
        out.push({
            direct: sorted(info.direct),
            docs,
            dtsFile: row.item.dtsFile,
            key: row.item.key,
            name: row.item.name,
            thrown: sorted(info.thrown),
            unknown: info.unknown,
        });
    }
    return out;
};
export const runCli = async (argv, opts = {}) => {
    const args = pkgArgs(argv);
    if (args.help) {
        console.log(usage);
        return;
    }
    const colorOn = opts.color ?? wantColor();
    const ctx = resolveCtx(args, opts.cwd, opts.runDir);
    npmInstall(ctx.runDir);
    const log = [];
    const ts = (opts.loadTs || loadTs)(ctx.pkgFile);
    const tsdoc = (opts.loadTSDoc || loadTSDoc)(ctx.pkgFile);
    const mods = listPublicModules(ctx);
    const typedSeen = new Set();
    const analysis = analyzeDocs(ts, mods);
    const dtsChecker = analysis.dtsChecker;
    const srcIndex = sourceIndex(ts, mods);
    const checkExampleTypes = opts.checkTypes
        ? (code) => opts.checkTypes(ts, ctx.runDir, code)
        : makeTypeCheck(ts, ctx.runDir, '.__jsdoc-check.ts');
    const throwReports = collectPrototypeThrows(ctx, ts, analysis.rows, analysis.dtsChecker, analysis.jsChecker);
    const throwMap = new Map(throwReports.map((item) => [`${item.key}:${item.name}`, item]));
    const out = emptyResult();
    const rowResults = [];
    const runExample = createLimit(opts.runCode ? 1 : jsbtWorkerLimit(EXAMPLE_WORKERS));
    const exampleRunCode = opts.runCode || runCodeInCurrentCwd;
    const pendingExamples = [];
    for (const row of analysis.rows) {
        const { ex, exported, item, mod } = row;
        if (forwardedAliasDocs(ts, mods, mod, exported, ex))
            continue;
        const sourceDecl = docNode(symDecl(ex.src));
        const wrappedDecl = unwrapDocDecl(ts, dtsChecker, ex.decl);
        const typed = typeDecls(ts, ex.resolved);
        const smeta = declMeta(tsdoc, sourceDecl);
        const wmeta = wrappedDecl ? declMeta(tsdoc, wrappedDecl) : undefined;
        // TRet<T>/TArg<T> exports often carry the public callable docs on the inner type alias.
        const vmeta = smeta.hasDocs || !wmeta?.hasDocs ? smeta : wmeta;
        const tmeta = typedMeta(tsdoc, typed);
        const typedItem = itemAt(item, ex.decl, ex.decl?.name?.getText?.() || ex.resolved.getName() || item.name);
        const rowResult = { failed: false };
        rowResults.push(rowResult);
        const fail = (at, text, kind) => {
            rowResult.failed = true;
            recordDocIssue(out, log, 'error', at, text, kind);
        };
        const failUnique = (seen, at, text, kind) => {
            if (!recordUniqueDocIssue(out, log, seen, 'error', at, text, kind))
                return;
            rowResult.failed = true;
        };
        const failTyped = (at, text, kind) => failUnique(typedSeen, at, text, kind);
        const info = typeOfExport(ts, dtsChecker, ex.resolved);
        if (typed.length) {
            reportDocMeta(failTyped, typedItem, tmeta, TYPE_DOC_MSG);
        }
        else {
            reportDocMeta(fail, item, vmeta, DOC_MSG);
        }
        const needsValueDocs = item.runtime || !typed.length;
        const inferredThrows = throwMap.get(`${item.key}:${item.name}`);
        if (info.params.length)
            reportParamDocs(fail, item, info.params, needsValueDocs ? vmeta.tags : [], info.bagRefs);
        const ret = needsValueDocs ? returnTag(vmeta.tags) : undefined;
        if (needsValueDocs && !!info.kind && inferredThrows) {
            for (const err of throwsCoverageIssues(vmeta.tags, throwInfo(inferredThrows))) {
                fail(item, err, 'throws');
            }
        }
        reportReturnDoc(fail, item, info.returns, ret);
        if (typed.length) {
            for (const member of docItems(ts, tsdoc, dtsChecker, ex.resolved)) {
                const memberItem = itemAt(typedItem, member.owner, member.ownerName);
                const inline = member.inline || sourceInline(srcIndex, memberItem.dtsFile, memberItem.name, member.name);
                reportDocMeta(failTyped, memberItem, member, memberDocMsg(member.name), () => {
                    if (hasDocText(member) && inline) {
                        failTyped(memberItem, `member ${member.name} must not mix JSDoc with inline comment`, 'member');
                    }
                });
                if (!hasDocText(member))
                    continue;
                const memberTags = paramTagRows(member.tags);
                const memberRet = returnTag(member.tags, true);
                const viaRef = member.ref?.hasDocs && !memberTags.length && !memberRet;
                if (!viaRef) {
                    reportParamDocs(failTyped, memberItem, member.info.params, member.tags, member.bagRefs, member.name);
                    reportReturnDoc(failTyped, memberItem, member.info.returns, memberRet, member.name);
                }
            }
        }
        const examples = needsValueDocs ? vmeta.examples : [];
        const needsExample = needsValueDocs && !!info.kind && !info.fnParams.length;
        if (needsExample) {
            if (!examples.length) {
                fail(item, 'missing @example', 'example');
            }
        }
        if (examples.length) {
            for (let i = 0; i < examples.length; i++) {
                for (const err of examples[i].errors) {
                    fail(item, `example ${i + 1}: ${err}`, 'example');
                }
                if (!examples[i].code)
                    continue;
                const example = examples[i];
                const n = i + 1;
                pendingExamples.push(runExample(() => tryExample(example.code, item, ctx, ts, {
                    checkTypes: checkExampleTypes,
                    runCode: exampleRunCode,
                })).then((msg) => () => {
                    if (!msg)
                        return;
                    fail(item, `example ${n}: ${msg}`, item.runtime ? 'exec' : 'type');
                }));
            }
        }
    }
    const applyExamples = opts.runCode
        ? await Promise.all(pendingExamples)
        : await withCwd(ctx.runDir, () => Promise.all(pendingExamples));
    for (const applyExample of applyExamples)
        applyExample();
    for (const row of rowResults)
        if (!row.failed)
            out.passed += 1;
    reportIssues('tsdoc', log, out, colorOn, 'JSDoc check found issues', 'fail');
};
export const __TEST = {
    bindName: bindName,
    dtsPath: dtsPath,
    docShape: docShape,
    examplePatternErrors: examplePatternErrors,
    exampleDoc: exampleDoc,
    inject: inject,
    isIgnored: isIgnored,
    isTrivial: isTrivial,
    jsPath: jsPath,
    normalizeDoc: normalizeDoc,
    parseParam: parseParam,
    parseReturn: parseReturn,
    placeholderExample: placeholderExample,
    prototypeThrows: prototypeThrows,
    prototypeThrowsRaw: prototypeThrowsRaw,
    shouldInject: shouldInject,
    sweepTemps: sweepTemps,
};
runSelf(import.meta.url, runCli);
