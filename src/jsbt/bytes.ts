#!/usr/bin/env -S node --experimental-strip-types
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
import {
  cliArgs,
  emptyResult,
  ident,
  loadTypeScriptApi,
  makeIssue,
  nodeLine,
  nodeStart,
  pickTSFiles,
  pkgTarget,
  readText,
  relName,
  reportIssues,
  resolveLocalImport,
  runSelf,
  type Issue as LogIssue,
  usageText,
  wantTSFile,
  walkAst,
} from './utils.ts';

type FileCtx = {
  decls: Map<string, unknown>;
  file: string;
  imports: Map<string, Typed>;
  rel: string;
  source: SourceLike;
  text: string;
};
type Issue = {
  file: string;
  issue: string;
  kind:
    | 'bytes-default'
    | 'bytes-field'
    | 'bytes-generic'
    | 'bytes-helper'
    | 'bytes-input'
    | 'bytes-return';
  line: number;
  sym: 'field' | 'generic' | 'helper' | 'input' | 'return';
};
type Flow = 'input' | 'output';
type Mode = 'field' | 'input' | 'neutral' | 'output';
type Subs = Map<string, any>;
type SourceLike = {
  statements?: unknown[];
  getLineAndCharacterOfPosition: (pos: number) => { line: number };
};
type TsLike = {
  ModuleKind: { ESNext?: unknown; NodeNext?: unknown };
  ModuleResolutionKind?: { Bundler?: unknown; NodeNext?: unknown };
  ScriptTarget: { ESNext: unknown };
  SymbolFlags?: { Alias?: number };
  SyntaxKind: Record<string, number>;
  createProgram: (files: string[], opts: Record<string, unknown>) => ProgLike;
  createSourceFile: (
    file: string,
    text: string,
    target: unknown,
    setParents?: boolean
  ) => SourceLike;
  findConfigFile?: (
    dir: string,
    exists: (file: string) => boolean,
    name?: string
  ) => string | undefined;
  forEachChild: (node: unknown, cb: (child: unknown) => void) => void;
  parseJsonConfigFileContent?: (
    config: unknown,
    host: unknown,
    base: string
  ) => { options: Record<string, unknown> };
  readConfigFile?: (
    file: string,
    read: (file: string) => string | undefined
  ) => { config?: unknown; error?: unknown };
  sys: {
    fileExists: (file: string) => boolean;
    readFile: (file: string) => string | undefined;
  };
};
type ProgLike = {
  getSourceFile: (file: string) => SourceLike | undefined;
  getTypeChecker: () => CheckerLike;
};
type CheckerLike = {
  getAliasedSymbol?: (sym: SymLike) => SymLike;
  getSymbolAtLocation: (node: unknown) => SymLike | undefined;
};
type SymLike = { declarations?: any[]; flags?: number };
type CtxDecl = { ctx: FileCtx; node: any };
type RefTarget = { ctx: FileCtx; local: boolean; node: any; subs?: Subs };
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
] as const;
type Typed = (typeof TYPED)[number];

const SHORT: Record<Typed, string> = {
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
const TYPED_SET = new Set<string>(TYPED);
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
] as const satisfies readonly Typed[];
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
] as const;
const TARG_DOC = [
  'Recursively adapts byte-carrying API input types. See {@link TypedArg}.',
] as const;
const TRET_DOC = [
  'Recursively adapts byte-carrying API output types. See {@link TypedArg}.',
] as const;
const jsdoc = (lines: string[]): string =>
  lines.length === 1
    ? `/** ${lines[0]} */`
    : ['/**', ...lines.map((line) => ` * ${line}`), ' */'].join('\n');
