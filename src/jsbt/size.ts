// Destructive ops SHOULD use only `fs-modify.ts`;
// do not call `rmSync`, `rmdirSync`, `unlinkSync`, or `writeFileSync` directly here.
/**
 * `jsbt-check size`: audit and budget the bundles a release actually ships.
 *
 * Bundling and measuring are `bismar`'s job — `bismar <selector> --size` and
 * `bismar -bs <selector>` print the file and per-export stats. This check reuses that
 * same engine, so a budget key is spelled exactly like a `bismar` selector and a budget
 * compares against the very gzip number `bismar -bs` prints — nothing here re-measures.
 * On top of those numbers it adds the two things a CI run needs:
 *
 * - unused locals that survived bundling, type-checked in memory with `noUnusedLocals`;
 * - `sizeLimits` gzip budgets from `.jsbtrc.json`.
 *
 * Cleanup rule for reported unused locals: keep diffs minimal. Prefer `/* @__PURE__ *\/`
 * on the exact offending call/expression first, instead of structural refactors. In practice
 * esbuild can keep parents alive through nested object-property builders, inline arithmetic
 * args, and object literals whose member initializers still look non-pure, so place the PURE
 * marker as close as possible to the offender; if a computed arg or top-level value still
 * survives, a tiny pure IIFE is the next-smallest fix.
 * @module
 */
import { join, resolve } from 'node:path';
import { foreignSelector } from 'bismar/refs.js';
import { measureRows, runSize, type RowData } from 'bismar/size.js';
import { writeJsbtRc } from '../fs-modify.ts';
import { readPkg, type Pkg } from './public.ts';
import {
  err,
  groupIssues,
  kb,
  loadTypeScriptApi,
  makeIssue,
  RC_FILE,
  readJsbtRc,
  wantColor,
  type Issue as LogIssue,
  type JsbtRc,
} from './utils.ts';

type TsLike = {
  ModuleKind: { ESNext: unknown };
  ScriptTarget: { ESNext: unknown };
  createProgram: (files: string[], opts: Record<string, unknown>, host?: unknown) => unknown;
  createSourceFile: (file: string, text: string, target: unknown, setParents?: boolean) => unknown;
  getPreEmitDiagnostics: (prog: unknown) => {
    code: number;
    file?: {
      fileName: string;
      getLineAndCharacterOfPosition: (pos: number) => { character: number; line: number };
      text: string;
    };
    length?: number;
    start?: number;
  }[];
};
type AuditItem = { line: number; text: string };
type Budget = { bytes: number; id: string; ids: string[] };
type Ctx = { cwd: string; pkg: Pkg };
// `file`/`line` locate an unused local inside a named bundle; a `limit` issue has neither
// (the budget lives in `.jsbtrc.json`) and reports through `id` and `text` alone.
export type SizeIssue = {
  file: string;
  id: string;
  kind?: 'limit';
  line: number;
  text: string;
};

const decoder = new TextDecoder();
const UNUSED = new Set([6133, 6198]); // TS6133, TS6198 typescript errors
const UNUSED_IGNORE = new Set(['__require', '__toESM']);

