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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
  wantTSFile,
  wantColor,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
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
const usage = `usage:
  jsbt bytes <package.json>

examples:
  jsbt bytes package.json
  node /path/to/check-bytes.ts package.json`;

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
const TARG_DOC = ['Recursively adapts byte-carrying API input types. See {@link TypedArg}.'] as const;
const TRET_DOC = ['Recursively adapts byte-carrying API output types. See {@link TypedArg}.'] as const;
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
const CANON_TYPED_ARG = `T extends BigInt64Array
  ? BigInt64Array
  : T extends BigUint64Array
    ? BigUint64Array
    : T extends Float32Array
      ? Float32Array
      : T extends Float64Array
        ? Float64Array
        : T extends Int16Array
          ? Int16Array
          : T extends Int32Array
            ? Int32Array
            : T extends Int8Array
              ? Int8Array
              : T extends Uint16Array
                ? Uint16Array
                : T extends Uint32Array
                  ? Uint32Array
                  : T extends Uint8ClampedArray
                    ? Uint8ClampedArray
                    : T extends Uint8Array
                      ? Uint8Array
                      : never`;
const CANON_TYPED_RET = `T extends BigInt64Array
  ? ReturnType<typeof BigInt64Array.of>
  : T extends BigUint64Array
    ? ReturnType<typeof BigUint64Array.of>
    : T extends Float32Array
      ? ReturnType<typeof Float32Array.of>
      : T extends Float64Array
        ? ReturnType<typeof Float64Array.of>
        : T extends Int16Array
          ? ReturnType<typeof Int16Array.of>
          : T extends Int32Array
            ? ReturnType<typeof Int32Array.of>
            : T extends Int8Array
              ? ReturnType<typeof Int8Array.of>
              : T extends Uint16Array
                ? ReturnType<typeof Uint16Array.of>
                : T extends Uint32Array
                  ? ReturnType<typeof Uint32Array.of>
                  : T extends Uint8ClampedArray
                    ? ReturnType<typeof Uint8ClampedArray.of>
                    : T extends Uint8Array
                      ? ReturnType<typeof Uint8Array.of>
                      : never`;
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
const wantHelperFile = (file: string): boolean =>
  /\.(?:d\.[cm]?ts|[cm]?ts|tsx)$/.test(file);

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
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
const resolveImportFile = (from: string, spec: string, files: Set<string>): string | undefined => {
  if (!spec.startsWith('.')) return;
  const raw = resolve(dirname(from), spec);
  const tries = [
    raw,
    `${raw}.ts`,
    `${raw}.mts`,
    `${raw}.cts`,
    `${raw}.tsx`,
    join(raw, 'index.ts'),
    join(raw, 'index.mts'),
    join(raw, 'index.cts'),
    join(raw, 'index.tsx'),
  ];
  if (/\.[cm]?js$/.test(raw))
    tries.push(
      raw.replace(/\.js$/, '.ts'),
      raw.replace(/\.js$/, '.mts'),
      raw.replace(/\.js$/, '.cts'),
      raw.replace(/\.mjs$/, '.mts'),
      raw.replace(/\.cjs$/, '.cts')
    );
  for (const file of tries)
    if (files.has(file) || (existsSync(file) && wantTSFile(file))) return file;
  return;
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
  if (
    typeof ts.createProgram !== 'function' ||
    typeof ts.createSourceFile !== 'function' ||
    typeof ts.forEachChild !== 'function'
  )
    err(`expected TypeScript parser API near ${pkgFile}`);
  return ts;
};
const textOf = (file: FileCtx, node: any): string => file.text.slice(node.pos, node.end).trim();
const normType = (text: string): string => text.replace(/\s+/g, '');
const posOf = (file: FileCtx, node: any): number =>
  typeof node.getStart === 'function' ? node.getStart(file.source as any) : node.pos;
const lineOf = (file: FileCtx, node: any): number =>
  file.source.getLineAndCharacterOfPosition(posOf(file, node)).line + 1;
const nameOf = (file: FileCtx, node: any): string => {
  if (!node) return '';
  if (typeof node.escapedText === 'string') return node.escapedText;
  return textOf(file, node);
};
const ident = (name: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
const typedOf = (file: FileCtx, node: any): Typed | undefined => {
  if (!node || node.kind !== KIND.TypeReference) return;
  const name = nameOf(file, node.typeName);
  if (!TYPED_SET.has(name)) return;
  return name as Typed;
};
const canonicalOf = (file: FileCtx, node: any): Typed | undefined => {
  if (!node || node.kind !== KIND.TypeReference) return;
  if (nameOf(file, node.typeName) !== 'ReturnType' || node.typeArguments?.length !== 1) return;
  const raw = textOf(file, node).replace(/\s+/g, '');
  const hit = raw.match(/^ReturnType<typeof([A-Za-z0-9_]+)\.of>$/);
  if (!hit || !TYPED_SET.has(hit[1])) return;
  return hit[1] as Typed;
};
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
const genMsg = (_state: State, name: Typed, raw: string, mode: Mode): string => {
  if (mode === 'input') return `avoid generic ${raw}; use TArg<${name}> in input types`;
  if (mode === 'field') return `avoid generic ${raw}; use ${name} in field types`;
  if (mode === 'output') return `avoid generic ${raw}; use TRet<${name}> in output types`;
  return `avoid generic ${raw}; use TArg<${name}> in input types or TRet<${name}> in output types`;
};
const genAliasMsg = (name: Typed, alias: string, raw: string, mode: Mode): string => {
  const base = `avoid generic typed-array alias ${alias} (${genericDef(alias, raw)}); define ${rawDef(name, alias)}, then `;
  if (mode === 'input') return `${base}use TArg<${alias}> in input types`;
  if (mode === 'field') return `${base}use ${alias} in field types`;
  if (mode === 'output') return `${base}use TRet<${alias}> in output types`;
  return `${base}use TArg<${alias}> in input types or TRet<${alias}> in output types`;
};
const inMsg = (name: Typed, alias: string): string =>
  `use ${name} in input types instead of ${labelIn(name, alias)}`;
const fieldMsg = (name: Typed, alias: string): string =>
  `use ${name} in field types instead of ${labelIn(name, alias)}`;
const defaultMsg = (typed: Typed, role: 'raw' | 'ret', name: string): string => {
  const chosen = role === 'raw' ? typed : canonDef(typed);
  return `avoid default byte generic parameter ${chosen} on ${name}; spell ${typed} or ${canonDef(typed)} explicitly at use sites`;
};
const helperMsg = (action: 'add' | 'update', target: string): string =>
  `${action} canonical bytes helper types ${action === 'add' ? 'to' : 'in'} ${target}; use this block:\n${helperBlock()}`;
const wrapName = (mode: Mode): 'TArg' | 'TRet' | undefined => {
  if (mode === 'input') return 'TArg';
  if (mode === 'output') return 'TRet';
  return;
};
const isWrapped = (file: FileCtx, node: any, wrap: 'TArg' | 'TRet'): boolean =>
  node?.kind === KIND.TypeReference && nameOf(file, node.typeName) === wrap;
const typeArg = (file: FileCtx, node: any, name: string): any | undefined =>
  node?.kind === KIND.TypeReference && nameOf(file, node.typeName) === name
    ? node.typeArguments?.[0]
    : undefined;
const promiseArg = (file: FileCtx, node: any): any | undefined => typeArg(file, node, 'Promise');
const badPromiseRet = (file: FileCtx, node: any): any | undefined => {
  const arg = typeArg(file, node, 'TRet');
  return promiseArg(file, arg);
};
// Explicit async return annotations must stay Promise<...>, not TRet<Promise<...>>.
const wrapMsg = (file: FileCtx, node: any, mode: 'input' | 'output'): string => {
  const promise = mode === 'output' ? promiseArg(file, node) : undefined;
  if (promise)
    return `wrap output type with Promise<TRet<${textOf(file, promise).replace(/\s+/g, ' ')}>>`;
  const wrap = mode === 'input' ? 'TArg' : 'TRet';
  return `wrap ${mode} type with ${wrap}<${textOf(file, node).replace(/\s+/g, ' ')}>`;
};
const badPromiseRetMsg = (file: FileCtx, node: any): string => {
  const raw = textOf(file, node).replace(/\s+/g, ' ');
  return `use Promise<TRet<${raw}>> instead of TRet<Promise<${raw}>>`;
};
const bindSubs = (file: FileCtx, decl: any, args?: any[]): Subs | undefined => {
  const params = decl?.typeParameters || [];
  if (!params.length) return;
  const subs: Subs = new Map();
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const name = nameOf(file, param.name);
    const arg = args?.[i] || param.default;
    if (name && arg) subs.set(name, arg);
  }
  return subs.size ? subs : undefined;
};
const subKey = (subs?: Subs): string =>
  !subs || !subs.size
    ? ''
    : [...subs].map(([name, node]) => `${name}:${node?.pos || 0}:${node?.end || 0}`).join(',');
