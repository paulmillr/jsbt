#!/usr/bin/env -S node
/**
Checks typed-array API type usage across old and new TypeScript releases.
Goal:
  - keep input types broad, so old plain `Uint8Array` callers stay accepted
  - keep output types portable, so new TS does not leak `SharedArrayBuffer` into WebCrypto calls
Rules:
  - function parameters should wrap byte-carrying types in `TArg<...>`
  - function returns / exported values should wrap byte-carrying types in `TRet<...>`
  - class fields should stay plain typed arrays, not wrapped output helper types
  - generic typed arrays such as `Uint8Array<ArrayBuffer>` are rejected everywhere
 */
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import { cliArgs, emptyResult, ident, loadTypeScriptApi, makeIssue, nodeLine, nodeStart, pickTSFiles, pkgTarget, readText, relName, reportIssues, resolveLocalImport, runSelf, usageText, walkAst, wantTSFile, } from "./utils.js";
const usage = usageText('bytes', 'check-bytes.ts');
const TYPED = [
    'BigInt64Array',
    'BigUint64Array',
    'Float32Array',
    'Float64Array',
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'Uint16Array',
    'Uint32Array',
    'Uint8Array',
    'Uint8ClampedArray',
];
const SHORT = {
    BigInt64Array: 'RetBI64A',
    BigUint64Array: 'RetBU64A',
    Float32Array: 'RetF32A',
    Float64Array: 'RetF64A',
    Int16Array: 'RetI16A',
    Int32Array: 'RetI32A',
    Int8Array: 'RetI8A',
    Uint16Array: 'RetU16A',
    Uint32Array: 'RetU32A',
    Uint8Array: 'RetU8A',
    Uint8ClampedArray: 'RetU8CA',
};
const TYPED_SET = new Set(TYPED);
const CANON_TYPED = [
    'BigInt64Array',
    'BigUint64Array',
    'Float32Array',
    'Float64Array',
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'Uint16Array',
    'Uint32Array',
    'Uint8ClampedArray',
    'Uint8Array',
];
const HELPER_DOC = [
    'Bytes API type helpers for old + new TypeScript.',
    '',
    'TS 5.6 has `Uint8Array`, while TS 5.9+ made it generic `Uint8Array<ArrayBuffer>`.',
    "We can't use specific return type, because TS 5.6 will error.",
    "We can't use generic return type, because most TS 5.9 software will expect specific type.",
    '',
    'Maps typed-array input leaves to broad forms.',
    'These are compatibility adapters, not ownership guarantees.',
    '',
    '- `TArg` keeps byte inputs broad.',
    '- `TRet` marks byte outputs for TS 5.6 and TS 5.9+ compatibility.',
];
const TARG_DOC = [
    'Recursively adapts byte-carrying API input types. See {@link TypedArg}.',
];
const TRET_DOC = [
    'Recursively adapts byte-carrying API output types. See {@link TypedArg}.',
];
const jsdoc = (lines) => lines.length === 1
    ? `/** ${lines[0]} */`
    : ['/**', ...lines.map((line) => ` * ${line}`), ' */'].join('\n');
const CANON_DOC = new Map([
    ['TypedArg', jsdoc([...HELPER_DOC])],
    ['TypedRet', jsdoc(['Maps typed-array output leaves to narrow TS-compatible forms.'])],
    ['TArg', jsdoc([...TARG_DOC])],
    ['TRet', jsdoc([...TRET_DOC])],
]);
const canonTyped = (leaf) => [
    ...CANON_TYPED.flatMap((typed, i) => [
        `${'  '.repeat(i)}${i ? ': ' : ''}T extends ${typed}`,
        `${'  '.repeat(i + 1)}? ${leaf(typed)}`,
    ]),
    `${'  '.repeat(CANON_TYPED.length)}: never`,
].join('\n');
const CANON_TYPED_ARG = canonTyped((typed) => typed);
const CANON_TYPED_RET = canonTyped((typed) => `ReturnType<typeof ${typed}.of>`);
const CANON_TARG = `T | ([TypedArg<T>] extends [never]
  ? T extends (...args: infer A) => infer R
    ? ((...args: { [K in keyof A]: TRet<A[K]> }) => TArg<R>) & {
        [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TArg<T[K]>;
      }
    : T extends [infer A, ...infer R]
      ? [TArg<A>, ...{ [K in keyof R]: TArg<R[K]> }]
      : T extends readonly [infer A, ...infer R]
        ? readonly [TArg<A>, ...{ [K in keyof R]: TArg<R[K]> }]
        : T extends (infer A)[]
          ? TArg<A>[]
          : T extends readonly (infer A)[]
            ? readonly TArg<A>[]
            : T extends Promise<infer A>
              ? Promise<TArg<A>>
              : T extends object
                ? { [K in keyof T]: TArg<T[K]> }
                : T
  : TypedArg<T>)`;
const CANON_TRET = `T extends unknown
  ? T & ([TypedRet<T>] extends [never]
    ? T extends (...args: infer A) => infer R
      ? ((...args: { [K in keyof A]: TArg<A[K]> }) => TRet<R>) & {
          [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TRet<T[K]>;
        }
      : T extends [infer A, ...infer R]
        ? [TRet<A>, ...{ [K in keyof R]: TRet<R[K]> }]
        : T extends readonly [infer A, ...infer R]
          ? readonly [TRet<A>, ...{ [K in keyof R]: TRet<R[K]> }]
          : T extends (infer A)[]
            ? TRet<A>[]
            : T extends readonly (infer A)[]
              ? readonly TRet<A>[]
              : T extends Promise<infer A>
                ? Promise<TRet<A>>
                : T extends object
                  ? { [K in keyof T]: TRet<T[K]> }
                  : T
    : TypedRet<T>)
  : never`;
const helperBlock = () => [
    jsdoc([...HELPER_DOC]),
    `export type TypedArg<T> = ${CANON_TYPED_ARG};`,
    jsdoc(['Maps typed-array output leaves to narrow TS-compatible forms.']),
    `export type TypedRet<T> = ${CANON_TYPED_RET};`,
    jsdoc([...TARG_DOC]),
    `export type TArg<T> = ${CANON_TARG};`,
    jsdoc([...TRET_DOC]),
    `export type TRet<T> = ${CANON_TRET};`,
]
    .join('\n')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