const CANON_DOC = new Map<string, string>([
  ['TypedArg', jsdoc([...HELPER_DOC])],
  ['TypedRet', jsdoc(['Maps typed-array output leaves to narrow TS-compatible forms.'])],
  ['TArg', jsdoc([...TARG_DOC])],
  ['TRet', jsdoc([...TRET_DOC])],
]);
const canonTyped = (leaf: (typed: Typed) => string): string =>
  [
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
const helperBlock = (): string =>
  [
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

const tsOpts = (ts: TsLike, cwd: string) => {
  const file = ts.findConfigFile?.(cwd, ts.sys.fileExists, 'tsconfig.json');
  const base = (() => {
    if (!file || !ts.readConfigFile || !ts.parseJsonConfigFileContent) return {};
    const res = ts.readConfigFile(file, ts.sys.readFile);
    return res.error
      ? {}
      : ts.parseJsonConfigFileContent(res.config || {}, ts.sys, dirname(file)).options || {};
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
const resolveImportFile = (from: string, spec: string, files: Set<string>): string | undefined =>
  resolveLocalImport(from, spec, {
    accept: (file) => files.has(file) || (existsSync(file) && wantTSFile(file)),
  });
const loadTS = (pkgFile: string): TsLike => {
  return loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript parser API', [
    'createProgram',
    'createSourceFile',
    'forEachChild',
  ]);
};
const nodeText = (file: FileCtx, node: any): string => file.text.slice(node.pos, node.end).trim();
const normType = (text: string): string => text.replace(/\s+/g, '');
const normText = (file: FileCtx, node: any): string => normType(nodeText(file, node));
const flatText = (file: FileCtx, node: any): string => nodeText(file, node).replace(/\s+/g, ' ');
const nodePos = (file: FileCtx, node: any): number => nodeStart(file.source as any, node);
const nodeLineNo = (file: FileCtx, node: any): number => nodeLine(file.source, node);
const nodeName = (file: FileCtx, node: any): string => {
  if (!node) return '';
  if (typeof node.escapedText === 'string') return node.escapedText;
  return nodeText(file, node);
};
const refLike = (node: any): boolean =>
  node?.kind === KIND.TypeReference || node?.kind === KIND.ImportType;
const typeRefName = (file: FileCtx, node: any): string =>
  node?.kind === KIND.TypeReference ? nodeName(file, node.typeName) : '';
const refName = (file: FileCtx, node: any): string =>
  node?.kind === KIND.ImportType ? nodeName(file, node.qualifier) : nodeName(file, node?.typeName);
const typedAlias = (state: State, file: FileCtx, name: string): Typed | undefined =>
  file.imports.get(name) || state.aliasByName.get(name);
const typedKind = (file: FileCtx, node: any): Typed | undefined => {
  const name = typeRefName(file, node);
  if (!TYPED_SET.has(name)) return;
  return name as Typed;
};
const canonicalKind = (file: FileCtx, node: any): Typed | undefined => {
  if (typeRefName(file, node) !== 'ReturnType' || typeArgs(node).length !== 1) return;
  const raw = normText(file, node);
  const hit = raw.match(/^ReturnType<typeof([A-Za-z0-9_]+)\.of>$/);
  if (!hit || !TYPED_SET.has(hit[1])) return;
  return hit[1] as Typed;
};
const byteLeaf = (file: FileCtx, node: any): boolean =>
  !!(typedKind(file, node) || canonicalKind(file, node));
const aliasDef = (name: Typed, alias: string = SHORT[name]): string =>
  `type ${alias} = ReturnType<typeof ${name}.of>`;
const canonDef = (name: Typed): string => `ReturnType<typeof ${name}.of>`;
const rawDef = (name: Typed, alias: string): string => `type ${alias} = ${name}`;
const genericDef = (alias: string, raw: string): string => `type ${alias} = ${raw}`;
const labelIn = (name: Typed, alias: string): string =>
  alias.startsWith('ReturnType<')
    ? `${alias} (return-only type)`
    : `${alias} (${aliasDef(name, alias)}; return-only type)`;
const outMsg = (raw: string): string => `wrap output type with TRet<${raw}>`;
const modeUse = (name: string, mode: Mode): string => {
  if (mode === 'input') return `use TArg<${name}> in input types`;
  if (mode === 'field') return `use ${name} in field types`;
  if (mode === 'output') return `use TRet<${name}> in output types`;
  return `use TArg<${name}> in input types or TRet<${name}> in output types`;
};
const genMsg = (name: Typed, raw: string, mode: Mode): string =>
  `avoid generic ${raw}; ${modeUse(name, mode)}`;
const genAliasMsg = (name: Typed, alias: string, raw: string, mode: Mode): string => {
  const base = [
    `avoid generic typed-array alias ${alias} (${genericDef(alias, raw)});`,
    `define ${rawDef(name, alias)}, then`,
  ].join(' ');
  return `${base} ${modeUse(alias, mode)}`;
};
const inMsg = (name: Typed, alias: string): string =>
  `use ${name} in input types instead of ${labelIn(name, alias)}`;
const fieldMsg = (name: Typed, alias: string): string =>
  `use ${name} in field types instead of ${labelIn(name, alias)}`;
const defaultMsg = (typed: Typed, role: 'raw' | 'ret', name: string): string => {
  const chosen = role === 'raw' ? typed : canonDef(typed);
  return [
    `avoid default byte generic parameter ${chosen} on ${name};`,
    `spell ${typed} or ${canonDef(typed)} explicitly at use sites`,
  ].join(' ');
};
const helperMsg = (action: 'add' | 'update', target: string): string =>
  [
    `${action} canonical bytes helper types ${action === 'add' ? 'to' : 'in'} ${target};`,
    `use this block:\n${helperBlock()}`,
  ].join(' ');
const wrapName = (mode: Mode): 'TArg' | 'TRet' | undefined => {
  if (mode === 'input') return 'TArg';
  if (mode === 'output') return 'TRet';
  return;
};
const isWrapped = (file: FileCtx, node: any, wrap: 'TArg' | 'TRet'): boolean =>
  typeRefName(file, node) === wrap;
const typeArgs = (node: any): any[] => node?.typeArguments || [];
type NodeVisit = (node: any) => boolean | void;
type PartVisit<T> = (part: T) => boolean | void;
const visitNodes = (nodes: any[], visit: NodeVisit): boolean => {
  for (const node of nodes) if (visit(node) === true) return true;
  return false;
};
const visitParts = <T>(parts: T[] | undefined, visit: PartVisit<T>): boolean | undefined => {
  if (!parts) return;
  for (const part of parts) if (visit(part) === true) return true;
  return false;
};
const visitTypeArgs = (node: any, visit: NodeVisit): boolean => visitNodes(typeArgs(node), visit);
const typeArg = (file: FileCtx, node: any, name: string): any | undefined =>
  typeRefName(file, node) === name ? typeArgs(node)[0] : undefined;
const promiseArg = (file: FileCtx, node: any): any | undefined => typeArg(file, node, 'Promise');
const badPromiseRet = (file: FileCtx, node: any): any | undefined => {
  const arg = typeArg(file, node, 'TRet');
  return promiseArg(file, arg);
};
// Explicit async return annotations must stay Promise<...>, not TRet<Promise<...>>.
const wrapMsg = (file: FileCtx, node: any, mode: 'input' | 'output'): string => {
  const promise = mode === 'output' ? promiseArg(file, node) : undefined;
  if (promise) return `wrap output type with Promise<TRet<${flatText(file, promise)}>>`;
  const wrap = mode === 'input' ? 'TArg' : 'TRet';
  return `wrap ${mode} type with ${wrap}<${flatText(file, node)}>`;
};
const badPromiseRetMsg = (file: FileCtx, node: any): string => {
  const raw = flatText(file, node);
  return `use Promise<TRet<${raw}>> instead of TRet<Promise<${raw}>>`;
};
const bindSubs = (file: FileCtx, decl: any, args?: any[]): Subs | undefined => {
  const params = typeParams(decl);
  if (!params.length) return;
  const subs: Subs = new Map();
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const name = nodeName(file, param.name);
    const arg = args?.[i] || param.default;
    if (name && arg) subs.set(name, arg);
  }
  return subs.size ? subs : undefined;
};
const subKey = (subs?: Subs): string =>
  !subs || !subs.size
    ? ''
    : [...subs].map(([name, node]) => `${name}:${node?.pos || 0}:${node?.end || 0}`).join(',');
const spanKey = (file: FileCtx, node: any, ...parts: string[]): string =>
  [file.file, node?.pos || 0, node?.end || 0, ...parts].join(':');
const seenAdd = (seen: Set<string>, key: string): boolean => {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
};
const subNode = (file: FileCtx, node: any, subs?: Subs): any => {
  if (!subs || !node || node.kind !== KIND.TypeReference || typeArgs(node).length) return node;
  const name = typeRefName(file, node);
  return subs.get(name) || node;
};
const enterType = (
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs,
  ...parts: string[]
): any => {
  node = subNode(file, node, subs);
  if (!node) return;
  // Recursive mapped generics can re-enter the same type-argument node before a decl guard runs.
  if (!seenAdd(seen, spanKey(file, node, ...parts, subKey(subs)))) return;
  return node;
};
const refBody = (item: RefTarget): any => subNode(item.ctx, item.node?.type, item.subs);
const refArgs = (file: FileCtx, node: any, subs?: Subs): any[] | undefined =>
  typeArgs(node).map((arg: any) => subNode(file, arg, subs));
const typeCallable = (node: any): boolean =>
  node?.kind === KIND.FunctionType || node?.kind === KIND.ConstructorType;
const constructLike = (node: any): boolean =>
  node?.kind === KIND.ConstructorType || node?.kind === KIND.ConstructSignature;
const functionLike = (node: any): boolean =>
  node?.kind === KIND.FunctionDeclaration ||
  node?.kind === KIND.MethodDeclaration ||
  node?.kind === KIND.FunctionExpression ||
  node?.kind === KIND.ArrowFunction;
const accessor = (node: any): boolean =>
  node?.kind === KIND.GetAccessor || node?.kind === KIND.SetAccessor;
const memberCallable = (node: any): boolean =>
  node?.kind === KIND.MethodDeclaration ||
  node?.kind === KIND.MethodSignature ||
  node?.kind === KIND.CallSignature ||
  node?.kind === KIND.ConstructSignature ||
  typeCallable(node);
const runtimeCallable = (node: any): boolean =>
  functionLike(node) || node?.kind === KIND.Constructor || accessor(node);
const classRuntimeMember = (node: any): boolean =>
  !!classDecl(node?.parent) &&
  (node.kind === KIND.MethodDeclaration || node.kind === KIND.Constructor || accessor(node));
const classStorageMember = (node: any): boolean =>
  node?.kind === KIND.PropertyDeclaration || node?.kind === KIND.IndexSignature;
const members = (node: any): any[] => node?.members || [];
const paramTypes = (node: any): any[] => (node?.parameters || []).map((item: any) => item.type);
const visitParamTypes = (node: any, visit: NodeVisit): boolean =>
  visitNodes(paramTypes(node), visit);
const typeParams = (node: any): any[] => node?.typeParameters || [];
const stmts = (source: SourceLike): any[] => (source.statements || []) as any[];
const typeAlias = (node: any): any => (node?.kind === KIND.TypeAliasDeclaration ? node : undefined);
const interfaceDecl = (node: any): any =>
  node?.kind === KIND.InterfaceDeclaration ? node : undefined;
const classDecl = (node: any): any => (node?.kind === KIND.ClassDeclaration ? node : undefined);
const variableDecl = (node: any): any =>
  node?.kind === KIND.VariableDeclaration ? node : undefined;
const typeQuery = (node: any): any => (node?.kind === KIND.TypeQuery ? node : undefined);
const declLike = (node: any): boolean =>
  !!(typeAlias(node) || interfaceDecl(node) || classDecl(node));
const importDecl = (node: any): any => (node?.kind === KIND.ImportDeclaration ? node : undefined);
const modSpec = (node: any): string | undefined => {
  const spec = node?.moduleSpecifier?.text;
  return typeof spec === 'string' ? spec : undefined;
};
const importElements = (node: any): any[] =>
  importDecl(node)?.importClause?.namedBindings?.elements || [];
const namedElements = (node: any): any[] => {
  if (node?.kind === KIND.ExportDeclaration) return node.exportClause?.elements || [];
  return importElements(node);
};
const heritageTypes = (node: any): any[] => {
  const out: any[] = [];
  for (const item of node?.heritageClauses || [])
    for (const part of item.types || []) out.push(part);
  return out;
};
const flowFor = (mode: Mode): Flow | undefined => {
  if (mode === 'output') return 'output';
  if (mode === 'input' || mode === 'field') return 'input';
  return;
};
const markFlow = (uses: Map<string, Set<Flow>>, name: string, mode: Mode) => {
  const flow = flowFor(mode);
  if (!flow) return;
  let set = uses.get(name);
  if (!set) {
    set = new Set();
    uses.set(name, set);
  }
  set.add(flow);
};
type TypePart = { kind: 'callable' | 'member' | 'type'; mode: Mode; node: any };
type TypeVisit = (node: any, mode: Mode) => boolean | void;
type CallablePart = { kind: 'params' | 'type'; mode: Mode; node: any };
type CallableVisit = (node: any, mode: Mode) => boolean | void;
type MemberPart = { kind: 'callable' | 'opaque' | 'params' | 'type'; mode: Mode; node: any };
type MemberVisit = (node: any, mode: Mode) => boolean | void;
type DeclPart = { kind: 'member' | 'type'; node: any; owner?: 'class' | 'interface' };
type DeclVisit = (node: any) => boolean | void;
const declType = (node: any): DeclPart => ({ kind: 'type', node });
const declMember = (node: any, owner: DeclPart['owner']): DeclPart => ({
  kind: 'member',
  node,
  owner,
});
const callableParts = (node: any, mode: Mode): CallablePart[] => {
  const out: CallablePart[] = [{ kind: 'params', mode: 'input', node }];
  if (node?.kind !== KIND.SetAccessor && node?.type)
    out.push({ kind: 'type', mode: fnOutMode(mode), node: node.type });
  return out;
};
const visitCallableParts = (
  node: any,
  mode: Mode,
  params: CallableVisit,
  type: CallableVisit
): boolean => {
  return (
    visitParts(callableParts(node, mode), (part) =>
      part.kind === 'params' ? params(part.node, part.mode) : type(part.node, part.mode)
    ) === true
  );
};
const memberParts = (
  node: any,
  mode: Mode,
  construct: 'callable' | 'opaque' = 'callable'
): MemberPart[] | undefined => {
  const type = (part: any, next = mode): MemberPart => ({ kind: 'type', mode: next, node: part });
  if (!node) return;
  if (construct === 'opaque' && constructLike(node)) return [{ kind: 'opaque', mode, node }];
  if (node.kind === KIND.PropertySignature || node.kind === KIND.IndexSignature) {
    // Returned object/interface members are part of the API surface, unlike class storage fields.
    return [type(node.type)];
  }
  if (node.kind === KIND.PropertyDeclaration) return [type(node.type, 'field')];
  if (memberCallable(node)) return [{ kind: 'callable', mode, node }];
  if (node.kind === KIND.GetAccessor) return [type(node.type, fnOutMode(mode))];
  if (node.kind === KIND.SetAccessor) return [{ kind: 'params', mode: 'input', node }];
  return;
};
const visitMemberParts = (
  node: any,
  mode: Mode,
  construct: 'callable' | 'opaque',
  type: MemberVisit,
  callable: MemberVisit,
  params: MemberVisit,
  opaque: MemberVisit = () => undefined
): boolean => {
  return (
    visitParts(memberParts(node, mode, construct), (part) =>
      part.kind === 'type'
        ? type(part.node, part.mode)
        : part.kind === 'callable'
          ? callable(part.node, part.mode)
          : part.kind === 'params'
            ? params(part.node, part.mode)
            : opaque(part.node, part.mode)
    ) === true
  );
};
const typeParts = (node: any, mode: Mode): TypePart[] | undefined => {
  const type = (part: any, next = mode): TypePart => ({ kind: 'type', mode: next, node: part });
  if (node.kind === KIND.ArrayType) return [type(node.elementType)];
  if (node.kind === KIND.ParenthesizedType || node.kind === KIND.TypeOperator)
    return [type(node.type)];
  if (node.kind === KIND.IndexedAccessType)
    return [type(node.objectType), type(node.indexType, 'neutral')];
  if (node.kind === KIND.UnionType || node.kind === KIND.IntersectionType)
    return (node.types || []).map((item: any) => type(item));
  if (node.kind === KIND.TupleType) return (node.elements || []).map((item: any) => type(item));
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
  if (typeCallable(node)) return [{ kind: 'callable', mode, node }];
  return;
};
const visitTypeParts = (
  node: any,
  mode: Mode,
  visit: TypeVisit,
  member: TypeVisit,
  callable: TypeVisit
): boolean | undefined => {
  return visitParts(typeParts(node, mode), (part) =>
    part.kind === 'member'
      ? member(part.node, part.mode)
      : part.kind === 'callable'
        ? callable(part.node, part.mode)
        : visit(part.node, part.mode)
  );
};
const walkTypeParts = (
  node: any,
  mode: Mode,
  visit: TypeVisit,
  member: TypeVisit,
  callable: TypeVisit
): boolean => visitTypeParts(node, mode, visit, member, callable) !== undefined;
const declParts = (node: any): DeclPart[] | undefined => {
  if (!node) return;
  if (typeAlias(node)) return [declType(node.type)];
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
const visitDeclParts = (
  node: any,
  type: DeclVisit,
  member: DeclVisit,
  classMember: DeclVisit = member
): boolean => {
  return (
    visitParts(declParts(node), (part) =>
      part.kind === 'type'
        ? type(part.node)
        : part.owner === 'class'
          ? classMember(part.node)
          : member(part.node)
    ) === true
  );
};
const collectParamUse = (
  file: FileCtx,
  node: any,
  mode: Mode,
  names: Set<string>,
  uses: Map<string, Set<Flow>>
) => {
  if (!node) return;
  const name = typeRefName(file, node);
  if (name) {
    if (names.has(name) && !typeArgs(node).length) {
      markFlow(uses, name, mode);
      return;
    }
    visitTypeArgs(node, (item) => collectParamUse(file, item, mode, names, uses));
    return;
  }
  walkTypeParts(
    node,
    mode,
    (item, next) => collectParamUse(file, item, next, names, uses),
    (item, next) => collectMemberParamUse(file, item, next, names, uses),
    (item, next) => collectCallableParamUse(file, item, next, names, uses)
  );
};
const collectParamTypes = (
  file: FileCtx,
  node: any,
  names: Set<string>,
  uses: Map<string, Set<Flow>>
) => {
  visitParamTypes(node, (type) => collectParamUse(file, type, 'input', names, uses));
};
const collectCallableParamUse = (
  file: FileCtx,
  node: any,
  mode: Mode,
  names: Set<string>,
  uses: Map<string, Set<Flow>>
) => {
  visitCallableParts(
    node,
    mode,
    (item) => collectParamTypes(file, item, names, uses),
    (item, next) => collectParamUse(file, item, next, names, uses)
  );
};
const collectMemberParamUse = (
  file: FileCtx,
  node: any,
  mode: Mode,
  names: Set<string>,
  uses: Map<string, Set<Flow>>
) => {
  visitMemberParts(
    node,
    mode,
    'callable',
    (item, next) => collectParamUse(file, item, next, names, uses),
    (item, next) => collectCallableParamUse(file, item, next, names, uses),
    (item) => collectParamTypes(file, item, names, uses)
  );
};
const collectDeclParamUse = (file: FileCtx, node: any, mode: Mode, names: Set<string>) => {
  const uses = new Map<string, Set<Flow>>();
  visitDeclParts(
    node,
    (item) => collectParamUse(file, item, mode, names, uses),
    (item) => collectMemberParamUse(file, item, mode, names, uses),
    (item) => {
      if (classStorageMember(item)) collectParamUse(file, item.type, 'field', names, uses);
    }
  );
  return uses;
};
const filterSubs = (file: FileCtx, decl: any, mode: Mode, subs?: Subs): Subs | undefined => {
  if (!subs || !subs.size || mode === 'neutral') return subs;
  const names = new Set(subs.keys());
  const uses = collectDeclParamUse(file, decl, mode, names);
  let out: Subs | undefined;
  for (const [name, node] of subs) {
    const seen = uses.get(name);
    // Mixed generic parameters are invariant: Ret* or raw would break Coder-like APIs.
    if (seen?.has('input') && seen.has('output')) continue;
    if (!out) out = new Map();
    out.set(name, node);
  }
  return out;
};
const makeFileCtx = (ts: TsLike, prog: ProgLike, cwd: string, file: string): FileCtx => {
  const hit = prog.getSourceFile(file);
  const text = (hit as any)?.text || readText(file);
  const source = hit || ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const decls = new Map<string, unknown>();
  const ctx: FileCtx = {
    decls,
    file,
    imports: new Map(),
    rel: relName(cwd, file),
    source,
    text,
  };
  for (const stmt of stmts(source)) {
    const name = nodeName(ctx, (stmt as any).name);
    if (!name) continue;
    if (declLike(stmt)) decls.set(name, stmt);
  }
  return ctx;
};
const getFileCtx = (state: State, file: string): FileCtx => {
  const hit = state.files.get(file);
  if (hit) return hit;
  const ctx = makeFileCtx(state.ts, state.prog, state.cwd, file);
  state.files.set(file, ctx);
  return ctx;
};
const symDecls = (
  state: State,
  part: any,
  wantFile: (file: string) => boolean = wantTSFile
): CtxDecl[] => {
  let sym = state.checker.getSymbolAtLocation(part);
  const aliasFlag = state.ts.SymbolFlags?.Alias || 0;
  while (sym && aliasFlag && !!state.checker.getAliasedSymbol && (sym.flags || 0) & aliasFlag) {
    const next = state.checker.getAliasedSymbol(sym);
    if (!next || next === sym) break;
    sym = next;
  }
  return (sym?.declarations || [])
    .map((decl) => {
      const sf = decl?.getSourceFile?.();
      const fileName = sf?.fileName;
      if (!fileName || !existsSync(fileName) || !wantFile(fileName)) return;
      return { ctx: getFileCtx(state, fileName), node: decl };
    })
    .filter((item): item is CtxDecl => !!item);
};
const ctxDecls = (state: State, part: any): CtxDecl[] => (part ? symDecls(state, part) : []);
const refDecls = (state: State, node: any): CtxDecl[] =>
  ctxDecls(state, node?.typeName || node?.qualifier || node);
const targetKey = (target: RefTarget, ...parts: string[]): string =>
  [target.ctx.file, target.node?.pos || 0, ...parts].join(':');
const makeRefTarget = (
  ctx: FileCtx,
  local: boolean,
  node: any,
  args: any[] | undefined,
  mapSubs: (ctx: FileCtx, decl: any, subs?: Subs) => Subs | undefined
): RefTarget => ({
  ctx,
  local,
  node,
  subs: mapSubs(ctx, node, bindSubs(ctx, node, args)),
});
const refTargets = (
  state: State,
  file: FileCtx,
  node: any,
  subs?: Subs,
  mapSubs: (ctx: FileCtx, decl: any, subs?: Subs) => Subs | undefined = (_ctx, _decl, cur) => cur
): RefTarget[] => {
  const args = refArgs(file, node, subs);
  const out: RefTarget[] = [];
  for (const item of refDecls(state, node))
    out.push(makeRefTarget(item.ctx, false, item.node, args, mapSubs));
  const name = refName(file, node);
  const decl = file.decls.get(name);
  if (decl) out.push(makeRefTarget(file, true, decl, args, mapSubs));
  return out;
};
const resolveByteType = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string> = new Set()
): { role: 'raw' | 'ret'; typed: Typed } | undefined => {
  if (!node) return;
  const typed = typedKind(file, node);
  if (typed && !typeArgs(node).length) return { role: 'raw', typed };
  const canon = canonicalKind(file, node);
  if (canon) return { role: 'ret', typed: canon };
  if (!refLike(node)) return;
  const name = refName(file, node);
  const aliased = typedAlias(state, file, name);
  if (aliased) return { role: 'ret', typed: aliased };
  for (const item of refTargets(state, file, node)) {
    if (!seenAdd(seen, targetKey(item))) continue;
    const body = refBody(item);
    const resolved = resolveByteType(state, item.ctx, body, seen);
    if (resolved) return resolved;
  }
  return;
};
const refValueDecls = (state: State, node: any): CtxDecl[] =>
  ctxDecls(state, node?.exprName || node);
const typeQueryRefs = (state: State, node: any) =>
  typeQuery(node) ? refValueDecls(state, node) : [];
const returnTypeRefs = (state: State, file: FileCtx, node: any, subs?: Subs) => {
  if (typeRefName(file, node) !== 'ReturnType') return [];
  const arg = subNode(file, typeArgs(node)[0], subs);
  return typeQueryRefs(state, arg);
};
type TypeProbe = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
) => boolean;
const probeIn = (
  probe: TypeProbe,
  state: State,
  file: FileCtx,
  seen: Set<string>,
  subs?: Subs
): ((node: any) => boolean) => {
  return (node: any): boolean => probe(state, file, node, seen, subs);
};
const probeTarget = (
  probe: TypeProbe,
  state: State,
  seen: Set<string>
): ((target: RefTarget) => boolean) => {
  return (target: RefTarget): boolean => probe(state, target.ctx, target.node, seen, target.subs);
};
const hasParamTypes = (
  probe: TypeProbe,
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  return visitParamTypes(node, probeIn(probe, state, file, seen, subs));
};
const hasTypeArgs = (
  probe: TypeProbe,
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  return visitTypeArgs(node, probeIn(probe, state, file, seen, subs));
};
const hasRefTargetDecls = (
  probe: TypeProbe,
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  const has = probeTarget(probe, state, seen);
  for (const item of refTargets(state, file, node, subs)) if (has(item)) return true;
  return false;
};
const hasRefParts = (
  probe: TypeProbe,
  decl: TypeProbe,
  aliasMatch: boolean,
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  const name = refName(file, node);
  if (typedAlias(state, file, name)) return aliasMatch;
  if (hasTypeArgs(probe, state, file, node, seen, subs)) return true;
  if (hasRefTargetDecls(decl, state, file, node, seen, subs)) return true;
  return false;
};
const hasMemberTypes = (
  probe: TypeProbe,
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean =>
  probeIn(probe, state, file, seen, subs)(node?.type) ||
  hasParamTypes(probe, state, file, node, seen, subs);
const hasByteMember = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => hasMemberTypes(hasByteType, state, file, node, seen, subs);
const hasOpaqueParamTypes = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => hasParamTypes(hasOpaqueDomain, state, file, node, seen, subs);
const hasOpaqueCallable = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => hasMemberTypes(hasOpaqueDomain, state, file, node, seen, subs);
const hasByteDecl = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean =>
  visitDeclParts(
    node,
    (item) => hasByteType(state, file, item, seen, subs),
    (item) => hasByteMember(state, file, item, seen, subs)
  );
const hasTypeParts = (
  probe: TypeProbe,
  member: TypeProbe,
  callable: TypeProbe,
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  const typeHere = probeIn(probe, state, file, seen, subs);
  const memberHere = probeIn(member, state, file, seen, subs);
  const callableHere = probeIn(callable, state, file, seen, subs);
  return visitTypeParts(node, 'neutral', typeHere, memberHere, callableHere) === true;
};
const hasByteType = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  node = enterType(file, node, seen, subs);
  if (!node) return false;
  if (byteLeaf(file, node)) return true;
  for (const item of returnTypeRefs(state, file, node, subs))
    if (hasByteType(state, item.ctx, item.node?.type, seen, subs)) return true;
  if (refLike(node)) {
    return hasRefParts(hasByteType, hasByteDecl, true, state, file, node, seen, subs);
  }
  if (hasTypeParts(hasByteType, hasByteMember, hasByteMember, state, file, node, seen, subs))
    return true;
  return false;
};
const hasOpaqueDomainMember = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  return visitMemberParts(
    node,
    'neutral',
    'opaque',
    (item) => hasOpaqueDomain(state, file, item, seen, subs),
    (item) => hasOpaqueCallable(state, file, item, seen, subs),
    (item) => hasOpaqueParamTypes(state, file, item, seen, subs),
    () => true
  );
};
const hasSelfBound = (file: FileCtx, node: any): boolean => {
  for (const param of typeParams(node)) {
    const name = nodeName(file, param.name);
    if (
      name &&
      param.constraint &&
      new RegExp(`\\b${name}\\b`).test(nodeText(file, param.constraint))
    ) {
      return true;
    }
  }
  return false;
};
const hasOpaqueMembers = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs,
  skipStorage = false
): boolean => {
  for (const item of members(node)) {
    if (
      (!skipStorage || !classStorageMember(item)) &&
      hasOpaqueDomainMember(state, file, item, seen, subs)
    ) {
      return true;
    }
  }
  return false;
};
const hasOpaqueDomainDecl = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  if (!node) return false;
  if (node.kind === KIND.TypeParameter) {
    const constraint = subNode(file, node.constraint, subs);
    return hasOpaqueDomain(state, file, constraint, seen, subs);
  }
  if (typeAlias(node)) return hasOpaqueDomain(state, file, node.type, seen, subs);
  if (interfaceDecl(node)) {
    if (hasSelfBound(file, node)) return true;
    if (node.heritageClauses?.length) return true;
    if (hasOpaqueMembers(state, file, node, seen, subs)) return true;
  }
  if (classDecl(node)) {
    if (hasSelfBound(file, node)) return true;
    if (hasOpaqueMembers(state, file, node, seen, subs, true)) return true;
  }
  return false;
};
const hasOpaqueDomain = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  node = enterType(file, node, seen, subs, 'opaque');
  if (!node) return false;
  if (byteLeaf(file, node)) return false;
  // Whole-object wrappers are unsafe when they would recurse into domain objects such as
  // F-bounded points or point constructors; those need explicit method-level fixes instead.
  if (constructLike(node)) return true;
  if (typeQuery(node)) {
    // `typeof PointClass` is a constructor surface even though it reaches us as a type query.
    for (const item of typeQueryRefs(state, node)) {
      if (classDecl(item.node)) return true;
      if (hasOpaqueDomain(state, item.ctx, item.node?.type, seen, subs)) return true;
    }
    return false;
  }
  if (refLike(node)) {
    return hasRefParts(hasOpaqueDomain, hasOpaqueDomainDecl, false, state, file, node, seen, subs);
  }
  if (
    hasTypeParts(
      hasOpaqueDomain,
      hasOpaqueDomainMember,
      hasOpaqueCallable,
      state,
      file,
      node,
      seen,
      subs
    )
  ) {
    return true;
  }
  return false;
};
const walkReturnDecl = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
): boolean => {
  if (!node) return false;
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
const fnOutMode = (mode: Mode): Mode => (mode === 'output' ? 'output' : 'neutral');
const walkParamTypes = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
) => {
  visitParamTypes(node, (type) => walkType(state, file, type, 'input', seen, subs, onlyGeneric));
};
const walkCallable = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
) => {
  visitCallableParts(
    node,
    mode,
    (item) => walkParamTypes(state, file, item, seen, subs, onlyGeneric),
    (item, next) => walkType(state, file, item, next, seen, subs, onlyGeneric)
  );
};
const pushIssue = (
  state: State,
  file: string,
  line: number,
  sym: Issue['sym'],
  issue: Issue['issue'],
  kind: Issue['kind'],
  prepend = false
) => {
  const key = `${file}:${line}:${kind}:${issue}`;
  if (!seenAdd(state.seen, key)) return;
  const item = { file, issue, kind, line, sym };
  if (prepend) state.issues.unshift(item);
  else state.issues.push(item);
};
const issueSym = (kind: Issue['kind']): Issue['sym'] =>
  kind === 'bytes-field'
    ? 'field'
    : kind === 'bytes-generic' || kind === 'bytes-default'
      ? 'generic'
      : kind === 'bytes-helper'
        ? 'helper'
        : kind === 'bytes-input'
          ? 'input'
          : 'return';
