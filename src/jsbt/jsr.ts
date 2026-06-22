#!/usr/bin/env -S node
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`.
Do not call raw fs delete/write helpers or raw `npm install` directly here.

`check:jsr` keeps `jsr.json` aligned with the package public API and JSR source package shape.
It checks that public exports mirror package.json, JSR import mappings cover exported-source deps,
and `publish.include` points at source files instead of built output.
It also warns when the exported local module graph reaches files hidden by `.gitignore`,
because JSR dry-run will treat those as excluded modules unless `publish.exclude` unignores them.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { listModules, publicCtx } from './public.ts';
import {
  cliArgs,
  dirEntries,
  emptyResult,
  importTypeText,
  literalText,
  loadTypeScriptApi,
  pkgTarget,
  readJson,
  readSource,
  recordIssue,
  relFile,
  reportIssues,
  resolveLocalImport,
  runSelf,
  sorted,
  tsSourceRel,
  usageText,
  walkAst,
  wantTSFile,
  type Issue as LogIssue,
} from './utils.ts';

type RawJsr = {
  exports?: unknown;
  imports?: unknown;
  name?: unknown;
  publish?: { exclude?: unknown; include?: unknown };
  version?: unknown;
};
type RawPkg = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  name?: unknown;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  version?: unknown;
};
type RootMode = 'runtime' | 'type';
type Graph = {
  files: string[];
  graphFiles: string[];
  roots: string[];
  runtimeRoots: string[];
  typeRoots: string[];
};
type TsLike = typeof import('typescript');

const usage = usageText('jsr', 'check-jsr.ts');
const KEEP = new Set(['LICENSE', 'README.md', 'jsr.json']);

const norm = (file: string): string => (file.startsWith('./') ? file : `./${file}`);
const LOCAL_SPEC = /^(?:file:|workspace:|link:)/;
const depRoot = (spec: string): string => {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/');
    return scope && name ? `${scope}/${name}` : spec;
  }
  return spec.split('/')[0] || spec;
};
const jsrName = (name: string): string => (name.startsWith('@') ? name : `@paulmillr/${name}`);
const parseJsr = (value: string): { name: string; version: string } => {
  const hit = value.match(/^jsr:(@[^/]+\/[^@/]+|[^@/]+)(?:@(.+))?$/);
  return { name: hit?.[1] || '', version: hit?.[2] || '' };
};
const loadTS = (pkgFile: string): TsLike => {
  return loadTypeScriptApi<TsLike>(pkgFile, 'TypeScript parser API', [
    'createSourceFile',
    'forEachChild',
  ]);
};
const stringMap = (raw: unknown, map: (value: string) => string = (value) => value) => {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw))
    if (typeof value === 'string') out[key] = map(value);
  return out;
};
const stringList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
const normalizeExports = (raw: unknown): Record<string, string> => {
  if (typeof raw === 'string') return { '.': norm(raw) };
  return stringMap(raw, norm);
};
const GRAPH_FILE = /(?:\.d\.[cm]?ts|\.cts|\.mts|\.tsx|\.ts|\.cjs|\.mjs|\.jsx|\.js)$/;
const sourceRel = (cwd: string, dtsFile: string): string => {
  const rel = tsSourceRel(norm(relative(cwd, dtsFile)));
  const src = norm(`src/${rel}`);
  const root = norm(rel);
  if (existsSync(resolve(cwd, src))) return src;
  if (existsSync(resolve(cwd, root))) return root;
  return src;
};
const resolveImportFile = (
  from: string,
  spec: string,
  want: (file: string) => boolean = wantTSFile
): string | undefined =>
  resolveLocalImport(from, spec, {
    accept: (file) => existsSync(file) && statSync(file).isFile() && want(file),
    exts: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'],
  });
const hasTS = (file: string): boolean => {
  if (!existsSync(file)) return false;
  const stat = statSync(file);
  if (stat.isFile()) return wantTSFile(file);
  if (!stat.isDirectory()) return false;
  for (const ent of dirEntries(file)) {
    const cur = join(file, ent.name);
    if (ent.isDirectory()) {
      if (hasTS(cur)) return true;
      continue;
    }
    if (ent.isFile() && wantTSFile(cur)) return true;
  }
  return false;
};
const pathCovers = (base: string, file: string): boolean =>
  base === file || (!!base && file.startsWith(`${base}/`));
const coveredBy = (inc: string[], file: string): boolean => {
  const cur = file.replace(/^\.\//, '');
  return inc.some((item) => pathCovers(item.replace(/^\.\//, ''), cur));
};
const importDeclTypeOnly = (ts: TsLike, node: import('typescript').ImportDeclaration): boolean => {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bind = clause.namedBindings;
  if (!bind) return false;
  if (ts.isNamespaceImport(bind)) return false;
  return bind.elements.length > 0 && bind.elements.every((item) => item.isTypeOnly);
};
const exportDeclTypeOnly = (ts: TsLike, node: import('typescript').ExportDeclaration): boolean => {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((item) => item.isTypeOnly);
};
const scanRefs = (ts: TsLike, file: string): { local: string[]; roots: Map<string, RootMode> } => {
  const { source } = readSource(ts, file);
  const local = new Set<string>();
  const roots = new Map<string, RootMode>();
  const add = (spec: string, typeOnly: boolean) => {
    if (!spec || spec.startsWith('node:')) return;
    if (spec.startsWith('.')) return void local.add(spec);
    const key = depRoot(spec);
    if (!key) return;
    if (!typeOnly || roots.get(key) === 'runtime') return void roots.set(key, 'runtime');
    if (!roots.has(key)) roots.set(key, 'type');
  };
  walkAst(ts, source, (node: import('typescript').Node) => {
    if (ts.isImportDeclaration(node))
      add(literalText(ts, node.moduleSpecifier), importDeclTypeOnly(ts, node));
    else if (ts.isExportDeclaration(node))
      add(literalText(ts, node.moduleSpecifier), exportDeclTypeOnly(ts, node));
    else if (ts.isImportTypeNode(node) && !node.isTypeOf) add(importTypeText(ts, node), true);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      add(literalText(ts, node.arguments[0]), false);
    }
  });
  return { local: [...local], roots };
};
const graph = (ts: TsLike, entries: string[]): Graph => {
  const files = new Set<string>();
  const graphFiles = new Set<string>();
  const roots = new Map<string, RootMode>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (graphFiles.has(file) || !existsSync(file)) continue;
    graphFiles.add(file);
    if (wantTSFile(file)) files.add(file);
    const refs = scanRefs(ts, file);
    for (const spec of refs.local) {
      const target = resolveImportFile(file, spec, (item) => GRAPH_FILE.test(item));
      if (target) stack.push(target);
    }
    for (const [root, mode] of refs.roots) {
      if (mode === 'runtime' || roots.get(root) === 'runtime') roots.set(root, 'runtime');
      else if (!roots.has(root)) roots.set(root, 'type');
    }
  }
  const runtimeRoots = [...roots].flatMap(([root, mode]) => (mode === 'runtime' ? [root] : []));
  const typeRoots = [...roots].flatMap(([root, mode]) => (mode === 'type' ? [root] : []));
  return {
    files: sorted(files),
    graphFiles: sorted(graphFiles),
    roots: sorted(roots.keys()),
    runtimeRoots: sorted(runtimeRoots),
    typeRoots: sorted(typeRoots),
  };
};
const hasRuntimePkgDep = (raw: RawPkg, key: string): boolean =>
  typeof raw.dependencies?.[key] === 'string' ||
  typeof raw.optionalDependencies?.[key] === 'string' ||
  typeof raw.peerDependencies?.[key] === 'string';
const depSpec = (raw: RawPkg, key: string): string => {
  for (const set of [
    raw.dependencies,
    raw.optionalDependencies,
    raw.peerDependencies,
    raw.devDependencies,
  ]) {
    const spec = set?.[key];
    if (typeof spec === 'string') return spec;
  }
  return '';
};
const ignoreFix = (pattern: string, rel: string): string => {
  const raw = pattern.trim().replace(/^!+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw) return `!${rel}`;
  if (/[*?[\\]/.test(raw)) return `!${rel}`;
  const relParts = rel.split('/');
  const rawParts = raw.split('/');
  for (let i = 0; i <= relParts.length - rawParts.length; i++) {
    let ok = true;
    for (let j = 0; j < rawParts.length; j++) {
      if (relParts[i + j] !== rawParts[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const hit = relParts.slice(0, i + rawParts.length).join('/');
    // JSR's documented unignore shape is the path entry itself (`!dist`), not `!dist/**`.
    // Real dry-runs confirmed `!src/targets` works, while `!src/targets/**` does not.
    return `!${hit}`;
  }
  return `!${rel}`;
};
const alreadyUnignored = (exclude: string[], rel: string): boolean => {
  for (const item of exclude) {
    if (!item.startsWith('!')) continue;
    const raw = item.trim().replace(/^!+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!raw || /[*?[\\]/.test(raw)) continue;
    if (pathCovers(raw, rel)) return true;
  }
  return false;
};
const ignoredGraphFiles = (cwd: string, files: string[]): Map<string, string> => {
  if (!files.length) return new Map();
  const rels = files.map((file) => relFile(cwd, file));
  const out = new Map<string, string>();
  for (let i = 0; i < rels.length; i += 256) {
    const chunk = rels.slice(i, i + 256);
    const res = spawnSync('git', ['check-ignore', '-v', ...chunk], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 && res.status !== 1) return new Map();
    for (const line of (res.stdout || '').split(/\r?\n/)) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const meta = line.slice(0, tab);
      const rel = line.slice(tab + 1);
      const idx = meta.indexOf(':');
      const idx2 = idx === -1 ? -1 : meta.indexOf(':', idx + 1);
      const pattern = idx2 === -1 ? '' : meta.slice(idx2 + 1);
      if (!rel || !pattern) continue;
      out.set(rel, ignoreFix(pattern, rel));
    }
  }
  return out;
};
export const runCli = async (
  argv: string[],
  opts: {
    color?: boolean;
    cwd?: string;
    loadTS?: (pkgFile: string) => TsLike;
  } = {}
): Promise<void> => {
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const { cwd, pkgFile } = pkgTarget(args.pkgArg, opts.cwd);
  const jsrFile = resolve(cwd, 'jsr.json');
  const issues: LogIssue[] = [];
  const out = emptyResult();
  const issue = (file: string, sym: string, text: string, kind: string): void => {
    recordIssue(out, issues, 'error', file, sym, text, kind);
  };
  if (!existsSync(jsrFile)) {
    issue('jsr.json', 'file', 'add jsr.json next to package.json', 'jsr-file');
  } else {
    const rawPkg = readJson<RawPkg>(pkgFile);
    const rawJsr = readJson<RawJsr>(jsrFile);
    const ctx = publicCtx(args.pkgArg, opts.cwd);
    const pkg = ctx.pkg;
    const mods = listModules(ctx);
    const exp = Object.fromEntries(mods.map((item) => [item.key, sourceRel(cwd, item.dtsFile)]));
    const act = normalizeExports(rawJsr.exports);
    for (const key of sorted(Object.keys(exp))) {
      const want = exp[key];
      const got = act[key];
      if (got === want) continue;
      issue(
        'jsr.json',
        'exports',
        `${got ? 'fix' : 'missing'} jsr export mapping; use ${key} -> ${want}`,
        'jsr-export'
      );
    }
    for (const key of sorted(Object.keys(act))) {
      if (exp[key]) continue;
      issue(
        'jsr.json',
        'exports',
        `remove unexpected jsr export mapping; drop ${key} -> ${act[key]}`,
        'jsr-export-extra'
      );
    }
    const wantName = jsrName(pkg.name);
    if (rawJsr.name !== wantName) {
      issue(
        'jsr.json',
        'name',
        `name mismatch; expected ${wantName} from package.json`,
        'jsr-name'
      );
    }
    if (rawJsr.version !== rawPkg.version) {
      issue(
        'jsr.json',
        'version',
        `version mismatch; expected ${String(rawPkg.version || '')} from package.json`,
        'jsr-version'
      );
    }
    const ts = (opts.loadTS || loadTS)(pkgFile);
    const src = graph(
      ts,
      Object.values(exp)
        .map((item) => resolve(cwd, item))
        .filter((file) => existsSync(file))
    );
    const exclude = stringList(rawJsr.publish?.exclude);
    const ignored = ignoredGraphFiles(cwd, src.graphFiles);
    for (const file of sorted(ignored.keys())) {
      if (!alreadyUnignored(exclude, file)) {
        issue(
          file,
          'gitignore',
          [
            'unignore gitignored module graph path;',
            `add publish.exclude entry ${ignored.get(file) || `!${file}`}`,
          ].join(' '),
          'jsr-gitignore'
        );
      }
    }
    const jsrImports = stringMap(rawJsr.imports);
    for (const key of src.runtimeRoots) {
      if (!hasRuntimePkgDep(rawPkg, key)) {
        issue(
          'package.json',
          'dependencies',
          `add package dependency for exported source import ${key}`,
          'jsr-dep'
        );
      }
    }
    for (const key of src.roots) {
      const want = jsrName(key);
      const spec = depSpec(rawPkg, key);
      const wantVer = spec && !LOCAL_SPEC.test(spec) ? spec : '';
      const wantImport = `jsr:${want}${wantVer ? `@${wantVer}` : ''}`;
      const got = parseJsr(jsrImports[key] || '');
      if (got.name === want && (!wantVer || got.version === wantVer)) continue;
      issue(
        'jsr.json',
        'imports',
        `fix jsr import mapping; use ${key} -> ${wantImport}`,
        'jsr-import'
      );
    }
    for (const key of sorted(Object.keys(jsrImports))) {
      if (src.roots.includes(key)) continue;
      issue(
        'jsr.json',
        'imports',
        `remove unexpected jsr import mapping; drop ${key} -> ${jsrImports[key]}`,
        'jsr-import-extra'
      );
    }
    const include = stringList(rawJsr.publish?.include);
    for (const item of ['LICENSE', 'README.md', 'jsr.json']) {
      if (!include.includes(item)) {
        issue(
          'jsr.json',
          'publish',
          `add required publish entry; use ${item}`,
          'jsr-publish-required'
        );
      }
    }
    for (const item of include) {
      if (KEEP.has(item)) continue;
      if (hasTS(resolve(cwd, item))) continue;
      issue(
        'jsr.json',
        'publish',
        `remove non-source publish entry; drop ${item}`,
        'jsr-publish-source'
      );
    }
    for (const file of sorted(src.files.map((item) => relFile(cwd, item)))) {
      if (!coveredBy(include, file)) {
        issue(
          'jsr.json',
          'publish',
          `add publish coverage for exported source graph; use ${file}`,
          'jsr-publish'
        );
      }
    }
  }
  if (!out.failures && !out.warnings) out.passed = 1;
  reportIssues('jsr', issues, out, colorOn, 'JSR check found issues', 'warn');
};

runSelf(import.meta.url, runCli);
