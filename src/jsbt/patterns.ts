#!/usr/bin/env -S node --experimental-strip-types
/**
Checks TypeScript code for low-value patterns that agents often introduce.
Rules:
  - unused-value bypasses such as `void value;` and bare `value;` are errors
  - direct value/type aliases are errors, except direct aliases of imports and generic type aliases
  - single-use function helpers are warnings
  - helper names ending in `Of` are errors
  - direct pass-through wrappers are errors
  - multiline control-flow conditions or bodies need braces
 */
import { readFileSync } from 'node:fs';
import {
  cliArgs,
  createCachedSourceFile,
  emptyResult,
  loadTypeScriptApi,
  makeIssue,
  nodeStart,
  pickTSFiles,
  pkgTarget,
  relName,
  reportIssues,
  runSelf,
  usageText,
  walkAst,
  type Issue as LogIssue,
} from './utils.ts';

type Level = 'error' | 'warning';
export type PatternIssue = {
  col: number;
  issue: string;
  kind: string;
  level: Level;
  line: number;
};
type Decl = {
  exported: boolean;
  name: string;
  node: any;
  passthrough: boolean;
  small: boolean;
  topLevel: boolean;
};
type TsLike = {
  ScriptTarget: { ESNext: unknown };
  SyntaxKind: Record<string, number>;
  createSourceFile: (file: string, text: string, target: unknown, parents?: boolean) => any;
  forEachChild: (node: any, cb: (node: any) => void) => void;
};
type TestApi = {
  files: typeof pickTSFiles;
  scanPatternText: typeof scanPatternText;
};

const usage = usageText('patterns', 'jsbt/patterns.ts');
const GLOBAL_VALUES = new Set(['Infinity', 'NaN', 'undefined']);

const loadTS = (pkgFile: string): TsLike =>
  loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript parser API', ['createSourceFile']);
const api = (ts: TsLike) => ts as any;
const isKind = (ts: TsLike, node: any, name: string): boolean =>
  !!node && node.kind === ts.SyntaxKind[name];
const isNode = (ts: TsLike, node: any, name: string): boolean => {
  if (!node) return false;
  const fn = api(ts)[`is${name}`];
  return typeof fn === 'function' ? fn(node) : isKind(ts, node, name);
};
const nameText = (ts: TsLike, node: any): string =>
  isNode(ts, node, 'Identifier') ? node.text || '' : '';
const srcLine = (src: any, node: any): { col: number; line: number } => {
  const pos = nodeStart(src, node);
  const loc = src.getLineAndCharacterOfPosition(pos);
  return { col: loc.character + 1, line: loc.line + 1 };
};
const emit = (
  out: PatternIssue[],
  src: any,
  node: any,
  level: Level,
  kind: string,
  issue: string
): void => {
  out.push({ ...srcLine(src, node), issue, kind, level });
};
const exported = (ts: TsLike, node: any): boolean =>
  (node.modifiers || []).some((mod: any) => mod.kind === ts.SyntaxKind.ExportKeyword);
const sourceChild = (ts: TsLike, node: any): boolean => isNode(ts, node?.parent, 'SourceFile');
const spanMulti = (src: any, node: any): boolean => {
  const start = nodeStart(src, node);
  const end = Math.max(start, node.end || start);
  return (
    src.getLineAndCharacterOfPosition(start).line !== src.getLineAndCharacterOfPosition(end).line
  );
};
const lineSpan = (src: any, node: any): number => {
  const start = nodeStart(src, node);
  const end = Math.max(start, node.end || start);
  return (
    src.getLineAndCharacterOfPosition(end).line - src.getLineAndCharacterOfPosition(start).line + 1
  );
};
const lineOf = (src: any, node: any): number =>
  src.getLineAndCharacterOfPosition(nodeStart(src, node)).line;
const simpleValue = (ts: TsLike, node: any): boolean =>
  isNode(ts, node, 'Identifier') ||
  isNode(ts, node, 'PropertyAccessExpression') ||
  isNode(ts, node, 'ElementAccessExpression');