const addIssue = (
  state: State,
  file: FileCtx,
  node: any,
  issue: Issue['issue'],
  kind: Issue['kind']
) => {
  const line = nodeLineNo(file, node);
  pushIssue(state, file.rel, line, issueSym(kind), issue, kind);
};
const addInFieldIssue = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  typed: Typed,
  label: string
): void => {
  if (mode === 'input') addIssue(state, file, node, inMsg(typed, label), 'bytes-input');
  else if (mode === 'field') addIssue(state, file, node, fieldMsg(typed, label), 'bytes-field');
};
const addGenericIssue = (
  state: State,
  file: FileCtx,
  node: any,
  typed: Typed,
  raw: string,
  mode: Mode,
  alias = raw
): void => {
  const msg = alias === raw ? genMsg(typed, raw, mode) : genAliasMsg(typed, alias, raw, mode);
  addIssue(state, file, node, msg, 'bytes-generic');
};
const addRawLeafIssue = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  onlyGeneric: boolean,
  typed: Typed,
  raw: string,
  label = raw,
  generic = false
): boolean => {
  if (generic) {
    addGenericIssue(state, file, node, typed, raw, mode, label);
    return true;
  }
  if (onlyGeneric) return true;
  if (mode === 'output') addIssue(state, file, node, outMsg(label), 'bytes-return');
  return true;
};
const addRetLeafIssue = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  onlyGeneric: boolean,
  typed: Typed,
  label: string
): boolean => {
  if (!onlyGeneric) addInFieldIssue(state, file, node, mode, typed, label);
  return true;
};
const hasBytes = (state: State, file: FileCtx, node: any): boolean =>
  hasByteType(state, file, node, new Set());
