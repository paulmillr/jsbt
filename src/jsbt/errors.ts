#!/usr/bin/env -S node --experimental-strip-types
/**
Checks public examples for runtime validation quality.
Goal:
  - use TSDoc examples as real valid setup programs
  - replay public calls from those examples with wrong runtime types
  - catch validators that return false instead of throwing on type errors
  - print raw rejection evidence, and warn on mutation, aliasing, or value leakage
Rules:
  - this is standalone/manual-audit focused and is not part of default `jsbt check`
  - examples are the source of valid semantic inputs; no errors.json fixture is used
  - mutation and alias findings are warnings because some APIs intentionally document them
  - accepted wrong runtime types print as NO ERROR! audit rows and still count as failures
  - error messages must not print secret byte values
 */
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, resolve } from 'node:path';
import { publicCtx, publicEntries, type PublicCtx } from './public.ts';
import {
  cliArgs,
  color,
  docCommentLines,
  emptyResult,
  fileUrl,
  ident,
  lineIndex,
  loadTypeScriptApi,
  nodeStart,
  nodeText,
  readText,
  relName,
  recordIssue,
  runWorker,
  runSelf,
  printIssues,
  paint,
  status,
  summary,
  tsSourceRel,
  usageText,
  walkAst,
  withTempFile,
  type Issue as LogIssue,
  type Level,
} from './utils.ts';

type TsLike = {
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: Record<string, number>;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => any;
  forEachChild: (node: any, cb: (node: any) => void) => void;
  isCallExpression: (node: any) => boolean;
  isElementAccessExpression?: (node: any) => boolean;
  isFunctionTypeNode?: (node: any) => boolean;
  isIdentifier: (node: any) => boolean;
  isImportDeclaration: (node: any) => boolean;
  isClassDeclaration?: (node: any) => boolean;
  isConstructorDeclaration?: (node: any) => boolean;
  isInterfaceDeclaration?: (node: any) => boolean;
  isMethodDeclaration?: (node: any) => boolean;
  isMethodSignature?: (node: any) => boolean;
  isNamedImports?: (node: any) => boolean;
  isNewExpression?: (node: any) => boolean;
  isNamespaceImport?: (node: any) => boolean;
  isParenthesizedTypeNode?: (node: any) => boolean;
  isPropertyAccessExpression: (node: any) => boolean;
  isPropertySignature?: (node: any) => boolean;
  isStringLiteral?: (node: any) => boolean;
  isTypeAliasDeclaration?: (node: any) => boolean;
  isTypeLiteralNode?: (node: any) => boolean;
  isVariableDeclaration?: (node: any) => boolean;
};
type PublicSource = { file: string; url: string };
type RuntimeEntry = PublicSource & { spec: string };
type Param = { name: string; optional: boolean };
type Owner = { callable: boolean; generic?: boolean; name: string; params: Param[] };
type Example = {
  code: string;
  docs: string;
  file: string;
  line: number;
  owner?: Owner;
  url: string;
};
type Call = {
  args: string[];
  argNames: string[];
  deep: boolean[];
  end: number;
  line: number;
  member?: string;
  missing: boolean[];
  name: string;
  needsImport?: boolean;
  newExpr?: boolean;
  ownerCall?: boolean;
  ownerName?: string;
  probe: boolean[];
  self?: string;
  start: number;
  text: string;
};
type CallArgs = { argNames: string[]; generic: boolean; missing: boolean[]; probe: boolean[] };
type Owners = Map<string, Owner>;
type Methods = Map<string, Param[]>;
type MethodMeta = { classes: Set<string>; params: Methods; private: Set<string> };
type Work = Example & { calls: Call[]; methods: MethodMeta };
type ProbeIssue = { call: string; detail: string; kind: string; level: Level; line: number };
type ProbeReject = {
  accepted?: boolean;
  call: string;
  label: string;
  line: number;
  message: string;
  probe: string;
};
type Probe = { error?: string; issues: ProbeIssue[]; probed: number; rejects?: ProbeReject[] };
type Audit = ProbeReject & { file: string };
type TestApi = {
  harnessCode: typeof harnessCode;
  harness: typeof harness;
  loadTs: typeof loadTs;
  publicCtx: typeof publicCtx;
  runtimeEntries: typeof runtimeEntries;
  specMap: typeof specMap;
  workRows: typeof workRows;
};

const usage = usageText('errors', 'check-errors.ts');

const TIMEOUT = 120_000;
const MAX_PROBES_PER_ARG = 12;
const PROBE_LIMIT = Math.max(1, Math.min(availableParallelism?.() || 4, 16));
const loadTs = (pkgFile: string): TsLike => {
  return loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript compiler API', ['createSourceFile']);
};
const sourceFile = (cwd: string, jsRel: string): string => {
  const tsRel = tsSourceRel(jsRel);
  const src = resolve(cwd, 'src', tsRel);
  if (existsSync(src)) return src;
  return resolve(cwd, tsRel);
};
const runtimeUrl = (cwd: string, jsRel: string): string => {
  const js = resolve(cwd, jsRel);
  return fileUrl(existsSync(js) ? js : sourceFile(cwd, jsRel));
};
const runtimeEntries = (ctx: PublicCtx): RuntimeEntry[] =>
  publicEntries(ctx).map(({ jsRel, spec }) => ({
    file: sourceFile(ctx.cwd, jsRel),
    spec,
    url: runtimeUrl(ctx.cwd, jsRel),
  }));
