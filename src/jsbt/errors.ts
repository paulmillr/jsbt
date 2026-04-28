#!/usr/bin/env -S node --experimental-strip-types
/**
Checks public examples for runtime validation quality.
Goal:
  - use TSDoc examples as real valid setup programs
  - replay public calls from those examples with wrong runtime types
  - catch validators that return false instead of throwing on type errors
  - warn on vague error messages, input mutation, returned-input aliasing, or value leakage
Rules:
  - this is standalone/manual-audit focused and is not part of default `jsbt check`
  - examples are the source of valid semantic inputs; no errors.json fixture is used
  - mutation and alias findings are warnings because some APIs intentionally document them
  - error messages must point at the argument/field and must not print secret byte values
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { rm, write } from '../fs-modify.ts';
import { jsPathOf, readPkg, type Pkg } from './public.ts';
import {
  bundled,
  groupIssues,
  guardChild,
  issueKind,
  status,
  summary,
  type Issue as LogIssue,
  type Level,
  type Result,
  wantColor,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type Ctx = { cwd: string; pkg: Pkg; pkgFile: string };
type TsLike = {
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: Record<string, number>;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => any;
  forEachChild: (node: any, cb: (node: any) => void) => void;
  isCallExpression: (node: any) => boolean;
  isElementAccessExpression?: (node: any) => boolean;
  isIdentifier: (node: any) => boolean;
  isImportDeclaration: (node: any) => boolean;
  isNamedImports?: (node: any) => boolean;
  isNewExpression?: (node: any) => boolean;
  isNamespaceImport?: (node: any) => boolean;
  isPropertyAccessExpression: (node: any) => boolean;
  isStringLiteral?: (node: any) => boolean;
  isVariableDeclaration?: (node: any) => boolean;
};
type PublicSource = { file: string; url: string };
type Param = { name: string; optional: boolean };
type Owner = { callable: boolean; name: string; params: Param[] };
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
  self?: string;
  start: number;
  text: string;
};
type Work = Example & { calls: Call[] };
type ProbeIssue = { call: string; detail: string; kind: string; level: Level; line: number };
type Probe = { error?: string; issues: ProbeIssue[]; probed: number };

const usage = `usage:
  jsbt errors <package.json>

examples:
  jsbt errors package.json
  node /path/to/check-errors.ts package.json`;

const TIMEOUT = 10_000;
const MAX_PROBES_PER_ARG = 12;
let nextId = 0;
const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const resolveCtx = (args: Args, cwd = process.cwd()): Ctx => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, args.pkgArg);
  guardChild(base, pkgFile, 'package');
  const root = dirname(pkgFile);
  return { cwd: root, pkg: readPkg(pkgFile), pkgFile };
};
const loadTs = (pkgFile: string): TsLike => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req('typescript') as TsLike | { default?: TsLike };
    } catch {
      return err(`missing typescript near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const ts = ('default' in raw && raw.default ? raw.default : raw) as TsLike;
  if (typeof ts.createSourceFile !== 'function')
    err(`expected TypeScript compiler API near ${pkgFile}`);
  return ts;
};
const sourceOf = (cwd: string, jsRel: string): string => {
  const tsRel = jsRel.replace(/\.(?:c|m)?js$/, '.ts').replace(/^\.\//, '');
  const src = resolve(cwd, 'src', tsRel);
  if (existsSync(src)) return src;
  return resolve(cwd, tsRel);
};
const runtimeUrl = (cwd: string, jsRel: string): string => {
  const js = resolve(cwd, jsRel);
  return pathToFileURL(existsSync(js) ? js : sourceOf(cwd, jsRel)).href;
};
const publicSources = (ctx: Ctx): PublicSource[] => {
  const out = new Map<string, PublicSource>();
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    if (!key.startsWith('.')) continue;
    const jsRel = jsPathOf(value);
    if (!jsRel) continue;
    const src = sourceOf(ctx.cwd, jsRel);
    if (existsSync(src)) out.set(src, { file: src, url: runtimeUrl(ctx.cwd, jsRel) });
  }
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file));
};
const specMap = (ctx: Ctx): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    if (!key.startsWith('.')) continue;
    const jsRel = jsPathOf(value);
    if (!jsRel) continue;
    const spec = key === '.' ? ctx.pkg.name : ctx.pkg.name + '/' + key.slice(2);
    out.set(spec, runtimeUrl(ctx.cwd, jsRel));
  }
  return out;
};
const rewriteImports = (ctx: Ctx, code: string): string => {
  const specs = specMap(ctx);
  return code.replace(
    /(\bfrom\s*['"]|\bimport\s*\(\s*['"])([^'"]+)(['"])/g,
    (all, head: string, spec: string, tail: string) => {
      const next = specs.get(spec);
      return next ? head + next + tail : all;
    }
  );
};
const lineAt = (text: string, pos: number): number => text.slice(0, pos).split(/\r?\n/).length;
const cleanDoc = (raw: string): string =>
  raw
    .replace(/^\/\*\*|\*\/$/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n');
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
    .filter((param) => /^[A-Za-z_$][\w$]*$/.test(param.name));
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
      if (/^[A-Za-z_$][\w$]*$/.test(name) && /^[A-Za-z_$][\w$]*$/.test(pub)) out.set(name, pub);
    }
  }
  return out;
};
const constParams = (next: string): Param[] | undefined => {
  const direct = next
    .slice(0, 1200)
    .match(
      /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[\s\S]*?)?=\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:async\s+)?(?:\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>|function\s*\(([^)]*)\))/
    );
  return direct ? splitParams(direct[1] || direct[2] || direct[3] || '') : undefined;
};
const ownerOf = (
  text: string,
  pos: number,
  docs: string,
  exported: Map<string, string>
): Owner | undefined => {
  // Some repos keep implementation notes between TSDoc and export; the example still documents it.
  const next = skipDocGap(text.slice(pos, pos + 4000));
  const params = paramDocs(docs);
  const fn = next.match(
    /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)[\s\S]*?\(([^)]*)\)/
  );
  if (fn) {
    if (!fn[1] && !exported.has(fn[2])) return undefined;
    const parsed = splitParams(fn[3]);
    return {
      callable: true,
      name: fn[1] ? fn[2] : exported.get(fn[2])!,
      params: parsed.length ? parsed : params,
    };
  }
  const cls = next.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (cls)
    return cls[1] || exported.has(cls[2])
      ? { callable: true, name: cls[1] ? cls[2] : exported.get(cls[2])!, params }
      : undefined;
  const typ = next.match(/^\s*(export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/);
  if (typ)
    return typ[1] || exported.has(typ[2])
      ? { callable: !!params.length, name: typ[1] ? typ[2] : exported.get(typ[2])!, params }
      : undefined;
  const cnst = next.match(/^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (!cnst) return undefined;
  if (!cnst[1] && !exported.has(cnst[2])) return undefined;
  const parsed = constParams(next);
  const callable = parsed !== undefined || !!params.length;
  return {
    callable,
    name: cnst[1] ? cnst[2] : exported.get(cnst[2])!,
    params: parsed?.length ? parsed : params,
  };
};
const examplesOf = (src: PublicSource): Example[] => {
  const { file, url } = src;
  const text = readFileSync(file, 'utf8');
  const exported = exportedLocals(text);
  const out: Example[] = [];
  for (const match of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const raw = match[0];
    if (!/@example\b/.test(raw)) continue;
    const docs = cleanDoc(raw);
    const owner = ownerOf(text, (match.index || 0) + raw.length, docs, exported);
    if (!owner?.callable) continue;
    const blocks = [...docs.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)];
    for (const block of blocks) {
      const code = (block[1] || '').trim();
      if (!code) continue;
      out.push({
        code,
        docs,
        file,
        line: lineAt(text, (match.index || 0) + raw.indexOf(block[0])),
        owner,
        url,
      });
    }
  }
  return out;
};
const stringText = (ts: TsLike, node: any): string => {
  if (ts.isStringLiteral?.(node)) return node.text;
  return typeof node?.text === 'string' ? node.text : '';
};
const importedNames = (ts: TsLike, sf: any, pkg: string): Set<string> => {
  const names = new Set<string>();
  for (const stmt of sf.statements || []) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stringText(ts, stmt.moduleSpecifier);
    if (spec !== pkg && !spec.startsWith(pkg + '/')) continue;
    const clause = stmt.importClause;
    if (clause?.name?.text) names.add(clause.name.text);
    const named = clause?.namedBindings;
    if (ts.isNamespaceImport?.(named) && named.name?.text) names.add(named.name.text);
    if (ts.isNamedImports?.(named))
      for (const el of named.elements || []) {
        const name = (el.name || el.propertyName)?.text;
        if (name) names.add(name);
      }
  }
  return names;
};
const rootOf = (ts: TsLike, node: any): string => {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text || '';
  if (ts.isPropertyAccessExpression(node)) return rootOf(ts, node.expression);
  if (ts.isElementAccessExpression?.(node)) return rootOf(ts, node.expression);
  return '';
};
const finalNameOf = (ts: TsLike, node: any): string => {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text || '';
  if (ts.isPropertyAccessExpression(node)) return node.name?.text || '';
  if (ts.isElementAccessExpression?.(node)) return node.argumentExpression?.getText?.() || '';
  return '';
};
const publicFactory = (ts: TsLike, node: any, imports: Set<string>, implicit: string): boolean => {
  if (!node) return false;
  if (ts.isCallExpression(node) || ts.isNewExpression?.(node)) {
    const root = rootOf(ts, node.expression);
    return imports.has(root) || (!!implicit && root === implicit);
  }
  return false;
};
const publicValue = (ts: TsLike, node: any, imports: Set<string>, implicit: string): boolean => {
  const root = rootOf(ts, node);
  return imports.has(root) || (!!implicit && root === implicit);
};
const selfOf = (ts: TsLike, node: any, sf: any): string | undefined => {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression?.(node))
    return node.expression.getText(sf);
  return undefined;
};
const memberOf = (ts: TsLike, node: any): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name?.text;
  if (ts.isElementAccessExpression?.(node) && ts.isStringLiteral?.(node.argumentExpression))
    return node.argumentExpression.text;
  return undefined;
};
const deepArg = (arg: string): boolean =>
  /^\s*[{[]/.test(arg) || /\b(?:opts?|options?|params?|config|settings)\b/i.test(arg);
const callsOf = (ts: TsLike, ex: Example, pkg: string): Call[] => {
  const sf = ts.createSourceFile('example.ts', ex.code, ts.ScriptTarget.ESNext, true);
  const imports = importedNames(ts, sf, pkg);
  const implicit = !imports.size && ex.owner ? ex.owner.name : '';
  const out: Call[] = [];
  const publicVars = new Set<string>();
  const seen = new Set<string>();
  const publicMethod = (expr: any): boolean => {
    if (!ts.isPropertyAccessExpression(expr) && !ts.isElementAccessExpression?.(expr)) return false;
    const self = expr.expression;
    const root = rootOf(ts, self);
    return (
      publicVars.has(root) ||
      publicFactory(ts, self, imports, implicit) ||
      publicValue(ts, self, imports, implicit)
    );
  };
  const add = (node: any, expr: any, argsRaw: any, newExpr = false): boolean => {
    const args = [...(argsRaw || [])].map((arg: any) => arg.getText(sf));
    const root = rootOf(ts, expr);
    const text = node.getText(sf);
    const method = !newExpr && publicMethod(expr);
    const directNeedsImport = !!implicit && root === implicit;
    const needsImport = directNeedsImport || (!!implicit && method);
    if ((!imports.has(root) && !needsImport && !method) || seen.has(text)) return false;
    const last = finalNameOf(ts, expr);
    const argNames =
      ex.owner && last === ex.owner.name && (imports.has(root) || directNeedsImport)
        ? ex.owner.params.map((param) => param.name)
        : args;
    const missing =
      ex.owner && last === ex.owner.name && (imports.has(root) || directNeedsImport)
        ? ex.owner.params.map((param) => param.optional)
        : args.map(() => false);
    if (!args.length && !argNames.length) return false;
    seen.add(text);
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({
      args,
      argNames,
      deep: args.map(deepArg),
      end: node.getEnd(),
      line: ex.line + pos.line,
      member: method ? memberOf(ts, expr) : undefined,
      missing,
      name: expr.getText(sf),
      needsImport,
      newExpr,
      self: newExpr ? undefined : selfOf(ts, expr, sf),
      start: node.getStart(sf),
      text,
    });
    return true;
  };
  const walk = (node: any): void => {
    if (ts.isVariableDeclaration?.(node) && ts.isIdentifier(node.name)) {
      if (
        publicFactory(ts, node.initializer, imports, implicit) ||
        publicValue(ts, node.initializer, imports, implicit)
      )
        publicVars.add(node.name.text);
    }
    if (ts.isCallExpression(node) && add(node, node.expression, node.arguments)) return;
    if (ts.isNewExpression?.(node) && add(node, node.expression, node.arguments, true)) return;
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
};
const workItems = (ctx: Ctx, ts: TsLike): Work[] =>
  publicSources(ctx)
    .flatMap((file) => examplesOf(file))
    .map((ex) => ({ ...ex, calls: callsOf(ts, ex, ctx.pkg.name) }))
    .filter((item) => item.calls.length);
const q = (value: unknown): string => JSON.stringify(value);
const instrumentedCode = (work: Work): string => {
  const chunks = work.calls
    .map((call, i) => ({
      end: call.end,
      start: call.start,
      text: call.newExpr
        ? `__jsbtNew(${i}, ${call.name}, [${call.args.join(', ')}])`
        : call.member && call.self
          ? `__jsbtMethod(${i}, () => (${call.self}), ${q(call.member)}, [${call.args.join(', ')}])`
          : `__jsbtCall(${i}, ${call.name}, ${call.self || 'undefined'}, [${call.args.join(', ')}])`,
    }))
    .sort((a, b) => b.start - a.start);
  let out = work.code;
  for (const chunk of chunks) out = out.slice(0, chunk.start) + chunk.text + out.slice(chunk.end);
  return out;
};
const codeOf = (ctx: Ctx, work: Work): string => {
  let code = rewriteImports(ctx, instrumentedCode(work));
  if (work.owner && work.calls.some((call) => call.needsImport)) {
    // TSDoc examples often omit imports for the documented public symbol; inject only that symbol.
    code = `import { ${work.owner.name} } from ${q(work.url)};\n${code}`;
  }
  return code;
};
const harness = (work: Work, code: string): string => {
  const cases = work.calls.map((call) => ({
    argNames: call.argNames,
    autoRet: !call.member,
    deep: call.deep,
    line: call.line,
    missing: call.missing,
    name: call.name,
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
    name: ${q(item.name)}
  }`
  )
  .join(',\n')}
];
const __jsbtRecords = [];
const __jsbtHex = (b) => Array.from(b, (i) => i.toString(16).padStart(2, '0')).join('');
const __jsbtIsBytes = (v) => v instanceof Uint8Array;
const __jsbtPlain = (v) => !!v && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && Object.getPrototypeOf(v) === Object.prototype;
const __jsbtBytes = (value, path = '', out = [], seen = new WeakSet()) => {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
  }
  if (__jsbtIsBytes(value)) out.push({ path, value, hex: __jsbtHex(value), dec: Array.from(value).join(',') });
  else if (Array.isArray(value)) value.forEach((item, i) => __jsbtBytes(item, path + '[' + i + ']', out, seen));
  else if (__jsbtPlain(value)) for (const [key, val] of Object.entries(value)) __jsbtBytes(val, path ? path + '.' + key : key, out, seen);
  return out;
};
const __jsbtCall = (idx, fn, self, args) => {
  const item = __jsbtCases[idx];
  const rec = { ...item, args, before: __jsbtBytes(args, 'arg').map((ref) => ({ ...ref })), fn, self };
  __jsbtRecords.push(rec);
  try {
    const ret = fn.apply(self, args);
    rec.ret = ret;
    if (ret && typeof ret.then === 'function') return ret.then((value) => (rec.ret = value));
    return ret;
  } catch (error) {
    rec.error = error;
    throw error;
  }
};
const __jsbtNew = (idx, fn, args) => {
  const item = __jsbtCases[idx];
  const rec = { ...item, args, before: __jsbtBytes(args, 'arg').map((ref) => ({ ...ref })), fn, newExpr: true };
  __jsbtRecords.push(rec);
  try {
    rec.ret = new fn(...args);
    return rec.ret;
  } catch (error) {
    rec.error = error;
    throw error;
  }
};
const __jsbtMethod = (idx, getSelf, member, args) => {
  const self = getSelf();
  return __jsbtCall(idx, self && self[member], self, args);
};
${code}
const __jsbtIssues = [];
const __jsbtDocs = ${q(work.docs)};
const __jsbtDocumented = /\\b(alias|same|reuse|return(?:s|ed)? input|mutat|in place)\\b/i.test(__jsbtDocs);
const __jsbtClone = (v) => {
  if (__jsbtIsBytes(v)) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(__jsbtClone);
  if (__jsbtPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, __jsbtClone(val)]));
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
  if (value && typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
  }
  const add = (vals) => out.push({ path, vals });
  if (__jsbtIsBytes(value)) add([false, '__jsbt_wrong_string__', [1, 2, 3]]);
  else if (typeof value === 'boolean') add([0, 'true', null]);
  else if (typeof value === 'number') add([false, '1', null, value + 0.5]);
  else if (typeof value === 'string') add([false, 1, {}]);
  else if (typeof value === 'function') add([false, {}, '__jsbt_wrong_function__']);
  else if (Array.isArray(value)) {
    add([false, {}, '__jsbt_wrong_array__']);
    if (deep && value.length) __jsbtWalk(value[0], path.concat(0), out, seen, deep);
  } else if (__jsbtPlain(value)) {
    add([false, null, '__jsbt_wrong_object__']);
    if (deep) for (const [key, val] of Object.entries(value)) __jsbtWalk(val, path.concat(key), out, seen, deep);
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
const __jsbtLeaks = (message, refs) => refs.some((ref) => ref.hex.length >= 16 && (message.includes(ref.hex) || message.includes(ref.dec)));
const __jsbtAlias = (value, refs, seen = new WeakSet()) => {
  if (__jsbtIsBytes(value) && refs.some((ref) => ref.value === value)) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => __jsbtAlias(item, refs, seen));
  if (__jsbtPlain(value)) return Object.values(value).some((item) => __jsbtAlias(item, refs, seen));
  return false;
};
const __jsbtRetMethods = (value, path = [], out = [], seen = new WeakSet()) => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return out;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return out;
  if (seen.has(value) || path.length > 3 || out.length >= 24) return out;
  seen.add(value);
  const local = [];
  const nested = [];
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
        // Returned API objects often expose constructors; new-examples cover those explicitly.
        !/^class\\s/.test(Function.prototype.toString.call(val))
      )
        local.push({ argc: Math.min(val.length, 4), fn: val, path: next, self });
      else if (!proto && (__jsbtPlain(val) || Array.isArray(val))) nested.push({ path: next, value: val });
    }
  };
  scan(value, value);
  const proto = Object.getPrototypeOf(value);
  if (
    typeof value !== 'function' &&
    proto &&
    proto !== Object.prototype &&
    proto !== Array.prototype
  )
    scan(proto, value, true);
  // Large math/point/factory objects are too broad for automatic wrong-arg probing.
  if (local.length > 8) return out;
  for (const method of local) {
    if (method.argc > 0) out.push(method);
    if (out.length >= 24) return out;
  }
  for (const item of nested) {
    __jsbtRetMethods(item.value, item.path, out, seen);
    if (out.length >= 24) return out;
  }
  return out;
};
const __jsbtMsg = (err) => err && typeof err.message === 'string' ? err.message : String(err);
const __jsbtSeen = new Set();
const __jsbtAdd = (level, kind, line, call, detail) => {
  const key = level + '\\0' + kind + '\\0' + line + '\\0' + call + '\\0' + detail;
  if (__jsbtSeen.has(key)) return;
  __jsbtSeen.add(key);
  __jsbtIssues.push({ call, detail, kind, level, line });
};
const __jsbtLabel = (arg, path) => path.length ? arg + '.' + path.join('.') : arg;
const __jsbtLabels = (label) => {
  const text = String(label || '');
  const out = [];
  if (!text || /^arg\\d+$/.test(text) || /^new\\b/.test(text)) return out;
  if (/^[A-Za-z_$][\\w$]*$/.test(text)) out.push(text);
  const path = text.match(/([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?$/);
  const tail = path && (path[2] || path[1]);
  if (text.includes('.') && tail && !/^(?:arg\\d+|of)$/.test(tail)) out.push(tail);
  const syn = { dkLen: ['outputLen', 'length'], msg: ['message'], opts: ['options'] };
  for (const item of [...out]) for (const alt of syn[item] || []) out.push(alt);
  return [...new Set(out)];
};
const __jsbtCheckMsg = (item, label, err, refs) => {
  const message = __jsbtMsg(err);
  const labels = __jsbtLabels(label);
  if (__jsbtLeaks(message, refs)) __jsbtAdd('ERROR', 'leak', item.line, item.name, 'error message exposes byte input value for ' + label);
  if (labels.length && !labels.some((item) => message.includes(item)))
    __jsbtAdd('WARNING', 'message', item.line, item.name, 'error message should mention ' + label + ': ' + message);
  if (!/(expected|got|invalid|must|should|length|range|type|wrong)/i.test(message))
    __jsbtAdd('WARNING', 'message', item.line, item.name, 'error message is too vague for ' + label + ': ' + message);
};
const __jsbtMissing = () => [{ path: [], vals: [false, '__jsbt_wrong_string__', {}, [1, 2, 3], null] }];
// Keep nested option-object probing finite; large API config objects otherwise multiply calls/noise.
const __jsbtMaxProbesPerArg = ${MAX_PROBES_PER_ARG};
let __jsbtProbed = 0;
const __jsbtProbeRet = async (item, ret, refs) => {
  for (const method of __jsbtRetMethods(ret)) {
    const name = item.name + '.' + method.path.join('.');
    const vals = __jsbtMissing()[0].vals;
    __jsbtProbed++;
    for (let i = 0; i < method.argc; i++) {
      for (const value of vals) {
        const args = Array(method.argc).fill(undefined);
        args[i] = value;
        try {
          await method.fn.apply(method.self, args);
          __jsbtAdd('ERROR', 'type', item.line, name, 'wrong runtime type accepted for arg' + i);
        } catch (error) {
          __jsbtCheckMsg({ ...item, name }, 'arg' + i, error, refs);
        }
      }
    }
  }
};
const __jsbtRun = async (records) => {
  for (const item of records) {
    const args = item.args;
    let ret;
    const refs = __jsbtBytes(args, 'arg');
    const before = item.before || refs.map((ref) => ({ ...ref }));
    try {
      if (item.error) throw item.error;
      ret = await item.ret;
    } catch (error) {
      __jsbtAdd('WARNING', 'example', item.line, item.name, 'cannot replay valid example call: ' + __jsbtMsg(error));
      continue;
    }
    const changed = __jsbtChanged(before, __jsbtBytes(args, 'arg'));
    if (changed.length && !__jsbtDocumented)
      __jsbtAdd('WARNING', 'mutation', item.line, item.name, 'valid call mutates input at ' + changed.join(', ') + '; document explicit mutation or copy input');
    if (__jsbtAlias(ret, refs) && !__jsbtDocumented)
      __jsbtAdd('WARNING', 'alias', item.line, item.name, 'return value aliases input; document returned-input aliasing or copy output');
    let direct = false;
    for (let i = 0; i < Math.max(args.length, item.argNames.length); i++) {
      const missing = i >= args.length;
      if (missing && !item.missing[i]) continue;
      const probes = (
        missing ? __jsbtMissing() : __jsbtWalk(args[i], [], [], new WeakSet(), item.deep[i])
      ).slice(0, __jsbtMaxProbesPerArg);
      if (probes.length) direct = true;
      for (const probe of probes) {
        const label = __jsbtLabel(item.argNames[i] || ('arg' + i), probe.path);
        for (const value of probe.vals) {
          const next = args.slice();
          next[i] = missing ? value : __jsbtSet(__jsbtClone(args[i]), probe.path, value);
          try {
            if (item.newExpr) new item.fn(...next);
            else await item.fn.apply(item.self, next);
            __jsbtAdd('ERROR', 'type', item.line, item.name, 'wrong runtime type accepted for ' + label);
          } catch (error) {
            __jsbtCheckMsg(item, label, error, refs);
          }
        }
      }
    }
    if (direct) __jsbtProbed++;
    if (item.autoRet) await __jsbtProbeRet(item, ret, refs);
  }
};
await __jsbtRun(__jsbtRecords);
export default { issues: __jsbtIssues, probed: __jsbtProbed };
`;
};
const workerCode = `
import { parentPort, workerData } from 'node:worker_threads';
try {
  const mod = await import(workerData.file);
  parentPort.postMessage(mod.default || { issues: [], probed: 0 });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error), issues: [], probed: 0 });
}`;
const probe = async (ctx: Ctx, work: Work, timeoutMs = TIMEOUT): Promise<Probe> => {
  const file = join(ctx.cwd, 'test', 'build', `.__errors-check-${process.pid}-${++nextId}.ts`);
  write(file, harness(work, codeOf(ctx, work)));
  try {
    return await new Promise((resolve) => {
      const worker = new Worker(workerCode, {
        eval: true,
        execArgv: ['--experimental-strip-types'],
        type: 'module',
        workerData: { file: pathToFileURL(file).href },
      } as any);
      let done = false;
      const finish = (res: Probe) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res);
      };
      const timer = setTimeout(() => {
        worker.terminate().catch(() => {});
        finish({ error: `timed out after ${timeoutMs}ms`, issues: [], probed: 0 });
      }, timeoutMs);
      worker.once('message', (msg) => finish(msg as Probe));
      worker.once('error', (error) => finish({ error: error.message, issues: [], probed: 0 }));
      worker.once('exit', (code) => {
        if (done) return;
        finish({
          error: code ? `worker exited with code ${code}` : 'worker exited without result',
          issues: [],
          probed: 0,
        });
      });
    });
  } finally {
    rm(file);
  }
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; timeoutMs?: number } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const ctx = resolveCtx(args, opts.cwd);
  const colorOn = opts.color ?? wantColor();
  const ts = loadTs(ctx.pkgFile);
  const items = workItems(ctx, ts);
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  const logs: LogIssue[] = [];
  if (!items.length) {
    out.skipped++;
    logs.push({
      level: 'INFO',
      ref: {
        file: 'package.json',
        issue: issueKind('no public callable TSDoc examples found', 'example'),
        sym: 'examples',
      },
    });
  }
  for (const item of items) {
    const rel = relative(ctx.cwd, item.file) || basename(item.file);
    const res = await probe(ctx, item, opts.timeoutMs || TIMEOUT);
    if (res.error) {
      out.warnings++;
      logs.push({
        level: 'WARNING',
        ref: {
          file: rel,
          issue: issueKind('example probe failed: ' + res.error, 'example'),
          sym: `${item.line}/example`,
        },
      });
      continue;
    }
    if (!res.issues.length) out.passed += res.probed || 1;
    for (const issue of res.issues) {
      if (issue.level === 'ERROR') out.failures++;
      else if (issue.level === 'WARNING') out.warnings++;
      else out.skipped++;
      logs.push({
        level: issue.level,
        ref: {
          file: rel,
          issue: issueKind(issue.detail, `errors-${issue.kind}`),
          sym: `${issue.line}/${issue.call}`,
        },
      });
    }
  }
  for (const line of groupIssues('errors', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('Errors check found issues');
  }
  console.log(`${status(out.warnings ? 'warn' : 'pass', colorOn)} summary: ${summary(out)}`);
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