// Type-checks the bundles entirely in memory: no temp files, no filesystem access.
const audit = (ts: TsLike, entries: { name: string; text: string }[]): Map<string, AuditItem[]> => {
  const files = new Map(entries.map((entry) => [`/${entry.name}`, entry.text]));
  const opts = {
    allowJs: true,
    checkJs: true,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    noResolve: true,
    noUnusedLocals: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = {
    directoryExists: () => false,
    fileExists: (file: string) => files.has(file),
    getCanonicalFileName: (file: string) => file,
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => '/lib.d.ts',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (file: string, target: unknown) =>
      files.has(file)
        ? ts.createSourceFile(file, files.get(file) as string, target, true)
        : undefined,
    readFile: (file: string) => files.get(file),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const prog = ts.createProgram([...files.keys()], opts, host);
  const res = new Map<string, AuditItem[]>();
  for (const diag of ts.getPreEmitDiagnostics(prog).filter((diag) => UNUSED.has(diag.code))) {
    const sf = diag.file;
    if (!sf || diag.start === undefined) continue;
    const end = diag.start + (diag.length || 0);
    const { line } = sf.getLineAndCharacterOfPosition(diag.start);
    const text = sf.text
      .slice(diag.start, end || diag.start + 1)
      .split('\n')[0]
      .trim();
    if (UNUSED_IGNORE.has(text)) continue;
    const name = sf.fileName.slice(1);
    const list = res.get(name) || [];
    if (!list.some((item) => item.line === line + 1 && item.text === text))
      list.push({ line: line + 1, text });
    res.set(name, list);
  }
  return res;
};

export const sizeIssueLog = (item: SizeIssue): LogIssue =>
  item.kind === 'limit'
    ? makeIssue('error', `"${item.id}"`, '', item.text)
    : makeIssue('error', item.file, `${item.line}/${item.text}`, `unused (${item.id})`, 'size');

// `sizeLimits` values accept raw bytes (4096) or a kb string ("4kb", 1kb = 1024).
const LIMIT_KB = /^(\d+(?:\.\d+)?)\s*kb$/i;
const limitBytes = (id: string, raw: unknown): number => {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string') {
    const match = raw.trim().match(LIMIT_KB);
    if (match) return Math.round(Number(match[1]) * 1024);
  }
  return err(`invalid sizeLimits value for ${id}: use bytes (4096) or "4kb"`);
};
// Validated before any bundling: a config typo should fail fast, not after a full measure.
// A space-separated key budgets the combined bundle of all its selectors — the cost when
// imported together, with shared code counted once.
const readBudgets = (cwd: string, pkgName: string): Budget[] =>
  Object.entries(readJsbtRc(cwd).sizeLimits || {}).map(([id, raw]) => {
    const ids = id.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) err('sizeLimits keys must name at least one selector');
    // Local selectors only: budgeting someone else's package pins nothing about ours.
    // What counts as someone else's is bismar's rule to state, not ours to re-derive.
    for (const sel of ids)
      if (foreignSelector(sel, pkgName))
        err(`sizeLimits must name local modules or exports: ${sel}`);
    return { bytes: limitBytes(id, raw), id, ids };
  });
// A budget compares against `gzBytes` — the very number `bismar -bs` prints, so the
// figure in an over-budget message is the one debugging will reproduce. A single-selector
// key is spelled exactly like the row label of a bundle the full measuring pass already
// measured, so that row is reused; a combined key ("their cost when imported together")
// is per-invocation, and `single` narrows the run to exactly that combined row. Keys
// matching no label still go through bismar so its unknown-module hints reach the user.
const measureBudgets = (
  budgets: Budget[],
  gzipped: Map<string, number>,
  ctx: Ctx
): Promise<{ budget: Budget; gz: number }[]> =>
  Promise.all(
    budgets.map(async (budget) => {
      const gz =
        gzipped.get(budget.id) ??
        (await measureRows({ cwd: ctx.cwd, localOnly: true, only: budget.ids, single: true }))[0]
          ?.gzBytes;
      if (gz === undefined) return err(`no bundle produced for sizeLimits key: ${budget.id}`);
      return { budget, gz };
    })
  );

const withCtx = <T>(cwdArg: string | undefined, fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
  const cwd = resolve(cwdArg ?? process.cwd());
  return fn({ cwd, pkg: readPkg(join(cwd, 'package.json')) });
};