const hasOpaque = (state: State, file: FileCtx, node: any): boolean =>
  hasOpaqueDomain(state, file, node, new Set());
const addBadPromiseRetIssue = (state: State, file: FileCtx, node: any): boolean => {
  const bad = badPromiseRet(file, node);
  if (!bad || !hasBytes(state, file, bad)) return false;
  addIssue(state, file, node, badPromiseRetMsg(file, bad), 'bytes-return');
  return true;
};
const wrappedPromiseRet = (file: FileCtx, node: any): boolean => {
  const promise = promiseArg(file, node);
  return !!promise && isWrapped(file, promise, 'TRet');
};
const addPromiseRetIssue = (state: State, file: FileCtx, node: any, wrapByte = false): boolean => {
  if (addBadPromiseRetIssue(state, file, node)) return true;
  const promise = promiseArg(file, node);
  if (!promise) return false;
  if (wrappedPromiseRet(file, node)) return true;
  if (!wrapByte || !hasBytes(state, file, promise)) return false;
  addIssue(state, file, node, wrapMsg(file, node, 'output'), 'bytes-return');
  return true;
};
const checkWrap = (state: State, file: FileCtx, node: any, mode: 'input' | 'output'): void => {
  if (!node) return;
  const before = state.issues.length;
  walkType(state, file, node, mode, new Set(), undefined, true);
  if (state.issues.length !== before) return;
  const wrap = wrapName(mode);
  if (mode === 'output' && addPromiseRetIssue(state, file, node, true)) return;
  if (!wrap || isWrapped(file, node, wrap)) return;
  if (!hasBytes(state, file, node)) return;
  if (hasOpaque(state, file, node)) return;
  addIssue(
    state,
    file,
    node,
    wrapMsg(file, node, mode),
    mode === 'input' ? 'bytes-input' : 'bytes-return'
  );
};
const refAlias = (file: FileCtx, node: any, decl: any, declFile: FileCtx): string => {
  const raw = refName(file, node);
  if (ident(raw)) return raw;
  const name = nodeName(declFile, decl?.name);
  return ident(name) ? name : raw;
};
const addExternalRefIssue = (
  state: State,
  file: FileCtx,
  node: any,
  target: RefTarget,
  mode: Mode,
  onlyGeneric: boolean
): boolean => {
  if (target.local) return false;
  const body = refBody(target);
  const generic = typedKind(target.ctx, body);
  const alias = refAlias(file, node, target.node, target.ctx);
  if (generic) {
    return addRawLeafIssue(
      state,
      file,
      node,
      mode,
      onlyGeneric,
      generic,
      nodeText(target.ctx, body || target.node),
      alias,
      !!typeArgs(target.node?.type).length
    );
  }
  const canonical = canonicalKind(target.ctx, body);
  if (canonical) return addRetLeafIssue(state, file, node, mode, onlyGeneric, canonical, alias);
  return false;
};
const walkType = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
): void => {
  node = enterType(file, node, seen, subs, mode);
  if (!node) return;
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
    if (addPromiseRetIssue(state, file, node, true)) return;
  }
  for (const item of returnTypeRefs(state, file, node, subs))
    if (walkReturnDecl(state, item.ctx, item.node, mode, seen, subs, onlyGeneric)) return;
  if (refLike(node)) {
    const name = refName(file, node);
    const aliased = typedAlias(state, file, name);
    if (aliased) {
      if (onlyGeneric) return;
      addInFieldIssue(state, file, node, mode, aliased, name);
      return;
    }
    for (const item of refTargets(state, file, node, subs, (ctx, decl, cur) =>
      filterSubs(ctx, decl, mode, cur)
    )) {
      if (addExternalRefIssue(state, file, node, item, mode, onlyGeneric)) return;
      if (mode === 'neutral') continue;
      const key = item.local
        ? `${name}:${mode}:${subKey(item.subs)}`
        : targetKey(item, mode, subKey(item.subs));
      if (!seenAdd(seen, key)) continue;
      walkDecl(state, item.ctx, item.node, mode, seen, item.subs, onlyGeneric);
      return;
    }
    visitTypeArgs(node, (item) => walkType(state, file, item, mode, seen, subs, onlyGeneric));
    return;
  }
  if (
    walkTypeParts(
      node,
      mode,
      (item, next) => walkType(state, file, item, next, seen, subs, onlyGeneric),
      (item, next) => walkMember(state, file, item, next, seen, subs, onlyGeneric),
      (item, next) => walkCallable(state, file, item, next, seen, subs, onlyGeneric)
    )
  ) {
    return;
  }
};
const walkMember = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
) => {
  visitMemberParts(
    node,
    mode,
    'callable',
    (item, next) => walkType(state, file, item, next, seen, subs, onlyGeneric),
    (item, next) => walkCallable(state, file, item, next, seen, subs, onlyGeneric),
    (item) => walkParamTypes(state, file, item, seen, subs, onlyGeneric)
  );
};
const walkClassMember = (
  state: State,
  file: FileCtx,
  node: any,
  _mode: Mode,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
) => {
  if (!node) return;
  if (classStorageMember(node)) {
    walkType(state, file, node.type, 'field', seen, subs, onlyGeneric);
    return;
  }
};
const walkDecl = (
  state: State,
  file: FileCtx,
  node: any,
  mode: Mode,
  seen: Set<string>,
  subs?: Subs,
  onlyGeneric = false
) => {
  if (!node) return;
  if (isCanonicalHelperDecl(file, node)) return;
  visitDeclParts(
    node,
    (item) => walkType(state, file, item, mode, seen, subs, onlyGeneric),
    (item) => walkMember(state, file, item, mode, seen, subs, onlyGeneric),
    (item) => walkClassMember(state, file, item, mode, seen, subs, onlyGeneric)
  );
};
const scanTypeParams = (state: State, file: FileCtx, node: any) => {
  for (const param of typeParams(node)) {
    const constraint = resolveByteType(state, file, param.constraint);
    const def = resolveByteType(state, file, param.default);
    if (!constraint || !def || constraint.typed !== def.typed) continue;
    addIssue(
      state,
      file,
      param.default || param,
      defaultMsg(def.typed, def.role, nodeName(file, param.name)),
      'bytes-default'
    );
  }
};
const KIND: any = {};
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
type State = {
  aliasByName: Map<string, Typed>;
  checker: CheckerLike;
  cwd: string;
  files: Map<string, FileCtx>;
  issues: Issue[];
  prog: ProgLike;
  seen: Set<string>;
  ts: TsLike;
};
const exported = (node: any): boolean =>
  !!node?.modifiers?.some((item: any) => item.kind === KIND.ExportKeyword);