const subNode = (file: FileCtx, node: any, subs?: Subs): any => {
  if (!subs || !node || node.kind !== KIND.TypeReference || node.typeArguments?.length) return node;
  const name = nameOf(file, node.typeName);
  return subs.get(name) || node;
};
const flowOf = (mode: Mode): Flow | undefined => {
  if (mode === 'output') return 'output';
  if (mode === 'input' || mode === 'field') return 'input';
  return;
};
const markFlow = (uses: Map<string, Set<Flow>>, name: string, mode: Mode) => {
  const flow = flowOf(mode);
  if (!flow) return;
  let set = uses.get(name);
  if (!set) {
    set = new Set();
    uses.set(name, set);
  }
  set.add(flow);
};
const collectParamUse = (
  file: FileCtx,
  node: any,
  mode: Mode,
  names: Set<string>,
  uses: Map<string, Set<Flow>>
) => {
  if (!node) return;
  if (node.kind === KIND.TypeReference) {
    const name = nameOf(file, node.typeName);
    if (names.has(name) && !node.typeArguments?.length) {
      markFlow(uses, name, mode);
      return;
    }
    for (const item of node.typeArguments || []) collectParamUse(file, item, mode, names, uses);
    return;
  }
  if (node.kind === KIND.ArrayType)
    return collectParamUse(file, node.elementType, mode, names, uses);
  if (node.kind === KIND.ParenthesizedType || node.kind === KIND.TypeOperator)
    return collectParamUse(file, node.type, mode, names, uses);
  if (node.kind === KIND.IndexedAccessType) {
    collectParamUse(file, node.objectType, mode, names, uses);
    collectParamUse(file, node.indexType, 'neutral', names, uses);
    return;
  }
  if (node.kind === KIND.UnionType || node.kind === KIND.IntersectionType) {
    for (const item of node.types || []) collectParamUse(file, item, mode, names, uses);
    return;
  }
  if (node.kind === KIND.TupleType) {
    for (const item of node.elements || []) collectParamUse(file, item, mode, names, uses);
    return;
  }
  if (node.kind === KIND.ConditionalType) {
    collectParamUse(file, node.checkType, 'neutral', names, uses);
    collectParamUse(file, node.extendsType, 'neutral', names, uses);
    collectParamUse(file, node.trueType, mode, names, uses);
    collectParamUse(file, node.falseType, mode, names, uses);
    return;
  }
  if (node.kind === KIND.MappedType) {
    collectParamUse(file, node.typeParameter?.constraint, 'neutral', names, uses);
    collectParamUse(file, node.type, mode, names, uses);
    return;
  }
  if (node.kind === KIND.TypeLiteral) {
    for (const item of node.members || []) collectMemberParamUse(file, item, mode, names, uses);
    return;
  }
  if (node.kind === KIND.FunctionType || node.kind === KIND.ConstructorType) {
    for (const item of node.parameters || [])
      collectParamUse(file, item.type, 'input', names, uses);
    collectParamUse(file, node.type, fnOutMode(mode), names, uses);
  }
};
const collectMemberParamUse = (
  file: FileCtx,
  node: any,
  mode: Mode,
  names: Set<string>,
  uses: Map<string, Set<Flow>>
) => {
  if (!node) return;
  if (node.kind === KIND.PropertySignature || node.kind === KIND.IndexSignature) {
    collectParamUse(file, node.type, mode, names, uses);
    return;
  }
  if (node.kind === KIND.PropertyDeclaration) {
    collectParamUse(file, node.type, 'field', names, uses);
    return;
  }
  if (
    node.kind === KIND.MethodDeclaration ||
    node.kind === KIND.MethodSignature ||
    node.kind === KIND.CallSignature ||
    node.kind === KIND.ConstructSignature ||
    node.kind === KIND.FunctionType ||
    node.kind === KIND.ConstructorType
  ) {
    for (const item of node.parameters || [])
      collectParamUse(file, item.type, 'input', names, uses);
    collectParamUse(file, node.type, fnOutMode(mode), names, uses);
    return;
  }
  if (node.kind === KIND.GetAccessor)
    collectParamUse(file, node.type, fnOutMode(mode), names, uses);
  if (node.kind === KIND.SetAccessor)
    for (const item of node.parameters || [])
      collectParamUse(file, item.type, 'input', names, uses);
};
const collectDeclParamUse = (file: FileCtx, node: any, mode: Mode, names: Set<string>) => {
  const uses = new Map<string, Set<Flow>>();
  if (!node) return uses;
  if (node.kind === KIND.TypeAliasDeclaration) collectParamUse(file, node.type, mode, names, uses);
  else if (node.kind === KIND.InterfaceDeclaration) {
    for (const item of node.heritageClauses || [])
      for (const part of item.types || []) collectParamUse(file, part, mode, names, uses);
    for (const item of node.members || []) collectMemberParamUse(file, item, mode, names, uses);
  } else if (node.kind === KIND.ClassDeclaration) {
    for (const item of node.heritageClauses || [])
      for (const part of item.types || []) collectParamUse(file, part, mode, names, uses);
    for (const item of node.members || [])
      if (item.kind === KIND.PropertyDeclaration || item.kind === KIND.IndexSignature)
        collectParamUse(file, item.type, 'field', names, uses);
  }
  return uses;
};
const filterSubs = (file: FileCtx, decl: any, mode: Mode, subs?: Subs): Subs | undefined => {
  if (!subs || !subs.size || mode === 'neutral') return subs;
  const names = new Set(subs.keys());
  const uses = collectDeclParamUse(file, decl, mode, names);
  let out: Subs | undefined;
  for (const [name, node] of subs) {
    const seen = uses.get(name);
    // Mixed generic parameters are invariant: forcing Ret* or raw would break one side of Coder-like APIs.
    if (seen?.has('input') && seen.has('output')) continue;
    if (!out) out = new Map();
    out.set(name, node);
  }
  return out;
};
const ctxOf = (state: State, file: string): FileCtx => {
  const hit = state.files.get(file);
  if (hit) return hit;
  const source =
    state.prog.getSourceFile(file) ||
    state.ts.createSourceFile(file, readFileSync(file, 'utf8'), state.ts.ScriptTarget.ESNext, true);
  const text = (source as any).text || readFileSync(file, 'utf8');
  const decls = new Map<string, unknown>();
  const ctx: FileCtx = {
    decls,
    file,
    imports: new Map(),
    rel: relative(state.cwd, file) || basename(file),
    source,
    text,
  };
  for (const stmt of source.statements || []) {
    const name = nameOf(ctx, (stmt as any).name);
    if (!name) continue;
    if (
      (stmt as any).kind === KIND.TypeAliasDeclaration ||
      (stmt as any).kind === KIND.InterfaceDeclaration ||
      (stmt as any).kind === KIND.ClassDeclaration
    )
      decls.set(name, stmt);
  }
  state.files.set(file, ctx);
  return ctx;
};
const symDecls = (
  state: State,
  part: any,
  wantFile: (file: string) => boolean = wantTSFile
) => {
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
      return { ctx: ctxOf(state, fileName), node: decl };
    })
    .filter((item): item is { ctx: FileCtx; node: any } => !!item);
};
const refDecls = (state: State, node: any) => {
  const part = node?.typeName || node?.qualifier || node;
  if (!part) return [] as { ctx: FileCtx; node: any }[];
  return symDecls(state, part);
};
const resolveByteType = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string> = new Set()
): { role: 'raw' | 'ret'; typed: Typed } | undefined => {
  if (!node) return;
  const typed = typedOf(file, node);
  if (typed && !node.typeArguments?.length) return { role: 'raw', typed };
  const canon = canonicalOf(file, node);
  if (canon) return { role: 'ret', typed: canon };
  if (node.kind !== KIND.TypeReference && node.kind !== KIND.ImportType) return;
  const name =
    node.kind === KIND.ImportType ? nameOf(file, node.qualifier) : nameOf(file, node.typeName);
  const aliased = file.imports.get(name) || state.aliasByName.get(name);
  if (aliased) return { role: 'ret', typed: aliased };
  for (const item of refDecls(state, node)) {
    const key = `${item.ctx.file}:${item.node?.pos || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const declSubs = bindSubs(item.ctx, item.node, node.typeArguments);
    const body = subNode(item.ctx, item.node?.type, declSubs);
    const resolved = resolveByteType(state, item.ctx, body, seen);
    if (resolved) return resolved;
  }
  const decl = file.decls.get(name);
  if (decl) {
    const key = `${file.file}:${(decl as any)?.pos || 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      const declSubs = bindSubs(file, decl, node.typeArguments);
      const body = subNode(file, (decl as any)?.type, declSubs);
      return resolveByteType(state, file, body, seen);
    }
  }
  return;
};
const refValueDecls = (state: State, node: any) => {
  const part = node?.exprName || node;
  if (!part) return [] as { ctx: FileCtx; node: any }[];
  return symDecls(state, part);
};
const hasByteMember = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  if (!node) return false;
  if (node.type && hasByteType(state, file, node.type, seen, subs)) return true;
  for (const item of node.parameters || [])
    if (hasByteType(state, file, item.type, seen, subs)) return true;
  return false;
};
const hasByteDecl = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  if (!node) return false;
  if (node.kind === KIND.TypeAliasDeclaration)
    return hasByteType(state, file, node.type, seen, subs);
  if (node.kind === KIND.InterfaceDeclaration || node.kind === KIND.ClassDeclaration) {
    for (const item of node.heritageClauses || [])
      for (const part of item.types || [])
        if (hasByteType(state, file, part, seen, subs)) return true;
    for (const item of node.members || [])
      if (hasByteMember(state, file, item, seen, subs)) return true;
  }
  return false;
};
const hasByteType = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  node = subNode(file, node, subs);
  if (!node) return false;
  const key = `${file.file}:${node.pos || 0}:${node.end || 0}:${subKey(subs)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (typedOf(file, node) || canonicalOf(file, node)) return true;
  if (node.kind === KIND.TypeReference && nameOf(file, node.typeName) === 'ReturnType') {
    const arg = subNode(file, node.typeArguments?.[0], subs);
    if (arg?.kind === KIND.TypeQuery) {
      for (const item of refValueDecls(state, arg))
        if (hasByteType(state, item.ctx, item.node?.type, seen, subs)) return true;
    }
  }
  if (node.kind === KIND.TypeReference || node.kind === KIND.ImportType) {
    const name =
      node.kind === KIND.ImportType ? nameOf(file, node.qualifier) : nameOf(file, node.typeName);
    if (file.imports.has(name) || state.aliasByName.has(name)) return true;
    for (const item of node.typeArguments || [])
      if (hasByteType(state, file, item, seen, subs)) return true;
    for (const item of refDecls(state, node)) {
      const args = node.typeArguments?.map((arg: any) => subNode(file, arg, subs));
      const declSubs = bindSubs(item.ctx, item.node, args);
      if (hasByteDecl(state, item.ctx, item.node, seen, declSubs)) return true;
    }
    const decl = file.decls.get(name);
    if (decl) {
      const args = node.typeArguments?.map((arg: any) => subNode(file, arg, subs));
      const declSubs = bindSubs(file, decl, args);
      if (hasByteDecl(state, file, decl, seen, declSubs)) return true;
    }
    return false;
  }
  if (node.kind === KIND.ArrayType) return hasByteType(state, file, node.elementType, seen, subs);
  if (node.kind === KIND.ParenthesizedType || node.kind === KIND.TypeOperator)
    return hasByteType(state, file, node.type, seen, subs);
  if (node.kind === KIND.IndexedAccessType)
    return (
      hasByteType(state, file, node.objectType, seen, subs) ||
      hasByteType(state, file, node.indexType, seen, subs)
    );
  if (node.kind === KIND.UnionType || node.kind === KIND.IntersectionType)
    return (node.types || []).some((item: any) => hasByteType(state, file, item, seen, subs));
  if (node.kind === KIND.TupleType)
    return (node.elements || []).some((item: any) => hasByteType(state, file, item, seen, subs));
  if (node.kind === KIND.ConditionalType)
    return (
      hasByteType(state, file, node.checkType, seen, subs) ||
      hasByteType(state, file, node.extendsType, seen, subs) ||
      hasByteType(state, file, node.trueType, seen, subs) ||
      hasByteType(state, file, node.falseType, seen, subs)
    );
  if (node.kind === KIND.MappedType)
    return (
      hasByteType(state, file, node.typeParameter?.constraint, seen, subs) ||
      hasByteType(state, file, node.type, seen, subs)
    );
  if (node.kind === KIND.TypeLiteral)
    return (node.members || []).some((item: any) => hasByteMember(state, file, item, seen, subs));
  if (node.kind === KIND.FunctionType || node.kind === KIND.ConstructorType)
    return hasByteMember(state, file, node, seen, subs);
  return false;
};
const hasOpaqueDomainMember = (
  state: State,
  file: FileCtx,
  node: any,
  seen: Set<string>,
  subs?: Subs
): boolean => {
  if (!node) return false;
  if (node.kind === KIND.ConstructSignature || node.kind === KIND.ConstructorType) return true;
  if (
    node.kind === KIND.PropertySignature ||
    node.kind === KIND.IndexSignature ||
    node.kind === KIND.PropertyDeclaration
  )
    return hasOpaqueDomain(state, file, node.type, seen, subs);
  if (
    node.kind === KIND.MethodDeclaration ||
    node.kind === KIND.MethodSignature ||
    node.kind === KIND.CallSignature ||
    node.kind === KIND.FunctionType ||
    node.kind === KIND.GetAccessor
  ) {
    if (hasOpaqueDomain(state, file, node.type, seen, subs)) return true;
    for (const item of node.parameters || [])
      if (hasOpaqueDomain(state, file, item.type, seen, subs)) return true;
  }
  if (node.kind === KIND.SetAccessor)
    for (const item of node.parameters || [])
      if (hasOpaqueDomain(state, file, item.type, seen, subs)) return true;
  return false;
};
const hasSelfBound = (file: FileCtx, node: any): boolean => {
  for (const param of node?.typeParameters || []) {
    const name = nameOf(file, param.name);
    if (
      name &&
      param.constraint &&
      new RegExp(`\\b${name}\\b`).test(textOf(file, param.constraint))
    )
      return true;
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
  if (node.kind === KIND.TypeAliasDeclaration)
    return hasOpaqueDomain(state, file, node.type, seen, subs);
  if (node.kind === KIND.InterfaceDeclaration) {
    if (hasSelfBound(file, node)) return true;
    if (node.heritageClauses?.length) return true;
    for (const item of node.members || [])
      if (hasOpaqueDomainMember(state, file, item, seen, subs)) return true;
  }
  if (node.kind === KIND.ClassDeclaration) {
    if (hasSelfBound(file, node)) return true;
    for (const item of node.members || [])
      if (
        item.kind !== KIND.PropertyDeclaration &&
        item.kind !== KIND.IndexSignature &&
        hasOpaqueDomainMember(state, file, item, seen, subs)
      )
        return true;
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
  node = subNode(file, node, subs);
  if (!node) return false;
  const key = `${file.file}:${node.pos || 0}:${node.end || 0}:opaque:${subKey(subs)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (typedOf(file, node) || canonicalOf(file, node)) return false;
  // Whole-object wrappers are unsafe when they would recurse into domain objects such as
  // F-bounded points or point constructors; those need explicit method-level fixes instead.
  if (node.kind === KIND.ConstructorType || node.kind === KIND.ConstructSignature) return true;
  if (node.kind === KIND.TypeQuery) {
    // `typeof PointClass` is a constructor surface even though it reaches us as a type query.
    for (const item of refValueDecls(state, node)) {
      if (item.node?.kind === KIND.ClassDeclaration) return true;
      if (hasOpaqueDomain(state, item.ctx, item.node?.type, seen, subs)) return true;
    }
    return false;
  }
  if (node.kind === KIND.TypeReference || node.kind === KIND.ImportType) {
    const name =
      node.kind === KIND.ImportType ? nameOf(file, node.qualifier) : nameOf(file, node.typeName);
    if (file.imports.has(name) || state.aliasByName.has(name)) return false;
    for (const item of node.typeArguments || [])
      if (hasOpaqueDomain(state, file, item, seen, subs)) return true;
    for (const item of refDecls(state, node)) {
      const args = node.typeArguments?.map((arg: any) => subNode(file, arg, subs));
      const declSubs = bindSubs(item.ctx, item.node, args);
      if (hasOpaqueDomainDecl(state, item.ctx, item.node, seen, declSubs)) return true;
    }
    const decl = file.decls.get(name);
    if (decl) {
      const args = node.typeArguments?.map((arg: any) => subNode(file, arg, subs));
      const declSubs = bindSubs(file, decl, args);
      if (hasOpaqueDomainDecl(state, file, decl, seen, declSubs)) return true;
    }
    return false;
  }
  if (node.kind === KIND.ArrayType)
    return hasOpaqueDomain(state, file, node.elementType, seen, subs);
  if (node.kind === KIND.ParenthesizedType || node.kind === KIND.TypeOperator)
    return hasOpaqueDomain(state, file, node.type, seen, subs);
  if (node.kind === KIND.IndexedAccessType)
    return (
      hasOpaqueDomain(state, file, node.objectType, seen, subs) ||
      hasOpaqueDomain(state, file, node.indexType, seen, subs)
    );
  if (node.kind === KIND.UnionType || node.kind === KIND.IntersectionType)
    return (node.types || []).some((item: any) => hasOpaqueDomain(state, file, item, seen, subs));
  if (node.kind === KIND.TupleType)
    return (node.elements || []).some((item: any) =>
      hasOpaqueDomain(state, file, item, seen, subs)
    );
  if (node.kind === KIND.ConditionalType)
    return (
      hasOpaqueDomain(state, file, node.checkType, seen, subs) ||
      hasOpaqueDomain(state, file, node.extendsType, seen, subs) ||
      hasOpaqueDomain(state, file, node.trueType, seen, subs) ||
      hasOpaqueDomain(state, file, node.falseType, seen, subs)
    );
  if (node.kind === KIND.MappedType)
    return (
      hasOpaqueDomain(state, file, node.typeParameter?.constraint, seen, subs) ||
      hasOpaqueDomain(state, file, node.type, seen, subs)
    );
  if (node.kind === KIND.TypeLiteral)
    return (node.members || []).some((item: any) =>
      hasOpaqueDomainMember(state, file, item, seen, subs)
    );
  if (node.kind === KIND.FunctionType) {
    if (hasOpaqueDomain(state, file, node.type, seen, subs)) return true;
    for (const item of node.parameters || [])
      if (hasOpaqueDomain(state, file, item.type, seen, subs)) return true;
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
  if (
    node.kind === KIND.FunctionDeclaration ||
    node.kind === KIND.MethodDeclaration ||
    node.kind === KIND.MethodSignature ||
    node.kind === KIND.FunctionExpression ||
    node.kind === KIND.ArrowFunction ||
    node.kind === KIND.GetAccessor
  ) {
    walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
    return true;
  }
  if (node.kind === KIND.VariableDeclaration) {
    const type = node.type;
    if (type?.kind === KIND.FunctionType || type?.kind === KIND.ConstructorType) {
      walkType(state, file, type.type, mode, seen, subs, onlyGeneric);
      return true;
    }
    const init = node.initializer;
    if (
      init &&
      (init.kind === KIND.FunctionExpression ||
        init.kind === KIND.ArrowFunction ||
        init.kind === KIND.MethodDeclaration)
    ) {
      walkType(state, file, init.type, mode, seen, subs, onlyGeneric);
      return true;
    }
  }
  return false;
};
const fnOutMode = (mode: Mode): Mode => (mode === 'output' ? 'output' : 'neutral');
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
  if (state.seen.has(key)) return;
  state.seen.add(key);
  const item = { file, issue, kind, line, sym };
  if (prepend) state.issues.unshift(item);
  else state.issues.push(item);
};
const addIssue = (
  state: State,
  file: FileCtx,
  node: any,
  issue: Issue['issue'],
  kind: Issue['kind']
) => {
  const line = lineOf(file, node);
  const sym =
    kind === 'bytes-field'
      ? 'field'
      : kind === 'bytes-generic' || kind === 'bytes-default'
        ? 'generic'
        : kind === 'bytes-helper'
          ? 'helper'
          : kind === 'bytes-input'
            ? 'input'
            : 'return';
  pushIssue(state, file.rel, line, sym, issue, kind);
};
const checkWrap = (state: State, file: FileCtx, node: any, mode: 'input' | 'output'): void => {
  if (!node) return;
  const before = state.issues.length;
  walkType(state, file, node, mode, new Set(), undefined, true);
  if (state.issues.length !== before) return;
  const wrap = wrapName(mode);
  if (mode === 'output') {
    const bad = badPromiseRet(file, node);
    if (bad && hasByteType(state, file, bad, new Set())) {
      addIssue(state, file, node, badPromiseRetMsg(file, bad), 'bytes-return');
      return;
    }
    const promise = promiseArg(file, node);
    if (promise && isWrapped(file, promise, 'TRet')) return;
  }
  if (!wrap || isWrapped(file, node, wrap)) return;
  if (!hasByteType(state, file, node, new Set())) return;
  if (hasOpaqueDomain(state, file, node, new Set())) return;
  addIssue(
    state,
    file,
    node,
    wrapMsg(file, node, mode),
    mode === 'input' ? 'bytes-input' : 'bytes-return'
  );
};
const refAlias = (file: FileCtx, node: any, decl: any, declFile: FileCtx): string => {
  const raw =
    node.kind === KIND.ImportType ? nameOf(file, node.qualifier) : nameOf(file, node.typeName);
  if (ident(raw)) return raw;
  const name = nameOf(declFile, decl?.name);
  return ident(name) ? name : raw;
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
  node = subNode(file, node, subs);
  if (!node) return;
  // Recursive mapped generics can re-enter the same type-argument node without touching a decl guard.
  const nodeKey = `${file.file}:${node.pos || 0}:${node.end || 0}:${mode}:${subKey(subs)}`;
  if (seen.has(nodeKey)) return;
  seen.add(nodeKey);
  const typed = typedOf(file, node);
  if (typed) {
    const raw = textOf(file, node);
    if (node.typeArguments?.length) {
      addIssue(state, file, node, genMsg(state, typed, raw, mode), 'bytes-generic');
      return;
    }
    if (onlyGeneric) return;
    if (mode === 'output') addIssue(state, file, node, outMsg(raw), 'bytes-return');
    return;
  }
  const canon = canonicalOf(file, node);
  if (canon) {
    if (onlyGeneric) return;
    if (mode === 'input') addIssue(state, file, node, inMsg(canon, canonDef(canon)), 'bytes-input');
    if (mode === 'field')
      addIssue(state, file, node, fieldMsg(canon, canonDef(canon)), 'bytes-field');
    return;
  }
  if (!onlyGeneric && mode === 'output') {
    const bad = badPromiseRet(file, node);
    if (bad && hasByteType(state, file, bad, new Set())) {
      addIssue(state, file, node, badPromiseRetMsg(file, bad), 'bytes-return');
      return;
    }
    const promise = promiseArg(file, node);
    if (promise) {
      if (isWrapped(file, promise, 'TRet')) return;
      if (hasByteType(state, file, promise, new Set())) {
        addIssue(state, file, node, wrapMsg(file, node, 'output'), 'bytes-return');
        return;
      }
    }
  }
  if (node.kind === KIND.TypeReference && nameOf(file, node.typeName) === 'ReturnType') {
    const arg = subNode(file, node.typeArguments?.[0], subs);
    if (arg?.kind === KIND.TypeQuery) {
      for (const item of refValueDecls(state, arg))
        if (walkReturnDecl(state, item.ctx, item.node, mode, seen, subs, onlyGeneric)) return;
    }
  }
  if (node.kind === KIND.TypeReference || node.kind === KIND.ImportType) {
    const name =
      node.kind === KIND.ImportType ? nameOf(file, node.qualifier) : nameOf(file, node.typeName);
    const aliased = file.imports.get(name) || state.aliasByName.get(name);
    if (aliased) {
      if (onlyGeneric) return;
      if (mode === 'input') addIssue(state, file, node, inMsg(aliased, name), 'bytes-input');
      else if (mode === 'field')
        addIssue(state, file, node, fieldMsg(aliased, name), 'bytes-field');
      return;
    }
    for (const item of refDecls(state, node)) {
      const args = node.typeArguments?.map((arg: any) => subNode(file, arg, subs));
      const declSubs = filterSubs(item.ctx, item.node, mode, bindSubs(item.ctx, item.node, args));
      const body = subNode(item.ctx, item.node?.type, declSubs);
      const generic = typedOf(item.ctx, body);
      const canonical = canonicalOf(item.ctx, body);
      const raw = textOf(item.ctx, body || item.node);
      const alias = refAlias(file, node, item.node, item.ctx);
      if (generic && item.node?.type?.typeArguments?.length) {
        const msg =
          alias === raw
            ? genMsg(state, generic, raw, mode)
            : genAliasMsg(generic, alias, raw, mode);
        addIssue(state, file, node, msg, 'bytes-generic');
        return;
      }
      if (canonical) {
        if (onlyGeneric) return;
        if (mode === 'input') addIssue(state, file, node, inMsg(canonical, alias), 'bytes-input');
        else if (mode === 'field')
          addIssue(state, file, node, fieldMsg(canonical, alias), 'bytes-field');
        return;
      }
      if (generic) {
        if (onlyGeneric) return;
        if (mode === 'output') addIssue(state, file, node, outMsg(alias), 'bytes-return');
        return;
      }
      if (mode === 'neutral') continue;
      const key = `${item.ctx.file}:${item.node?.pos || 0}:${mode}:${subKey(declSubs)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      walkDecl(state, item.ctx, item.node, mode, seen, declSubs, onlyGeneric);
      return;
    }
    const decl = file.decls.get(name);
    if (decl && mode !== 'neutral') {
      const args = node.typeArguments?.map((arg: any) => subNode(file, arg, subs));
      const declSubs = filterSubs(file, decl, mode, bindSubs(file, decl, args));
      const key = `${name}:${mode}:${subKey(declSubs)}`;
      if (!seen.has(key)) {
        seen.add(key);
        walkDecl(state, file, decl, mode, seen, declSubs, onlyGeneric);
      }
      return;
    }
    if (node.typeArguments)
      for (const item of node.typeArguments)
        walkType(state, file, item, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.ArrayType)
    return walkType(state, file, node.elementType, mode, seen, subs, onlyGeneric);
  if (node.kind === KIND.ParenthesizedType)
    return walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
  if (node.kind === KIND.TypeOperator)
    return walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
  if (node.kind === KIND.IndexedAccessType) {
    walkType(state, file, node.objectType, mode, seen, subs, onlyGeneric);
    walkType(state, file, node.indexType, 'neutral', seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.UnionType || node.kind === KIND.IntersectionType) {
    for (const item of node.types || []) walkType(state, file, item, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.TupleType) {
    for (const item of node.elements || [])
      walkType(state, file, item, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.ConditionalType) {
    walkType(state, file, node.checkType, 'neutral', seen, subs, onlyGeneric);
    walkType(state, file, node.extendsType, 'neutral', seen, subs, onlyGeneric);
    walkType(state, file, node.trueType, mode, seen, subs, onlyGeneric);
    walkType(state, file, node.falseType, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.MappedType) {
    walkType(state, file, node.typeParameter?.constraint, 'neutral', seen, subs, onlyGeneric);
    walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.TypeLiteral) {
    for (const item of node.members || [])
      walkMember(state, file, item, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.FunctionType || node.kind === KIND.ConstructorType) {
    for (const item of node.parameters || [])
      walkType(state, file, item.type, 'input', seen, subs, onlyGeneric);
    walkType(state, file, node.type, fnOutMode(mode), seen, subs, onlyGeneric);
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
  if (!node) return;
  if (node.kind === KIND.PropertySignature || node.kind === KIND.IndexSignature) {
    // Returned object/interface members are part of the API surface, unlike class storage fields.
    walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.PropertyDeclaration) {
    walkType(state, file, node.type, 'field', seen, subs, onlyGeneric);
    return;
  }
  if (
    node.kind === KIND.MethodDeclaration ||
    node.kind === KIND.MethodSignature ||
    node.kind === KIND.CallSignature ||
    node.kind === KIND.ConstructSignature ||
    node.kind === KIND.FunctionType ||
    node.kind === KIND.ConstructorType
  ) {
    for (const item of node.parameters || [])
      walkType(state, file, item.type, 'input', seen, subs, onlyGeneric);
    walkType(state, file, node.type, fnOutMode(mode), seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.GetAccessor)
    return walkType(state, file, node.type, fnOutMode(mode), seen, subs, onlyGeneric);
  if (node.kind === KIND.SetAccessor) {
    for (const item of node.parameters || [])
      walkType(state, file, item.type, 'input', seen, subs, onlyGeneric);
    return;
  }
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
  if (node.kind === KIND.PropertyDeclaration || node.kind === KIND.IndexSignature) {
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
  if (node.kind === KIND.TypeAliasDeclaration)
    return walkType(state, file, node.type, mode, seen, subs, onlyGeneric);
  if (node.kind === KIND.InterfaceDeclaration) {
    for (const item of node.heritageClauses || [])
      for (const part of item.types || [])
        walkType(state, file, part, mode, seen, subs, onlyGeneric);
    for (const item of node.members || [])
      walkMember(state, file, item, mode, seen, subs, onlyGeneric);
    return;
  }
  if (node.kind === KIND.ClassDeclaration) {
    for (const item of node.heritageClauses || [])
      for (const part of item.types || [])
        walkType(state, file, part, mode, seen, subs, onlyGeneric);
    for (const item of node.members || [])
      walkClassMember(state, file, item, mode, seen, subs, onlyGeneric);
  }
};
const scanTypeParams = (state: State, file: FileCtx, node: any) => {
  for (const param of node?.typeParameters || []) {
    const constraint = resolveByteType(state, file, param.constraint);
    const def = resolveByteType(state, file, param.default);
    if (!constraint || !def || constraint.typed !== def.typed) continue;
    addIssue(
      state,
      file,
      param.default || param,
      defaultMsg(def.typed, def.role, nameOf(file, param.name)),
      'bytes-default'
    );
  }
};
const KIND: any = {};
type State = {
  aliasByName: Map<string, Typed>;
  checker: CheckerLike;
  cwd: string;
  exportedByFile: Map<string, Map<string, Typed>>;
  files: Map<string, FileCtx>;
  issues: Issue[];
  prog: ProgLike;
  seen: Set<string>;
  ts: TsLike;
};
const varMode = (node: any): Mode =>
  node.parent?.parent?.modifiers?.some((item: any) => item.kind === KIND.ExportKeyword)
    ? 'output'
    : 'neutral';
const exported = (node: any): boolean =>
  !!node?.modifiers?.some((item: any) => item.kind === KIND.ExportKeyword);
const helperDecl = (file: FileCtx, name: string): any => {
  const node = file.decls.get(name) as any;
  return node?.kind === KIND.TypeAliasDeclaration ? node : undefined;
};
const CANON_HELPERS = new Map([
  ['TypedArg', CANON_TYPED_ARG],
  ['TypedRet', CANON_TYPED_RET],
  ['TArg', CANON_TARG],
  ['TRet', CANON_TRET],
]);
const isCanonicalHelperDecl = (file: FileCtx, node: any): boolean => {
  if (node?.kind !== KIND.TypeAliasDeclaration) return false;
  // Canonical helpers intentionally contain ReturnType<TypedArray.of>.
  // Expanding them reports the helper as its own input misuse.
  const body = CANON_HELPERS.get(nameOf(file, node.name));
  return !!body && exported(node) && normType(textOf(file, node.type)) === normType(body);
};
const canonicalType = (file: FileCtx, name: string, body: string): boolean => {
  const node = helperDecl(file, name);
  if (!node || !exported(node)) return false;
  const raw = normType(textOf(file, node.type)).replace(/^\|/, '');
  return raw === normType(body);
};
const canonicalDoc = (file: FileCtx, name: string, doc: string): boolean => {
  const node = helperDecl(file, name);
  if (!node || !exported(node)) return false;
  const start = typeof node.getStart === 'function' ? node.getStart(file.source as any) : node.pos;
  return normType(file.text.slice(node.pos, start)) === normType(doc);
};
const goodLocalHelper = (file: FileCtx, name: string): boolean => {
  const doc = CANON_DOC.get(name);
  const body = CANON_HELPERS.get(name);
  return !!doc && !!body && canonicalDoc(file, name, doc) && canonicalType(file, name, body);
};
const helperRefs = (file: FileCtx, name: string): any[] => {
  const out: any[] = [];
  for (const stmt of file.source.statements || []) {
    if ((stmt as any).kind === KIND.ImportDeclaration) {
      const named = (stmt as any).importClause?.namedBindings?.elements || [];
      for (const item of named) if (nameOf(file, item.name) === name) out.push(item.name);
      continue;
    }
    if ((stmt as any).kind === KIND.ExportDeclaration) {
      const named = (stmt as any).exportClause?.elements || [];
      for (const item of named) if (nameOf(file, item.name) === name) out.push(item.name);
    }
  }
  return out;
};
const resolveHelperImport = (from: string, spec: string): string | undefined => {
  if (spec.startsWith('.')) return;
  try {
    const req = createRequire(from);
    const raw = req.resolve(spec);
    // file: dependencies can carry canonical helper source that differs from generated declarations.
    const tries = [
      raw,
      raw.replace(/\.js$/, '.ts'),
      raw.replace(/\.mjs$/, '.mts'),
      raw.replace(/\.cjs$/, '.cts'),
      raw.replace(/\.js$/, '.d.ts'),
      raw.replace(/\.mjs$/, '.d.mts'),
      raw.replace(/\.cjs$/, '.d.cts'),
    ];
    for (const file of tries)
      if (file !== raw || existsSync(file))
        if (existsSync(file) && wantHelperFile(file)) return realpathSync(file);
  } catch {}
  return;
};
const helperTargets = (state: State, file: FileCtx, name: string): FileCtx[] => {
  const out: FileCtx[] = [];
  const fileSet = new Set(state.files.keys());
  for (const stmt of file.source.statements || []) {
    const spec = (stmt as any).moduleSpecifier?.text;
    if (typeof spec !== 'string') continue;
    const items =
      (stmt as any).kind === KIND.ImportDeclaration
        ? (stmt as any).importClause?.namedBindings?.elements || []
        : (stmt as any).kind === KIND.ExportDeclaration
          ? (stmt as any).exportClause?.elements || []
          : [];
    if (!items.length) continue;
    if (!items.some((item: any) => nameOf(file, item.name) === name)) continue;
    const target = resolveImportFile(file.file, spec, fileSet) || resolveHelperImport(file.file, spec);
    if (target) out.push(ctxOf(state, target));
  }
  return out;
};
const hasAnyHelper = (file: FileCtx): boolean =>
  !!helperDecl(file, 'TArg') ||
  !!helperDecl(file, 'TRet') ||
  TYPED.some((typed) => !!helperDecl(file, SHORT[typed])) ||
  !!helperRefs(file, 'TArg').length ||
  !!helperRefs(file, 'TRet').length;
const goodHelperRef = (state: State, file: FileCtx, name: string, seen = new Set<string>()): boolean => {
  const key = `${file.file}:${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  for (const target of helperTargets(state, file, name)) {
    if (goodLocalHelper(target, name) && goodLocalHelpers(target)) return true;
    if (goodHelperRef(state, target, name, seen)) return true;
  }
  return false;
};
const goodLocalHelpers = (file: FileCtx): boolean => {
  return (
    goodLocalHelper(file, 'TypedArg') &&
    goodLocalHelper(file, 'TypedRet') &&
    goodLocalHelper(file, 'TArg') &&
    goodLocalHelper(file, 'TRet')
  );
};
const goodHelpers = (state: State, file: FileCtx): boolean =>
  goodLocalHelpers(file) ||
  (goodHelperRef(state, file, 'TArg') && goodHelperRef(state, file, 'TRet'));
const helperTarget = (
  state: State,
  files: FileCtx[]
): { action: 'add' | 'update'; line: number; rel: string } | undefined => {
  const candidates = files.filter((file) => {
    const base = basename(file.file);
    return base === 'utils.ts' || base === 'index.ts';
  });
  const withHelpers = candidates.find(hasAnyHelper);
  if (withHelpers) {
    if (goodHelpers(state, withHelpers)) return;
    const decl =
      helperDecl(withHelpers, 'TArg') ||
      helperDecl(withHelpers, 'TRet') ||
      helperRefs(withHelpers, 'TArg')[0] ||
      helperRefs(withHelpers, 'TRet')[0];
    return {
      action: 'update',
      line: decl ? lineOf(withHelpers, decl) : 1,
      rel: withHelpers.rel,
    };
  }
  const utils = candidates.find((file) => basename(file.file) === 'utils.ts');
  const index = candidates.find((file) => basename(file.file) === 'index.ts');
  const target = utils || index;
  if (target) return { action: 'add', line: 1, rel: target.rel };
  return { action: 'add', line: 1, rel: 'utils.ts' };
};
const checkHelpers = (state: State, files: FileCtx[]) => {
  if (
    !state.issues.some(
      (item) =>
        (item.kind === 'bytes-input' || item.kind === 'bytes-return') &&
        item.issue.startsWith('wrap ')
    )
  )
    return;
  const target = helperTarget(state, files);
  if (!target) return;
  if (target.action === 'add') {
    pushIssue(
      state,
      target.rel,
      target.line,
      'helper',
      helperMsg('add', 'utils.ts or index.ts'),
      'bytes-helper',
      true
    );
    return;
  }
  pushIssue(
    state,
    target.rel,
    target.line,
    'helper',
    helperMsg('update', target.rel),
    'bytes-helper',
    true
  );
};

const scanFile = (state: State, file: FileCtx, ts: TsLike) => {
  const walkNode = (node: any) => {
    if (!node) return;
    scanTypeParams(state, file, node);
    if (
      node.parent?.kind === KIND.ClassDeclaration &&
      (node.kind === KIND.MethodDeclaration ||
        node.kind === KIND.Constructor ||
        node.kind === KIND.GetAccessor ||
        node.kind === KIND.SetAccessor)
    )
      return;
    if (
      node.kind === KIND.MethodDeclaration ||
      node.kind === KIND.FunctionDeclaration ||
      node.kind === KIND.FunctionExpression ||
      node.kind === KIND.ArrowFunction ||
      node.kind === KIND.Constructor ||
      node.kind === KIND.GetAccessor ||
      node.kind === KIND.SetAccessor
    ) {
      for (const item of node.parameters || []) checkWrap(state, file, item.type, 'input');
      if (node.kind !== KIND.SetAccessor) checkWrap(state, file, node.type, 'output');
      if (node.body) ts.forEachChild(node.body, walkNode);
      return;
    }
    if (node.kind === KIND.TypeAliasDeclaration) {
      if (isCanonicalHelperDecl(file, node)) return;
      const name = nameOf(file, node.name);
      const generic = typedOf(file, node.type);
      if (generic && name && node.type?.typeArguments?.length) {
        addIssue(
          state,
          file,
          node.type,
          genAliasMsg(generic, name, textOf(file, node.type), 'neutral'),
          'bytes-generic'
        );
        return;
      }
      walkType(state, file, node.type, 'neutral', new Set(), undefined, true);
      return;
    }
    if (node.kind === KIND.InterfaceDeclaration || node.kind === KIND.ClassDeclaration) {
      walkDecl(
        state,
        file,
        node,
        'neutral',
        new Set(),
        undefined,
        node.kind !== KIND.ClassDeclaration
      );
      return;
    }
    if (node.kind === KIND.VariableDeclaration) {
      if (node.type?.kind === KIND.FunctionType || node.type?.kind === KIND.ConstructorType) {
        for (const item of node.type.parameters || []) checkWrap(state, file, item.type, 'input');
        checkWrap(state, file, node.type.type, 'output');
      } else if (varMode(node) === 'output') checkWrap(state, file, node.type, 'output');
      else walkType(state, file, node.type, 'neutral', new Set(), undefined, true);
      if (node.initializer) walkNode(node.initializer);
      return;
    }
    ts.forEachChild(node, walkNode);
  };
  walkNode(file.source as any);
};
const loadFile = (ts: TsLike, prog: ProgLike, cwd: string, file: string): FileCtx => {
  const source =
    prog.getSourceFile(file) ||
    ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const text = (source as any).text || readFileSync(file, 'utf8');
  const decls = new Map<string, unknown>();
  for (const stmt of source.statements || []) {
    const name = nameOf(
      { decls, file, imports: new Map(), rel: '', source, text },
      (stmt as any).name
    );
    if (!name) continue;
    if (
      (stmt as any).kind === KIND.TypeAliasDeclaration ||
      (stmt as any).kind === KIND.InterfaceDeclaration ||
      (stmt as any).kind === KIND.ClassDeclaration
    )
      decls.set(name, stmt);
  }
  return {
    decls,
    file,
    imports: new Map(),
    rel: relative(cwd, file) || basename(file),
    source,
    text,
  };
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; loadTS?: (pkgFile: string) => TsLike } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const base = resolve(opts.cwd || process.cwd());
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  const colorOn = opts.color ?? wantColor();
  const ts = (opts.loadTS || loadTS)(pkgFile);
  Object.assign(KIND, {
    ArrayType: ts.SyntaxKind.ArrayType,
    ArrowFunction: ts.SyntaxKind.ArrowFunction,
    CallSignature: ts.SyntaxKind.CallSignature,
    ClassDeclaration: ts.SyntaxKind.ClassDeclaration,
    ConditionalType: ts.SyntaxKind.ConditionalType,
    Constructor: ts.SyntaxKind.Constructor,
    ConstructorType: ts.SyntaxKind.ConstructorType,
    ConstructSignature: ts.SyntaxKind.ConstructSignature,
    FunctionDeclaration: ts.SyntaxKind.FunctionDeclaration,
    FunctionExpression: ts.SyntaxKind.FunctionExpression,
    FunctionType: ts.SyntaxKind.FunctionType,
    GetAccessor: ts.SyntaxKind.GetAccessor,
    IndexedAccessType: ts.SyntaxKind.IndexedAccessType,
    IndexSignature: ts.SyntaxKind.IndexSignature,
    InterfaceDeclaration: ts.SyntaxKind.InterfaceDeclaration,
    IntersectionType: ts.SyntaxKind.IntersectionType,
    MappedType: ts.SyntaxKind.MappedType,
    MethodDeclaration: ts.SyntaxKind.MethodDeclaration,
    MethodSignature: ts.SyntaxKind.MethodSignature,
    ParenthesizedType: ts.SyntaxKind.ParenthesizedType,
    PropertyDeclaration: ts.SyntaxKind.PropertyDeclaration,
    PropertySignature: ts.SyntaxKind.PropertySignature,
    ExportKeyword: ts.SyntaxKind.ExportKeyword,
    ExportDeclaration: ts.SyntaxKind.ExportDeclaration,
    ImportDeclaration: ts.SyntaxKind.ImportDeclaration,
    ImportType: ts.SyntaxKind.ImportType,
    SetAccessor: ts.SyntaxKind.SetAccessor,
    TupleType: ts.SyntaxKind.TupleType,
    TypeAliasDeclaration: ts.SyntaxKind.TypeAliasDeclaration,
    TypeLiteral: ts.SyntaxKind.TypeLiteral,
    TypeOperator: ts.SyntaxKind.TypeOperator,
    TypeQuery: ts.SyntaxKind.TypeQuery,
    TypeParameter: ts.SyntaxKind.TypeParameter,
    TypeReference: ts.SyntaxKind.TypeReference,
    UnionType: ts.SyntaxKind.UnionType,
    VariableDeclaration: ts.SyntaxKind.VariableDeclaration,
  });
  const names = pickTSFiles(base);
  const prog = ts.createProgram(names, tsOpts(ts, base));
  const files = names.map((file) => loadFile(ts, prog, base, file));
  const fileSet = new Set(files.map((file) => file.file));
  const checker = prog.getTypeChecker();
  const aliasByName = new Map<string, Typed>();
  const exportedByFile = new Map<string, Map<string, Typed>>();
  for (const file of files) {
    const exps = new Map<string, Typed>();
    for (const stmt of file.source.statements || []) {
      if ((stmt as any).kind !== KIND.TypeAliasDeclaration) continue;
      const name = nameOf(file, (stmt as any).name);
      const typed = canonicalOf(file, (stmt as any).type);
      if (!name || !typed) continue;
      if ((stmt as any).modifiers?.some((item: any) => item.kind === KIND.ExportKeyword))
        exps.set(name, typed);
      aliasByName.set(name, typed);
    }
    exportedByFile.set(file.file, exps);
  }
  for (const file of files)
    for (const stmt of file.source.statements || []) {
      if ((stmt as any).kind !== KIND.ImportDeclaration) continue;
      const spec = (stmt as any).moduleSpecifier?.text;
      if (typeof spec !== 'string') continue;
      const target = resolveImportFile(file.file, spec, fileSet);
      if (!target) continue;
      const exps = exportedByFile.get(target);
      if (!exps?.size) continue;
      const named = (stmt as any).importClause?.namedBindings?.elements;
      if (!named) continue;
      for (const item of named) {
        const imported = nameOf(file, item.propertyName || item.name);
        const local = nameOf(file, item.name);
        const typed = exps.get(imported);
        if (!local || !typed) continue;
        file.imports.set(local, typed);
      }
    }
  const state: State = {
    aliasByName,
    checker,
    cwd: base,
    exportedByFile,
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
  const out: Result = {
    failures: state.issues.length,
    passed: files.filter((file) => !byFile.has(file.rel)).length,
    skipped: 0,
    warnings: 0,
  };
  const logs: LogIssue[] = state.issues.map((item) => ({
    level: 'ERROR',
    ref: {
      file: item.file,
      issue: issueKind(item.issue, item.kind),
      sym: `${item.line}/${item.sym}`,
    },
  }));
  for (const line of groupIssues('bytes', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('Bytes check found issues');
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
