#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`.
Do not call raw fs delete/write helpers or raw `npm install` directly here.

Canonical shared copy: keep this file in `@paulmillr/jsbt/src/jsbt`,
then run it after a fresh build.
Like `jsbt bundle`, it runs `npm install` in the selected run/build directory before checking.
File writes/deletes log through `fs-modify.ts` and honor `JSBT_LOG_LEVEL`.

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
This checker takes only a package.json path, uses `test/build` next to it as the run directory,
and MUST fail if that fixture directory is missing or if `test/build/package.json`
does not install the checked package name as `"file:../.."`.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { npmInstall, sweepTemps } from '../fs-modify.ts';
import { scanPatternText } from './patterns.ts';
import {
  dtsPath,
  jsPath,
  listModules as listPublicModules,
  publicCtx,
  type PublicCtx,
  type PublicMod,
} from './public.ts';
import {
  compact,
  docCommentLines,
  emptyResult,
  err,
  execText,
  firstText,
  loadTypeScriptApi,
  makeTypeCheck,
  nodeLine,
  nodeStart,
  pkgArgs,
  readJson,
  readSource,
  recordIssue,
  reportIssues,
  runSelf,
  runTempImport,
  sorted,
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

type Ctx = PublicCtx & { runDir: string };
type Disp = { kind?: string; text: string };
type Tag = { name: string; paramName?: string; prose?: string; text?: string };
type Sym = {
  declarations?: any[];
  flags: number;
  getDocumentationComment: (checker: unknown) => Disp[];
  getJsDocTags: (checker: unknown) => Tag[];
  getName: () => string;
  valueDeclaration?: any;
};
type CheckerLike = {
  getAliasedSymbol: (sym: Sym) => Sym;
  getExportsOfModule: (sym: Sym) => Sym[];
  getPropertiesOfType?: (type: unknown) => Sym[];
  getSignaturesOfType: (type: unknown, kind: unknown) => SigLike[];
  getSymbolAtLocation: (node: unknown) => Sym | undefined;
  getTypeOfSymbolAtLocation: (sym: Sym, node: unknown) => unknown;
  getTypeAtLocation?: (node: unknown) => unknown;
  typeToString: (type: unknown) => string;
};
type ProgLike = {
  getSourceFile: (file: string) => any;
  getTypeChecker: () => CheckerLike;
};
type SigLike = { getReturnType: () => unknown; parameters: Sym[] };
type Programs = { dts: ProgLike; js: ProgLike };
type SymDocs = { docs: string; tags: Tag[] };
type TsLike = Omit<TsCheck, 'createProgram'> & {
  ScriptTarget: { ESNext: unknown };
  SignatureKind: { Call: unknown; Construct: unknown };
  SymbolFlags: { Alias: number };
  createProgram: (files: string[], opts: Record<string, unknown>, host?: any) => ProgLike;
  displayPartsToString?: (parts: Disp[]) => string;
};
type TSDocLike = {
  TSDocConfiguration: new () => {
    addTagDefinitions: (defs: unknown[]) => void;
  };
  TSDocParser: new (cfg?: unknown) => {
    parseString: (text: string) => {
      docComment?: {
        customBlocks?: any[];
        params?: { blocks?: any[] };
        returnsBlock?: { content?: any };
        summarySection?: any;
      };
      log?: { messages?: { messageId?: unknown; unformattedText?: string }[] };
    };
  };
  TSDocTagDefinition: new (opts: { syntaxKind: unknown; tagName: string }) => unknown;
  TSDocTagSyntaxKind: { ModifierTag: unknown };
};
type Item = {
  bind: string;
  dtsFile: string;
  key: string;
  line: number;
  name: string;
  runtime: boolean;
  spec: string;
  sym: Sym;
};
type ItemRef = Pick<Item, 'dtsFile' | 'line' | 'name'>;
type FailFn = (at: ItemRef, text: string, kind: string) => void;
type DocLike = Pick<
  DeclMeta,
  'docProse' | 'docs' | 'errors' | 'plainLongSingle' | 'single' | 'tags'
>;
type DocMessages = {
  example?: string;
  invalid: (err: string) => string;
  link: (err: string) => string;
  missing: string;
  // Member-doc absence is grouped as "member", while top-level absence stays "docs".
  missingKind?: string;
  plain: string;
  tagged: string;
  throws: (err: string) => string;
};
type BagRefs = Map<string, string[]> | Record<string, string[]>;
type RefDoc = Pick<DeclMeta, 'docs' | 'docProse' | 'hasDocs' | 'tags'> & { info: CallInfo };
type TypeRefInfo = { base: Sym; decl?: any; sym: Sym };
type DocItem = DeclMeta & {
  bagRefs: Map<string, string[]>;
  info: CallInfo;
  inline: string;
  name: string;
  owner: any;
  ownerName: string;
  ref?: RefDoc;
};
type CallInfo = {
  bagRefs: Record<string, string[]>;
  bags: Record<string, string[]>;
  fnParams: string[];
  kind: string;
  params: string[];
  returns: boolean;
};
type TypedDecl = { decl: any; kind: 'interface' | 'type'; members: any[] };
type DeclMeta = {
  docs: string;
  docProse: string;
  errors: string[];
  examples: Example[];
  hasDocs: boolean;
  plainLongSingle: boolean;
  single: boolean;
  tags: Tag[];
};
type ExportInfo = {
  decl: any;
  own: SymDocs;
  resolved: Sym;
  resolvedDoc: SymDocs;
  resolvedFile: string | undefined;
  src: Sym;
};
type ExportRow = { ex: ExportInfo; exported: Sym; item: Item; jsSym?: Sym; mod: PublicMod };
type Analysis = {
  dtsChecker: CheckerLike;
  jsChecker: CheckerLike;
  rows: ExportRow[];
};
type SrcIndex = Map<string, Map<string, Map<string, string>>>;
type DocShape = { plainLongSingle: boolean; taggedSingle: boolean };
type Example = { code: string; errors: string[]; prose: string[] };
type ParsedDoc = Omit<DeclMeta, 'single'> & { taggedSingle: boolean };
type TestApi = {
  bindName: typeof bindName;
  dtsPath: typeof dtsPath;
  docShape: typeof docShape;
  examplePatternErrors: typeof examplePatternErrors;
  exampleDoc: typeof exampleDoc;
  inject: typeof inject;
  isIgnored: typeof isIgnored;
  isTrivial: typeof isTrivial;
  jsPath: typeof jsPath;
  normalizeDoc: typeof normalizeDoc;
  parseParam: typeof parseParam;
  parseReturn: typeof parseReturn;
  placeholderExample: typeof placeholderExample;
  prototypeThrows: typeof prototypeThrows;
  prototypeThrowsRaw: typeof prototypeThrowsRaw;
  shouldInject: typeof shouldInject;
  sweepTemps: typeof sweepTemps;
};
type ThrowInfo = { direct: Set<string>; thrown: Set<string>; unknown: boolean };
type ThrowRawReport = {
  direct: string[];
  docs: string[];
  dtsFile: string;
  key: string;
  name: string;
  thrown: string[];
  unknown: boolean;
};
type ThrowReport = ThrowRawReport & { issues: string[] };
type AbsBool =
  | { kind: 'and'; items: AbsBool[] }
  | { kind: 'atom'; id: string }
  | { kind: 'const'; value: boolean }
  | { kind: 'not'; item: AbsBool }
  | { kind: 'or'; items: AbsBool[] };
type AbsVal =
  | { kind: 'bigint'; value: bigint }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'undefined' }
  | { kind: 'unknown' };
type EnvEntry = { bool?: AbsBool; value?: AbsVal };
type Env = Map<string, EnvEntry>;
type Facts = Map<string, boolean>;
type Flow = { env: Env; facts: Facts };
type Walk = { flows: Flow[]; info: ThrowInfo };

const usage = usageText('tsdoc', 'check-jsdoc.ts');