const varMode = (node: any): Mode => (exported(node.parent?.parent) ? 'output' : 'neutral');
const helperDecl = (file: FileCtx, name: string): any => {
  const node = file.decls.get(name) as any;
  return typeAlias(node);
};
const HELPER_NAMES = ['TypedArg', 'TypedRet', 'TArg', 'TRet'] as const;
const WRAP_HELPERS = ['TArg', 'TRet'] as const;
const HELPER_FILES = new Set(['utils.ts', 'index.ts']);
const DEFAULT_HELPER_FILE = 'utils.ts';
const HELPER_FILE_LABEL = 'utils.ts or index.ts';
// Helper probes can start from arbitrary imported names before canonical-name filtering.
const CANON_HELPERS = new Map<string, string>([
  ['TypedArg', CANON_TYPED_ARG],
  ['TypedRet', CANON_TYPED_RET],
  ['TArg', CANON_TARG],
  ['TRet', CANON_TRET],
]);
const isCanonicalHelperDecl = (file: FileCtx, node: any): boolean => {
  if (!typeAlias(node)) return false;
  // Canonical helpers intentionally contain ReturnType<TypedArray.of>.
  // Expanding them reports the helper as its own input misuse.
  const body = CANON_HELPERS.get(nodeName(file, node.name));
  return !!body && exported(node) && normText(file, node.type) === normType(body);
};
const goodLocalHelper = (file: FileCtx, name: string): boolean => {
  const doc = CANON_DOC.get(name);
  const body = CANON_HELPERS.get(name);
  const node = helperDecl(file, name);
  if (!node || !exported(node) || !doc || !body) return false;
  const raw = normText(file, node.type).replace(/^\|/, '');
  const start = nodePos(file, node);
  return raw === normType(body) && normType(file.text.slice(node.pos, start)) === normType(doc);
};
const namedRefs = (file: FileCtx, stmt: any, name: string): any[] =>
  namedElements(stmt)
    .filter((item: any) => nodeName(file, item.name) === name)
    .map((item: any) => item.name);