// Noble packages use underscore names for private API; probing those makes audit output noisy.
const privateName = (name: string): boolean => name.startsWith('_');
const publicName = (name: string): boolean => ident(name) && !privateName(name);
const BUILTIN_CHAIN = new Set([
  'catch',
  'every',
  'filter',
  'finally',
  'find',
  'findIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'then',
]);
const publicSources = (entries: RuntimeEntry[]): PublicSource[] => {
  const out = new Map<string, PublicSource>();
  for (const item of entries)
    if (existsSync(item.file) && !privateName(basename(item.file))) out.set(item.file, item);
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file));
};
const specMap = (entries: RuntimeEntry[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const item of entries) out.set(item.spec, item.url);
  return out;
};
const rewriteImports = (specs: Map<string, string>, code: string): string => {
  return code.replace(
    /(\bfrom\s*['"]|\bimport\s*\(\s*['"])([^'"]+)(['"])/g,
    (all, head: string, spec: string, tail: string) => {
      const next = specs.get(spec);
      return next ? head + next + tail : all;
    }
  );
};
const cleanDoc = (raw: string): string => docCommentLines(raw, false).join('\n');
const paramDocs = (docs: string): Param[] => {
  const out: Param[] = [];
  for (const match of docs.matchAll(/@param\s+(?:\{[^}]*\}\s*)?([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (!out.some((param) => param.name === name)) out.push({ name, optional: false });
  }
  return out;
};
const splitParams = (raw: string): Param[] =>
  raw
    .split(',')
    .map((part) => {
      const optional =
        /^\s*\.\.\./.test(part) || /=/.test(part) || /^[\s.]*[A-Za-z_$][\w$]*\?/.test(part);
      const name = part
        .replace(/=.*$/s, '')
        .replace(/^\s*\.\.\./, '')
        .replace(/[:?].*$/s, '')
        .trim();
      return { name, optional };
    })
    .filter((param) => ident(param.name));
const skipDocGap = (raw: string): string => {
  let text = raw;
  for (;;) {
    const next = text
      .replace(/^\s+/, '')
      .replace(/^\/\/[^\n]*(?:\n|$)/, '')
      .replace(/^\/\*(?!\*)[\s\S]*?\*\//, '');
    if (next === text) return text;
    text = next;
  }
};
const exportedLocals = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of match[1].split(',')) {
      const part = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      const name = (part[0] || '').trim();
      const pub = (part[1] || name).trim();
      if (publicName(name) && publicName(pub)) out.set(name, pub);
    }
  }
  return out;
};
const ownerMatch = (
  exported: Map<string, string>,
  match: RegExpMatchArray,
  params: Param[],
  callable = true,
  generic = false
): Owner | undefined => {
  const local = match[2];
  const name = match[1] ? local : exported.get(local);
  return name && publicName(local) && publicName(name)
    ? { callable, generic, name, params }
    : undefined;
};
const paramList = (parsed: Param[], docs: Param[]): Param[] => (parsed.length ? parsed : docs);
const constParams = (next: string): Param[] | undefined => {
  const head = next.match(/^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*/);
  if (!head) return undefined;
  let quote = '';
  let block = false;
  let line = false;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let init = '';
  // Stay inside this declaration; a broad type-annotation regex can cross into later type aliases.
  for (let i = head[0].length; i < Math.min(next.length, 1200); i++) {
    const ch = next[i];
    const after = next[i + 1];
    if (line) {
      if (ch === '\n') line = false;
      continue;
    }
    if (block) {
      if (ch === '*' && after === '/') {
        block = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && after === '/') {
      line = true;
      i++;
      continue;
    }
    if (ch === '/' && after === '*') {
      block = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (!paren && !brace && !bracket && ch === '=' && after !== '>') {
      init = next.slice(i + 1, i + 601);
      break;
    }
  }
  if (!init) return undefined;
  const body = init.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '');
  // Parenthesized arrow IIFEs export their return value, not the arrow itself.
  if (/^\(\s*\(/.test(body)) return undefined;
  const arrow = '(?:\\(([^)]*)\\)\\s*=>|([A-Za-z_$][\\w$]*)\\s*=>)';
  const direct = body.match(
    new RegExp(
      '^\\s*(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)*(?:async\\s+)?' +
        `(?:${arrow}|function\\s*\\(([^)]*)\\))`
    )
  );
  return direct ? splitParams(direct[1] || direct[2] || direct[3] || '') : undefined;
};
const ownerInfo = (
  text: string,
  pos: number,
  docs: string,
  exported: Map<string, string>
): Owner | undefined => {
  // Some repos keep implementation notes between TSDoc and export; the example still documents it.
  const next = skipDocGap(text.slice(pos, pos + 4000));
  const params = paramDocs(docs);
  const fn = next.match(
    /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(<[\s\S]*?>)?\s*\(([^)]*)\)/
  );
  if (fn) {
    const parsed = splitParams(fn[4]);
    return ownerMatch(exported, fn, paramList(parsed, params), true, !!fn[3]);
  }
  const cls = next.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (cls) return ownerMatch(exported, cls, params);
  const typ = next.match(/^\s*(export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/);
  if (typ) return ownerMatch(exported, typ, params, !!params.length);
  const cnst = next.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (!cnst) return undefined;
  const parsed = constParams(next);
  return ownerMatch(
    exported,
    cnst,
    parsed?.length ? parsed : params,
    parsed !== undefined || !!params.length
  );
};
const exampleRows = (src: PublicSource): Example[] => {
  const { file, url } = src;
  const text = readText(file);
  const index = lineIndex(text);
  const exported = exportedLocals(text);
  const out: Example[] = [];
  for (const match of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const raw = match[0];
    if (!/@example\b/.test(raw)) continue;
    const docs = cleanDoc(raw);
    const owner = ownerInfo(text, (match.index || 0) + raw.length, docs, exported);
    if (!owner) continue;
    const blocks = [...docs.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)];
    for (const block of blocks) {
      const code = (block[1] || '').trim();
      if (!code) continue;
      out.push({
        code,
        docs,
        file,
        line: index.lineOf((match.index || 0) + raw.indexOf(block[0])) + 1,
        owner,
        url,
      });
    }
  }
  return out;
};
const importedNames = (ts: TsLike, sf: any, pkg: string): Set<string> => {
  const names = new Set<string>();
  for (const stmt of sf.statements || []) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = nodeText(stmt.moduleSpecifier);
    if (spec !== pkg && !spec.startsWith(pkg + '/')) continue;
    const sub = spec.startsWith(pkg + '/') ? spec.slice(pkg.length + 1) : '';
    if (sub && privateName(basename(sub))) continue;
    const clause = stmt.importClause;
    if (clause?.name?.text && publicName(clause.name.text)) names.add(clause.name.text);
    const named = clause?.namedBindings;
    // Default-only imports have no namedBindings; TS predicate helpers can throw on undefined.
    if (named && ts.isNamespaceImport?.(named) && publicName(named.name?.text || ''))
      names.add(named.name.text);
    if (named && ts.isNamedImports?.(named)) {
      for (const el of named.elements || []) {
        const local = el.name?.text || '';
        const imported = el.propertyName?.text || local;
        if (publicName(local) && publicName(imported)) names.add(local);
      }
    }
  }
  return names;
};
const rootName = (ts: TsLike, node: any): string => {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text || '';
  const base = memberBase(ts, node);
  if (base) return rootName(ts, base);
  return '';
};
const memberExpr = (ts: TsLike, node: any): boolean =>
  ts.isPropertyAccessExpression(node) || !!ts.isElementAccessExpression?.(node);
const memberBase = (ts: TsLike, node: any): any | undefined =>
  memberExpr(ts, node) ? node.expression : undefined;
const propName = (ts: TsLike, node: any, literalOnly = false): string => {
  if (ts.isPropertyAccessExpression(node)) return node.name?.text || '';
  if (!ts.isElementAccessExpression?.(node)) return '';
  const arg = node.argumentExpression;
  if (literalOnly && !ts.isStringLiteral?.(arg)) return '';
  return literalOnly ? arg.text || '' : arg?.getText?.() || '';
};
const finalName = (ts: TsLike, node: any): string => {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text || '';
  return propName(ts, node);
};
const publicRoot = (root: string, imports: Set<string>, implicit: string): boolean =>
  !privateName(root) && (imports.has(root) || (!!implicit && root === implicit));
const publicExpr = (ts: TsLike, node: any, imports: Set<string>, implicit: string): boolean => {
  if (!node) return false;
  return publicRoot(rootName(ts, callTarget(ts, node)), imports, implicit);
};
const callTarget = (ts: TsLike, node: any): any =>
  ts.isCallExpression(node) || ts.isNewExpression?.(node) ? node.expression : node;
const selfName = (ts: TsLike, node: any, sf: any): string | undefined => {
  const base = memberBase(ts, node);
  return base ? base.getText(sf) : undefined;
};
const memberName = (ts: TsLike, node: any): string | undefined => {
  return propName(ts, node, true) || undefined;
};
const memberPath = (ts: TsLike, node: any): string => {
  const out: string[] = [];
  let cur = node;
  while (memberExpr(ts, cur)) {
    const name = propName(ts, cur, true);
    if (!name) return '';
    out.push(name);
    cur = memberBase(ts, cur);
  }
  return out.reverse().join('.');
};
const INTERNAL_LABEL = /^(?:error)?title$|^label$/i;
const probeParam = (param: Param): boolean =>
  !privateName(param.name) && !INTERNAL_LABEL.test(param.name);
const deepArg = (arg: string, name: string, generic: boolean): boolean =>
  !generic &&
  (/^\s*[{[]/.test(arg) || /\b(?:opts?|options?|params?|config|settings)\b/i.test(name || arg));
const argsMeta = (params: Param[], args: string[], generic = false): CallArgs => {
  if (params.length) {
    return {
      argNames: params.map((param) => param.name),
      generic,
      missing: params.map((param) => param.optional),
      probe: params.map(probeParam),
    };
  }
  return {
    argNames: args.map((_, i) => 'arg' + i),
    generic: false,
    missing: args.map(() => false),
    probe: args.map(() => true),
  };
};
const propMemberName = (ts: TsLike, node: any): string => {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteral?.(node)) return node.text || '';
  return '';
};
const astParams = (sf: any, params: any[] = []): Param[] => {
  const out: Param[] = [];
  for (const param of params) {
    const name = param.name?.getText?.(sf) || '';
    if (!ident(name)) continue;
    out.push({
      name,
      optional: !!param.questionToken || !!param.initializer || !!param.dotDotDotToken,
    });
  }
  return out;
};
const addMethod = (out: Methods, path: string, params: Param[]): void => {
  if (!path || !params.length) return;
  // Variable method calls fall back to short names like `encrypt`, so a
  // one-arg method seen first must not hide later optional output-buffer args.
  const add = (key: string) => {
    const prev = out.get(key);
    if (!prev || params.length > prev.length) out.set(key, params);
  };
  add(path);
  const idx = path.lastIndexOf('.');
  if (idx >= 0) {
    const short = path.slice(idx + 1);
    add(short);
  }
};
const privateMember = (ts: TsLike, member: any, name: string): boolean =>
  privateName(name) ||
  member.name?.kind === ts.SyntaxKind.PrivateIdentifier ||
  (member.modifiers || []).some((mod: any) => mod.kind === ts.SyntaxKind.PrivateKeyword);
const methodParams = (ts: TsLike, sources: PublicSource[]): MethodMeta => {
  const out: Methods = new Map();
  const hidden = new Set<string>();
  const hiddenClasses = new Set<string>();
  const readType = (sf: any, node: any, path = ''): void => {
    if (!node) return;
    if (ts.isParenthesizedTypeNode?.(node)) return readType(sf, node.type, path);
    if (ts.isFunctionTypeNode?.(node)) return addMethod(out, path, astParams(sf, node.parameters));
    if (ts.isTypeLiteralNode?.(node)) return readMembers(sf, node.members || [], path);
    if (Array.isArray(node.types)) for (const item of node.types) readType(sf, item, path);
  };
  const readMembers = (sf: any, members: any[] = [], prefix = ''): void => {
    for (const member of members) {
      const name = propMemberName(ts, member.name);
      if (!publicName(name)) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (ts.isMethodSignature?.(member)) addMethod(out, path, astParams(sf, member.parameters));
      else if (ts.isPropertySignature?.(member)) readType(sf, member.type, path);
    }
  };
  const readClass = (sf: any, node: any): void => {
    const cls = propMemberName(ts, node.name);
    if (privateName(cls)) {
      hiddenClasses.add(cls);
      return;
    }
    if (!publicName(cls)) return;
    for (const member of node.members || []) {
      if (ts.isConstructorDeclaration?.(member)) continue;
      const name = propMemberName(ts, member.name);
      if (!name) continue;
      const path = `${cls}.${name}`;
      if (privateMember(ts, member, name)) {
        hidden.add(path);
        continue;
      }
      if (ts.isMethodDeclaration?.(member)) addMethod(out, path, astParams(sf, member.parameters));
    }
  };
  for (const src of sources) {
    const sf = ts.createSourceFile(src.file, readText(src.file), ts.ScriptTarget.ESNext, true);
    walkAst(ts, sf, (node: any) => {
      if (ts.isClassDeclaration?.(node)) {
        readClass(sf, node);
        return false;
      }
      if (ts.isInterfaceDeclaration?.(node)) {
        readMembers(sf, node.members || []);
        return false;
      }
      if (ts.isTypeAliasDeclaration?.(node)) {
        readType(sf, node.type);
        return false;
      }
      return true;
    });
  }
  return { classes: hiddenClasses, params: out, private: hidden };
};
const requiredParams = (params: Param[]): number => {
  let out = 0;
  for (let i = 0; i < params.length; i++) if (!params[i].optional) out = i + 1;
  return out;
};
const methodParamInfo = (
  methods: Methods
): Record<string, { names: string[]; required: number }> => {
  const out: Record<string, { names: string[]; required: number }> = {};
  for (const [key, params] of methods)
    out[key] = { names: params.map((param) => param.name), required: requiredParams(params) };
  return out;
};
const callArgs = (
  ownerMap: Owners,
  methods: MethodMeta,
  ex: Example,
  last: string,
  direct: boolean,
  methodPath: string,
  args: string[]
): CallArgs => {
  if (direct && ex.owner && last === ex.owner.name)
    return argsMeta(ex.owner.params, args, !!ex.owner.generic);
  if (direct) {
    const owner = ownerMap.get(last);
    if (owner) return argsMeta(owner.params, args, !!owner.generic);
  }
  const methodParams = methodPath
    ? methods.params.get(methodPath) || methods.params.get(last)
    : undefined;
  if (methodParams) return argsMeta(methodParams, args);
  return {
    argNames: args.map((_, i) => 'arg' + i),
    generic: false,
    missing: args.map(() => false),
    probe: args.map(() => true),
  };
};
const calls = (
  ts: TsLike,
  ex: Example,
  pkg: string,
  ownerMap: Owners,
  methods: MethodMeta
): Call[] => {
  const sf = ts.createSourceFile('example.ts', ex.code, ts.ScriptTarget.ESNext, true);
  const imports = importedNames(ts, sf, pkg);
  const implicit = !imports.size && ex.owner ? ex.owner.name : '';
  const out: Call[] = [];
  const publicVars = new Set<string>();
  const publicVarOwners = new Map<string, string>();
  const seen = new Set<string>();
  const privateMethodCall = (root: string, last: string, methodPath: string): boolean => {
    if (privateName(last)) return true;
    if (!methodPath) return false;
    if (methods.private.has(methodPath)) return true;
    const owner = publicVarOwners.get(root);
    return !!owner && methods.private.has(`${owner}.${last}`);
  };
  const publicMethod = (expr: any): boolean => {
    const self = memberBase(ts, expr);
    if (!self) return false;
    const root = rootName(ts, self);
    return publicVars.has(root) || publicExpr(ts, self, imports, implicit);
  };
  const add = (node: any, expr: any, argsRaw: any, newExpr = false): boolean => {
    const args = [...(argsRaw || [])].map((arg: any) => arg.getText(sf));
    const root = rootName(ts, expr);
    const text = node.getText(sf);
    const method = !newExpr && publicMethod(expr);
    const directNeedsImport = !!implicit && root === implicit;
    const needsImport = directNeedsImport || (!!implicit && method);
    if ((!imports.has(root) && !needsImport && !method) || seen.has(text)) return false;
    const last = finalName(ts, expr);
    if (privateName(root) || privateName(last)) return false;
    const direct = imports.has(root) || directNeedsImport;
    const methodPath = method ? memberPath(ts, expr) : '';
    const methodSelf = method ? memberBase(ts, expr) : undefined;
    if (method && BUILTIN_CHAIN.has(last)) {
      // Promise/Array chains are plumbing around API results; probe the producer, not callbacks.
      if (ts.isCallExpression?.(methodSelf))
        add(methodSelf, methodSelf.expression, methodSelf.arguments);
      return true;
    }
    if (method && privateMethodCall(root, last, methodPath)) return false;
    const { argNames, generic, missing, probe } = callArgs(
      ownerMap,
      methods,
      ex,
      last,
      direct,
      methodPath,
      args
    );
    // Zero-arg public factories can still expose returned methods that need probing.
    if (!args.length && !argNames.length && !(direct && ex.owner && last === ex.owner.name))
      return false;
    seen.add(text);
    const start = nodeStart(sf, node);
    const pos = sf.getLineAndCharacterOfPosition(start);
    const self = newExpr ? undefined : selfName(ts, expr, sf);
    const ownerName =
      method && self
        ? publicVarOwners.get(root) ||
          (direct
            ? root
            : publicExpr(ts, methodSelf, imports, implicit)
              ? callTarget(ts, methodSelf).getText(sf)
              : undefined)
        : undefined;
    const ownerCall =
      !!ex.owner &&
      ((last === ex.owner.name && direct) ||
        (!!method &&
          !!self &&
          (self === ex.owner.name ||
            self.startsWith(ex.owner.name + '(') ||
            ownerName === ex.owner.name ||
            ownerName?.endsWith('.' + ex.owner.name))));
    const displayOwner = method && self && publicVars.has(root) ? root : ownerName;
    const name =
      method && displayOwner && methodPath
        ? `${displayOwner}.${methodPath}`
        : method && displayOwner && last
          ? `${displayOwner}.${last}`
          : expr.getText(sf);
    out.push({
      args,
      argNames,
      deep: args.map((arg, idx) => deepArg(arg, argNames[idx], generic)),
      end: node.getEnd(),
      line: ex.line + pos.line,
      member: method ? memberName(ts, expr) : undefined,
      missing,
      name,
      needsImport,
      newExpr,
      ownerCall,
      ownerName,
      probe,
      self,
      start,
      text,
    });
    return true;
  };
  walkAst(ts, sf, (node: any) => {
    if (ts.isVariableDeclaration?.(node) && ts.isIdentifier(node.name)) {
      if (publicExpr(ts, node.initializer, imports, implicit)) {
        publicVars.add(node.name.text);
        publicVarOwners.set(node.name.text, callTarget(ts, node.initializer).getText(sf));
      }
    }
    if (ts.isCallExpression(node) && add(node, node.expression, node.arguments)) return false;
    if (ts.isNewExpression?.(node) && add(node, node.expression, node.arguments, true))
      return false;
    return true;
  });
  return out;
};
const ownerMap = (rows: Example[]): Owners => {
  const out: Owners = new Map();
  for (const item of rows) if (item.owner) out.set(item.owner.name, item.owner);
  return out;
};
const workRows = (ctx: PublicCtx, ts: TsLike, entries: RuntimeEntry[]): Work[] => {
  const sources = publicSources(entries);
  const rows = sources.flatMap((file) => exampleRows(file));
  const owners = ownerMap(rows);
  const methods = methodParams(ts, sources);
  return rows.map((ex) => ({
    ...ex,
    calls: calls(ts, ex, ctx.pkg.name, owners, methods),
    methods,
  }));
};
const q = JSON.stringify;
const instrumentedCode = (work: Work): string => {
  const chunks = work.calls
    .map((call, i) => ({
      end: call.end,
      start: call.start,
      text: call.newExpr
        ? `__jsbtNew(${i}, ${call.name}, [${call.args.join(', ')}])`
        : call.member && call.self
          ? [
              `__jsbtMethod(${i}, () => (${call.self}),`,
              `${q(call.member)}, [${call.args.join(', ')}])`,
            ].join(' ')
          : [
              `__jsbtCall(${i}, ${call.name}, ${call.self || 'undefined'},`,
              `[${call.args.join(', ')}])`,
            ].join(' '),
    }))
    .sort((a, b) => b.start - a.start);
  let out = work.code;
  for (const chunk of chunks) out = out.slice(0, chunk.start) + chunk.text + out.slice(chunk.end);
  return out;
};
const harnessCode = (specs: Map<string, string>, work: Work): string => {
  let code = rewriteImports(specs, instrumentedCode(work));
  if (work.owner && work.calls.some((call) => call.needsImport)) {
    // TSDoc examples can omit imports for the documented public symbol; inject only that symbol.
    code = `import { ${work.owner.name} } from ${q(work.url)};\n${code}`;
  }
  return code;
};
const harness = (work: Work, code: string): string => {
  const cases = work.calls.map((call) => ({
    argNames: call.argNames,
    autoRet: true,
    deep: call.deep,
    line: call.line,
    missing: call.missing,
    name: call.name,
    ownerName: call.ownerName,
    probe: call.probe,
  }));
  return `
const __jsbtCases = [
${cases
  .map(
    (item) => `  {
    argNames: ${q(item.argNames)},
    autoRet: ${item.autoRet},
    deep: ${q(item.deep)},
    line: ${item.line},
    missing: ${q(item.missing)},
    name: ${q(item.name)},
    ownerName: ${q(item.ownerName)},
    probe: ${q(item.probe)}
  }`
  )
  .join(',\n')}
];
const __jsbtMethodParams = ${q(methodParamInfo(work.methods.params))};
const __jsbtPrivateClasses = new Set(${q([...work.methods.classes])});
const __jsbtPrivateMethods = new Set(${q([...work.methods.private])});
const __jsbtPrivateName = (name) => typeof name === 'string' && name.startsWith('_');
const __jsbtIdent = (name) => /^[A-Za-z_$][\\w$]*$/.test(name || '');
const __jsbtMaxRetMethods = 64;
const __jsbtRecords = [];
const __jsbtHex = (b) => Array.from(b, (i) => i.toString(16).padStart(2, '0')).join('');
const __jsbtIsBytes = (v) => v instanceof Uint8Array;
const __jsbtPlain = (v) =>
  !!v &&
  typeof v === 'object' &&
  !ArrayBuffer.isView(v) &&
  !(v instanceof ArrayBuffer) &&
  Object.getPrototypeOf(v) === Object.prototype;
const __jsbtChildren = (value) => {
  if (Array.isArray(value)) return value.map((val, key) => [key, val]);
  if (__jsbtPlain(value)) return Object.entries(value);
  return [];
};
const __jsbtTextPath = (path, key) =>
  typeof key === 'number' ? path + '[' + key + ']' : path ? path + '.' + key : key;
const __jsbtMark = (value, seen) => {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
};
const __jsbtBytes = (value, path = '', out = [], seen = new WeakSet()) => {
  if (value && typeof value === 'object' && !__jsbtMark(value, seen)) return out;
  if (__jsbtIsBytes(value)) {
    out.push({ path, value, hex: __jsbtHex(value), dec: Array.from(value).join(',') });
  } else {
    for (const [key, val] of __jsbtChildren(value))
      __jsbtBytes(val, __jsbtTextPath(path, key), out, seen);
  }
  return out;
};
const __jsbtRecord = (idx, args, props) => {
  const item = __jsbtCases[idx];
  const rec = {
    ...item,
    args,
    before: __jsbtBytes(args, 'arg').map((ref) => ({ ...ref })),
    ...props,
  };
  __jsbtRecords.push(rec);
  return rec;
};
const __jsbtSave = (rec, run, awaitable = true) => {
  try {
    const ret = run();
    rec.ret = ret;
    if (awaitable && ret && typeof ret.then === 'function')
      return ret.then((value) => (rec.ret = value));
    return ret;
  } catch (error) {
    rec.error = error;
    throw error;
  }
};
const __jsbtCall = (idx, fn, self, args) => {
  return __jsbtSave(__jsbtRecord(idx, args, { fn, self }), () => fn.apply(self, args));
};
const __jsbtNew = (idx, fn, args) => {
  return __jsbtSave(__jsbtRecord(idx, args, { fn, newExpr: true }), () => new fn(...args), false);
};
const __jsbtMethod = (idx, getSelf, member, args) => {
  const self = getSelf();
  return __jsbtSave(
    __jsbtRecord(idx, args, { fn: self && self[member], getSelf, member, self }),
    () => self[member].apply(self, args)
  );
};
${code}
const __jsbtIssues = [];
const __jsbtRejects = [];
const __jsbtDocs = ${q(work.docs)};
const __jsbtDocRe = /\\b(alias|same|reuse|return(?:s|ed)? input|mutat|in place)\\b/i;
const __jsbtDocumented = __jsbtDocRe.test(__jsbtDocs);
const __jsbtClone = (v) => {
  if (__jsbtIsBytes(v)) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(__jsbtClone);
  if (__jsbtPlain(v))
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, __jsbtClone(val)]));
  return v;
};
const __jsbtSet = (root, path, value) => {
  if (!path.length) return value;
  const out = Array.isArray(root) ? root.slice() : { ...root };
  let cur = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const val = cur[key];
    cur[key] = Array.isArray(val) ? val.slice() : __jsbtPlain(val) ? { ...val } : {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
  return out;
};
const __jsbtWalk = (value, path = [], out = [], seen = new WeakSet(), deep = true) => {
  if (value && typeof value === 'object' && !__jsbtMark(value, seen)) return out;
  const add = (vals) => out.push({ path, vals });
  if (__jsbtIsBytes(value)) add([false, '__jsbt_wrong_string__', [1, 2, 3]]);
  else if (typeof value === 'boolean') add([0, 'true', null]);
  else if (typeof value === 'number') add([true, false, null, '1', value + 0.1]);
  else if (typeof value === 'string') add([false, 1, {}]);
  else if (typeof value === 'function') add([true, false, null]);
  else if (Array.isArray(value)) {
    add([false, {}, '__jsbt_wrong_array__']);
    const children = __jsbtChildren(value);
    if (deep && children.length)
      __jsbtWalk(children[0][1], path.concat(children[0][0]), out, seen, deep);
  } else if (__jsbtPlain(value)) {
    add([false, null, '__jsbt_wrong_object__']);
    if (deep) {
      for (const [key, val] of __jsbtChildren(value))
        __jsbtWalk(val, path.concat(key), out, seen, deep);
    }
  } else if (value && typeof value === 'object') {
    // Public key/signature point instances still need top-level runtime type probes.
    add([false, null, '__jsbt_wrong_string__', {}, [1, 2, 3]]);
  }
  return out;
};
const __jsbtChanged = (before, after, out = []) => {
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after.find((item) => item.value === a.value);
    if (b && a.hex !== b.hex) out.push(a.path || 'arg');
  }
  return out;
};
const __jsbtLeaks = (message, refs) =>
  refs.some(
    (ref) => ref.hex.length >= 16 && (message.includes(ref.hex) || message.includes(ref.dec))
  );
const __jsbtAlias = (value, refs, seen = new WeakSet()) => {
  if (__jsbtIsBytes(value) && refs.some((ref) => ref.value === value)) return true;
  if (!__jsbtMark(value, seen)) return false;
  for (const [, item] of __jsbtChildren(value)) if (__jsbtAlias(item, refs, seen)) return true;
  return false;
};
const __jsbtRetMethods = (
  value,
  path = [],
  out = [],
  seen = new WeakSet(),
  includeZero = false
) => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return out;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return out;
  if (seen.has(value) || path.length > 3 || out.length >= __jsbtMaxRetMethods) return out;
  seen.add(value);
  const local = [];
  const nested = [];
  const seenMethods = new Set();
  const scan = (obj, self, proto = false) => {
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key !== 'string' || key === 'constructor' || key.startsWith('_')) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || !('value' in desc)) continue;
      const next = path.concat(key);
      const val = desc.value;
      if (
        typeof val === 'function' &&
        !['apply', 'bind', 'call'].includes(key) &&
        // Returned API objects often expose constructors; new examples cover those explicitly.
        !/^class\\s/.test(Function.prototype.toString.call(val))
      ) {
        const id = next.join('.');
        if (seenMethods.has(id)) continue;
        seenMethods.add(id);
        local.push({ argc: Math.min(val.length, 4), fn: val, path: next, self });
      } else if (!proto && (__jsbtPlain(val) || Array.isArray(val))) {
        nested.push({ path: next, value: val });
      }
    }
  };
  scan(value, value);
  if (typeof value !== 'function') {
    let proto = Object.getPrototypeOf(value);
    for (let depth = 0; proto && depth < 6; depth++, proto = Object.getPrototypeOf(proto)) {
      if (proto === Object.prototype || proto === Array.prototype) break;
      scan(proto, value, true);
    }
  }
  // Large math/point/factory objects are too broad; keep documented methods when available.
  const methods =
    local.length > 8 ? local.filter((method) => __jsbtHasRetArgNames(method.path)) : local;
  if (local.length > 8 && !methods.length) return out;
  for (const method of methods) {
    if (includeZero || method.argc > 0) out.push(method);
    if (out.length >= __jsbtMaxRetMethods) return out;
  }
  for (const item of nested) {
    __jsbtRetMethods(item.value, item.path, out, seen, includeZero);
    if (out.length >= __jsbtMaxRetMethods) return out;
  }
  return out;
};
const __jsbtFnArgNames = (fn) => {
  if (typeof fn !== 'function') return [];
  const src = Function.prototype.toString
    .call(fn)
    .replace(/\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n\\r]*/g, '');
  const match =
    src.match(/^(?:async\\s+)?function(?:\\s+[A-Za-z_$][\\w$]*)?\\s*\\(([^)]*)\\)/) ||
    src.match(/^(?:async\\s+)?#?[A-Za-z_$][\\w$]*\\s*\\(([^)]*)\\)\\s*\\{/) ||
    src.match(/^(?:async\\s*)?\\(([^)]*)\\)\\s*=>/) ||
    src.match(/^(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>/);
  const raw = (match && match[1]) || '';
  const out = [];
  for (const part of raw.split(',')) {
    const name = part.replace(/=.*/, '').replace(/^\\.\\.\\./, '').trim();
    if (__jsbtIdent(name)) out.push(name);
  }
  return out;
};
// Returned methods are discovered at runtime; prefer actual names over short-name docs.
const __jsbtStaticParams = (path) => {
  const key = path.join('.');
  return __jsbtMethodParams[key] || __jsbtMethodParams[path[path.length - 1]];
};
const __jsbtArgNames = (fn, path, argc, fallback = []) => {
  // Runtime function names keep variable calls like cipher.encrypt() from
  // inheriting a same-named static helper signature from another API shape.
  const runtime = __jsbtFnArgNames(fn);
  const stat = __jsbtStaticParams(path);
  const statNames = stat && stat.names || [];
  const params =
    runtime.length && statNames.length && runtime.length > statNames.length
      ? runtime.slice(0, statNames.length)
      : runtime.length
        ? runtime
        : fallback.length
          ? fallback
          : statNames;
  return Array.from(
    { length: Math.max(Math.min(argc, params.length || argc), params.length) },
    (_, i) => params[i] || 'arg' + i
  );
};
const __jsbtHasRetArgNames = (path) => {
  return !!__jsbtStaticParams(path);
};
const __jsbtRequiredArgs = (path, argc) => {
  const stat = __jsbtStaticParams(path);
  return stat ? Math.min(argc, stat.required) : argc;
};
const __jsbtMessageArg = (name) =>
  /^(?:msg|message|messages|data|input|buf|bytes|plaintext|ciphertext)$/i.test(
    name || ''
  );
const __jsbtArgAliases = (name) => {
  const aliases = [name];
  const add = (...items) => {
    for (const item of items) if (item && !aliases.includes(item)) aliases.push(item);
  };
  if (name === 'msg') add('message', 'messageBytes', 'data');
  else if (name === 'message') add('msg', 'messageBytes', 'data');
  else if (name === 'messageBytes') add('message', 'msg');
  else if (name === 'sig') add('signature');
  else if (name === 'signature') add('sig');
  else if (name === 'pk') add('publicKey');
  else if (name === 'publicKey') add('pk', 'publicKeyB', 'uCoordinate');
  else if (name === 'publicKeyB' || name === 'uCoordinate') add('publicKey');
  else if (name === 'out' || name === 'dst' || name === 'output') add('out', 'dst', 'output');
  else if (name === 'plaintext' || name === 'ciphertext' || name === 'data')
    add('plaintext', 'ciphertext', 'data');
  return aliases;
};
const __jsbtKnownArg = Symbol('jsbt-known-arg');
const __jsbtKnownRow = (known, key) => {
  if (!key) return;
  const prev = known.get(key);
  if (prev) return prev;
  const row = new Map();
  known.set(key, row);
  return row;
};
const __jsbtAddKnown = (known, key, name, value) => {
  if (!name || __jsbtPrivateName(name) || value === undefined) return;
  const row = __jsbtKnownRow(known, key);
  if (!row) return;
  for (const alias of __jsbtArgAliases(name)) if (!row.has(alias)) row.set(alias, value);
};
const __jsbtRecordMethodPath = (item) => {
  const parts = String(item.name || item.member || '').split('.').filter(Boolean);
  const idx = parts.lastIndexOf(item.member);
  return (idx > 0 ? parts.slice(1, idx + 1) : [item.member]).filter(Boolean).join('.');
};
const __jsbtRecordKeys = (item) => {
  if (!item.member) return item.name ? [item.name] : [];
  const path = __jsbtRecordMethodPath(item);
  const keys = [];
  if (item.ownerName && path) keys.push(item.ownerName + '.' + path);
  if (item.name) keys.push(item.name);
  return keys;
};
const __jsbtKnownValue = (known, keys, name) => {
  for (const key of keys) {
    const row = known.get(key);
    if (!row) continue;
    for (const alias of __jsbtArgAliases(name)) if (row.has(alias)) return row.get(alias);
  }
  return __jsbtKnownArg;
};
const __jsbtKnownArgs = (records) => {
  const known = new Map();
  for (const item of records) {
    const args = item.args || [];
    const names = item.member
      ? __jsbtArgNames(item.fn, [item.member], args.length, item.argNames)
      : item.argNames || [];
    for (const key of ['*', ...__jsbtRecordKeys(item)])
      for (let i = 0; i < args.length; i++) __jsbtAddKnown(known, key, names[i], args[i]);
  }
  return known;
};
const __jsbtKnownMethodKeys = (item, method) => {
  const path = method.path.join('.');
  return item.name && path ? [item.name + '.' + path] : [];
};
const __jsbtKnownMethodArgs = (known, keys, names, len) =>
  Array.from({ length: Math.max(len, names.length) }, (_, i) =>
    __jsbtKnownValue(known, keys, names[i] || ('arg' + i))
  );
const __jsbtNameIdx = (names, re) => names.findIndex((name) => re.test(name || ''));
const __jsbtSuiteRecord = (suite, member) =>
  __jsbtRecords.find((rec) => rec.self === suite && rec.member === member && !rec.error);
const __jsbtFillSignerArgs = (known, method, names, base) => {
  const member = method.path[method.path.length - 1];
  if (member !== 'sign' && member !== 'verify') return base;
  const msgIdx = __jsbtNameIdx(names, /^(?:msg|message|messages)$/i);
  const secretIdx = __jsbtNameIdx(names, /^(?:secretKey|privateKey|sk)$/i);
  const sigIdx = member === 'verify' ? __jsbtNameIdx(names, /^(?:sig|signature)$/i) : -1;
  const keyIdx = member === 'verify' ? __jsbtNameIdx(names, /^(?:publicKey|pk|key)$/i) : -1;
  if (msgIdx < 0) return base;
  if (member === 'sign' && secretIdx < 0) return base;
  if (member === 'verify' && (sigIdx < 0 || keyIdx < 0)) return base;
  const suite = method.self;
  if (!suite) return base;
  const out = base.slice();
  const set = (idx, value) => {
    if (idx >= 0 && value !== undefined) out[idx] = value;
  };
  const exact = __jsbtSuiteRecord(suite, member);
  if (exact && exact.args.length) {
    if (member === 'sign') {
      set(msgIdx, exact.args[msgIdx]);
      set(secretIdx, exact.args[secretIdx]);
      return out;
    }
    set(sigIdx, exact.args[sigIdx]);
    set(msgIdx, exact.args[msgIdx]);
    set(keyIdx, exact.args[keyIdx]);
    return out;
  }
  if (typeof suite.keygen !== 'function') return base;
  const knownMsg =
    out[msgIdx] !== __jsbtKnownArg ? out[msgIdx] : __jsbtKnownValue(known, ['*'], names[msgIdx]);
  if (knownMsg === __jsbtKnownArg) return base;
  const candidates = [knownMsg];
  // BLS-like signer suites expose hash() to convert raw messages into the suite's point type.
  if (typeof suite.hash === 'function') {
    try {
      candidates.unshift(suite.hash(__jsbtClone(knownMsg)));
    } catch {}
  }
  for (const msg of candidates) {
    try {
      const keys = suite.keygen();
      const secretKey = keys && (keys.secretKey || keys.privateKey);
      const publicKey = keys && keys.publicKey;
      if (secretKey === undefined) continue;
      set(msgIdx, msg);
      if (member === 'sign') {
        set(secretIdx, secretKey);
        return out;
      }
      if (typeof suite.sign !== 'function' || publicKey === undefined) continue;
      const sig = suite.sign(__jsbtClone(msg), secretKey);
      set(sigIdx, sig);
      set(keyIdx, publicKey);
      return out;
    } catch {
      continue;
    }
  }
  return base;
};
const __jsbtCallableArgs = (item, method) => {
  const names = __jsbtArgNames(method.fn, method.path, method.argc);
  const byName = new Map(item.argNames.map((name, i) => [name, item.args[i]]));
  const out = [];
  let matched = false;
  for (const name of names) {
    if (__jsbtPrivateName(name)) return;
    if (byName.has(name)) {
      out.push(byName.get(name));
      matched = true;
    }
  }
  if (matched || !method.argc || names.length) return out;
  return item.args.filter((_, i) => !__jsbtMessageArg(item.argNames[i])).slice(0, method.argc);
};
const __jsbtPrivateRetMethod = (item, ret, path) => {
  const name = item.name + '.' + path.join('.');
  if (__jsbtPrivateMethods.has(name)) return true;
  const cls = ret && ret.constructor && ret.constructor.name;
  if (cls && __jsbtPrivateClasses.has(cls)) return true;
  return !!cls && __jsbtPrivateMethods.has(cls + '.' + path.join('.'));
};
const __jsbtMsg = (err) => err && typeof err.message === 'string' ? err.message : String(err);
const __jsbtSeen = new Set();
const __jsbtAdd = (level, kind, line, call, detail) => {
  const head = String(detail).split('\\n')[0];
  const key = level + '\\0' + kind + '\\0' + line + '\\0' + call + '\\0' + head;
  if (__jsbtSeen.has(key)) return;
  __jsbtSeen.add(key);
  __jsbtIssues.push({ call, detail, kind, level, line });
};
const __jsbtNoError = new Set();
const __jsbtAddAccepted = (item, label, probe) => {
  const name = __jsbtProbeName(probe);
  const key = item.line + '\\0' + item.name + '\\0' + label + '\\0' + name;
  if (__jsbtNoError.has(key)) return;
  __jsbtNoError.add(key);
  __jsbtRejects.push({
    accepted: true,
    call: item.name,
    label,
    line: item.line,
    message: 'NO ERROR!',
    probe: name,
  });
};
const __jsbtLabel = (arg, path) => path.length ? arg + '.' + path.join('.') : arg;
const __jsbtProbeName = (value) => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value === false) return 'false';
  if (value === true) return 'true';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isInteger(value)) return 'float';
    return String(value);
  }
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'function')
    return /^class\\s/.test(Function.prototype.toString.call(value)) ? 'class' : 'function';
  if (Array.isArray(value)) return 'array';
  if (__jsbtIsBytes(value)) return 'Uint8Array(len=' + value.length + ')';
  if (ArrayBuffer.isView(value))
    return (
      value.constructor.name +
      '(len=' +
      (value.length === undefined ? value.byteLength : value.length) +
      ')'
    );
  if (value instanceof ArrayBuffer) return 'ArrayBuffer(len=' + value.byteLength + ')';
  return value && value.constructor && value.constructor.name !== 'Object'
    ? value.constructor.name
    : 'object';
};
const __jsbtCheckMsg = (item, label, probe, err, refs) => {
  const message = __jsbtMsg(err);
  __jsbtRejects.push({
    call: item.name,
    label,
    line: item.line,
    message,
    probe: __jsbtProbeName(probe),
  });
  if (__jsbtLeaks(message, refs))
    __jsbtAdd(
      'ERROR',
      'leak',
      item.line,
      item.name,
      'error message exposes byte input value for ' + label
    );
};
const __jsbtExpectReject = async (item, label, refs, probe, run, awaitable = true) => {
  try {
    const ret = run();
    if (awaitable) await ret;
    __jsbtAddAccepted(item, label, probe);
  } catch (error) {
    __jsbtCheckMsg(item, label, probe, error, refs);
  }
};
const __jsbtProbeValues = async (item, label, refs, vals, run, awaitable = true) => {
  for (const value of vals)
    await __jsbtExpectReject(item, label, refs, value, () => run(value), awaitable);
};
const __jsbtPublicMissingArg = (name) =>
  __jsbtIdent(name) &&
  !__jsbtPrivateName(name) &&
  !/^arg\\d+$/.test(name) &&
  !/^unused(?:Arg)?$/i.test(name);
const __jsbtProducer = (value) =>
  __jsbtRecords.find(
    (rec) => rec.autoRet && rec.ret === value && typeof rec.fn === 'function'
  );
const __jsbtFreshValue = async (value) => {
  const rec = __jsbtProducer(value);
  if (!rec) return value;
  try {
    const args = rec.args.map(__jsbtClone);
    if (rec.member) {
      if (rec.self === value && typeof rec.getSelf === 'function') {
        const self = rec.getSelf();
        const fn = self && self[rec.member];
        return await fn.apply(self, args);
      }
      const self = await __jsbtFreshSelf(rec);
      const fn = self && self[rec.member];
      return await fn.apply(self, args);
    }
    return rec.newExpr ? new rec.fn(...args) : await rec.fn.apply(rec.self, args);
  } catch {
    return value;
  }
};
const __jsbtMethodAt = (value, path) => {
  let self = value;
  for (let i = 0; i < path.length - 1; i++) self = self && self[path[i]];
  const fn = self && self[path[path.length - 1]];
  return typeof fn === 'function' ? { fn, self } : undefined;
};
const __jsbtFreshMethod = async (method) => {
  // Stateful returned objects can be spent by the valid example before probes run.
  const fresh = await __jsbtFreshValue(method.self);
  return __jsbtMethodAt(fresh, method.path) || method;
};
const __jsbtFreshSelf = async (item) => {
  const fresh = await __jsbtFreshValue(item.self);
  if (fresh !== item.self) return fresh;
  // Inline chains such as hash.create().update() have no recorded factory value;
  // rerunning the self expression reconstructs the pre-finalized receiver.
  if (typeof item.getSelf === 'function') {
    try {
      return item.getSelf();
    } catch {}
  }
  return fresh;
};
const __jsbtMissing = () => [
  { path: [], vals: [false, '__jsbt_wrong_string__', {}, [1, 2, 3], null] },
];
// Keep nested option-object probing finite; large config objects multiply calls/noise.
const __jsbtMaxProbesPerArg = ${MAX_PROBES_PER_ARG};
let __jsbtProbed = 0;
const __jsbtProbeRet = async (item, ret, refs, known) => {
  for (const method of __jsbtRetMethods(ret)) {
    const name = item.name + '.' + method.path.join('.');
    if (__jsbtPrivateRetMethod(item, ret, method.path)) continue;
    const names = __jsbtArgNames(method.fn, method.path, method.argc);
    const required = __jsbtRequiredArgs(method.path, method.argc);
    const vals = __jsbtMissing()[0].vals;
    // Returned-surface probing may run before/without the direct method record for this owner.
    // Reuse valid example arguments by name so later params are not probed with earlier args
    // accidentally left undefined.
    const base = __jsbtFillSignerArgs(
      known,
      method,
      names,
      __jsbtKnownMethodArgs(
        known,
        __jsbtKnownMethodKeys(item, method),
        names,
        Math.max(required, names.length)
      )
    );
    let probed = false;
    for (let i = 0; i < base.length; i++) {
      if (__jsbtPrivateName(names[i])) continue;
      const complete = base.every(
        (value, j) =>
          j === i || j >= required || (!__jsbtPrivateName(names[j]) && value !== __jsbtKnownArg)
      );
      if (i > 0 && !complete) continue;
      probed = true;
      await __jsbtProbeValues({ ...item, name }, names[i], refs, vals, (value) => {
        const args = base.map((item) =>
          item === __jsbtKnownArg ? undefined : __jsbtClone(item)
        );
        args[i] = value;
        return __jsbtFreshMethod(method).then((fresh) => fresh.fn.apply(fresh.self, args));
      });
    }
    if (probed) __jsbtProbed++;
  }
};
const __jsbtProbeCallableOutputs = async (item, refs, known) => {
  for (const method of __jsbtRetMethods(item.fn, [], [], new WeakSet(), true)) {
    const name = item.name + '.' + method.path.join('.');
    if (__jsbtPrivateMethods.has(name)) continue;
    const args = __jsbtCallableArgs(item, method);
    if (!args) continue;
    try {
      const ret = await method.fn.apply(method.self, args);
      await __jsbtProbeRet({ ...item, name }, ret, refs, known);
    } catch {}
  }
};
const __jsbtRun = async (records) => {
  const known = __jsbtKnownArgs(records);
  for (const item of records) {
    const args = item.args;
    const argNames = item.member
      ? __jsbtArgNames(item.fn, [item.member], args.length, item.argNames)
      : item.argNames;
    let ret;
    const refs = __jsbtBytes(args, 'arg');
    const before = item.before || refs.map((ref) => ({ ...ref }));
    try {
      if (item.error) throw item.error;
      ret = await item.ret;
    } catch (error) {
      __jsbtAdd(
        'WARNING',
        'example',
        item.line,
        item.name,
        'cannot replay valid example call: ' + __jsbtMsg(error)
      );
      continue;
    }
    const changed = __jsbtChanged(before, __jsbtBytes(args, 'arg'));
    if (changed.length && !__jsbtDocumented)
      __jsbtAdd(
        'WARNING',
        'mutation',
        item.line,
        item.name,
        'valid call mutates input at ' +
          changed.join(', ') +
          '; document explicit mutation or copy input'
      );
    if (__jsbtAlias(ret, refs) && !__jsbtDocumented)
      __jsbtAdd(
        'WARNING',
        'alias',
        item.line,
        item.name,
        'return value aliases input; document returned-input aliasing or copy output'
      );
    let direct = false;
    for (let i = 0; i < Math.max(args.length, argNames.length); i++) {
      if (item.probe[i] === false) continue;
      const missing = i >= args.length;
      if (missing && !__jsbtPublicMissingArg(argNames[i])) continue;
      if (missing && !item.missing[i] && !item.member) continue;
      const probes = (
        missing ? __jsbtMissing() : __jsbtWalk(args[i], [], [], new WeakSet(), item.deep[i])
      ).slice(0, __jsbtMaxProbesPerArg);
      if (probes.length) direct = true;
      for (const probe of probes) {
        const label = __jsbtLabel(argNames[i] || ('arg' + i), probe.path);
        await __jsbtProbeValues(
          item,
          label,
        refs,
        probe.vals,
        (value) => {
          const next = args.slice();
          next[i] = missing ? value : __jsbtSet(__jsbtClone(args[i]), probe.path, value);
          if (!item.member)
            return item.newExpr ? new item.fn(...next) : item.fn.apply(item.self, next);
          return __jsbtFreshSelf(item).then((self) => {
            const fn = self && self[item.member];
            return fn.apply(self, next);
          });
        },
        !item.newExpr
      );
      }
    }
    if (direct) __jsbtProbed++;
    await __jsbtProbeCallableOutputs(item, refs, known);
    await __jsbtProbeRet(item, ret, refs, known);
  }
};
await __jsbtRun(__jsbtRecords);
export default { issues: __jsbtIssues, probed: __jsbtProbed, rejects: __jsbtRejects };
`;
};
const workerCode = `
import { parentPort, workerData } from 'node:worker_threads';
try {
  const mod = await import(workerData.file);
  parentPort.postMessage(mod.default || { issues: [], probed: 0 });
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
    issues: [],
    probed: 0,
    rejects: [],
  });
}
`;
type ProbeRun = { idx: number; item: Work; rel: string; res: Probe };
const probe = async (
  ctx: PublicCtx,
  specs: Map<string, string>,
  work: Work,
  timeoutMs: number
): Promise<Probe> => {
  return withTempFile(
    resolve(ctx.cwd, 'test', 'build'),
    { code: harness(work, harnessCode(specs, work)), ext: 'ts', prefix: '.__errors-check-' },
    async (file) => {
      // Keep each example in its own worker: package modules, globals, timers, and timeouts
      // must not leak from one public example probe into another.
      return await runWorker<Probe>(workerCode, {
        data: { file: fileUrl(file) },
        error: (error) => ({ error, issues: [], probed: 0, rejects: [] }),
        execArgv: ['--experimental-strip-types'],
        timeout: {
          ms: timeoutMs,
          result: () => ({
            error: `timed out after ${timeoutMs}ms`,
            issues: [],
            probed: 0,
            rejects: [],
          }),
        },
      });
    }
  );
};
const runProbeLimit = async (
  ctx: PublicCtx,
  specs: Map<string, string>,
  items: Work[],
  limit: number,
  timeoutMs: number
): Promise<ProbeRun[]> => {
  const out = new Array<ProbeRun>(items.length);
  let pos = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = pos++;
      if (idx >= items.length) return;
      const item = items[idx];
      out[idx] = {
        idx,
        item,
        rel: relName(ctx.cwd, item.file),
        res: await probe(ctx, specs, item, timeoutMs),
      };
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
};
const auditLines = (items: Audit[], colorOn: boolean): string[] => {
  const groups = new Map<string, { msg: string; name: string }[]>();
  for (const item of items) {
    const key = `wrong ${item.label}=${item.probe}`;
    const row = { msg: item.message, name: `${basename(item.file)}:${item.call}` };
    const prev = groups.get(key);
    if (prev) {
      if (!prev.some((old) => old.name === row.name && old.msg === row.msg)) prev.push(row);
    } else groups.set(key, [row]);
  }
  return [...groups.entries()].flatMap(([head, rows]) => {
    const width = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
    return [
      paint(head, color.green, colorOn),
      ...rows.map((row) => `- ${row.name.padEnd(width, ' ')}: ${row.msg}`),
    ];
  });
};
const printAudit = (items: Audit[], colorOn: boolean): void => {
  for (const line of auditLines(items, colorOn)) console.log(line);
};
const finish = (res: ReturnType<typeof emptyResult>, colorOn: boolean): void => {
  if (res.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(res)}`);
    throw new Error('Errors check found issues');
  }
  if (res.warnings) return console.error(`${status('warn', colorOn)} summary: ${summary(res)}`);
  console.log(`${status('pass', colorOn)} summary: ${summary(res)}`);
};

export const runCli = async (
  argv: string[],
  opts: {
    color?: boolean;
    cwd?: string;
    examplesOnly?: boolean;
    limit?: number;
    timeoutMs?: number;
  } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const ctx = publicCtx(args.pkgArg, opts.cwd);
  const ts = loadTs(ctx.pkgFile);
  const entries = runtimeEntries(ctx);
  const specs = specMap(entries);
  const rows = workRows(ctx, ts, entries);
  const items = rows.filter((item) => item.calls.length);
  const out = emptyResult();
  const logs: LogIssue[] = [];
  const audit: Audit[] = [];
  for (const item of rows) {
    if (item.calls.some((call) => call.ownerCall)) continue;
    if (!item.owner?.callable) continue;
    // Zero-argument ownerMap such as removed-alias stubs cannot produce wrong-argument probes.
    if (!item.owner.params.some(probeParam)) continue;
    recordIssue(
      out,
      logs,
      'WARNING',
      relName(ctx.cwd, item.file),
      `${item.line}/example`,
      'could not derive valid runtime probes from TSDoc example',
      'errors-example'
    );
  }
  if (!rows.length) {
    recordIssue(
      out,
      logs,
      'INFO',
      'package.json',
      'examples',
      'no public callable TSDoc examples found',
      'errors-example'
    );
  }
  if (opts.examplesOnly) {
    printIssues('errors', logs, colorOn);
    return finish(out, colorOn);
  }
  const runs = await runProbeLimit(
    ctx,
    specs,
    items,
    opts.limit || PROBE_LIMIT,
    opts.timeoutMs || TIMEOUT
  );
  for (const { item, rel, res } of runs) {
    if (res.error) {
      recordIssue(
        out,
        logs,
        'WARNING',
        rel,
        `${item.line}/example`,
        'example probe failed: ' + res.error,
        'example'
      );
      continue;
    }
    if (!res.issues.length) out.passed += res.probed || 1;
    for (const item of res.rejects || []) {
      audit.push({ ...item, file: rel });
      if (item.accepted) out.failures += 1;
    }
    for (const issue of res.issues) {
      recordIssue(
        out,
        logs,
        issue.level,
        rel,
        `${issue.line}/${issue.call}`,
        issue.detail,
        `errors-${issue.kind}`
      );
    }
  }
  printIssues('errors', logs, colorOn);
  printAudit(audit, colorOn);
  finish(out, colorOn);
};

export const __TEST: TestApi = {
  harnessCode,
  harness,
  loadTs,
  publicCtx,
  runtimeEntries,
  specMap,
  workRows,
};

runSelf(import.meta.url, runCli);