const partsText = (parts?: Disp[]) => parts?.map((part) => part.text).join('') || '';
const tagText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? partsText(value as Disp[]) : '';
};
const resolveCtx = (args: PkgArgs, cwd = process.cwd()): Ctx => {
  return withRunDir(publicCtx(args.pkgArg, cwd));
};
const loadTs = (pkgFile: string): TsLike => {
  return loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript compiler API', ['createProgram']);
};
const loadTSDoc = (pkgFile: string): TSDocLike => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req('@microsoft/tsdoc') as TSDocLike | { default?: TSDocLike };
    } catch {}
    try {
      const jsbtPkg = req.resolve('@paulmillr/jsbt/package.json');
      const jsbtReq = createRequire(jsbtPkg);
      return jsbtReq('@microsoft/tsdoc') as TSDocLike | { default?: TSDocLike };
    } catch {
      return err(
        [
          `missing @microsoft/tsdoc near ${pkgFile};`,
          'reinstall @paulmillr/jsbt or run npm install in the target repo first',
        ].join(' ')
      );
    }
  })();
  const tsdoc = ('default' in raw && raw.default ? raw.default : raw) as TSDocLike;
  if (typeof tsdoc.TSDocParser !== 'function') err(`expected TSDoc parser API near ${pkgFile}`);
  return tsdoc;
};
const runCode = async (code: string, cwd: string): Promise<ExecRes> => {
  return runTempImport(cwd, {
    code,
    execArgv: ['--experimental-strip-types'],
    ext: 'ts',
    prefix: '.__jsdoc-check-',
  });
};
const loadProgram = (ts: TsLike, files: string[], allowJs = false) =>
  ts.createProgram(files, {
    allowJs,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
const programs = (ts: TsLike, mods: PublicMod[]): Programs => ({
  dts: loadProgram(
    ts,
    mods.map((mod) => mod.dtsFile)
  ),
  js: loadProgram(
    ts,
    mods.map((mod) => mod.jsFile),
    true
  ),
});
const moduleExports = (checker: CheckerLike, sf: any, file: string) => {
  const sym = sf?.symbol || checker.getSymbolAtLocation(sf);
  if (!sf || !sym) err(`cannot inspect exports of ${file}`);
  return checker.getExportsOfModule(sym);
};
const progExports = (checker: CheckerLike, prog: ProgLike, file: string): Sym[] =>
  moduleExports(checker, prog.getSourceFile(file), file);
const sortedProgExports = (checker: CheckerLike, prog: ProgLike, file: string): Sym[] =>
  progExports(checker, prog, file).sort((a, b) => a.getName().localeCompare(b.getName()));
const isAlias = (ts: TsLike, sym: Sym): boolean => !!(sym.flags & ts.SymbolFlags.Alias);
const resolveAlias = (ts: TsLike, checker: CheckerLike, sym: Sym): Sym =>
  isAlias(ts, sym) ? checker.getAliasedSymbol(sym) : sym;
const symLine = (sym: Sym): number => {
  const node = symDecl(sym);
  return lineAt(node);
};
const lineAt = (node: any): number => {
  const sf = node?.getSourceFile?.();
  if (!node || !sf?.getLineAndCharacterOfPosition) return 0;
  return nodeLine(sf, node);
};
const itemAt = (
  item: Pick<Item, 'dtsFile' | 'line' | 'name'>,
  node: any,
  name: string = item.name
): Pick<Item, 'dtsFile' | 'line' | 'name'> => ({
  dtsFile: node?.getSourceFile?.()?.fileName || item.dtsFile,
  line: lineAt(node) || item.line,
  name,
});
const isTrivial = (text: string, name = ''): boolean => {
  const norm = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[`*_()[\]{}<>,.:;'"/\\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const value = norm(text);
  if (!value) return true;
  if (name && value === norm(name)) return true;
  return value === 'return' || value === 'returns';
};
const normalizeDoc = (raw: string): string =>
  raw.replace(/(^|\n)(\s*\*\s*)@return\b/g, '$1$2@returns');
const todoTag = /(^|\n)\s*\*\s*@todo\b/;
const parseParam = (tag: Tag): { desc: string; name: string } => ({
  desc: (tag.text || '').replace(/^\s*-\s*/, '').trim(),
  name: (tag.paramName || '').replace(/^\[|\]$/g, ''),
});
const tagsNamed = (tags: Tag[], name: string): Tag[] => tags.filter((tag) => tag.name === name);
const hasTagName = (tags: Tag[], name: string): boolean => !!tagsNamed(tags, name).length;
const paramTagRows = (tags: Tag[]): { desc: string; name: string }[] =>
  tagsNamed(tags, 'param')
    .map(parseParam)
    .filter((tag) => tag.name);
const tagDescMap = (tags: { desc: string; name: string }[]): Map<string, string> =>
  new Map(tags.map((tag) => [tag.name, tag.desc]));
const returnTag = (tags: Tag[], legacy = false): Tag | undefined =>
  tags.find((tag) => tag.name === 'returns' || (legacy && tag.name === 'return'));
const parseReturn = (tag: Tag): string => (tag.text || '').replace(/^\s*-\s*/, '').trim();
const LINK_TAG = /\{@link\b/;
const linkTargets = (text: string): string[] =>
  [...text.matchAll(/\{@link\s+([^\s}|]+)/g)].map((match) => match[1] || '').filter(Boolean);
const linkTail = (target: string): string => {
  const raw = target.trim();
  return /([A-Z][A-Za-z0-9_]*)$/.exec(raw)?.[1] || raw.split(/[.#/]/).at(-1) || raw;
};
const linkTypeNames = (texts: Iterable<string>): Set<string> => {
  const out = new Set<string>();
  for (const text of texts) {
    for (const target of linkTargets(text)) {
      const tail = linkTail(target);
      if (tail) out.add(tail);
    }
  }
  return out;
};
const sameLinkTarget = (actual: string, expected: string): boolean => {
  const trim = (value: string) => value.replace(/^typeof\s+/, '').trim();
  return trim(actual) === trim(expected) || trim(actual).split(/[.#/]/).at(-1) === trim(expected);
};
const hasLinkTarget = (text: string, expected: string): boolean =>
  linkTargets(text).some((target) => sameLinkTarget(target, expected));
const hasAnyLinkTarget = (text: string, expected: string[]): boolean =>
  expected.some((ref) => hasLinkTarget(text, ref));
const linkTargetMsg = (refs: string[]): string =>
  refs.length <= 1
    ? `{@link ${refs[0]}}`
    : `one of ${refs.map((ref) => `{@link ${ref}}`).join(', ')}`;
const isTsLibDecl = (decl: any): boolean =>
  /(?:^|\/)lib\.[^/]+\.d\.ts$/.test(decl?.getSourceFile?.()?.fileName || '');
const symDecls = (sym: Sym | undefined): any[] =>
  sym?.declarations || (sym?.valueDeclaration ? [sym.valueDeclaration] : []);
const symDecl = (sym: Sym | undefined) => sym?.valueDeclaration || sym?.declarations?.[0];
const paramDecl = (sym: Sym, fallback?: any): any =>
  sym.valueDeclaration || sym.declarations?.[0] || fallback;
const docNode = (node: any): any => {
  let cur = node;
  while (cur) {
    if (cur?.jsDoc?.length) return cur;
    cur = cur.parent;
  }
  return node;
};
const mdLink = /\[[^\]\n]+\]\([^)]+\)/;
const rawLink = /\bhttps?:\/\/\S+/i;
const proseLinkIssues = (text: string): string[] => {
  const issues: string[] = [];
  if (mdLink.test(text)) issues.push('markdown links are not allowed; use {@link ...}');
  if (rawLink.test(text)) issues.push('plain URLs are not allowed; use {@link ...}');
  return issues;
};
const linkIssues = (docs: string, tags: Tag[]): string[] => {
  const issues: string[] = [];
  issues.push(...proseLinkIssues(docs));
  for (const tag of tags) {
    if (tag.name === 'example') continue;
    for (const issue of proseLinkIssues(tag.prose || tag.text || ''))
      issues.push(issue.replace(' are not allowed', ` are not allowed in @${tag.name}`));
  }
  return issues;
};
const tagBody = (tag: Tag): string => [tag.text || '', tag.prose || ''].filter(Boolean).join('\n');
const throwsIssues = (tags: Tag[]): string[] => {
  const issues: string[] = [];
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
const throwTagTypes = (tags: Tag[]): Set<string> =>
  linkTypeNames(tagsNamed(tags, 'throws').map(tagBody));
const throwsExample = (name: string): string => {
  if (name === 'TypeError') return '@throws On wrong argument types. {@link TypeError}';
  if (name === 'RangeError')
    return '@throws On wrong argument ranges or values. {@link RangeError}';
  if (name === 'Error')
    return '@throws If a documented runtime validation or state check fails. {@link Error}';
  return `@throws If a documented ${name} condition is hit. {@link ${name}}`;
};
const missingThrowsMsg = (name: string): string =>
  `missing @throws for ${name}; e.g. "${throwsExample(name)}"`;
const throwDocIssues = (docs: Set<string>, info: ThrowInfo, hasThrowTags: boolean): string[] => {
  const issues: string[] = [];
  if (!info.thrown.size) {
    if (hasThrowTags && !info.unknown)
      return ['remove @throws; no thrown errors were inferred from the current implementation'];
    return [];
  }
  if (!info.unknown) {
    for (const name of sorted(info.thrown)) {
      if (!docs.has(name)) issues.push(missingThrowsMsg(name));
    }
    for (const name of sorted(docs)) {
      if (!info.thrown.has(name)) {
        issues.push(
          `remove stale @throws for ${name}; it is not inferred from the current implementation`
        );
      }
    }
    return issues;
  }
  if (info.direct.size) {
    for (const name of sorted(info.direct)) {
      if (docs.has(name)) continue;
      issues.push(missingThrowsMsg(name));
    }
    return issues;
  }
  if (hasThrowTags) return issues;
  issues.push(
    [
      'missing @throws; document the known thrown conditions with prose first',
      'and a linked error type',
    ].join(' ')
  );
  return issues;
};
const throwsCoverageIssues = (tags: Tag[], info: ThrowInfo): string[] =>
  throwDocIssues(throwTagTypes(tags), info, hasTagName(tags, 'throws'));
const throwInfo = (item: Pick<ThrowRawReport, 'direct' | 'thrown' | 'unknown'>): ThrowInfo => ({
  direct: new Set(item.direct),
  thrown: new Set(item.thrown),
  unknown: item.unknown,
});
const emptyThrows = (): ThrowInfo => ({
  direct: new Set<string>(),
  thrown: new Set<string>(),
  unknown: false,
});
const mergeThrows = (...infos: ThrowInfo[]): ThrowInfo => {
  const out = emptyThrows();
  for (const info of infos) {
    out.unknown ||= info.unknown;
    for (const name of info.direct) out.direct.add(name);
    for (const name of info.thrown) out.thrown.add(name);
  }
  return out;
};
const mergeThrownOnly = (base: ThrowInfo, info: ThrowInfo): ThrowInfo => {
  base.unknown ||= info.unknown;
  for (const name of info.thrown) base.thrown.add(name);
  return base;
};
const isLocalDecl = (root: string, decl: any): boolean => {
  const file = decl?.getSourceFile?.()?.fileName || '';
  if (!file) return false;
  if (/(?:^|\/)node_modules\//.test(file)) return false;
  if (/\.d\.(?:c|m)?ts$/.test(file)) return false;
  const rel = relative(root, file);
  return !!rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel);
};
const THROW_CLASS = /^[A-Z][A-Za-z0-9_$.]*$/;
const throwName = (checker: CheckerLike, expr: any): string => {
  if (!expr) return '';
  const sym = checker.getSymbolAtLocation(expr.expression || expr);
  if (sym) {
    const name = sym.getName();
    return THROW_CLASS.test(name) ? name : '';
  }
  const type = checker.getTypeAtLocation?.(expr);
  const text = type ? checker.typeToString(type).trim() : '';
  if (!text || text === 'never' || text === 'unknown' || text === 'any') return '';
  return THROW_CLASS.test(text) ? text : '';
};
const bodyOfDecl = (ts: TsLike, decl: any): any => {
  const api = ts as any;
  if (decl?.body) return decl.body;
  if (api.isVariableDeclaration?.(decl)) {
    const init = decl.initializer;
    if (api.isArrowFunction?.(init) || api.isFunctionExpression?.(init)) return init.body;
  }
  return undefined;
};
const absUndef = (): AbsVal => ({ kind: 'undefined' });
const absUnknown = (): AbsVal => ({ kind: 'unknown' });
const boolConst = (value: boolean): AbsBool => ({ kind: 'const', value });
const boolAtom = (id: string): AbsBool => ({ kind: 'atom', id });
const boolNot = (item: AbsBool): AbsBool => {
  if (item.kind === 'const') return boolConst(!item.value);
  if (item.kind === 'not') return item.item;
  return { kind: 'not', item };
};
const boolGroup = (kind: 'and' | 'or', stop: boolean, empty: boolean, raw: AbsBool[]): AbsBool => {
  const items: AbsBool[] = [];
  for (const cur of raw) {
    if (cur.kind === 'const') {
      if (cur.value === stop) return cur;
      continue;
    }
    if (cur.kind === kind) items.push(...cur.items);
    else items.push(cur);
  }
  if (!items.length) return boolConst(empty);
  if (items.length === 1) return items[0];
  return kind === 'and' ? { kind: 'and', items } : { kind: 'or', items };
};
const boolAnd = (...raw: AbsBool[]): AbsBool => boolGroup('and', false, true, raw);
const boolOr = (...raw: AbsBool[]): AbsBool => boolGroup('or', true, false, raw);
const exprText = (node: any): string => {
  const sf = node?.getSourceFile?.();
  if (node?.getText) return node.getText(sf).trim();
  const text = sf?.text;
  const start = node?.getStart?.(sf) ?? node?.pos;
  const end = node?.end;
  return typeof text === 'string' && typeof start === 'number' && typeof end === 'number'
    ? text.slice(start, end).trim()
    : '';
};
const boolValue = (expr: AbsBool, facts: Facts): boolean | undefined => {
  const group = (items: AbsBool[], stop: boolean, full: boolean): boolean | undefined => {
    let unknown = false;
    for (const item of items) {
      const value = boolValue(item, facts);
      if (value === stop) return stop;
      if (value === undefined) unknown = true;
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
const applyGroupFacts = (
  facts: Facts,
  items: AbsBool[],
  stop: boolean,
  value: boolean
): Facts[] => {
  if (value === stop) return items.flatMap((item) => applyFacts(new Map(facts), item, stop));
  let states: Facts[] = [new Map(facts)];
  for (const item of items) {
    states = states.flatMap((state) => applyFacts(state, item, !stop));
    if (!states.length) return [];
  }
  return states;
};
const applyFacts = (facts: Facts, expr: AbsBool, value: boolean): Facts[] => {
  const current = boolValue(expr, facts);
  if (current !== undefined) return current === value ? [new Map(facts)] : [];
  if (expr.kind === 'atom') {
    const next = new Map(facts);
    next.set(expr.id, value);
    return [next];
  }
  if (expr.kind === 'not') return applyFacts(facts, expr.item, !value);
  if (expr.kind === 'and') return applyGroupFacts(facts, expr.items, false, value);
  if (expr.kind === 'or') return applyGroupFacts(facts, expr.items, true, value);
  return [];
};
const truthyVal = (value: AbsVal): boolean | undefined => {
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
const typeOfVal = (value: AbsVal): string | undefined => {
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
const eqVal = (a: AbsVal, b: AbsVal): boolean | undefined => {
  if (a.kind === 'unknown' || b.kind === 'unknown') return;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'undefined':
    case 'null':
      return true;
    case 'bool':
    case 'number':
    case 'string':
    case 'bigint':
      return a.value === (b as any).value;
    default:
      return;
  }
};
const envGet = (env: Env, name: string): EnvEntry => env.get(name) || {};
const bindParams = (
  ts: TsLike,
  decl: any,
  args: any[],
  evalValue: (node: any, env: Env, facts: Facts) => AbsVal,
  evalBool: (node: any, env: Env, facts: Facts) => AbsBool,
  env: Env,
  facts: Facts
): Env => {
  const api = ts as any;
  const next = new Map<string, EnvEntry>();
  const params = decl?.parameters || decl?.initializer?.parameters || [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (!api.isIdentifier?.(param.name)) continue;
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
  const cache = new WeakMap<object, ThrowInfo>();
  const active = new WeakSet<object>();
  return (ts: TsLike, checker: CheckerLike, root: string, decl: any, seedEnv?: Env): ThrowInfo => {
    if (!decl || typeof decl !== 'object') return emptyThrows();
    if (!seedEnv) {
      const hit = cache.get(decl);
      if (hit) return hit;
    }
    if (active.has(decl)) return emptyThrows();
    active.add(decl);
    const api = ts as any;
    const evalValue = (node: any, env: Env, facts: Facts): AbsVal => {
      if (!node || typeof node !== 'object') return absUnknown();
      if (api.isParenthesizedExpression?.(node)) return evalValue(node.expression, env, facts);
      if (api.isIdentifier?.(node)) {
        if (node.text === 'undefined') return absUndef();
        const hit = envGet(env, node.text);
        return hit.value || absUnknown();
      }
      if (api.isStringLiteralLike?.(node)) return { kind: 'string', value: node.text };
      if (api.isNumericLiteral?.(node)) return { kind: 'number', value: Number(node.text) };
      if (api.isBigIntLiteral?.(node))
        return { kind: 'bigint', value: BigInt(node.text.slice(0, -1)) };
      if (node.kind === api.SyntaxKind?.TrueKeyword) return { kind: 'bool', value: true };
      if (node.kind === api.SyntaxKind?.FalseKeyword) return { kind: 'bool', value: false };
      if (node.kind === api.SyntaxKind?.NullKeyword) return { kind: 'null' };
      if (api.isPrefixUnaryExpression?.(node)) {
        const value = evalValue(node.operand, env, facts);
        if (value.kind === 'number' && node.operator === api.SyntaxKind?.MinusToken)
          return { kind: 'number', value: -value.value };
        if (value.kind === 'number' && node.operator === api.SyntaxKind?.PlusToken) return value;
      }
      const question = node.questionDotToken !== undefined;
      if (
        (api.isPropertyAccessExpression?.(node) || api.isPropertyAccessChain?.(node)) &&
        node.name?.text === 'length'
      ) {
        const base = evalValue(node.expression, env, facts);
        if (question && (base.kind === 'undefined' || base.kind === 'null')) return absUndef();
        if (base.kind === 'string') return { kind: 'number', value: base.value.length };
        return absUnknown();
      }
      if (api.isConditionalExpression?.(node)) {
        const cond = boolValue(evalBool(node.condition, env, facts), facts);
        if (cond === true) return evalValue(node.whenTrue, env, facts);
        if (cond === false) return evalValue(node.whenFalse, env, facts);
      }
      if (api.isTypeOfExpression?.(node)) {
        const value = evalValue(node.expression, env, facts);
        const text = typeOfVal(value);
        return text === undefined ? absUnknown() : { kind: 'string', value: text };
      }
      return absUnknown();
    };
    const evalBool = (node: any, env: Env, facts: Facts): AbsBool => {
      if (!node || typeof node !== 'object') return boolAtom('unknown');
      if (api.isParenthesizedExpression?.(node)) return evalBool(node.expression, env, facts);
      if (api.isCallExpression?.(node)) {
        const callee = node.expression?.getText?.() || '';
        if (callee === 'Number.isSafeInteger') {
          const value = evalValue(node.arguments?.[0], env, facts);
          if (value.kind === 'number') return boolConst(Number.isSafeInteger(value.value));
          if (value.kind !== 'unknown') return boolConst(false);
        }
      }
      if (api.isIdentifier?.(node)) {
        const hit = envGet(env, node.text);
        if (hit.bool) return hit.bool;
        if (hit.value?.kind === 'bool') return boolConst(hit.value.value);
        return boolAtom(node.text);
      }
      if (node.kind === api.SyntaxKind?.TrueKeyword) return boolConst(true);
      if (node.kind === api.SyntaxKind?.FalseKeyword) return boolConst(false);
      if (
        api.isPrefixUnaryExpression?.(node) &&
        node.operator === api.SyntaxKind?.ExclamationToken
      ) {
        const value = truthyVal(evalValue(node.operand, env, facts));
        if (value !== undefined) return boolConst(!value);
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
        if (
          op === api.SyntaxKind?.EqualsEqualsEqualsToken ||
          op === api.SyntaxKind?.EqualsEqualsToken
        ) {
          return eq === undefined ? boolAtom(exprText(node)) : boolConst(eq);
        }
        if (
          op === api.SyntaxKind?.ExclamationEqualsEqualsToken ||
          op === api.SyntaxKind?.ExclamationEqualsToken
        ) {
          return eq === undefined ? boolAtom(exprText(node)) : boolConst(!eq);
        }
        if (left.kind !== 'unknown' && right.kind !== 'unknown') {
          const a = (left as any).value;
          const b = (right as any).value;
          if (op === api.SyntaxKind?.LessThanToken) return boolConst(a < b);
          if (op === api.SyntaxKind?.LessThanEqualsToken) return boolConst(a <= b);
          if (op === api.SyntaxKind?.GreaterThanToken) return boolConst(a > b);
          if (op === api.SyntaxKind?.GreaterThanEqualsToken) return boolConst(a >= b);
        }
        return boolAtom(exprText(node));
      }
      const value = truthyVal(evalValue(node, env, facts));
      if (value !== undefined) return boolConst(value);
      return boolAtom(exprText(node));
    };
    const callThrows = (expr: any, env: Env, facts: Facts): ThrowInfo => {
      const sym0 = checker.getSymbolAtLocation(expr?.expression || expr);
      if (!sym0) return emptyThrows();
      const sym = resolveAlias(ts, checker, sym0);
      const infos: ThrowInfo[] = [];
      for (const next of symDecls(sym)) {
        if (!isLocalDecl(root, next)) continue;
        const body = bodyOfDecl(ts, next);
        if (!body) continue;
        const args = expr?.arguments ? Array.from(expr.arguments) : [];
        infos.push(
          inferThrows(
            ts,
            checker,
            root,
            next,
            bindParams(ts, next, args, evalValue, evalBool, env, facts)
          )
        );
      }
      return infos.length ? mergeThrows(...infos) : emptyThrows();
    };
    const throwExpr = (
      expr: any,
      env: Env,
      facts: Facts,
      caught?: { name: string; info: ThrowInfo }
    ): ThrowInfo => {
      if (!expr || typeof expr !== 'object') return emptyThrows();
      if (caught && api.isIdentifier?.(expr) && expr.text === caught.name) return caught.info;
      if (api.isParenthesizedExpression?.(expr))
        return throwExpr(expr.expression, env, facts, caught);
      if (api.isConditionalExpression?.(expr)) {
        const cond = boolValue(evalBool(expr.condition, env, facts), facts);
        if (cond === true) return throwExpr(expr.whenTrue, env, facts, caught);
        if (cond === false) return throwExpr(expr.whenFalse, env, facts, caught);
        return mergeThrows(
          throwExpr(expr.whenTrue, env, facts, caught),
          throwExpr(expr.whenFalse, env, facts, caught)
        );
      }
      const out = emptyThrows();
      const name = throwName(checker, expr);
      if (name) {
        out.direct.add(name);
        out.thrown.add(name);
      } else out.unknown = true;
      return out;
    };
    const walkExpr = (
      node: any,
      env: Env,
      facts: Facts,
      caught?: { name: string; info: ThrowInfo }
    ): ThrowInfo => {
      if (!node || typeof node !== 'object') return emptyThrows();
      if (api.isFunctionLike?.(node) && node !== decl) return emptyThrows();
      if (api.isThrowStatement?.(node)) return throwExpr(node.expression, env, facts, caught);
      let out = emptyThrows();
      if (api.isCallExpression?.(node) || api.isNewExpression?.(node))
        out = mergeThrownOnly(out, callThrows(node, env, facts));
      api.forEachChild(node, (child: any) => {
        out = mergeThrows(out, walkExpr(child, env, facts, caught));
      });
      return out;
    };
    const cloneEnv = (env: Env): Env => new Map(env);
    const flow = (env: Env, facts: Facts): Flow => ({ env, facts });
    const fork = (env: Env, facts: Facts): Flow => flow(cloneEnv(env), facts);
    const walkOut = (flows: Flow[], info: ThrowInfo): Walk => ({ flows, info });
    const walkKeep = (env: Env, facts: Facts, info: ThrowInfo = emptyThrows()): Walk =>
      walkOut([flow(env, facts)], info);
    const walkStop = (info: ThrowInfo): Walk => walkOut([], info);
    const walkStmt = (
      node: any,
      env: Env,
      facts: Facts,
      caught?: { name: string; info: ThrowInfo }
    ): Walk => {
      if (!node || typeof node !== 'object') return walkKeep(env, facts);
      if (api.isBlock?.(node)) return walkList(node.statements || [], [fork(env, facts)], caught);
      if (api.isVariableStatement?.(node)) {
        const nextEnv = cloneEnv(env);
        let out = emptyThrows();
        for (const decl0 of node.declarationList?.declarations || []) {
          if (decl0.initializer)
            out = mergeThrows(out, walkExpr(decl0.initializer, nextEnv, facts, caught));
          if (api.isIdentifier?.(decl0.name)) {
            const init = decl0.initializer;
            nextEnv.set(
              decl0.name.text,
              init
                ? { value: evalValue(init, nextEnv, facts), bool: evalBool(init, nextEnv, facts) }
                : { value: absUndef(), bool: boolConst(false) }
            );
          }
        }
        return walkKeep(nextEnv, facts, out);
      }
      if (api.isExpressionStatement?.(node))
        return walkKeep(env, facts, walkExpr(node.expression, env, facts, caught));
      if (api.isReturnStatement?.(node))
        return walkStop(walkExpr(node.expression, env, facts, caught));
      if (api.isThrowStatement?.(node)) return walkStop(walkExpr(node, env, facts, caught));
      if (api.isIfStatement?.(node)) {
        const condInfo = walkExpr(node.expression, env, facts, caught);
        const cond = evalBool(node.expression, env, facts);
        const thenFacts = applyFacts(facts, cond, true);
        const elseFacts = applyFacts(facts, cond, false);
        const walkStates = (stmt: any, states: Facts[]): Walk => {
          const flows: Flow[] = [];
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
          : walkOut(
              elseFacts.map((state) => fork(env, state)),
              emptyThrows()
            );
        return walkOut(
          [...thenRes.flows, ...elseRes.flows],
          mergeThrows(condInfo, thenRes.info, elseRes.info)
        );
      }
      if (api.isTryStatement?.(node)) {
        const inside = walkStmt(node.tryBlock, cloneEnv(env), facts, caught).info;
        const finalInfo = node.finallyBlock
          ? walkStmt(node.finallyBlock, cloneEnv(env), facts, caught).info
          : emptyThrows();
        if (!node.catchClause) return walkKeep(env, facts, mergeThrows(inside, finalInfo));
        const catchName = node.catchClause.variableDeclaration?.name;
        const name = catchName && api.isIdentifier?.(catchName) ? catchName.text : '';
        const handled = walkStmt(
          node.catchClause.block,
          cloneEnv(env),
          facts,
          name ? { name, info: inside } : undefined
        ).info;
        return walkKeep(env, facts, mergeThrows(handled, finalInfo));
      }
      return walkKeep(env, facts, walkExpr(node, env, facts, caught));
    };
    const walkList = (
      list: any[],
      flows: Flow[],
      caught?: { name: string; info: ThrowInfo }
    ): Walk => {
      let nextFlows = flows;
      let out = emptyThrows();
      for (const node of list) {
        const curFlows: Flow[] = [];
        for (const flow of nextFlows) {
          const cur = walkStmt(node, flow.env, flow.facts, caught);
          out = mergeThrows(out, cur.info);
          curFlows.push(...cur.flows);
        }
        nextFlows = curFlows;
        if (!nextFlows.length) break;
      }
      return walkOut(nextFlows, out);
    };
    const body = bodyOfDecl(ts, decl);
    const out = body
      ? api.isBlock?.(body)
        ? walkList(body.statements || [], [flow(new Map(seedEnv || []), new Map())]).info
        : walkExpr(body, new Map(seedEnv || []), new Map())
      : emptyThrows();
    if (!seedEnv) cache.set(decl, out);
    active.delete(decl);
    return out;
  };
})();
const docRaw = (doc: any): string => {
  const sf = doc?.getSourceFile?.();
  const text = sf?.text;
  if (typeof text !== 'string') return '';
  const start = nodeStart(sf, doc);
  const end = doc.end || start;
  return text.slice(start, end);
};
const docLines = (doc: any) => {
  return docCommentLines(docRaw(doc)).filter(Boolean);
};
const nodeKids = (node: any): any[] => {
  if (Array.isArray(node?.nodes)) return node.nodes;
  if (Array.isArray(node?._nodes)) return node._nodes;
  return [];
};
const linkDest = (node: any): string => {
  if (!node || node.kind !== 'LinkTag') return '';
  if (typeof node.urlDestination === 'string' && node.urlDestination.trim())
    return node.urlDestination.trim();
  const refs = node.codeDestination?.memberReferences;
  if (!Array.isArray(refs) || !refs.length) return '';
  return refs
    .map(
      (ref: any) => ref?.memberIdentifier?.identifier || ref?.memberSymbol?.symbolReference || ''
    )
    .filter(Boolean)
    .join('.');
};
const docNodeText = (node: any, prose = false): string => {
  if (!node) return '';
  if (node.kind === 'SoftBreak') return '\n';
  if (prose && (node.kind === 'CodeSpan' || node.kind === 'FencedCode' || node.kind === 'LinkTag'))
    return '';
  if (typeof node.text === 'string') return node.text;
  if (!prose && typeof node.code === 'string') return node.code;
  if (!prose && node.kind === 'LinkTag') {
    const dest = linkDest(node);
    return dest ? `{@link ${dest}}` : '{@link}';
  }
  const kids = nodeKids(node);
  if (kids.length) return kids.map((kid) => docNodeText(kid, prose)).join('');
  if (node.content) return docNodeText(node.content, prose);
  return '';
};
const proseText = (node: any): string => docNodeText(node, true);
const PROSE_COMMENT = /(?:^|\n)\s*(?:\/\/|\/\*)/;
const codeTopComment = (code: string): boolean => {
  const first = firstText(code);
  return !!first && /^(?:\/\/|\/\*)/.test(first);
};
const exampleDoc = (block: any): Example => {
  const prose: string[] = [];
  const codes: string[] = [];
  const errors: string[] = [];
  for (const node of nodeKids(block?.content)) {
    if (node?.kind === 'FencedCode') {
      if (typeof node.code === 'string') codes.push(node.code.trim());
      continue;
    }
    const text = docNodeText(node).trim();
    if (!text) continue;
    prose.push(text);
  }
  if (!codes.length) errors.push('example must contain a fenced code block');
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
  if (codes.length && !code) errors.push('example fenced code block is empty');
  return { code, errors, prose };
};
const messageText = (msg: { messageId?: unknown; unformattedText?: string }): string => {
  const id = String(msg.messageId || '');
  const text = msg.unformattedText?.trim() || id;
  return id ? `${id}: ${text}` : text;
};
const docTag = (name: string, content: any, paramName?: string): Tag => ({
  name,
  ...(paramName === undefined ? {} : { paramName }),
  prose: proseText(content).trim(),
  text: docNodeText(content).trim(),
});
const docParseText = (raw: string): string =>
  raw.replace(/(^|\n)(\s*\*\s*)@__NO_SIDE_EFFECTS__(?=\s|$)/g, '$1$2@nosideeffects');
const emptyDocShape = (): DocShape => ({ plainLongSingle: false, taggedSingle: false });
const addDocShape = (shape: DocShape, doc: any): void => {
  const sf = doc?.getSourceFile?.();
  if (!sf?.getLineAndCharacterOfPosition) return;
  const start = nodeStart(sf, doc);
  const end = Math.max(start, (doc.end || start) - 1);
  const single =
    sf.getLineAndCharacterOfPosition(start).line === sf.getLineAndCharacterOfPosition(end).line;
  if (doc?.tags?.length) {
    if (single) shape.taggedSingle = true;
    return;
  }
  if (!single && docLines(doc).length === 1) shape.plainLongSingle = true;
};
const docParser = (() => {
  const cache = new WeakMap<object, { parseString: (text: string) => any }>();
  return (tsdoc: TSDocLike) => {
    const hit = cache.get(tsdoc as unknown as object);
    if (hit) return hit;
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
    cache.set(tsdoc as unknown as object, parser);
    return parser;
  };
})();
const docInfo = (() => {
  const cache = new WeakMap<object, ParsedDoc>();
  return (tsdoc: TSDocLike, decl: any): ParsedDoc => {
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
    if (hit) return hit;
    const parser = docParser(tsdoc);
    const docs: string[] = [];
    const proseDocs: string[] = [];
    const errors: string[] = [];
    const examples: Example[] = [];
    const shape = emptyDocShape();
    const tags: Tag[] = [];
    for (const doc of decl?.jsDoc || []) {
      addDocShape(shape, doc);
      const raw = normalizeDoc(docRaw(doc));
      if (!raw) continue;
      const res = parser.parseString(docParseText(raw));
      const parsed = res.docComment;
      const summary = docNodeText(parsed?.summarySection).trim();
      const summaryProse = proseText(parsed?.summarySection).trim();
      if (summary) docs.push(summary);
      if (summaryProse) proseDocs.push(summaryProse);
      for (const block of parsed?.params?.blocks || []) {
        tags.push(
          docTag(
            'param',
            block?.content,
            typeof block?.parameterName === 'string' ? block.parameterName : ''
          )
        );
      }
      if (parsed?.returnsBlock) tags.push(docTag('returns', parsed.returnsBlock.content));
      for (const block of parsed?.customBlocks || []) {
        const name = String(block?.blockTag?.tagName || '').replace(/^@/, '');
        if (!name) continue;
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
const docShape = (decl: any): DocShape => {
  const shape = emptyDocShape();
  for (const doc of decl?.jsDoc || []) addDocShape(shape, doc);
  return shape;
};
const declMeta = (tsdoc: TSDocLike, decl: any): DeclMeta => {
  const { taggedSingle, ...info } = docInfo(tsdoc, decl);
  return {
    ...info,
    single: taggedSingle,
  };
};
const typedMeta = (tsdoc: TSDocLike, decls: TypedDecl[]): DeclMeta => {
  const docs: string[] = [];
  const docProse: string[] = [];
  const errors: string[] = [];
  const examples: Example[] = [];
  const tags: Tag[] = [];
  let hasDocs = false;
  let plainLongSingle = false;
  let single = false;
  for (const decl of decls) {
    const meta = declMeta(tsdoc, decl.decl);
    if (meta.hasDocs) hasDocs = true;
    if (meta.plainLongSingle) plainLongSingle = true;
    if (meta.single) single = true;
    if (meta.docs) docs.push(meta.docs);
    if (meta.docProse) docProse.push(meta.docProse);
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
const trailingInline = (node: any) => {
  const sf = node?.getSourceFile?.();
  const text = sf?.text;
  if (typeof text !== 'string') return '';
  const end = node?.getEnd?.(sf) || node?.end || 0;
  const next = text.indexOf('\n', end);
  const tail = text.slice(end, next === -1 ? text.length : next);
  const line = tail.match(/^\s*(\/\/.*|\/\*.*\*\/)\s*$/)?.[1];
  if (!line) return '';
  if (line.startsWith('//')) return line.slice(2).trim();
  return line
    .replace(/^\/\*+\s*/, '')
    .replace(/\s*\*\/$/, '')
    .trim();
};
const sourceFiles = (dtsFile: string) => {
  const mapFile = `${dtsFile}.map`;
  if (!existsSync(mapFile)) return [] as string[];
  const raw = readJson<{ sources?: unknown }>(mapFile);
  if (!Array.isArray(raw.sources)) return [] as string[];
  return raw.sources
    .filter((src): src is string => typeof src === 'string' && !!src)
    .map((src) => resolve(dirname(mapFile), src))
    .filter((file) => existsSync(file));
};
const exportedDecl = (ts: TsLike, node: any) => {
  const kind = (ts as any).SyntaxKind?.ExportKeyword;
  if (kind === undefined) return false;
  return (node?.modifiers || []).some((mod: any) => mod?.kind === kind);
};
const typedDecl = (ts: TsLike, decl: any): TypedDecl | undefined => {
  const api = ts as any;
  if (api.isInterfaceDeclaration?.(decl))
    return { decl, kind: 'interface', members: [...decl.members] };
  if (!api.isTypeAliasDeclaration?.(decl)) return;
  return {
    decl,
    kind: 'type',
    members: api.isTypeLiteralNode?.(decl.type) ? [...decl.type.members] : [],
  };
};
const sourceIndex = (ts: TsLike, mods: PublicMod[]): SrcIndex => {
  const out: SrcIndex = new Map();
  for (const mod of mods) {
    const fileMap = new Map<string, Map<string, string>>();
    for (const file of sourceFiles(mod.dtsFile)) {
      const { source: sf } = readSource(ts, file);
      for (const stmt of (sf as any).statements || []) {
        if (!exportedDecl(ts, stmt)) continue;
        const typed = typedDecl(ts, stmt);
        if (!typed) continue;
        const name = stmt.name?.text;
        if (!name) continue;
        const memberMap = fileMap.get(name) || new Map<string, string>();
        for (const member of typed.members) {
          const memberName = member.name?.getText?.();
          const inline = memberName ? trailingInline(member) : '';
          if (memberName && inline) memberMap.set(memberName, inline);
        }
        if (memberMap.size) fileMap.set(name, memberMap);
      }
    }
    out.set(mod.dtsFile, fileMap);
  }
  return out;
};
const sourceInline = (index: SrcIndex, dtsFile: string, typeName: string, memberName: string) =>
  index.get(dtsFile)?.get(typeName)?.get(memberName) || '';
const placeholderExample = (code: string): string => {
  const text = code
    .trim()
    .split(/\r?\n/)
    .filter((line) => {
      const trim = line.trim();
      return trim && !/^import(?:\s+type)?\b/.test(trim);
    })
    .join('\n')
    .trim();
  if (!text) return '';
  if (/^void\s+[A-Za-z_$][\w$.]*;?$/.test(text)) return 'placeholder example: void reference';
  if (/\{\}\s+as\s+any\b/.test(text)) return 'placeholder example: {} as any';
  if (/^type\s+\w+\s*=\s*[A-Za-z_$][\w$.<>,[\]|&?()\s]*;?$/.test(text))
    return 'placeholder example: alias-only type';
  return '';
};
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shouldInject = (code: string, bind: string): boolean => {
  if (/^\s*import\s/m.test(code)) return false;
  const pat = new RegExp(
    `\\b(?:const|let|var|function|class|type|interface|enum)\\s+${esc(bind)}\\b`
  );
  return !pat.test(code);
};
const BAG_PARAM = /(?:^|.*(?:opts?|options?|params?|config|cfg|settings?))$/i;
const typeRefName = (node: any): string => node?.typeName?.getText?.() || '';
const typeRefTail = (node: any): string => typeRefName(node).split('.').pop() || '';
const wrappedRef = (node: any): boolean => {
  const name = typeRefTail(node);
  return name === 'TArg' || name === 'TRet';
};
const typeRefInfo = (ts: TsLike, checker: CheckerLike, node: any): TypeRefInfo | undefined => {
  const base = checker.getSymbolAtLocation(node?.typeName);
  if (!base) return;
  const sym = resolveAlias(ts, checker, base);
  return { base, decl: symDecl(sym) || symDecl(base), sym };
};
const wrapperInner = (ts: TsLike, node: any): any => {
  const api = ts as any;
  let cur = node;
  const seen = new Set<any>();
  while (api.isTypeReferenceNode?.(cur) && !seen.has(cur)) {
    seen.add(cur);
    if (!wrappedRef(cur)) break;
    const next = cur.typeArguments?.[0];
    if (!next) break;
    cur = next;
  }
  return cur;
};
const functionTypeNode = (ts: TsLike, node: any): any | undefined => {
  const api = ts as any;
  const type = wrapperInner(ts, node);
  if (api.isFunctionTypeNode?.(type)) return type;
  if (api.isParenthesizedTypeNode?.(type)) return functionTypeNode(ts, type.type);
  if (api.isUnionTypeNode?.(type) || api.isIntersectionTypeNode?.(type)) {
    for (const item of type.types || []) {
      const fn = functionTypeNode(ts, item);
      if (fn) return fn;
    }
  }
};
const uniq = <T>(items: T[]): T[] => [...new Set(items)];
const bagRef = (refs: BagRefs, name: string): string[] | undefined =>
  refs instanceof Map ? refs.get(name) : refs[name];
const setBagRef = (refs: BagRefs, name: string, values: string[]): void => {
  if (!values.length || bagRef(refs, name)) return;
  if (refs instanceof Map) refs.set(name, values);
  else refs[name] = values;
};
const addBagFields = (bags: Record<string, string[]>, name: string, fields: string[]): void => {
  if (!fields.length) return;
  bags[name] = uniq([...(bags[name] || []), ...fields]);
};
const namedBagRefs = (ts: TsLike, checker: CheckerLike, node: any): string[] => {
  const api = ts as any;
  const type = wrapperInner(ts, node);
  if (!api.isTypeReferenceNode?.(type)) return [];
  const childRefs = uniq<string>(
    (type.typeArguments || []).flatMap((arg: any): string[] => namedBagRefs(ts, checker, arg))
  );
  const ref = typeRefName(type);
  if (!ref) return childRefs;
  const decls = typeRefInfo(ts, checker, type)?.base.declarations || [];
  if (decls.length && decls.every((d: any) => api.isTypeParameterDeclaration?.(d)))
    return childRefs;
  if (decls.length && decls.every((d: any) => isTsLibDecl(d))) return childRefs;
  return childRefs.length ? uniq([...childRefs, ref]) : [ref];
};
const addParamBagRefs = (
  refs: BagRefs,
  ts: TsLike,
  checker: CheckerLike,
  params: Iterable<any>
): void => {
  for (const param of params) {
    const name = param.name?.getText?.();
    if (!name || !BAG_PARAM.test(name)) continue;
    setBagRef(refs, name, namedBagRefs(ts, checker, param.type));
  }
};
const bagTypeRefs = (ts: TsLike, checker: CheckerLike, decl: any): Record<string, string[]> => {
  const out: Record<string, string[]> = Object.create(null);
  addParamBagRefs(out, ts, checker, decl?.parameters || []);
  return out;
};
const paramTypeNode = (param: Sym): any => paramDecl(param, param)?.type;
const wrapperAnnotation = (ts: TsLike, decl: any): any | undefined => {
  const api = ts as any;
  // Re-export-only doc paths can probe wrapper helpers without a direct declaration node.
  if (!decl) return;
  const ok =
    api.isVariableDeclaration?.(decl) ||
    api.isPropertySignature?.(decl) ||
    api.isPropertyDeclaration?.(decl) ||
    api.isTypeAliasDeclaration?.(decl);
  // Function and method `.type` nodes are return types, not callable annotations.
  if (!ok) return;
  const type = decl?.type;
  if (!type || !api.isTypeReferenceNode?.(type)) return;
  if (!wrappedRef(type)) return;
  return type;
};
const unwrapDocType = (ts: TsLike, checker: CheckerLike, decl: any): unknown => {
  const type = wrapperAnnotation(ts, decl);
  if (!type || !checker.getTypeAtLocation) return;
  // The checker API exposes transformed wrapper signatures as `...args`;
  // unwrap for doc-tag validation so original parameter names are checked.
  const inner = type.typeArguments?.[0];
  if (!inner) return;
  const doc = docCallableType(ts, checker, inner);
  return doc.type || checker.getTypeAtLocation(inner);
};
const docCallScore = (ts: TsLike, checker: CheckerLike, type: unknown): number => {
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call) || [];
  if (!calls.length) return -1;
  const params = sigParamNames(calls);
  return params.length === 1 && params[0] === 'args' ? 1 : 10 + params.length;
};
const betterDocType = (
  ts: TsLike,
  checker: CheckerLike,
  best: { score: number; type?: unknown },
  node: any,
  seen: Set<any>
): { score: number; type?: unknown } => {
  const next = docCallableType(ts, checker, node, seen);
  return next.score > best.score ? next : best;
};
const betterDocTypes = (
  ts: TsLike,
  checker: CheckerLike,
  best: { score: number; type?: unknown },
  nodes: Iterable<any>,
  seen: Set<any>
): { score: number; type?: unknown } => {
  for (const node of nodes) best = betterDocType(ts, checker, best, node, seen);
  return best;
};
const docCallableType = (
  ts: TsLike,
  checker: CheckerLike,
  node: any,
  seen: Set<any> = new Set()
): { score: number; type?: unknown } => {
  const api = ts as any;
  if (!node || seen.has(node) || !checker.getTypeAtLocation) return { score: -1 };
  seen.add(node);
  const type = checker.getTypeAtLocation(node);
  let best: { score: number; type?: unknown } = { score: docCallScore(ts, checker, type), type };
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
const unwrapDocDecl = (ts: TsLike, checker: CheckerLike, decl: any): any | undefined => {
  const api = ts as any;
  const type = wrapperAnnotation(ts, decl);
  if (!type) return;
  const inner = type.typeArguments?.[0];
  if (!api.isTypeReferenceNode?.(inner)) return;
  const decl0 = typeRefInfo(ts, checker, inner)?.decl;
  return decl0 ? docNode(decl0) : undefined;
};
const sigParamNames = (sigs: SigLike[]): string[] => [
  ...new Set(sigs.flatMap((sig) => sig.parameters.map((param) => param.getName()))),
];
const hasValueReturn = (checker: CheckerLike, sig: SigLike): boolean => {
  const out = checker.typeToString(sig.getReturnType()).replace(/\s+/g, '');
  return (
    out !== 'void' && out !== 'undefined' && out !== 'Promise<void>' && out !== 'Promise<undefined>'
  );
};
const emptyCallInfo = (): CallInfo => ({
  bagRefs: {},
  bags: {},
  fnParams: [],
  kind: '',
  params: [],
  returns: false,
});
const signatureInfo = (
  ts: TsLike,
  checker: CheckerLike,
  decl: any,
  sigs: SigLike[],
  bagRefs: Record<string, string[]>,
  kind: string,
  checkReturn: boolean
): CallInfo => {
  const params = sigParamNames(sigs);
  const bags: Record<string, string[]> = Object.create(null);
  const fnParams = new Set<string>();
  for (const sig of sigs) {
    for (const param of sig.parameters) {
      const name = param.getName();
      const at = paramDecl(param, decl);
      const type = checker.getTypeOfSymbolAtLocation(param, at);
      if (
        checker.getSignaturesOfType(type, ts.SignatureKind.Call)?.length ||
        checker.getSignaturesOfType(type, ts.SignatureKind.Construct)?.length
      ) {
        fnParams.add(name);
      }
      if (!BAG_PARAM.test(name)) continue;
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
const callInfo = (ts: TsLike, checker: CheckerLike, type: unknown, decl: any): CallInfo => {
  const docType = unwrapDocType(ts, checker, decl) || type;
  const calls = checker.getSignaturesOfType(docType, ts.SignatureKind.Call) || [];
  const bagRefs = bagTypeRefs(ts, checker, decl);
  if (calls.length) return signatureInfo(ts, checker, decl, calls, bagRefs, 'call', true);
  const constructs = checker.getSignaturesOfType(type, ts.SignatureKind.Construct) || [];
  if (constructs.length)
    return signatureInfo(ts, checker, decl, constructs, bagRefs, 'construct', false);
  return emptyCallInfo();
};
const typeOfExport = (ts: TsLike, checker: CheckerLike, sym: Sym) => {
  const decl = symDecl(sym);
  if (!decl) return emptyCallInfo();
  return callInfo(ts, checker, checker.getTypeOfSymbolAtLocation(sym, decl), decl);
};
const typeDecls = (ts: TsLike, sym: Sym) => {
  const out: TypedDecl[] = [];
  for (const decl of symDecls(sym)) {
    const typed = typedDecl(ts, decl);
    if (typed) out.push(typed);
  }
  return out;
};
const refDoc = (
  ts: TsLike,
  tsdoc: TSDocLike,
  checker: CheckerLike,
  member: any
): RefDoc | undefined => {
  const api = ts as any;
  const type = wrapperInner(ts, member?.type);
  const refNode = api.isTypeReferenceNode?.(type) ? type.typeName : undefined;
  if (!refNode) return;
  const ref = typeRefInfo(ts, checker, type);
  if (!ref?.decl) return;
  const meta = declMeta(tsdoc, ref.decl);
  const info = callInfo(
    ts,
    checker,
    checker.getTypeOfSymbolAtLocation(ref.sym, ref.decl),
    ref.decl
  );
  return {
    docs: meta.docs,
    docProse: meta.docProse,
    hasDocs: meta.hasDocs,
    info,
    tags: meta.tags,
  };
};
const docItems = (ts: TsLike, tsdoc: TSDocLike, checker: CheckerLike, sym: Sym): DocItem[] => {
  const api = ts as any;
  const out: DocItem[] = [];
  const seen = new Set<string>();
  for (const decl of typeDecls(ts, sym)) {
    const ownerName = decl.decl.name?.getText?.() || sym.getName();
    for (const member of decl.members) {
      const nameNode = (member as any).name;
      if (!nameNode?.getText) continue;
      const name = nameNode.getText();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const msym = (member as any).symbol || checker.getSymbolAtLocation(nameNode);
      const meta = declMeta(tsdoc, member);
      const type = msym
        ? checker.getTypeOfSymbolAtLocation(msym, member)
        : checker.getTypeAtLocation?.(member);
      const fn = api.isMethodSignature?.(member)
        ? member
        : api.isPropertySignature?.(member)
          ? functionTypeNode(ts, member.type)
          : undefined;
      const bagRefs = new Map<string, string[]>();
      addParamBagRefs(bagRefs, ts, checker, fn?.parameters || []);
      const info = fn
        ? callInfo(ts, checker, checker.getTypeAtLocation?.(fn) || type, fn)
        : callInfo(ts, checker, type, member);
      for (const [param, ref] of Object.entries(info.bagRefs)) setBagRef(bagRefs, param, ref);
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
const bindName = (name: string, sym: Sym): string => {
  const value = name === 'default' ? sym.getName() || 'value' : name;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : 'value';
};
const isIgnored = (name: string): boolean => name.startsWith('_');
const inject = (item: Item, code: string): string => {
  const spec = JSON.stringify(item.spec);
  if (item.runtime) {
    if (item.name === 'default') return `import ${item.bind} from ${spec};\n${code}`;
    return `import { ${item.name} as ${item.bind} } from ${spec};\n${code}`;
  }
  if (item.name === 'default') return `import type ${item.bind} from ${spec};\n${code}`;
  return `import type { ${item.name} as ${item.bind} } from ${spec};\n${code}`;
};
const describeAttempt = (errs: string[], exec?: ExecRes): string => {
  if (errs.length) return compact(errs);
  if (!exec) return '';
  return execText(exec);
};
const examplePatternErrors = (ts: TsLike, code: string): string[] =>
  scanPatternText(ts as any, 'example.ts', code)
    .filter((item) => item.level === 'error')
    .map((item) => `pattern ${item.line}:${item.col}: ${item.issue}`);
const tryExample = async (
  code: string,
  item: Item,
  ctx: Ctx,
  ts: TsLike,
  opts: {
    checkTypes?: TypeCheck;
    runCode?: (code: string, cwd: string) => ExecRes | Promise<ExecRes>;
  } = {}
) => {
  const attempts = [code, ...(shouldInject(code, item.bind) ? [inject(item, code)] : [])];
  const seen = new Set<string>();
  const fails: string[] = [];
  const check = opts.checkTypes || makeTypeCheck(ts, ctx.runDir, '.__jsdoc-check.ts');
  for (const cur of attempts) {
    if (!cur.trim() || seen.has(cur)) continue;
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
    if (!item.runtime) return '';
    const exec = await Promise.resolve((opts.runCode || runCode)(cur, ctx.runDir));
    if (exec.ok) return '';
    fails.push(describeAttempt([], exec));
  }
  return compact(fails);
};
const recordDocIssue = (
  out: Result,
  log: LogIssue[],
  level: 'error' | 'warn',
  item: ItemRef,
  text: string,
  kind: string
): void =>
  recordIssue(out, log, level, basename(item.dtsFile), `${item.line}/${item.name}`, text, kind);
const recordUniqueDocIssue = (
  out: Result,
  log: LogIssue[],
  seen: Set<string>,
  level: 'error' | 'warn',
  item: ItemRef,
  text: string,
  kind: string
): boolean => {
  const key = `${level}\0${item.dtsFile}\0${item.line}\0${item.name}\0${kind}\0${text}`;
  if (seen.has(key)) return false;
  seen.add(key);
  recordDocIssue(out, log, level, item, text, kind);
  return true;
};
const hasDocText = (meta: Pick<DocLike, 'docs' | 'tags'>): boolean =>
  !!(meta.docs.trim() || meta.tags.length);
const DOC_MSG: DocMessages = {
  invalid: (err) => `invalid TSDoc: ${err}`,
  link: (err) => err,
  missing: 'missing JSDoc',
  plain: 'single-line plain JSDoc must use short form',
  tagged: 'tagged JSDoc must be multiline',
  throws: (err) => err,
};
const TYPE_DOC_MSG: DocMessages = {
  ...DOC_MSG,
  example: 'types/interfaces must not use @example',
};
const memberDocMsg = (name: string): DocMessages => ({
  example: `typed member ${name} must not use @example`,
  invalid: (err) => `invalid TSDoc for ${name}: ${err}`,
  link: (err) => `${name}: ${err}`,
  missing: `missing member JSDoc for ${name}`,
  missingKind: 'member',
  plain: `single-line plain member JSDoc for ${name} must use short form`,
  tagged: `tagged member JSDoc for ${name} must be multiline`,
  throws: (err) => `${name}: ${err}`,
});
const reportDocMeta = (
  fail: FailFn,
  at: ItemRef,
  meta: DocLike,
  msg: DocMessages,
  beforeShape?: () => void
): void => {
  for (const err of meta.errors) fail(at, msg.invalid(err), 'tsdoc');
  for (const err of linkIssues(meta.docProse, meta.tags)) fail(at, msg.link(err), 'link');
  for (const err of throwsIssues(meta.tags)) fail(at, msg.throws(err), 'throws');
  beforeShape?.();
  if (!hasDocText(meta)) fail(at, msg.missing, msg.missingKind || 'docs');
  if (meta.tags.length && meta.single) fail(at, msg.tagged, 'format');
  if (!meta.tags.length && meta.plainLongSingle) fail(at, msg.plain, 'format');
  if (msg.example && hasTagName(meta.tags, 'example')) fail(at, msg.example, 'example');
};
const reportParamDocs = (
  fail: FailFn,
  at: ItemRef,
  params: string[],
  tags: Tag[],
  refs: BagRefs,
  owner = ''
): void => {
  const pTags = paramTagRows(tags);
  const paramMap = tagDescMap(pTags);
  const label = (name: string) => (owner ? `${owner}.${name}` : name);
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
    if (isTrivial(desc, name)) fail(at, `trivial @param ${full} description`, 'param');
  }
  for (const tag of pTags)
    if (!params.includes(tag.name)) fail(at, `unknown @param ${label(tag.name)}`, 'param');
};
const reportReturnDoc = (
  fail: FailFn,
  at: ItemRef,
  returns: boolean,
  tag: Tag | undefined,
  owner = ''
): void => {
  if (!returns) return;
  const suffix = owner ? ` for ${owner}` : '';
  if (!tag) fail(at, `missing @returns${suffix}`, 'return');
  else if (isTrivial(parseReturn(tag))) fail(at, `trivial @returns${suffix}`, 'return');
};
const symDocs = (checker: CheckerLike, sym: Sym): SymDocs => ({
  docs: partsText(sym.getDocumentationComment(checker)),
  tags: sym.getJsDocTags(checker),
});
const exportInfo = (ts: TsLike, checker: CheckerLike, exported: Sym): ExportInfo => {
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
const forwardedAliasDocs = (
  ts: TsLike,
  mods: PublicMod[],
  mod: PublicMod,
  exported: Sym,
  info: ExportInfo
): boolean => {
  if (!isAlias(ts, exported) || hasDocText(info.own) || !hasDocText(info.resolvedDoc)) return false;
  const file = info.resolvedFile;
  return !file || file === mod.dtsFile || mods.some((item) => item.dtsFile === file);
};
const runtimeExports = (checker: CheckerLike, prog: ProgLike, mod: PublicMod): Map<string, Sym> => {
  const out = new Map<string, Sym>();
  for (const sym of progExports(checker, prog, mod.jsFile)) out.set(sym.getName(), sym);
  return out;
};
const exportRows = (
  ts: TsLike,
  mods: PublicMod[],
  dtsChecker: CheckerLike,
  dtsProg: ProgLike,
  jsChecker: CheckerLike,
  jsProg: ProgLike
): ExportRow[] => {
  const out: ExportRow[] = [];
  for (const mod of mods) {
    const runtime = runtimeExports(jsChecker, jsProg, mod);
    for (const exported of sortedProgExports(dtsChecker, dtsProg, mod.dtsFile)) {
      const name = exported.getName();
      if (isIgnored(name)) continue;
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
const analyzeDocs = (ts: TsLike, mods: PublicMod[]): Analysis => {
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
const throwReportIssues = (item: ThrowRawReport): string[] => {
  const docs = linkTypeNames(item.docs);
  return throwDocIssues(docs, throwInfo(item), !!docs.size);
};
const prototypeThrowsRaw = (pkgFile: string): ThrowRawReport[] => {
  const ctx = resolveCtx({ help: false, pkgArg: pkgFile }, dirname(resolve(pkgFile)));
  const ts = loadTs(ctx.pkgFile);
  const mods = listPublicModules(ctx);
  const analysis = analyzeDocs(ts, mods);
  return collectPrototypeThrows(ctx, ts, analysis.rows, analysis.dtsChecker, analysis.jsChecker);
};
const prototypeThrows = (pkgFile: string): ThrowReport[] =>
  prototypeThrowsRaw(pkgFile)
    .map((item) => ({ ...item, issues: throwReportIssues(item) }))
    .filter((item) => item.issues.length);
const collectPrototypeThrows = (
  ctx: Ctx,
  ts: TsLike,
  rows: ExportRow[],
  dtsChecker: CheckerLike,
  jsChecker: CheckerLike
): ThrowRawReport[] => {
  const out: ThrowRawReport[] = [];
  for (const row of rows) {
    const docs = tagsNamed(row.ex.src.getJsDocTags(dtsChecker), 'throws').map((tag) =>
      tagText(tag.text)
    );
    if (!row.jsSym) continue;
    const decl = symDecl(row.jsSym);
    if (!decl || !isLocalDecl(ctx.cwd, decl)) continue;
    const info = inferThrows(ts, jsChecker, ctx.cwd, decl);
    if (!info.thrown.size && !docs.length) continue;
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

export const runCli = async (
  argv: string[],
  opts: {
    checkTypes?: (ts: TsLike, cwd: string, code: string) => string[];
    color?: boolean;
    cwd?: string;
    loadTSDoc?: (pkgFile: string) => TSDocLike;
    loadTs?: (pkgFile: string) => TsLike;
    runCode?: (code: string, cwd: string) => ExecRes | Promise<ExecRes>;
  } = {}
): Promise<void> => {
  const args = pkgArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  const colorOn = opts.color ?? wantColor();
  const ctx = resolveCtx(args, opts.cwd);
  npmInstall(ctx.runDir);
  const log: LogIssue[] = [];
  const ts = (opts.loadTs || loadTs)(ctx.pkgFile);
  const tsdoc = (opts.loadTSDoc || loadTSDoc)(ctx.pkgFile);
  const mods = listPublicModules(ctx);
  const typedSeen = new Set<string>();
  const analysis = analyzeDocs(ts, mods);
  const dtsChecker = analysis.dtsChecker;
  const srcIndex = sourceIndex(ts, mods);
  const checkExampleTypes = opts.checkTypes
    ? (code: string) => opts.checkTypes!(ts, ctx.runDir, code)
    : makeTypeCheck(ts, ctx.runDir, '.__jsdoc-check.ts');
  const throwReports = collectPrototypeThrows(
    ctx,
    ts,
    analysis.rows,
    analysis.dtsChecker,
    analysis.jsChecker
  );
  const throwMap = new Map(throwReports.map((item) => [`${item.key}:${item.name}`, item]));
  const out = emptyResult();
  for (const row of analysis.rows) {
    const { ex, exported, item, mod } = row;
    if (forwardedAliasDocs(ts, mods, mod, exported, ex)) continue;
    const sourceDecl = docNode(symDecl(ex.src));
    const wrappedDecl = unwrapDocDecl(ts, dtsChecker, ex.decl);
    const typed = typeDecls(ts, ex.resolved);
    const smeta = declMeta(tsdoc, sourceDecl);
    const wmeta = wrappedDecl ? declMeta(tsdoc, wrappedDecl) : undefined;
    // TRet<T>/TArg<T> exports often carry the public callable docs on the inner type alias.
    const vmeta = smeta.hasDocs || !wmeta?.hasDocs ? smeta : wmeta;
    const tmeta = typedMeta(tsdoc, typed);
    const typedItem = itemAt(
      item,
      ex.decl,
      ex.decl?.name?.getText?.() || ex.resolved.getName() || item.name
    );
    let failed = false;
    const fail = (at: ItemRef, text: string, kind: string): void => {
      failed = true;
      recordDocIssue(out, log, 'error', at, text, kind);
    };
    const failUnique = (seen: Set<string>, at: ItemRef, text: string, kind: string): void => {
      if (!recordUniqueDocIssue(out, log, seen, 'error', at, text, kind)) return;
      failed = true;
    };
    const failTyped: FailFn = (at, text, kind) => failUnique(typedSeen, at, text, kind);
    const info = typeOfExport(ts, dtsChecker, ex.resolved);
    if (typed.length) {
      reportDocMeta(failTyped, typedItem, tmeta, TYPE_DOC_MSG);
    } else {
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
        const inline =
          member.inline || sourceInline(srcIndex, memberItem.dtsFile, memberItem.name, member.name);
        reportDocMeta(failTyped, memberItem, member, memberDocMsg(member.name), () => {
          if (hasDocText(member) && inline) {
            failTyped(
              memberItem,
              `member ${member.name} must not mix JSDoc with inline comment`,
              'member'
            );
          }
        });
        if (!hasDocText(member)) continue;
        const memberTags = paramTagRows(member.tags);
        const memberRet = returnTag(member.tags, true);
        const viaRef = member.ref?.hasDocs && !memberTags.length && !memberRet;
        if (!viaRef) {
          reportParamDocs(
            failTyped,
            memberItem,
            member.info.params,
            member.tags,
            member.bagRefs,
            member.name
          );
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
        if (!examples[i].code) continue;
        const msg = await tryExample(examples[i].code, item, ctx, ts, {
          checkTypes: checkExampleTypes,
          runCode: opts.runCode,
        });
        if (!msg) continue;
        fail(item, `example ${i + 1}: ${msg}`, item.runtime ? 'exec' : 'type');
      }
    }
    if (!failed) out.passed += 1;
  }
  reportIssues('tsdoc', log, out, colorOn, 'JSDoc check found issues', 'fail');
};

export const __TEST: TestApi = {
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