const callName = (ts: TsLike, node: any): string => {
  if (!isNode(ts, node, 'CallExpression')) return '';
  const expr = node.expression;
  if (isNode(ts, expr, 'Identifier')) return expr.text || '';
  if (isNode(ts, expr, 'PropertyAccessExpression')) return expr.getText?.() || '';
  return '';
};
const paramNames = (ts: TsLike, node: any): string[] | undefined => {
  const names: string[] = [];
  for (const param of node.parameters || []) {
    const name = nameText(ts, param.name);
    if (!name) return;
    names.push(name);
  }
  return names;
};
const returnCall = (ts: TsLike, node: any): any => {
  if (isNode(ts, node, 'ArrowFunction')) {
    if (isNode(ts, node.body, 'CallExpression')) return node.body;
    if (!isNode(ts, node.body, 'Block')) return;
  }
  const body = node.body;
  if (!body?.statements || body.statements.length !== 1) return;
  const stmt = body.statements[0];
  return isNode(ts, stmt, 'ReturnStatement') && isNode(ts, stmt.expression, 'CallExpression')
    ? stmt.expression
    : undefined;
};
const forwards = (ts: TsLike, node: any): string => {
  const params = paramNames(ts, node);
  if (!params) return '';
  const call = returnCall(ts, node);
  if (!call) return '';
  if (call.arguments.length !== params.length) return '';
  for (let i = 0; i < params.length; i++) {
    if (!isNode(ts, call.arguments[i], 'Identifier') || call.arguments[i].text !== params[i])
      return '';
  }
  return callName(ts, call);
};
const smallHelper = (ts: TsLike, src: any, node: any): boolean => {
  if (isNode(ts, node, 'ArrowFunction') && !isNode(ts, node.body, 'Block')) return true;
  const body = node.body;
  return !!body?.statements && body.statements.length <= 1 && lineSpan(src, node) <= 3;
};
const typeTarget = (ts: TsLike, node: any): string => {
  if (!isNode(ts, node, 'TypeReferenceNode') || node.typeArguments?.length) return '';
  const name = node.typeName;
  return isNode(ts, name, 'Identifier') ? name.text || '' : name?.getText?.() || '';
};
const constDecl = (ts: TsLike, node: any): boolean => {
  const flag = api(ts).NodeFlags?.Const || 0;
  const flags = node.parent?.flags || 0;
  return !!(flags & flag);
};
const collectImports = (ts: TsLike, src: any): Set<string> => {
  const out = new Set<string>();
  walkAst(ts, src, (node) => {
    if (isNode(ts, node, 'ImportClause')) {
      const name = nameText(ts, node.name);
      if (name) out.add(name);
    } else if (isNode(ts, node, 'NamespaceImport')) {
      const name = nameText(ts, node.name);
      if (name) out.add(name);
    } else if (isNode(ts, node, 'ImportSpecifier')) {
      const name = nameText(ts, node.name);
      if (name) out.add(name);
    } else if (isNode(ts, node, 'ImportEqualsDeclaration')) {
      const name = nameText(ts, node.name);
      if (name) out.add(name);
    }
    return true;
  });
  return out;
};
const declIdentifier = (ts: TsLike, node: any): boolean => {
  const parent = node.parent;
  if (!parent || parent.name !== node) return false;
  return [
    'BindingElement',
    'ClassDeclaration',
    'EnumDeclaration',
    'FunctionDeclaration',
    'ImportClause',
    'ImportEqualsDeclaration',
    'ImportSpecifier',
    'InterfaceDeclaration',
    'MethodDeclaration',
    'NamespaceImport',
    'Parameter',
    'PropertyDeclaration',
    'TypeAliasDeclaration',
    'VariableDeclaration',
  ].some((name) => isNode(ts, parent, name));
};
const propertyIdentifier = (ts: TsLike, node: any): boolean => {
  const parent = node.parent;
  if (!parent) return false;
  if (isNode(ts, parent, 'PropertyAccessExpression') && parent.name === node) return true;
  return isNode(ts, parent, 'PropertyAssignment') && parent.name === node;
};
const refCounts = (ts: TsLike, src: any): Map<string, number> => {
  const refs = new Map<string, number>();
  walkAst(ts, src, (node) => {
    if (!isNode(ts, node, 'Identifier')) return true;
    if (declIdentifier(ts, node) || propertyIdentifier(ts, node)) return true;
    refs.set(node.text, (refs.get(node.text) || 0) + 1);
    return true;
  });
  return refs;
};
const collectHelpers = (ts: TsLike, src: any, issues: PatternIssue[]): Decl[] => {
  const out: Decl[] = [];
  walkAst(ts, src, (node) => {
    if (isNode(ts, node, 'FunctionDeclaration')) {
      const name = nameText(ts, node.name);
      if (!name) return true;
      const pass = forwards(ts, node);
      out.push({
        exported: exported(ts, node),
        name,
        node,
        passthrough: !!pass,
        small: smallHelper(ts, src, node),
        topLevel: sourceChild(ts, node),
      });
      if (name.endsWith('Of'))
        emit(issues, src, node.name, 'error', 'name', 'helper name must not end with Of');
      if (pass) {
        emit(
          issues,
          src,
          node.name,
          'error',
          'wrapper',
          `helper only forwards its arguments to ${pass}`
        );
      }
    } else if (isNode(ts, node, 'VariableDeclaration')) {
      const name = nameText(ts, node.name);
      const init = node.initializer;
      if (!name || !(isNode(ts, init, 'ArrowFunction') || isNode(ts, init, 'FunctionExpression')))
        return true;
      const pass = forwards(ts, init);
      out.push({
        exported: exported(ts, node.parent?.parent),
        name,
        node: node.name,
        passthrough: !!pass,
        small: smallHelper(ts, src, init),
        topLevel: sourceChild(ts, node.parent?.parent),
      });
      if (name.endsWith('Of'))
        emit(issues, src, node.name, 'error', 'name', 'helper name must not end with Of');
      if (pass) {
        emit(
          issues,
          src,
          node.name,
          'error',
          'wrapper',
          `helper only forwards its arguments to ${pass}`
        );
      }
    }
    return true;
  });
  return out;
};
const checkUnusedExpr = (ts: TsLike, src: any, node: any, issues: PatternIssue[]): void => {
  if (!isNode(ts, node, 'ExpressionStatement')) return;
  const expr = node.expression;
  if (isNode(ts, expr, 'VoidExpression') && simpleValue(ts, expr.expression)) {
    emit(
      issues,
      src,
      node,
      'error',
      'unused',
      'do not silence unused values with void expression statement'
    );
  } else if (simpleValue(ts, expr)) {
    emit(
      issues,
      src,
      node,
      'error',
      'unused',
      'bare value expression statement does not use the value'
    );
  }
};
const checkAliases = (
  ts: TsLike,
  src: any,
  node: any,
  imports: Set<string>,
  issues: PatternIssue[]
): void => {
  if (isNode(ts, node, 'VariableDeclaration')) {
    const name = nameText(ts, node.name);
    const init = nameText(ts, node.initializer);
    if (name && init && constDecl(ts, node) && !imports.has(init) && !GLOBAL_VALUES.has(init)) {
      emit(issues, src, node.name, 'error', 'alias', `pointless const alias; use ${init} directly`);
    }
  } else if (isNode(ts, node, 'TypeAliasDeclaration')) {
    const target = typeTarget(ts, node.type);
    if (target) {
      emit(
        issues,
        src,
        node.name,
        'error',
        'alias',
        `pointless type alias; use ${target} directly`
      );
    }
  }
};
const checkBraces = (ts: TsLike, src: any, node: any, issues: PatternIssue[]): void => {
  // TypeScript expression nodes exclude surrounding `if (` / `)`, so line-span the head too.
  const headMulti = (stmt: any): boolean => lineOf(src, node) + 1 < lineOf(src, stmt);
  const needs = (stmt: any, cond: any): boolean =>
    !isNode(ts, stmt, 'Block') && (spanMulti(src, cond) || headMulti(stmt) || spanMulti(src, stmt));
  const anyMulti = (items: any[]): boolean => items.some((item) => item && spanMulti(src, item));
  if (isNode(ts, node, 'IfStatement')) {
    if (needs(node.thenStatement, node.expression)) {
      emit(issues, src, node, 'error', 'braces', 'multiline if condition or body must use braces');
    }
    const els = node.elseStatement;
    if (
      els &&
      !isNode(ts, els, 'IfStatement') &&
      !isNode(ts, els, 'Block') &&
      spanMulti(src, els)
    ) {
      emit(issues, src, els, 'error', 'braces', 'multiline else body must use braces');
    }
  } else if (isNode(ts, node, 'ForStatement')) {
    const head = [node.initializer, node.condition, node.incrementor];
    if (
      !isNode(ts, node.statement, 'Block') &&
      (anyMulti(head) || headMulti(node.statement) || spanMulti(src, node.statement))
    ) {
      emit(issues, src, node, 'error', 'braces', 'multiline for condition or body must use braces');
    }
  } else if (isNode(ts, node, 'ForOfStatement') || isNode(ts, node, 'ForInStatement')) {
    if (
      !isNode(ts, node.statement, 'Block') &&
      (anyMulti([node.initializer, node.expression]) ||
        headMulti(node.statement) ||
        spanMulti(src, node.statement))
    ) {
      emit(issues, src, node, 'error', 'braces', 'multiline for condition or body must use braces');
    }
  } else if (isNode(ts, node, 'WhileStatement')) {
    if (needs(node.statement, node.expression)) {
      emit(
        issues,
        src,
        node,
        'error',
        'braces',
        'multiline while condition or body must use braces'
      );
    }
  }
};
const byPosition = (a: PatternIssue, b: PatternIssue): number =>
  a.line - b.line || a.col - b.col || a.issue.localeCompare(b.issue);