type HelperRow = { refs: any[]; spec?: string };
const helperRows = (file: FileCtx, name: string): HelperRow[] => {
  const out: HelperRow[] = [];
  for (const stmt of stmts(file.source)) {
    const refs = namedRefs(file, stmt, name);
    if (refs.length) out.push({ refs, spec: modSpec(stmt) });
  }
  return out;
};
const helperRefs = (file: FileCtx, name: string): any[] =>
  helperRows(file, name).flatMap((row) => row.refs);
const helperNode = (file: FileCtx, name: string): any =>
  helperDecl(file, name) || helperRefs(file, name)[0];
const resolveHelperImport = (from: string, spec: string): string | undefined => {
  if (spec.startsWith('.')) return;
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
        if (existsSync(file) && HELPER_FILE.test(file)) return realpathSync(file);
    }
  } catch {}
  return;
};
const helperTargets = (state: State, file: FileCtx, name: string): FileCtx[] => {
  const out: FileCtx[] = [];
  const fileSet = new Set(state.files.keys());
  for (const row of helperRows(file, name)) {
    if (!row.spec) continue;
    const target =
      resolveImportFile(file.file, row.spec, fileSet) || resolveHelperImport(file.file, row.spec);
    if (target) out.push(getFileCtx(state, target));
  }
  return out;
};
const hasAnyHelper = (file: FileCtx): boolean =>
  TYPED.some((typed) => !!helperDecl(file, SHORT[typed])) ||
  WRAP_HELPERS.some((name) => !!helperNode(file, name));