const HELPER_FILE = /\.(?:d\.[cm]?ts|[cm]?ts|tsx)$/;
const tsOpts = (ts, cwd) => {
    const file = ts.findConfigFile?.(cwd, ts.sys.fileExists, 'tsconfig.json');
    const base = (() => {
        if (!file || !ts.readConfigFile || !ts.parseJsonConfigFileContent)
            return {};
        const res = ts.readConfigFile(file, ts.sys.readFile);
        return res.error
            ? {}
            : ts.parseJsonConfigFileContent(res.config || {}, ts.sys, dirname(file)).options || {};
    })();
    return {
        ...base,
        allowImportingTsExtensions: true,
        module: base.module || ts.ModuleKind.NodeNext || ts.ModuleKind.ESNext,
        moduleResolution: base.moduleResolution ||
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
const resolveImportFile = (from, spec, files) => resolveLocalImport(from, spec, {
    accept: (file) => files.has(file) || (existsSync(file) && wantTSFile(file)),
});
const loadTS = (pkgFile) => {
    return loadTypeScriptApi(pkgFile, 'TypeScript parser API', [
        'createProgram',
        'createSourceFile',
        'forEachChild',
    ]);
};
const nodeText = (file, node) => file.text.slice(node.pos, node.end).trim();
const normType = (text) => text.replace(/\s+/g, '');
const normText = (file, node) => normType(nodeText(file, node));
const flatText = (file, node) => nodeText(file, node).replace(/\s+/g, ' ');
const nodePos = (file, node) => nodeStart(file.source, node);
const nodeLineNo = (file, node) => nodeLine(file.source, node);
const nodeName = (file, node) => {
    if (!node)
        return '';
    if (typeof node.escapedText === 'string')
        return node.escapedText;
    return nodeText(file, node);
};
const refLike = (node) => node?.kind === KIND.TypeReference || node?.kind === KIND.ImportType;
const typeRefName = (file, node) => node?.kind === KIND.TypeReference ? nodeName(file, node.typeName) : '';
const refName = (file, node) => node?.kind === KIND.ImportType ? nodeName(file, node.qualifier) : nodeName(file, node?.typeName);
const typedAlias = (state, file, name) => file.imports.get(name) || state.aliasByName.get(name);
const typedKind = (file, node) => {
    const name = typeRefName(file, node);
    if (!TYPED_SET.has(name))
        return;
    return name;
};
const canonicalKind = (file, node) => {
    if (typeRefName(file, node) !== 'ReturnType' || typeArgs(node).length !== 1)
        return;
    const raw = normText(file, node);
    const hit = raw.match(/^ReturnType<typeof([A-Za-z0-9_]+)\.of>$/);
    if (!hit || !TYPED_SET.has(hit[1]))
        return;
    return hit[1];
};
const byteLeaf = (file, node) => !!(typedKind(file, node) || canonicalKind(file, node));
const aliasDef = (name, alias = SHORT[name]) => `type ${alias} = ReturnType<typeof ${name}.of>`;
const canonDef = (name) => `ReturnType<typeof ${name}.of>`;
const rawDef = (name, alias) => `type ${alias} = ${name}`;
const genericDef = (alias, raw) => `type ${alias} = ${raw}`;
const labelIn = (name, alias) => alias.startsWith('ReturnType<')
    ? `${alias} (return-only type)`
    : `${alias} (${aliasDef(name, alias)}; return-only type)`;
const outMsg = (raw) => `wrap output type with TRet<${raw}>`;
const modeUse = (name, mode) => {
    if (mode === 'input')
        return `use TArg<${name}> in input types`;
    if (mode === 'field')
        return `use ${name} in field types`;
    if (mode === 'output')
        return `use TRet<${name}> in output types`;
    return `use TArg<${name}> in input types or TRet<${name}> in output types`;
};
const genMsg = (name, raw, mode) => `avoid generic ${raw}; ${modeUse(name, mode)}`;
const genAliasMsg = (name, alias, raw, mode) => {
    const base = [
        `avoid generic typed-array alias ${alias} (${genericDef(alias, raw)});`,
        `define ${rawDef(name, alias)}, then`,
    ].join(' ');
    return `${base} ${modeUse(alias, mode)}`;
};
const inMsg = (name, alias) => `use ${name} in input types instead of ${labelIn(name, alias)}`;
const fieldMsg = (name, alias) => `use ${name} in field types instead of ${labelIn(name, alias)}`;
const defaultMsg = (typed, role, name) => {
    const chosen = role === 'raw' ? typed : canonDef(typed);
    return [
        `avoid default byte generic parameter ${chosen} on ${name};`,
        `spell ${typed} or ${canonDef(typed)} explicitly at use sites`,
    ].join(' ');
};
const helperMsg = (action, target) => [
    `${action} canonical bytes helper types ${action === 'add' ? 'to' : 'in'} ${target};`,
    `use this block:\n${helperBlock()}`,
].join(' ');
const wrapName = (mode) => {
    if (mode === 'input')
        return 'TArg';
    if (mode === 'output')
        return 'TRet';
    return;
};
const isWrapped = (file, node, wrap) => typeRefName(file, node) === wrap;
const typeArgs = (node) => node?.typeArguments || [];
const visitNodes = (nodes, visit) => {
    for (const node of nodes)
        if (visit(node) === true)
            return true;
    return false;
};
const visitParts = (parts, visit) => {
    if (!parts)
        return;
    for (const part of parts)
        if (visit(part) === true)
            return true;
    return false;
};
const visitTypeArgs = (node, visit) => visitNodes(typeArgs(node), visit);
const typeArg = (file, node, name) => typeRefName(file, node) === name ? typeArgs(node)[0] : undefined;
const promiseArg = (file, node) => typeArg(file, node, 'Promise');
const badPromiseRet = (file, node) => {
    const arg = typeArg(file, node, 'TRet');
    return promiseArg(file, arg);
};
// Explicit async return annotations must stay Promise<...>, not TRet<Promise<...>>.
const wrapMsg = (file, node, mode) => {
    const promise = mode === 'output' ? promiseArg(file, node) : undefined;
    if (promise)
        return `wrap output type with Promise<TRet<${flatText(file, promise)}>>`;
    const wrap = mode === 'input' ? 'TArg' : 'TRet';
    return `wrap ${mode} type with ${wrap}<${flatText(file, node)}>`;
};
const badPromiseRetMsg = (file, node) => {
    const raw = flatText(file, node);
    return `use Promise<TRet<${raw}>> instead of TRet<Promise<${raw}>>`;
};
const bindSubs = (file, decl, args) => {
    const params = typeParams(decl);
    if (!params.length)
        return;
    const subs = new Map();
    for (let i = 0; i < params.length; i++) {
        const param = params[i];
        const name = nodeName(file, param.name);
        const arg = args?.[i] || param.default;
        if (name && arg)
            subs.set(name, arg);
    }
    return subs.size ? subs : undefined;
};
const subKey = (subs) => !subs || !subs.size
    ? ''
    : [...subs].map(([name, node]) => `${name}:${node?.pos || 0}:${node?.end || 0}`).join(',');
const spanKey = (file, node, ...parts) => [file.file, node?.pos || 0, node?.end || 0, ...parts].join(':');
const seenAdd = (seen, key) => {
    if (seen.has(key))
        return false;
    seen.add(key);
    return true;
};
const subNode = (file, node, subs) => {
    if (!subs || !node || node.kind !== KIND.TypeReference || typeArgs(node).length)
        return node;
    const name = typeRefName(file, node);
    return subs.get(name) || node;
};
const enterType = (file, node, seen, subs, ...parts) => {
    node = subNode(file, node, subs);
    if (!node)
        return;
    // Recursive mapped generics can re-enter the same type-argument node before a decl guard runs.
    if (!seenAdd(seen, spanKey(file, node, ...parts, subKey(subs))))
        return;
    return node;
};
const refBody = (item) => subNode(item.ctx, item.node?.type, item.subs);
const refArgs = (file, node, subs) => typeArgs(node).map((arg) => subNode(file, arg, subs));
const typeCallable = (node) => node?.kind === KIND.FunctionType || node?.kind === KIND.ConstructorType;
const constructLike = (node) => node?.kind === KIND.ConstructorType || node?.kind === KIND.ConstructSignature;
const functionLike = (node) => node?.kind === KIND.FunctionDeclaration ||
    node?.kind === KIND.MethodDeclaration ||
    node?.kind === KIND.FunctionExpression ||
    node?.kind === KIND.ArrowFunction;
const accessor = (node) => node?.kind === KIND.GetAccessor || node?.kind === KIND.SetAccessor;
const memberCallable = (node) => node?.kind === KIND.MethodDeclaration ||
    node?.kind === KIND.MethodSignature ||
    node?.kind === KIND.CallSignature ||
    node?.kind === KIND.ConstructSignature ||
    typeCallable(node);
const runtimeCallable = (node) => functionLike(node) || node?.kind === KIND.Constructor || accessor(node);
const classRuntimeMember = (node) => !!classDecl(node?.parent) &&
    (node.kind === KIND.MethodDeclaration || node.kind === KIND.Constructor || accessor(node));
const classStorageMember = (node) => node?.kind === KIND.PropertyDeclaration || node?.kind === KIND.IndexSignature;
const members = (node) => node?.members || [];
const paramTypes = (node) => (node?.parameters || []).map((item) => item.type);
const visitParamTypes = (node, visit) => visitNodes(paramTypes(node), visit);
const typeParams = (node) => node?.typeParameters || [];
const stmts = (source) => (source.statements || []);
const typeAlias = (node) => (node?.kind === KIND.TypeAliasDeclaration ? node : undefined);
const interfaceDecl = (node) => node?.kind === KIND.InterfaceDeclaration ? node : undefined;
const classDecl = (node) => (node?.kind === KIND.ClassDeclaration ? node : undefined);
const variableDecl = (node) => node?.kind === KIND.VariableDeclaration ? node : undefined;
const typeQuery = (node) => (node?.kind === KIND.TypeQuery ? node : undefined);
const declLike = (node) => !!(typeAlias(node) || interfaceDecl(node) || classDecl(node));
const importDecl = (node) => (node?.kind === KIND.ImportDeclaration ? node : undefined);
const modSpec = (node) => {
    const spec = node?.moduleSpecifier?.text;
    return typeof spec === 'string' ? spec : undefined;
};
const importElements = (node) => importDecl(node)?.importClause?.namedBindings?.elements || [];
const namedElements = (node) => {
    if (node?.kind === KIND.ExportDeclaration)
        return node.exportClause?.elements || [];
    return importElements(node);
};
const heritageTypes = (node) => {
    const out = [];
    for (const item of node?.heritageClauses || [])
        for (const part of item.types || [])
            out.push(part);
    return out;
};
const flowFor = (mode) => {
    if (mode === 'output')
        return 'output';
    if (mode === 'input' || mode === 'field')
        return 'input';
    return;
};
const markFlow = (uses, name, mode) => {
    const flow = flowFor(mode);
    if (!flow)
        return;
    let set = uses.get(name);
    if (!set) {
        set = new Set();
        uses.set(name, set);
    }
    set.add(flow);
};
const declType = (node) => ({ kind: 'type', node });
const declMember = (node, owner) => ({
    kind: 'member',
    node,
    owner,
});
const callableParts = (node, mode) => {
    const out = [{ kind: 'params', mode: 'input', node }];
    if (node?.kind !== KIND.SetAccessor && node?.type)
        out.push({ kind: 'type', mode: fnOutMode(mode), node: node.type });
    return out;
};
const visitCallableParts = (node, mode, params, type) => {
    return (visitParts(callableParts(node, mode), (part) => part.kind === 'params' ? params(part.node, part.mode) : type(part.node, part.mode)) === true);
};
const memberParts = (node, mode, construct = 'callable') => {
    const type = (part, next = mode) => ({ kind: 'type', mode: next, node: part });
    if (!node)
        return;
    if (construct === 'opaque' && constructLike(node))
        return [{ kind: 'opaque', mode, node }];
    if (node.kind === KIND.PropertySignature || node.kind === KIND.IndexSignature) {
        // Returned object/interface members are part of the API surface, unlike class storage fields.
        return [type(node.type)];
    }
    if (node.kind === KIND.PropertyDeclaration)
        return [type(node.type, 'field')];
    if (memberCallable(node))
        return [{ kind: 'callable', mode, node }];
    if (node.kind === KIND.GetAccessor)
        return [type(node.type, fnOutMode(mode))];
    if (node.kind === KIND.SetAccessor)
        return [{ kind: 'params', mode: 'input', node }];
    return;
};
const visitMemberParts = (node, mode, construct, type, callable, params, opaque = () => undefined) => {
    return (visitParts(memberParts(node, mode, construct), (part) => part.kind === 'type'
        ? type(part.node, part.mode)
        : part.kind === 'callable'
            ? callable(part.node, part.mode)
            : part.kind === 'params'
                ? params(part.node, part.mode)
                : opaque(part.node, part.mode)) === true);
};
const typeParts = (node, mode) => {
    const type = (part, next = mode) => ({ kind: 'type', mode: next, node: part });
    if (node.kind === KIND.ArrayType)
        return [type(node.elementType)];
    if (node.kind === KIND.ParenthesizedType || node.kind === KIND.TypeOperator)
        return [type(node.type)];
    if (node.kind === KIND.IndexedAccessType)
        return [type(node.objectType), type(node.indexType, 'neutral')];
    if (node.kind === KIND.UnionType || node.kind === KIND.IntersectionType)
        return (node.types || []).map((item) => type(item));
    if (node.kind === KIND.TupleType)
        return (node.elements || []).map((item) => type(item));
    if (node.kind === KIND.ConditionalType) {
        return [
            type(node.checkType, 'neutral'),
            type(node.extendsType, 'neutral'),
            type(node.trueType),
            type(node.falseType),
        ];
    }
    if (node.kind === KIND.MappedType)
        return [type(node.typeParameter?.constraint, 'neutral'), type(node.type)];
    if (node.kind === KIND.TypeLiteral)
        return members(node).map((item) => ({ kind: 'member', mode, node: item }));
    if (typeCallable(node))
        return [{ kind: 'callable', mode, node }];
    return;
};
const visitTypeParts = (node, mode, visit, member, callable) => {
    return visitParts(typeParts(node, mode), (part) => part.kind === 'member'
        ? member(part.node, part.mode)
        : part.kind === 'callable'
            ? callable(part.node, part.mode)
            : visit(part.node, part.mode));
};
const walkTypeParts = (node, mode, visit, member, callable) => visitTypeParts(node, mode, visit, member, callable) !== undefined;
const declParts = (node) => {
    if (!node)
        return;
    if (typeAlias(node))
        return [declType(node.type)];
    if (interfaceDecl(node)) {
        return [
            ...heritageTypes(node).map(declType),
            ...members(node).map((part) => declMember(part, 'interface')),
        ];
    }
    if (classDecl(node)) {
        return [
            ...heritageTypes(node).map(declType),
            ...members(node).map((part) => declMember(part, 'class')),
        ];
    }
    return;
};
const visitDeclParts = (node, type, member, classMember = member) => {
    return (visitParts(declParts(node), (part) => part.kind === 'type'
        ? type(part.node)
        : part.owner === 'class'
            ? classMember(part.node)
            : member(part.node)) === true);
};
const collectParamUse = (file, node, mode, names, uses) => {
    if (!node)
        return;
    const name = typeRefName(file, node);
    if (name) {
        if (names.has(name) && !typeArgs(node).length) {
            markFlow(uses, name, mode);
            return;
        }
        visitTypeArgs(node, (item) => collectParamUse(file, item, mode, names, uses));
        return;
    }
    walkTypeParts(node, mode, (item, next) => collectParamUse(file, item, next, names, uses), (item, next) => collectMemberParamUse(file, item, next, names, uses), (item, next) => collectCallableParamUse(file, item, next, names, uses));
};
const collectParamTypes = (file, node, names, uses) => {
    visitParamTypes(node, (type) => collectParamUse(file, type, 'input', names, uses));
};
const collectCallableParamUse = (file, node, mode, names, uses) => {
    visitCallableParts(node, mode, (item) => collectParamTypes(file, item, names, uses), (item, next) => collectParamUse(file, item, next, names, uses));
};
const collectMemberParamUse = (file, node, mode, names, uses) => {
    visitMemberParts(node, mode, 'callable', (item, next) => collectParamUse(file, item, next, names, uses), (item, next) => collectCallableParamUse(file, item, next, names, uses), (item) => collectParamTypes(file, item, names, uses));
};
const collectDeclParamUse = (file, node, mode, names) => {
    const uses = new Map();
    visitDeclParts(node, (item) => collectParamUse(file, item, mode, names, uses), (item) => collectMemberParamUse(file, item, mode, names, uses), (item) => {
        if (classStorageMember(item))
            collectParamUse(file, item.type, 'field', names, uses);
    });
    return uses;
};
const filterSubs = (file, decl, mode, subs) => {
    if (!subs || !subs.size || mode === 'neutral')
        return subs;
    const names = new Set(subs.keys());
    const uses = collectDeclParamUse(file, decl, mode, names);
    let out;
    for (const [name, node] of subs) {
        const seen = uses.get(name);
        // Mixed generic parameters are invariant: Ret* or raw would break Coder-like APIs.
        if (seen?.has('input') && seen.has('output'))
            continue;
        if (!out)
            out = new Map();
        out.set(name, node);
    }
    return out;
};
const makeFileCtx = (ts, prog, cwd, file) => {
    const hit = prog.getSourceFile(file);
    const text = hit?.text || readText(file);
    const source = hit || ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const decls = new Map();
    const ctx = {
        decls,
        file,
        imports: new Map(),
        rel: relName(cwd, file),
        source,
        text,
    };
    for (const stmt of stmts(source)) {
        const name = nodeName(ctx, stmt.name);
        if (!name)
            continue;
        if (declLike(stmt))
            decls.set(name, stmt);
    }
    return ctx;
};
const getFileCtx = (state, file) => {
    const hit = state.files.get(file);
    if (hit)
        return hit;
    const ctx = makeFileCtx(state.ts, state.prog, state.cwd, file);
    state.files.set(file, ctx);
    return ctx;
};
const symDecls = (state, part, wantFile = wantTSFile) => {
    let sym = state.checker.getSymbolAtLocation(part);
    const aliasFlag = state.ts.SymbolFlags?.Alias || 0;
    while (sym && aliasFlag && !!state.checker.getAliasedSymbol && (sym.flags || 0) & aliasFlag) {
        const next = state.checker.getAliasedSymbol(sym);
        if (!next || next === sym)
            break;
        sym = next;
    }
    return (sym?.declarations || [])
        .map((decl) => {
        const sf = decl?.getSourceFile?.();
        const fileName = sf?.fileName;
        if (!fileName || !existsSync(fileName) || !wantFile(fileName))
            return;
        return { ctx: getFileCtx(state, fileName), node: decl };
    })
        .filter((item) => !!item);
};
const ctxDecls = (state, part) => (part ? symDecls(state, part) : []);
const refDecls = (state, node) => ctxDecls(state, node?.typeName || node?.qualifier || node);
const targetKey = (target, ...parts) => [target.ctx.file, target.node?.pos || 0, ...parts].join(':');
const makeRefTarget = (ctx, local, node, args, mapSubs) => ({
    ctx,
    local,
    node,
    subs: mapSubs(ctx, node, bindSubs(ctx, node, args)),
});
const refTargets = (state, file, node, subs, mapSubs = (_ctx, _decl, cur) => cur) => {
    const args = refArgs(file, node, subs);
    const out = [];
    for (const item of refDecls(state, node))
        out.push(makeRefTarget(item.ctx, false, item.node, args, mapSubs));
    const name = refName(file, node);
    const decl = file.decls.get(name);
    if (decl)
        out.push(makeRefTarget(file, true, decl, args, mapSubs));
    return out;
};
const resolveByteType = (state, file, node, seen = new Set()) => {
    if (!node)
        return;
    const typed = typedKind(file, node);
    if (typed && !typeArgs(node).length)
        return { role: 'raw', typed };
    const canon = canonicalKind(file, node);
    if (canon)
        return { role: 'ret', typed: canon };
    if (!refLike(node))
        return;
    const name = refName(file, node);
    const aliased = typedAlias(state, file, name);
    if (aliased)
        return { role: 'ret', typed: aliased };
    for (const item of refTargets(state, file, node)) {
        if (!seenAdd(seen, targetKey(item)))
            continue;
        const body = refBody(item);
        const resolved = resolveByteType(state, item.ctx, body, seen);
        if (resolved)
            return resolved;
    }
    return;
};
const refValueDecls = (state, node) => ctxDecls(state, node?.exprName || node);
const typeQueryRefs = (state, node) => typeQuery(node) ? refValueDecls(state, node) : [];
const returnTypeRefs = (state, file, node, subs) => {
    if (typeRefName(file, node) !== 'ReturnType')
        return [];
    const arg = subNode(file, typeArgs(node)[0], subs);
    return typeQueryRefs(state, arg);
};
const probeIn = (probe, state, file, seen, subs) => {
    return (node) => probe(state, file, node, seen, subs);
};
const probeTarget = (probe, state, seen) => {
    return (target) => probe(state, target.ctx, target.node, seen, target.subs);
};
const hasParamTypes = (probe, state, file, node, seen, subs) => {
    return visitParamTypes(node, probeIn(probe, state, file, seen, subs));
};
const hasTypeArgs = (probe, state, file, node, seen, subs) => {
    return visitTypeArgs(node, probeIn(probe, state, file, seen, subs));
};
const hasRefTargetDecls = (probe, state, file, node, seen, subs) => {
    const has = probeTarget(probe, state, seen);
    for (const item of refTargets(state, file, node, subs))
        if (has(item))
            return true;
    return false;
};
const hasRefParts = (probe, decl, aliasMatch, state, file, node, seen, subs) => {
    const name = refName(file, node);
    if (typedAlias(state, file, name))
        return aliasMatch;
    if (hasTypeArgs(probe, state, file, node, seen, subs))
        return true;
    if (hasRefTargetDecls(decl, state, file, node, seen, subs))
        return true;
    return false;
};
const hasMemberTypes = (probe, state, file, node, seen, subs) => probeIn(probe, state, file, seen, subs)(node?.type) ||
    hasParamTypes(probe, state, file, node, seen, subs);
const hasByteMember = (state, file, node, seen, subs) => hasMemberTypes(hasByteType, state, file, node, seen, subs);
const hasOpaqueParamTypes = (state, file, node, seen, subs) => hasParamTypes(hasOpaqueDomain, state, file, node, seen, subs);
const hasOpaqueCallable = (state, file, node, seen, subs) => hasMemberTypes(hasOpaqueDomain, state, file, node, seen, subs);
const hasByteDecl = (state, file, node, seen, subs) => visitDeclParts(node, (item) => hasByteType(state, file, item, seen, subs), (item) => hasByteMember(state, file, item, seen, subs));
const hasTypeParts = (probe, member, callable, state, file, node, seen, subs) => {
    const typeHere = probeIn(probe, state, file, seen, subs);
    const memberHere = probeIn(member, state, file, seen, subs);
    const callableHere = probeIn(callable, state, file, seen, subs);
    return visitTypeParts(node, 'neutral', typeHere, memberHere, callableHere) === true;
};
const hasByteType = (state, file, node, seen, subs) => {
    node = enterType(file, node, seen, subs);
    if (!node)
        return false;
    if (byteLeaf(file, node))
        return true;
    for (const item of returnTypeRefs(state, file, node, subs))
        if (hasByteType(state, item.ctx, item.node?.type, seen, subs))
            return true;
    if (refLike(node)) {
        return hasRefParts(hasByteType, hasByteDecl, true, state, file, node, seen, subs);
    }
    if (hasTypeParts(hasByteType, hasByteMember, hasByteMember, state, file, node, seen, subs))
        return true;
    return false;
};
const hasOpaqueDomainMember = (state, file, node, seen, subs) => {
    return visitMemberParts(node, 'neutral', 'opaque', (item) => hasOpaqueDomain(state, file, item, seen, subs), (item) => hasOpaqueCallable(state, file, item, seen, subs), (item) => hasOpaqueParamTypes(state, file, item, seen, subs), () => true);
};
const hasSelfBound = (file, node) => {
    for (const param of typeParams(node)) {
        const name = nodeName(file, param.name);
        if (name &&
            param.constraint &&
            new RegExp(`\\b${name}\\b`).test(nodeText(file, param.constraint))) {
            return true;
        }
    }
    return false;
};
const hasOpaqueMembers = (state, file, node, seen, subs, skipStorage = false) => {
    for (const item of members(node)) {
        if ((!skipStorage || !classStorageMember(item)) &&
            hasOpaqueDomainMember(state, file, item, seen, subs)) {
            return true;
        }
    }
    return false;
};
const hasOpaqueDomainDecl = (state, file, node, seen, subs) => {
    if (!node)
        return false;
    if (node.kind === KIND.TypeParameter) {
        const constraint = subNode(file, node.constraint, subs);
        return hasOpaqueDomain(state, file, constraint, seen, subs);
    }
    if (typeAlias(node))
        return hasOpaqueDomain(state, file, node.type, seen, subs);
    if (interfaceDecl(node)) {
        if (hasSelfBound(file, node))
            return true;
        if (node.heritageClauses?.length)
            return true;
        if (hasOpaqueMembers(state, file, node, seen, subs))
            return true;
    }
    if (classDecl(node)) {
        if (hasSelfBound(file, node))
            return true;
        if (hasOpaqueMembers(state, file, node, seen, subs, true))
            return true;
    }
    return false;
};
const hasOpaqueDomain = (state, file, node, seen, subs) => {
    node = enterType(file, node, seen, subs, 'opaque');
    if (!node)
        return false;
    if (byteLeaf(file, node))
        return false;
    // Whole-object wrappers are unsafe when they would recurse into domain objects such as
    // F-bounded points or point constructors; those need explicit method-level fixes instead.
    if (constructLike(node))
        return true;
    if (typeQuery(node)) {
        // `typeof PointClass` is a constructor surface even though it reaches us as a type query.
        for (const item of typeQueryRefs(state, node)) {
            if (classDecl(item.node))
                return true;
            if (hasOpaqueDomain(state, item.ctx, item.node?.type, seen, subs))
                return true;
        }
        return false;
    }
    if (refLike(node)) {
        return hasRefParts(hasOpaqueDomain, hasOpaqueDomainDecl, false, state, file, node, seen, subs);
    }
    if (hasTypeParts(hasOpaqueDomain, hasOpaqueDomainMember, hasOpaqueCallable, state, file, node, seen, subs)) {
        return true;
    }
    return false;
};
const walkReturnDecl = (state, file, node, mode, seen, subs, onlyGeneric = false) => {
    if (!node)
        return false;
    if (functionLike(node) || node.kind === KIND.MethodSignature || node.kind === KIND.GetAccessor) {
        walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
        return true;
    }
    const variable = variableDecl(node);
    if (variable) {
        const type = variable.type;
        if (typeCallable(type)) {
            walkType(state, file, type.type, mode, seen, subs, onlyGeneric);
            return true;
        }
        const init = variable.initializer;
        if (functionLike(init)) {
            walkType(state, file, init.type, mode, seen, subs, onlyGeneric);
            return true;
        }
    }
    return false;
};
const fnOutMode = (mode) => (mode === 'output' ? 'output' : 'neutral');
const walkParamTypes = (state, file, node, seen, subs, onlyGeneric = false) => {
    visitParamTypes(node, (type) => walkType(state, file, type, 'input', seen, subs, onlyGeneric));
};
const walkCallable = (state, file, node, mode, seen, subs, onlyGeneric = false) => {
    visitCallableParts(node, mode, (item) => walkParamTypes(state, file, item, seen, subs, onlyGeneric), (item, next) => walkType(state, file, item, next, seen, subs, onlyGeneric));
};
const pushIssue = (state, file, line, sym, issue, kind, prepend = false) => {
    const key = `${file}:${line}:${kind}:${issue}`;
    if (!seenAdd(state.seen, key))
        return;
    const item = { file, issue, kind, line, sym };
    if (prepend)
        state.issues.unshift(item);
    else
        state.issues.push(item);
};
const issueSym = (kind) => kind === 'bytes-field'
    ? 'field'
    : kind === 'bytes-generic' || kind === 'bytes-default'
        ? 'generic'
        : kind === 'bytes-helper'
            ? 'helper'
            : kind === 'bytes-input'
                ? 'input'
                : 'return';
const addIssue = (state, file, node, issue, kind) => {
    const line = nodeLineNo(file, node);
    pushIssue(state, file.rel, line, issueSym(kind), issue, kind);
};
const addInFieldIssue = (state, file, node, mode, typed, label) => {
    if (mode === 'input')
        addIssue(state, file, node, inMsg(typed, label), 'bytes-input');
    else if (mode === 'field')
        addIssue(state, file, node, fieldMsg(typed, label), 'bytes-field');
};
const addGenericIssue = (state, file, node, typed, raw, mode, alias = raw) => {
    const msg = alias === raw ? genMsg(typed, raw, mode) : genAliasMsg(typed, alias, raw, mode);
    addIssue(state, file, node, msg, 'bytes-generic');
};
const addRawLeafIssue = (state, file, node, mode, onlyGeneric, typed, raw, label = raw, generic = false) => {
    if (generic) {
        addGenericIssue(state, file, node, typed, raw, mode, label);
        return true;
    }
    if (onlyGeneric)
        return true;
    if (mode === 'output')
        addIssue(state, file, node, outMsg(label), 'bytes-return');
    return true;
};
const addRetLeafIssue = (state, file, node, mode, onlyGeneric, typed, label) => {
    if (!onlyGeneric)
        addInFieldIssue(state, file, node, mode, typed, label);
    return true;
};
const hasBytes = (state, file, node) => hasByteType(state, file, node, new Set());
const hasOpaque = (state, file, node) => hasOpaqueDomain(state, file, node, new Set());
const addBadPromiseRetIssue = (state, file, node) => {
    const bad = badPromiseRet(file, node);
    if (!bad || !hasBytes(state, file, bad))
        return false;
    addIssue(state, file, node, badPromiseRetMsg(file, bad), 'bytes-return');
    return true;
};
const wrappedPromiseRet = (file, node) => {
    const promise = promiseArg(file, node);
    return !!promise && isWrapped(file, promise, 'TRet');
};
const addPromiseRetIssue = (state, file, node, wrapByte = false) => {
    if (addBadPromiseRetIssue(state, file, node))
        return true;
    const promise = promiseArg(file, node);
    if (!promise)
        return false;
    if (wrappedPromiseRet(file, node))
        return true;
    if (!wrapByte || !hasBytes(state, file, promise))
        return false;
    addIssue(state, file, node, wrapMsg(file, node, 'output'), 'bytes-return');
    return true;
};
const checkWrap = (state, file, node, mode) => {
    if (!node)
        return;
    const before = state.issues.length;
    walkType(state, file, node, mode, new Set(), undefined, true);
    if (state.issues.length !== before)
        return;
    const wrap = wrapName(mode);
    if (mode === 'output' && addPromiseRetIssue(state, file, node, true))
        return;
    if (!wrap || isWrapped(file, node, wrap))
        return;
    if (!hasBytes(state, file, node))
        return;
    if (hasOpaque(state, file, node))
        return;
    addIssue(state, file, node, wrapMsg(file, node, mode), mode === 'input' ? 'bytes-input' : 'bytes-return');
};
const refAlias = (file, node, decl, declFile) => {
    const raw = refName(file, node);
    if (ident(raw))
        return raw;
    const name = nodeName(declFile, decl?.name);
    return ident(name) ? name : raw;
};
const addExternalRefIssue = (state, file, node, target, mode, onlyGeneric) => {
    if (target.local)
        return false;
    const body = refBody(target);
    const generic = typedKind(target.ctx, body);
    const alias = refAlias(file, node, target.node, target.ctx);
    if (generic) {
        return addRawLeafIssue(state, file, node, mode, onlyGeneric, generic, nodeText(target.ctx, body || target.node), alias, !!typeArgs(target.node?.type).length);
    }
    const canonical = canonicalKind(target.ctx, body);
    if (canonical)
        return addRetLeafIssue(state, file, node, mode, onlyGeneric, canonical, alias);
    return false;
};
const walkType = (state, file, node, mode, seen, subs, onlyGeneric = false) => {
    node = enterType(file, node, seen, subs, mode);
    if (!node)
        return;
    const typed = typedKind(file, node);
    if (typed) {
        const raw = nodeText(file, node);
        addRawLeafIssue(state, file, node, mode, onlyGeneric, typed, raw, raw, !!typeArgs(node).length);
        return;
    }
    const canon = canonicalKind(file, node);
    if (canon) {
        addRetLeafIssue(state, file, node, mode, onlyGeneric, canon, canonDef(canon));
        return;
    }
    if (!onlyGeneric && mode === 'output') {
        if (addPromiseRetIssue(state, file, node, true))
            return;
    }
    for (const item of returnTypeRefs(state, file, node, subs))
        if (walkReturnDecl(state, item.ctx, item.node, mode, seen, subs, onlyGeneric))
            return;
    if (refLike(node)) {
        const name = refName(file, node);
        const aliased = typedAlias(state, file, name);
        if (aliased) {
            if (onlyGeneric)
                return;
            addInFieldIssue(state, file, node, mode, aliased, name);
            return;
        }
        for (const item of refTargets(state, file, node, subs, (ctx, decl, cur) => filterSubs(ctx, decl, mode, cur))) {
            if (addExternalRefIssue(state, file, node, item, mode, onlyGeneric))
                return;
            if (mode === 'neutral')
                continue;
            const key = item.local
                ? `${name}:${mode}:${subKey(item.subs)}`
                : targetKey(item, mode, subKey(item.subs));
            if (!seenAdd(seen, key))
                continue;
            walkDecl(state, item.ctx, item.node, mode, seen, item.subs, onlyGeneric);
            return;
        }
        visitTypeArgs(node, (item) => walkType(state, file, item, mode, seen, subs, onlyGeneric));
        return;
    }
    if (walkTypeParts(node, mode, (item, next) => walkType(state, file, item, next, seen, subs, onlyGeneric), (item, next) => walkMember(state, file, item, next, seen, subs, onlyGeneric), (item, next) => walkCallable(state, file, item, next, seen, subs, onlyGeneric))) {
        return;
    }
};
const walkMember = (state, file, node, mode, seen, subs, onlyGeneric = false) => {
    visitMemberParts(node, mode, 'callable', (item, next) => walkType(state, file, item, next, seen, subs, onlyGeneric), (item, next) => walkCallable(state, file, item, next, seen, subs, onlyGeneric), (item) => walkParamTypes(state, file, item, seen, subs, onlyGeneric));
};
const walkClassMember = (state, file, node, _mode, seen, subs, onlyGeneric = false) => {
    if (!node)
        return;
    if (classStorageMember(node)) {
        walkType(state, file, node.type, 'field', seen, subs, onlyGeneric);
        return;
    }
};
const walkDecl = (state, file, node, mode, seen, subs, onlyGeneric = false) => {
    if (!node)
        return;
    if (isCanonicalHelperDecl(file, node))
        return;
    visitDeclParts(node, (item) => walkType(state, file, item, mode, seen, subs, onlyGeneric), (item) => walkMember(state, file, item, mode, seen, subs, onlyGeneric), (item) => walkClassMember(state, file, item, mode, seen, subs, onlyGeneric));
};
const scanTypeParams = (state, file, node) => {
    for (const param of typeParams(node)) {
        const constraint = resolveByteType(state, file, param.constraint);
        const def = resolveByteType(state, file, param.default);
        if (!constraint || !def || constraint.typed !== def.typed)
            continue;
        addIssue(state, file, param.default || param, defaultMsg(def.typed, def.role, nodeName(file, param.name)), 'bytes-default');
    }
};
const KIND = {};
const KIND_NAMES = `
  ArrayType ArrowFunction CallSignature ClassDeclaration ConditionalType
  Constructor ConstructorType ConstructSignature ExportDeclaration ExportKeyword
  FunctionDeclaration FunctionExpression FunctionType GetAccessor ImportDeclaration ImportType
  IndexedAccessType IndexSignature InterfaceDeclaration IntersectionType MappedType
  MethodDeclaration MethodSignature ParenthesizedType PropertyDeclaration PropertySignature
  SetAccessor TupleType TypeAliasDeclaration TypeLiteral TypeOperator TypeParameter
  TypeQuery TypeReference UnionType VariableDeclaration
`
    .trim()
    .split(/\s+/);
const exported = (node) => !!node?.modifiers?.some((item) => item.kind === KIND.ExportKeyword);
const varMode = (node) => (exported(node.parent?.parent) ? 'output' : 'neutral');
const helperDecl = (file, name) => {
    const node = file.decls.get(name);
    return typeAlias(node);
};
const HELPER_NAMES = ['TypedArg', 'TypedRet', 'TArg', 'TRet'];
const WRAP_HELPERS = ['TArg', 'TRet'];
const HELPER_FILES = new Set(['utils.ts', 'index.ts']);
const DEFAULT_HELPER_FILE = 'utils.ts';
const HELPER_FILE_LABEL = 'utils.ts or index.ts';
// Helper probes can start from arbitrary imported names before canonical-name filtering.
const CANON_HELPERS = new Map([
    ['TypedArg', CANON_TYPED_ARG],
    ['TypedRet', CANON_TYPED_RET],
    ['TArg', CANON_TARG],
    ['TRet', CANON_TRET],
]);
const isCanonicalHelperDecl = (file, node) => {
    if (!typeAlias(node))
        return false;
    // Canonical helpers intentionally contain ReturnType<TypedArray.of>.
    // Expanding them reports the helper as its own input misuse.
    const body = CANON_HELPERS.get(nodeName(file, node.name));
    return !!body && exported(node) && normText(file, node.type) === normType(body);
};
const goodLocalHelper = (file, name) => {
    const doc = CANON_DOC.get(name);
    const body = CANON_HELPERS.get(name);
    const node = helperDecl(file, name);
    if (!node || !exported(node) || !doc || !body)
        return false;
    const raw = normText(file, node.type).replace(/^\|/, '');
    const start = nodePos(file, node);
    return raw === normType(body) && normType(file.text.slice(node.pos, start)) === normType(doc);
};
const namedRefs = (file, stmt, name) => namedElements(stmt)
    .filter((item) => nodeName(file, item.name) === name)
    .map((item) => item.name);
const helperRows = (file, name) => {
    const out = [];
    for (const stmt of stmts(file.source)) {
        const refs = namedRefs(file, stmt, name);
        if (refs.length)
            out.push({ refs, spec: modSpec(stmt) });
    }
    return out;
};
const helperRefs = (file, name) => helperRows(file, name).flatMap((row) => row.refs);
const helperNode = (file, name) => helperDecl(file, name) || helperRefs(file, name)[0];
const resolveHelperImport = (from, spec) => {
    if (spec.startsWith('.'))
        return;
    try {
        const req = createRequire(from);
        const raw = req.resolve(spec);
        // file: dependencies can carry canonical helper source different from declarations.
        const tries = [
            raw,
            raw.replace(/\.js$/, '.ts'),
            raw.replace(/\.mjs$/, '.mts'),
            raw.replace(/\.cjs$/, '.cts'),
            raw.replace(/\.js$/, '.d.ts'),
            raw.replace(/\.mjs$/, '.d.mts'),
            raw.replace(/\.cjs$/, '.d.cts'),
        ];
        for (const file of tries) {
            if (file !== raw || existsSync(file))
                if (existsSync(file) && HELPER_FILE.test(file))
                    return realpathSync(file);
        }
    }
    catch { }
    return;
};
const helperTargets = (state, file, name) => {
    const out = [];
    const fileSet = new Set(state.files.keys());
    for (const row of helperRows(file, name)) {
        if (!row.spec)
            continue;
        const target = resolveImportFile(file.file, row.spec, fileSet) || resolveHelperImport(file.file, row.spec);
        if (target)
            out.push(getFileCtx(state, target));
    }
    return out;
};
const hasAnyHelper = (file) => TYPED.some((typed) => !!helperDecl(file, SHORT[typed])) ||
    WRAP_HELPERS.some((name) => !!helperNode(file, name));
const goodHelperRef = (state, file, name, seen = new Set()) => {
    const key = `${file.file}:${name}`;
    if (!seenAdd(seen, key))
        return false;
    for (const target of helperTargets(state, file, name)) {
        if (goodLocalHelper(target, name) && goodLocalHelpers(target))
            return true;
        if (goodHelperRef(state, target, name, seen))
            return true;
    }
    return false;
};
const goodLocalHelpers = (file) => {
    return HELPER_NAMES.every((name) => goodLocalHelper(file, name));
};
const goodHelpers = (state, file) => goodLocalHelpers(file) || WRAP_HELPERS.every((name) => goodHelperRef(state, file, name));
const helperFileName = (file) => basename(file.file);
const helperFile = (file) => HELPER_FILES.has(helperFileName(file));
const helperCandidates = (files) => files.filter(helperFile);
const preferredHelperFile = (files) => files.find((file) => helperFileName(file) === DEFAULT_HELPER_FILE) || files.find(helperFile);
const helperTarget = (state, files) => {
    const candidates = helperCandidates(files);
    const withHelpers = candidates.find(hasAnyHelper);
    if (withHelpers) {
        if (goodHelpers(state, withHelpers))
            return;
        const decl = WRAP_HELPERS.map((name) => helperNode(withHelpers, name)).find(Boolean);
        return {
            action: 'update',
            line: decl ? nodeLineNo(withHelpers, decl) : 1,
            rel: withHelpers.rel,
        };
    }
    const target = preferredHelperFile(candidates);
    if (target)
        return { action: 'add', line: 1, rel: target.rel };
    return { action: 'add', line: 1, rel: DEFAULT_HELPER_FILE };
};
const needsHelpers = (state) => state.issues.some((item) => (item.kind === 'bytes-input' || item.kind === 'bytes-return') &&
    item.issue.startsWith('wrap '));
const addHelperIssue = (state, target) => {
    const name = target.action === 'add' ? HELPER_FILE_LABEL : target.rel;
    pushIssue(state, target.rel, target.line, 'helper', helperMsg(target.action, name), 'bytes-helper', true);
};
const checkHelpers = (state, files) => {
    if (!needsHelpers(state))
        return;
    const target = helperTarget(state, files);
    if (!target)
        return;
    addHelperIssue(state, target);
};
const checkParamWraps = (state, file, node) => {
    visitParamTypes(node, (type) => checkWrap(state, file, type, 'input'));
};
const checkCallableWraps = (state, file, node) => {
    visitCallableParts(node, 'output', (item) => checkParamWraps(state, file, item), (item) => checkWrap(state, file, item, 'output'));
};
const aliasMaps = (files) => {
    const aliasByName = new Map();
    const exportedByFile = new Map();
    for (const file of files) {
        const exps = new Map();
        for (const stmt of stmts(file.source)) {
            const alias = typeAlias(stmt);
            if (!alias)
                continue;
            const name = nodeName(file, alias.name);
            const typed = canonicalKind(file, alias.type);
            if (!name || !typed)
                continue;
            if (exported(stmt))
                exps.set(name, typed);
            aliasByName.set(name, typed);
        }
        exportedByFile.set(file.file, exps);
    }
    return { aliasByName, exportedByFile };
};
const applyImportedAliases = (files, fileSet, exportedByFile) => {
    for (const file of files) {
        for (const stmt of stmts(file.source)) {
            if (!importDecl(stmt))
                continue;
            const spec = modSpec(stmt);
            if (!spec)
                continue;
            const target = resolveImportFile(file.file, spec, fileSet);
            if (!target)
                continue;
            const exps = exportedByFile.get(target);
            if (!exps?.size)
                continue;
            const named = importElements(stmt);
            if (!named.length)
                continue;
            for (const item of named) {
                const imported = nodeName(file, item.propertyName || item.name);
                const local = nodeName(file, item.name);
                const typed = exps.get(imported);
                if (!local || !typed)
                    continue;
                file.imports.set(local, typed);
            }
        }
    }
};
const scanFile = (state, file, ts) => {
    const walkNeutralType = (node) => walkType(state, file, node, 'neutral', new Set(), undefined, true);
    const walkNode = (node) => {
        if (!node)
            return false;
        scanTypeParams(state, file, node);
        if (classRuntimeMember(node))
            return false;
        if (runtimeCallable(node)) {
            checkCallableWraps(state, file, node);
            if (node.body)
                walkAst(ts, node.body, walkNode);
            return false;
        }
        const alias = typeAlias(node);
        if (alias) {
            if (isCanonicalHelperDecl(file, node))
                return false;
            const name = nodeName(file, alias.name);
            const generic = typedKind(file, alias.type);
            if (generic && name && typeArgs(alias.type).length) {
                addGenericIssue(state, file, alias.type, generic, nodeText(file, alias.type), 'neutral', name);
                return false;
            }
            walkNeutralType(alias.type);
            return false;
        }
        if (interfaceDecl(node) || classDecl(node)) {
            walkDecl(state, file, node, 'neutral', new Set(), undefined, !classDecl(node));
            return false;
        }
        const variable = variableDecl(node);
        if (variable) {
            if (typeCallable(variable.type))
                checkCallableWraps(state, file, variable.type);
            else if (varMode(variable) === 'output')
                checkWrap(state, file, variable.type, 'output');
            else
                walkNeutralType(variable.type);
            if (variable.initializer)
                walkAst(ts, variable.initializer, walkNode);
            return false;
        }
        return true;
    };
    walkAst(ts, file.source, walkNode);
};
export const runCli = async (argv, opts = {}) => {
    const cli = cliArgs(argv, usage, opts.color);
    if (!cli)
        return;
    const { args, colorOn } = cli;
    const { cwd: base, pkgFile } = pkgTarget(args.pkgArg, opts.cwd);
    const ts = (opts.loadTS || loadTS)(pkgFile);
    for (const name of KIND_NAMES)
        KIND[name] = ts.SyntaxKind[name];
    const names = pickTSFiles(base);
    const prog = ts.createProgram(names, tsOpts(ts, base));
    const files = names.map((file) => makeFileCtx(ts, prog, base, file));
    const fileSet = new Set(files.map((file) => file.file));
    const checker = prog.getTypeChecker();
    const { aliasByName, exportedByFile } = aliasMaps(files);
    applyImportedAliases(files, fileSet, exportedByFile);
    const state = {
        aliasByName,
        checker,
        cwd: base,
        files: new Map(files.map((file) => [file.file, file])),
        issues: [],
        prog,
        seen: new Set(),
        ts,
    };
    for (const file of files)
        scanFile(state, file, ts);
    checkHelpers(state, files);
    const byFile = new Map();
    for (const item of state.issues)
        byFile.set(item.file, (byFile.get(item.file) || 0) + 1);
    const out = emptyResult();
    out.failures = state.issues.length;
    out.passed = files.filter((file) => !byFile.has(file.rel)).length;
    const logs = state.issues.map((item) => makeIssue('error', item.file, `${item.line}/${item.sym}`, item.issue, item.kind));
    reportIssues('bytes', logs, out, colorOn, 'Bytes check found issues');
};
runSelf(import.meta.url, runCli);
