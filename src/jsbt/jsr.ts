#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

`check:jsr` keeps `jsr.json` aligned with the package public API and JSR source package shape.
It checks that public exports mirror package.json, JSR import mappings cover exported-source deps,
and `publish.include` points at source files instead of built output.
It also warns when the exported local module graph reaches files hidden by `.gitignore`,
because JSR dry-run will treat those as excluded modules unless `publish.exclude` unignores them.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModules, readPkg } from './public.ts';
import {
  bundled,
  guardChild,
  issueKind,
  printIssues,
  status,
  summary,
  wantColor,
  wantTSFile,
  type Issue as LogIssue,
  type Result,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
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

const usage = `usage:
  jsbt jsr <package.json>

examples:
  jsbt jsr package.json
  node /path/to/check-jsr.ts package.json`;
const KEEP = new Set(['LICENSE', 'README.md', 'jsr.json']);

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const norm = (file: string): string => (file.startsWith('./') ? file : `./${file}`);
const localSpec = (spec: string): boolean => /^(?:file:|workspace:|link:)/.test(spec);
const rootOf = (spec: string): string => {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/');
    return scope && name ? `${scope}/${name}` : spec;
  }
  return spec.split('/')[0] || spec;
};
const jsrNameOf = (name: string): string => (name.startsWith('@') ? name : `@paulmillr/${name}`);
const parseJsr = (value: string): { name: string; version: string } => {
  const hit = value.match(/^jsr:(@[^/]+\/[^@/]+|[^@/]+)(?:@(.+))?$/);
  return { name: hit?.[1] || '', version: hit?.[2] || '' };
};
const loadTS = (pkgFile: string): TsLike => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req('typescript') as TsLike | { default?: TsLike };
    } catch {
      return err(`missing typescript near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const ts = ('default' in raw && raw.default ? raw.default : raw) as TsLike;
  if (typeof ts.createSourceFile !== 'function' || typeof ts.forEachChild !== 'function')
    err(`expected TypeScript parser API near ${pkgFile}`);
  return ts;
};
const normalizeExports = (raw: unknown): Record<string, string> => {
  if (typeof raw === 'string') return { '.': norm(raw) };
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw))
    if (typeof value === 'string') out[key] = norm(value);
  return out;
};
const normalizeImports = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value;
  return out;
};
const normalizeInclude = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
const normalizeExclude = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
const wantGraphFile = (file: string): boolean =>
  /(?:\.d\.[cm]?ts|\.cts|\.mts|\.tsx|\.ts|\.cjs|\.mjs|\.jsx|\.js)$/.test(file);
const sourceOf = (cwd: string, dtsFile: string): string => {
  const rel = norm(relative(cwd, dtsFile));
  const stem = rel.replace(/\.d\.(?:c|m)?ts$/, '');
  const src = norm(`src/${stem.slice(2)}.ts`);
  const root = norm(`${stem.slice(2)}.ts`);
  if (existsSync(resolve(cwd, src))) return src;
  if (existsSync(resolve(cwd, root))) return root;
  return src;
};
const resolveImportFile = (
  from: string,
  spec: string,
  want: (file: string) => boolean = wantTSFile
): string | undefined => {
  if (!spec.startsWith('.')) return;
  const raw = resolve(dirname(from), spec);
  const tries = [
    raw,
    `${raw}.ts`,
    `${raw}.mts`,
    `${raw}.cts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.mjs`,
    `${raw}.cjs`,
    `${raw}.jsx`,
    join(raw, 'index.ts'),
    join(raw, 'index.mts'),
    join(raw, 'index.cts'),
    join(raw, 'index.tsx'),
    join(raw, 'index.js'),
    join(raw, 'index.mjs'),
    join(raw, 'index.cjs'),
    join(raw, 'index.jsx'),
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
    if (existsSync(file) && statSync(file).isFile() && want(file)) return file;
  return;
};
const hasTS = (file: string): boolean => {
  if (!existsSync(file)) return false;
  const stat = statSync(file);
  if (stat.isFile()) return wantTSFile(file);
  if (!stat.isDirectory()) return false;
  for (const ent of readdirSync(file, { withFileTypes: true })) {
    const cur = join(file, ent.name);
    if (ent.isDirectory()) {
      if (hasTS(cur)) return true;
      continue;
    }
    if (ent.isFile() && wantTSFile(cur)) return true;
  }
  return false;
};
const coveredBy = (inc: string[], file: string): boolean => {
  const cur = file.replace(/^\.\//, '');
  return inc.some((item) => {
    const want = item.replace(/^\.\//, '');
    return want === cur || cur.startsWith(`${want}/`);
  });
};
const specText = (ts: TsLike, node: import('typescript').Expression | undefined): string => {
  if (!node) return '';
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : '';
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
const importTypeSpec = (ts: TsLike, node: import('typescript').ImportTypeNode): string => {
  if (!ts.isLiteralTypeNode(node.argument)) return '';
  const lit = node.argument.literal;
  return ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit) ? lit.text : '';
};
const scanRefs = (
  ts: TsLike,
  file: string
): { local: string[]; roots: Map<string, RootMode> } => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const local = new Set<string>();
  const roots = new Map<string, RootMode>();
  const add = (spec: string, typeOnly: boolean) => {
    if (!spec || spec.startsWith('node:')) return;
    if (spec.startsWith('.')) return void local.add(spec);
    const key = rootOf(spec);
    if (!key) return;
    if (!typeOnly || roots.get(key) === 'runtime') return void roots.set(key, 'runtime');
    if (!roots.has(key)) roots.set(key, 'type');
  };
  const walk = (node: import('typescript').Node): void => {
    if (ts.isImportDeclaration(node)) add(specText(ts, node.moduleSpecifier), importDeclTypeOnly(ts, node));
    else if (ts.isExportDeclaration(node))
      add(specText(ts, node.moduleSpecifier), exportDeclTypeOnly(ts, node));
    else if (ts.isImportTypeNode(node) && !node.isTypeOf) add(importTypeSpec(ts, node), true);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    )
      add(specText(ts, node.arguments[0]), false);
    ts.forEachChild(node, walk);
  };
  walk(source);
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
      const target = resolveImportFile(file, spec, wantGraphFile);
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
    files: [...files].sort(),
    graphFiles: [...graphFiles].sort(),
    roots: [...roots.keys()].sort(),
    runtimeRoots: runtimeRoots.sort(),
    typeRoots: typeRoots.sort(),
  };
};
const hasRuntimePkgDep = (raw: RawPkg, key: string): boolean =>
  typeof raw.dependencies?.[key] === 'string' ||
  typeof raw.optionalDependencies?.[key] === 'string' ||
  typeof raw.peerDependencies?.[key] === 'string';
const depSpecOf = (raw: RawPkg, key: string): string => {
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
const relPath = (cwd: string, file: string): string => (relative(cwd, file) || file).split('\\').join('/');
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
    // Real awasm-noble dry-runs confirmed `!src/targets` clears excluded-module while `!src/targets/**` does not.
    return `!${hit}`;
  }
  return `!${rel}`;
};
const alreadyUnignored = (exclude: string[], rel: string): boolean => {
  for (const item of exclude) {
    if (!item.startsWith('!')) continue;
    const raw = item.trim().replace(/^!+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!raw || /[*?[\\]/.test(raw)) continue;
    if (rel === raw || rel.startsWith(`${raw}/`)) return true;
  }
  return false;
};
const ignoredGraphFiles = (cwd: string, files: string[]): Map<string, string> => {
  if (!files.length) return new Map();
  const rels = files.map((file) => relPath(cwd, file));
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
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const cwd = resolve(opts.cwd || process.cwd());
  const pkgFile = resolve(cwd, args.pkgArg);
  const jsrFile = resolve(cwd, 'jsr.json');
  guardChild(cwd, pkgFile, 'package');
  guardChild(cwd, jsrFile, 'jsr');
  const colorOn = opts.color ?? wantColor();
  const issues: LogIssue[] = [];
  if (!existsSync(jsrFile)) {
    issues.push({
      level: 'ERROR',
      ref: {
        file: 'jsr.json',
        issue: issueKind('add jsr.json next to package.json', 'jsr-file'),
        sym: 'file',
      },
    });
  } else {
    const rawPkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as RawPkg;
    const rawJsr = JSON.parse(readFileSync(jsrFile, 'utf8')) as RawJsr;
    const pkg = readPkg(pkgFile);
    const mods = listModules({ cwd, pkg, pkgFile });
    const exp = Object.fromEntries(mods.map((item) => [item.key, sourceOf(cwd, item.dtsFile)]));
    const act = normalizeExports(rawJsr.exports);
    for (const key of Object.keys(exp).sort()) {
      const want = exp[key];
      const got = act[key];
      if (got === want) continue;
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(
            `${got ? 'fix' : 'missing'} jsr export mapping; use ${key} -> ${want}`,
            'jsr-export'
          ),
          sym: 'exports',
        },
      });
    }
    for (const key of Object.keys(act).sort()) {
      if (exp[key]) continue;
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(
            `remove unexpected jsr export mapping; drop ${key} -> ${act[key]}`,
            'jsr-export-extra'
          ),
          sym: 'exports',
        },
      });
    }
    const wantName = jsrNameOf(pkg.name);
    if (rawJsr.name !== wantName)
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(`name mismatch; expected ${wantName} from package.json`, 'jsr-name'),
          sym: 'name',
        },
      });
    if (rawJsr.version !== rawPkg.version)
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(
            `version mismatch; expected ${String(rawPkg.version || '')} from package.json`,
            'jsr-version'
          ),
          sym: 'version',
        },
      });
    const ts = (opts.loadTS || loadTS)(pkgFile);
    const src = graph(
      ts,
      Object.values(exp)
        .map((item) => resolve(cwd, item))
        .filter((file) => existsSync(file))
    );
    const exclude = normalizeExclude(rawJsr.publish?.exclude);
    const ignored = ignoredGraphFiles(cwd, src.graphFiles);
    for (const file of [...ignored.keys()].sort())
      if (!alreadyUnignored(exclude, file))
      issues.push({
        level: 'ERROR',
        ref: {
          file,
          issue: issueKind(
            `unignore gitignored module graph path; add publish.exclude entry ${ignored.get(file) || `!${file}`}`,
            'jsr-gitignore'
          ),
          sym: 'gitignore',
        },
      });
    const jsrImports = normalizeImports(rawJsr.imports);
    for (const key of src.runtimeRoots) {
      if (!hasRuntimePkgDep(rawPkg, key))
        issues.push({
          level: 'ERROR',
          ref: {
            file: 'package.json',
            issue: issueKind(`add package dependency for exported source import ${key}`, 'jsr-dep'),
            sym: 'dependencies',
          },
        });
    }
    for (const key of src.roots) {
      const want = jsrNameOf(key);
      const spec = depSpecOf(rawPkg, key);
      const wantVer = spec && !localSpec(spec) ? spec : '';
      const wantImport = `jsr:${want}${wantVer ? `@${wantVer}` : ''}`;
      const got = parseJsr(jsrImports[key] || '');
      if (got.name === want && (!wantVer || got.version === wantVer)) continue;
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(`fix jsr import mapping; use ${key} -> ${wantImport}`, 'jsr-import'),
          sym: 'imports',
        },
      });
    }
    for (const key of Object.keys(jsrImports).sort()) {
      if (src.roots.includes(key)) continue;
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(
            `remove unexpected jsr import mapping; drop ${key} -> ${jsrImports[key]}`,
            'jsr-import-extra'
          ),
          sym: 'imports',
        },
      });
    }
    const include = normalizeInclude(rawJsr.publish?.include);
    for (const item of ['LICENSE', 'README.md', 'jsr.json'])
      if (!include.includes(item))
        issues.push({
          level: 'ERROR',
          ref: {
            file: 'jsr.json',
            issue: issueKind(`add required publish entry; use ${item}`, 'jsr-publish-required'),
            sym: 'publish',
          },
        });
    for (const item of include) {
      if (KEEP.has(item)) continue;
      if (hasTS(resolve(cwd, item))) continue;
      issues.push({
        level: 'ERROR',
        ref: {
          file: 'jsr.json',
          issue: issueKind(`remove non-source publish entry; drop ${item}`, 'jsr-publish-source'),
          sym: 'publish',
        },
      });
    }
    for (const file of src.files.map((item) => relative(cwd, item) || item).sort())
      if (!coveredBy(include, file))
        issues.push({
          level: 'ERROR',
          ref: {
            file: 'jsr.json',
            issue: issueKind(
              `add publish coverage for exported source graph; use ${file}`,
              'jsr-publish'
            ),
            sym: 'publish',
          },
        });
  }
  const failures = issues.filter((item) => item.level === 'ERROR').length;
  const warnings = issues.filter((item) => item.level === 'WARNING').length;
  const out: Result = {
    failures,
    passed: failures || warnings ? 0 : 1,
    skipped: 0,
    warnings,
  };
  printIssues('jsr', issues, colorOn);
  if (failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    throw new Error('JSR check found issues');
  }
  if (warnings) return console.error(`${status('warn', colorOn)} summary: ${summary(out)}`);
  console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