const goodHelperRef = (
  state: State,
  file: FileCtx,
  name: string,
  seen = new Set<string>()
): boolean => {
  const key = `${file.file}:${name}`;
  if (!seenAdd(seen, key)) return false;
  for (const target of helperTargets(state, file, name)) {
    if (goodLocalHelper(target, name) && goodLocalHelpers(target)) return true;
    if (goodHelperRef(state, target, name, seen)) return true;
  }
  return false;
};
const goodLocalHelpers = (file: FileCtx): boolean => {
  return HELPER_NAMES.every((name) => goodLocalHelper(file, name));
};
const goodHelpers = (state: State, file: FileCtx): boolean =>
  goodLocalHelpers(file) || WRAP_HELPERS.every((name) => goodHelperRef(state, file, name));
const helperFileName = (file: FileCtx): string => basename(file.file);
const helperFile = (file: FileCtx): boolean => HELPER_FILES.has(helperFileName(file));
const helperCandidates = (files: FileCtx[]): FileCtx[] => files.filter(helperFile);
const preferredHelperFile = (files: FileCtx[]): FileCtx | undefined =>
  files.find((file) => helperFileName(file) === DEFAULT_HELPER_FILE) || files.find(helperFile);
type HelperTarget = { action: 'add' | 'update'; line: number; rel: string };
const helperTarget = (state: State, files: FileCtx[]): HelperTarget | undefined => {
  const candidates = helperCandidates(files);
  const withHelpers = candidates.find(hasAnyHelper);
  if (withHelpers) {
    if (goodHelpers(state, withHelpers)) return;
    const decl = WRAP_HELPERS.map((name) => helperNode(withHelpers, name)).find(Boolean);
    return {
      action: 'update',
      line: decl ? nodeLineNo(withHelpers, decl) : 1,
      rel: withHelpers.rel,
    };
  }
  const target = preferredHelperFile(candidates);
  if (target) return { action: 'add', line: 1, rel: target.rel };
  return { action: 'add', line: 1, rel: DEFAULT_HELPER_FILE };
};
const needsHelpers = (state: State): boolean =>
  state.issues.some(
    (item) =>
      (item.kind === 'bytes-input' || item.kind === 'bytes-return') &&
      item.issue.startsWith('wrap ')
  );
