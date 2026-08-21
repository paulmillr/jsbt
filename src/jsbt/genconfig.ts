// Destructive ops SHOULD use only `fs-modify.ts`;
// do not call `rmSync`, `rmdirSync`, `unlinkSync`, or `writeFileSync` directly here.
/**
 * `jsbt-check --gen-config`: populate `.jsbtrc.json` `exampleDependencies` from the
 * examples the checks actually run.
 *
 * The readme check runs runnable README fences and the tsdoc check runs `@example`
 * blocks from the public `.d.ts` surface; both may only import `dependencies` plus the
 * `exampleDependencies` allowlist. This scans those same example sources for bare package
 * imports and adds the ones nothing trusts yet, pinned to the exact installed version —
 * the pin `runDepNames` later verifies. Existing entries are hand-set and never touched;
 * the rest of `.jsbtrc.json` carries over byte-for-byte.
 * @module
 */
import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { writeJsbtRc } from '../fs-modify.ts';
import { listModules, publicCtx, type PublicCtx } from './public.ts';
import { parseReadme } from './readme.ts';
import {
  docCommentLines,
  err,
  installedVersion,
  RC_FILE,
  readJsbtRc,
  readJson,
  readText,
  type JsbtRc,
} from './utils.ts';

const DOC_COMMENT = /\/\*\*[\s\S]*?\*\//g;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const BARE_PKG_NAME = /^(@[\w.-]+\/)?[\w.-]+$/;

// Fenced code inside `@example` blocks only: prose fences elsewhere in a doc comment are
// not executed by the tsdoc check, so their imports prove nothing about needed deps.
const exampleFences = (lines: string[]): string[] => {
  const out: string[] = [];
  let inExample = false;
  let fenced = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (!fenced && /^@\w+/.test(line)) {
      inExample = /^@example\b/.test(line);
      continue;
    }
    if (!inExample) continue;
    if (/^`{3,}/.test(line)) {
      if (fenced) {
        out.push(buf.join('\n'));
        buf = [];
      }
      fenced = !fenced;
      continue;
    }
    if (fenced) buf.push(line);
  }
  return out;
};
const readmeExampleCode = (cwd: string): string[] => {
  const file = join(cwd, 'README.md');
  if (!existsSync(file)) return [];
  return parseReadme(readText(file))
    .filter((block) => block.runnable && block.kind)
    .map((block) => block.code);
};
const tsdocExampleCode = (ctx: PublicCtx): string[] => {
  const out: string[] = [];
  for (const mod of listModules(ctx)) {
    for (const comment of readText(mod.dtsFile).match(DOC_COMMENT) || [])
      out.push(...exampleFences(docCommentLines(comment)));
  }
  return out;
};
// A specifier names a package only when it is bare and not a node builtin; subpaths
// collapse to the package root, which is what node_modules resolution installs.
const specPkg = (spec: string): string => {
  if (!spec || /^[./#]/.test(spec) || spec.startsWith('node:')) return '';
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!BARE_PKG_NAME.test(name) || builtinModules.includes(name)) return '';
  return name;
};
const importedPkgs = (codes: string[]): string[] => {
  const out = new Set<string>();
  for (const code of codes) {
    for (const match of code.matchAll(IMPORT_SPEC)) {
      const name = specPkg(match[1]);
      if (name) out.add(name);
    }
  }
  return [...out].sort();
};

export const runGenerateJsbtRc = async (opts: { cwd?: string } = {}): Promise<void> => {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const ctx = publicCtx('package.json', cwd);
  const rc = readJsbtRc(cwd);
  const deps: Record<string, unknown> = { ...(rc.exampleDependencies || {}) };
  const pkg = readJson<{ dependencies?: Record<string, unknown> }>(ctx.pkgFile);
  const trusted = new Set(Object.keys(pkg.dependencies || {}));
  let added = 0;
  const missing: string[] = [];
  for (const dep of importedPkgs([...readmeExampleCode(ctx.cwd), ...tsdocExampleCode(ctx)])) {
    // `esbuild` and the package itself are provided automatically; `dependencies` are
    // implicitly trusted — listing any of them would fail the config validation.
    if (dep === ctx.pkg.name || dep === 'esbuild') continue;
    if (trusted.has(dep) || dep in deps) continue;
    const found = installedVersion(ctx.cwd, dep);
    if (!found) {
      missing.push(dep);
      continue;
    }
    deps[dep] = found;
    added += 1;
  }
  // Every other section carries over byte-for-byte: this command owns `exampleDependencies`.
  const out: JsbtRc = { ...rc, exampleDependencies: deps };
  if (!Object.keys(deps).length) delete out.exampleDependencies;
  writeJsbtRc(cwd, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `${RC_FILE}: ${Object.keys(deps).length} example dependenc${
      Object.keys(deps).length === 1 ? 'y' : 'ies'
    } (${added} new)`
  );
  // An uninstalled import cannot be pinned; the pinnable entries are written above, so
  // installing the rest and re-running converges. Fail so the gap does not pass silently.
  if (missing.length) {
    err(
      [
        `examples import packages that are not installed and could not be pinned: `,
        `${missing.join(', ')}; run npm install -D ${missing.join(' ')} `,
        `and re-run jsbt-check --gen-config`,
      ].join('')
    );
  }
};