export const scanPatternText = (ts: TsLike, file: string, text: string): PatternIssue[] => {
  const src = createCachedSourceFile(ts, file, text);
  const issues: PatternIssue[] = [];
  const imports = collectImports(ts, src);
  const helpers = collectHelpers(ts, src, issues);
  const refs = refCounts(ts, src);
  walkAst(ts, src, (node) => {
    checkUnusedExpr(ts, src, node, issues);
    checkAliases(ts, src, node, imports, issues);
    checkBraces(ts, src, node, issues);
    return true;
  });
  for (const helper of helpers) {
    if (helper.exported || helper.passthrough || helper.topLevel || !helper.small) continue;
    if ((refs.get(helper.name) || 0) === 1) {
      emit(
        issues,
        src,
        helper.node,
        'warning',
        'helper',
        'single-use helper; inline it or give it a real abstraction boundary'
      );
    }
  }
  return issues.sort(byPosition);
};
const read = (file: string): string => readFileSync(file, 'utf8');
export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string; loadTS?: (pkgFile: string) => TsLike } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const target = pkgTarget(args.pkgArg, opts.cwd);
  const ts = (opts.loadTS || loadTS)(target.pkgFile);
  const issues: LogIssue[] = [];
  const result = emptyResult();
  for (const file of pickTSFiles(target.cwd)) {
    const hits = scanPatternText(ts, file, read(file));
    if (!hits.length) {
      result.passed++;
      continue;
    }
    for (const item of hits) {
      if (item.level === 'warning') result.warnings++;
      else result.failures++;
      issues.push(
        makeIssue(
          item.level === 'warning' ? 'warn' : 'error',
          relName(target.cwd, file),
          `${item.line}:${item.col}/${item.kind}`,
          item.issue,
          item.kind
        )
      );
    }
  }
  reportIssues('patterns', issues, result, colorOn, 'Patterns check found issues', 'warn');
};

export const __TEST: TestApi = {
  files: pickTSFiles,
  scanPatternText: scanPatternText,
};

runSelf(import.meta.url, runCli);