const addHelperIssue = (state: State, target: HelperTarget): void => {
  const name = target.action === 'add' ? HELPER_FILE_LABEL : target.rel;
  pushIssue(
    state,
    target.rel,
    target.line,
    'helper',
    helperMsg(target.action, name),
    'bytes-helper',
    true
  );
};
const checkHelpers = (state: State, files: FileCtx[]) => {
  if (!needsHelpers(state)) return;
  const target = helperTarget(state, files);
  if (!target) return;
  addHelperIssue(state, target);
};
const checkParamWraps = (state: State, file: FileCtx, node: any) => {
  visitParamTypes(node, (type) => checkWrap(state, file, type, 'input'));
};
const checkCallableWraps = (state: State, file: FileCtx, node: any) => {
  visitCallableParts(
    node,
    'output',
    (item) => checkParamWraps(state, file, item),
    (item) => checkWrap(state, file, item, 'output')
  );
};
const aliasMaps = (files: FileCtx[]) => {
  const aliasByName = new Map<string, Typed>();
  const exportedByFile = new Map<string, Map<string, Typed>>();
  for (const file of files) {
    const exps = new Map<string, Typed>();
    for (const stmt of stmts(file.source)) {
      const alias = typeAlias(stmt);
      if (!alias) continue;
      const name = nodeName(file, alias.name);
      const typed = canonicalKind(file, alias.type);
      if (!name || !typed) continue;
      if (exported(stmt)) exps.set(name, typed);
      aliasByName.set(name, typed);
    }
    exportedByFile.set(file.file, exps);
  }
  return { aliasByName, exportedByFile };
};
const applyImportedAliases = (
  files: FileCtx[],
  fileSet: Set<string>,
  exportedByFile: Map<string, Map<string, Typed>>
) => {
  for (const file of files) {
    for (const stmt of stmts(file.source)) {
      if (!importDecl(stmt)) continue;
      const spec = modSpec(stmt);
      if (!spec) continue;
      const target = resolveImportFile(file.file, spec, fileSet);
      if (!target) continue;
      const exps = exportedByFile.get(target);
      if (!exps?.size) continue;
      const named = importElements(stmt);
      if (!named.length) continue;
      for (const item of named) {
        const imported = nodeName(file, item.propertyName || item.name);
        const local = nodeName(file, item.name);
        const typed = exps.get(imported);
        if (!local || !typed) continue;
        file.imports.set(local, typed);
      }
    }
  }
};

const scanFile = (state: State, file: FileCtx, ts: TsLike) => {
  const walkNeutralType = (node: any): void =>
    walkType(state, file, node, 'neutral', new Set(), undefined, true);
  const walkNode = (node: any) => {
    if (!node) return false;
    scanTypeParams(state, file, node);
    if (classRuntimeMember(node)) return false;
    if (runtimeCallable(node)) {
      checkCallableWraps(state, file, node);
      if (node.body) walkAst(ts, node.body, walkNode);
      return false;
    }
    const alias = typeAlias(node);
    if (alias) {
      if (isCanonicalHelperDecl(file, node)) return false;
      const name = nodeName(file, alias.name);
      const generic = typedKind(file, alias.type);
      if (generic && name && typeArgs(alias.type).length) {
        addGenericIssue(
          state,
          file,
          alias.type,
          generic,
          nodeText(file, alias.type),
          'neutral',
          name
        );
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
      if (typeCallable(variable.type)) checkCallableWraps(state, file, variable.type);
      else if (varMode(variable) === 'output') checkWrap(state, file, variable.type, 'output');
      else walkNeutralType(variable.type);
      if (variable.initializer) walkAst(ts, variable.initializer, walkNode);
      return false;
    }
    return true;
  };
  walkAst(ts, file.source, walkNode);
};
export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; loadTS?: (pkgFile: string) => TsLike } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const { cwd: base, pkgFile } = pkgTarget(args.pkgArg, opts.cwd);
  const ts = (opts.loadTS || loadTS)(pkgFile);
  for (const name of KIND_NAMES) KIND[name] = ts.SyntaxKind[name];
  const names = pickTSFiles(base);
  const prog = ts.createProgram(names, tsOpts(ts, base));
  const files = names.map((file) => makeFileCtx(ts, prog, base, file));
  const fileSet = new Set(files.map((file) => file.file));
  const checker = prog.getTypeChecker();
  const { aliasByName, exportedByFile } = aliasMaps(files);
  applyImportedAliases(files, fileSet, exportedByFile);
  const state: State = {
    aliasByName,
    checker,
    cwd: base,
    files: new Map(files.map((file) => [file.file, file])),
    issues: [],
    prog,
    seen: new Set(),
    ts,
  };
  for (const file of files) scanFile(state, file, ts);
  checkHelpers(state, files);
  const byFile = new Map<string, number>();
  for (const item of state.issues) byFile.set(item.file, (byFile.get(item.file) || 0) + 1);
  const out = emptyResult();
  out.failures = state.issues.length;
  out.passed = files.filter((file) => !byFile.has(file.rel)).length;
  const logs: LogIssue[] = state.issues.map((item) =>
    makeIssue('error', item.file, `${item.line}/${item.sym}`, item.issue, item.kind)
  );
  reportIssues('bytes', logs, out, colorOn, 'Bytes check found issues');
};

runSelf(import.meta.url, runCli);