export const runSizeCheck = async (
  opts: {
    cwd?: string;
    onIssue?: (issue: SizeIssue) => void;
    quiet?: boolean;
  } = {}
): Promise<void> =>
  withCtx(opts.cwd, async (ctx) => {
    const budgets = readBudgets(ctx.cwd, ctx.pkg.name);
    const built: { id: string; name: string; text: string }[] = [];
    // onBuilt for the bundle text the audit reads, onRow for the sizes: one pass feeds
    // both, and the budget compare needs no bundle of its own for a key already measured.
    const gzipped = new Map<string, number>();
    await runSize({
      cwd: ctx.cwd,
      onBuilt: (out, meta) => {
        built.push({ id: meta.id, name: meta.name, text: decoder.decode(out.plain) });
      },
      onRow: (row) => void gzipped.set(row.label, row.gzBytes),
      // Size stats are `bismar --size`'s job; the check only audits the built bundles.
      silent: true,
    });
    const ts = loadTypeScriptApi<TsLike>('TypeScript compiler API', ['createProgram']);
    const issues = audit(ts, built);
    const logs: LogIssue[] = [];
    const report = (issue: SizeIssue): void => {
      opts.onIssue?.(issue);
      logs.push(sizeIssueLog(issue));
    };
    for (const entry of built) {
      for (const item of issues.get(entry.name) || [])
        report({ file: entry.name, id: entry.id, line: item.line, text: item.text });
    }
    let over = 0;
    for (const { budget, gz } of await measureBudgets(budgets, gzipped, ctx)) {
      if (gz <= budget.bytes) continue;
      over += 1;
      report({
        file: RC_FILE,
        id: budget.id,
        kind: 'limit',
        line: 0,
        text: `max allowed size is ${kb(budget.bytes)}kb gzipped, currently ${kb(gz)}kb`,
      });
    }
    if (!issues.size && !over) return;
    if (!opts.quiet) for (const line of groupIssues('size', logs, wantColor())) console.error(line);
    const parts = [
      issues.size ? `found unused locals in ${issues.size} release bundles` : '',
      over ? `found ${over} bundle${over === 1 ? '' : 's'} over sizeLimits budget` : '',
    ].filter(Boolean);
    err(parts.join('; '));
  });

// `--gen-config`: one `sizeLimits` entry per public module, budgeted at the current
// gzip size rounded up to the next 0.01kb. Existing entries are hand-set budgets and are
// never touched; the rest of `.jsbtrc.json` carries over untouched.
const budgetValue = (gz: number): string => `${(Math.ceil((gz / 1024) * 100) / 100).toFixed(2)}kb`;
const generateSizeLimits = async (
  ctx: Ctx,
  existing: Record<string, unknown>
): Promise<{ added: number; limits: Record<string, unknown> }> => {
  const byModule = new Map<string, RowData[]>();
  // Rows, not bundles: the sizes come measured, and every row already knows the two
  // spellings this needs — the key to write (`moduleLabel`) and which row it belongs to.
  for (const row of await measureRows({ cwd: ctx.cwd })) {
    // The package-wide row is a measurement, not a module anyone can import.
    if (row.module === ctx.pkg.name) continue;
    byModule.set(row.moduleLabel, [...(byModule.get(row.moduleLabel) || []), row]);
  }
  const limits: Record<string, unknown> = { ...existing };
  let added = 0;
  for (const [label, rows] of byModule) {
    // The whole-module row when present; single-export modules have no `all` row, and
    // their sole export bundle is byte-identical to the module bundle.
    const row = rows.find((item) => item.export === 'all') ?? (rows.length === 1 ? rows[0] : null);
    if (!row || label in limits) continue;
    limits[label] = budgetValue(row.gzBytes);
    added += 1;
  }
  return { added, limits };
};

export const runGenerateJsbtRc = async (opts: { cwd?: string } = {}): Promise<void> =>
  withCtx(opts.cwd, async (ctx) => {
    const rc = readJsbtRc(ctx.cwd);
    const { added, limits } = await generateSizeLimits(ctx, rc.sizeLimits || {});
    // Every other section carries over byte-for-byte: this command owns `sizeLimits` alone.
    const out: JsbtRc = { ...rc, sizeLimits: limits };
    if (!Object.keys(limits).length) delete out.sizeLimits;
    writeJsbtRc(ctx.cwd, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`${RC_FILE}: ${Object.keys(limits).length} size limits (${added} new)`);
  });
