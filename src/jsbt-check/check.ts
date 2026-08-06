// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt-check` runs the heavy audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt-check`
 *   `jsbt-check <selector>`  (bigint, bytes, comments, errors, importtime, jsdoc, jsr,
 *                             jsrpublish, mutate, patterns, readme, size, tsdoc, typeimport)
 * @module
 */
import * as TSDoc from '@microsoft/tsdoc';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { rmTempDir, tempDir } from 'baler/fs-modify.js';
import { runCli as runBigInt } from './bigint.ts';
import { runCli as runBytes } from './bytes.ts';
import { runCli as runComments } from './comments.ts';
import { runCli as runErrors } from './errors.ts';
import { runCli as runImportTime } from './importtime.ts';
import { runCli as runTSDoc } from './jsdoc.ts';
import { runCli as runJsr } from './jsr.ts';
import { runCli as runJsrPublish } from './jsrpublish.ts';
import { runCli as runMutate } from './mutate.ts';
import { runCli as runPatterns } from './patterns.ts';
import { docExampleImportNames, readmeImportNames, runCli as runReadme } from './readme.ts';
import { err, kb, listModules, publicCtx, readJson, readText } from 'baler';
import { runSize, type Built } from 'baler/size.js';
import { runCli as runTypeImport } from './typeimport.ts';
import { color, paint, wantColor } from 'baler/env.js';
import {
  defaultFast,
  fastWorkerCount,
  formatIssue,
  groupIssues,
  installedVersion,
  loadTs,
  makeIssue,
  RC_FILE,
  readJsbtRc,
  runWorker,
  tag as statusTag,
  stripAnsi,
  textLines,
  withSourceFileCache,
  writeJsbtRc,
  type Issue,
  type Level,
  type Ref,
} from './utils.ts';

type Opts = {
  color?: boolean;
  cwd?: string;
  runDir?: string;
  runJsrPublish?: typeof runJsrPublish;
  treeshakeOutDir?: string;
};
type Capture = {
  error?: string;
  hard?: boolean;
  ok: boolean;
  stderr: string;
  stdout: string;
  tree?: TreeIssue[];
};
type TimedCapture = Capture & { ms: number };
type Pick = { count: number; fatal: boolean; hard?: boolean; lines: string[] };
type SharedIssue = { count: number; fatal: boolean; lines: string[] };
type CheckHead =
  | 'bytes'
  | 'comments'
  | 'errors'
  | 'bigint'
  | 'importtime'
  | 'jsr'
  | 'jsrpublish'
  | 'mutate'
  | 'patterns'
  | 'readme'
  | 'size'
  | 'typeimport'
  | 'tsdoc';
type CheckRun = { head: CheckHead; pick: (res: Capture) => Pick; serial?: boolean };
type CheckArgs = ReturnType<typeof checkArgs>;
type CheckTask = (args: CheckArgs, opts: Opts, tree: TreeIssue[]) => Promise<void>;
type CheckWorkerData = {
  args: CheckArgs;
  entry: string;
  head?: CheckHead;
  heads?: CheckHead[];
  kind: typeof CHECK_WORKER;
  opts: { color?: boolean; cwd?: string; runDir?: string; treeshakeOutDir?: string };
  self: string;
};
type CheckJob = { i: number; item: CheckRun };

// ── `size` selector implementation: measure via the shared size engine, then audit the
// in-memory bundles for retained unused locals with a virtual TypeScript program.
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
export type TreeIssue = {
  file: string;
  id: string;
  kind?: 'limit' | 'unused';
  line: number;
  text: string;
};
const decoder = new TextDecoder();
const UNUSED = new Set([6133, 6198]); // TS6133, TS6198 typescript errors
const UNUSED_IGNORE = new Set(['__require', '__toESM']);

// Type-checks the bundles entirely in memory: no temp files, no filesystem access.
const audit = (
  ts: TsLike,
  entries: { name: string; text: string }[]
): Map<string, { code: number; line: number; text: string }[]> => {
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
  const res = new Map<string, { code: number; line: number; text: string }[]>();
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
      list.push({ code: diag.code, line: line + 1, text });
    res.set(name, list);
  }
  return res;
};

const treeIssueLog = (item: TreeIssue): Issue =>
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
const runSizeCheck = async (opts: {
  cwd?: string;
  onIssue?: (issue: TreeIssue) => void;
  outDir?: string;
  quiet?: boolean;
}): Promise<void> => {
  if (!opts.outDir) return err('expected outDir for the size check');
  const cwd = opts.cwd ?? process.cwd();
  const pkg = readJson<{ name?: string }>(join(cwd, 'package.json'));
  // Validate the whole budget map before any bundling: a config typo should fail fast.
  // A space-separated key budgets the combined bundle of all its selectors — the cost
  // when imported together, with shared code counted once.
  const budgets = Object.entries(readJsbtRc(cwd).sizeLimits || {}).map(([id, raw]) => {
    const ids = id.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) err('sizeLimits keys must name at least one selector');
    for (const sel of ids) {
      // Local selectors only: budgeting someone else's package pins nothing about ours.
      const foreign = sel.startsWith('@') && sel !== pkg.name && !sel.startsWith(`${pkg.name}/`);
      if (sel.startsWith('npm:') || foreign)
        err(`sizeLimits must name local modules or exports: ${sel}`);
    }
    return { bytes: limitBytes(id, raw), id, ids };
  });
  const built: { id: string; name: string; out: Built }[] = [];
  await runSize({
    cwd: opts.cwd,
    onBuilt: (out, meta) => built.push({ id: meta.id, name: meta.name, out }),
    outDir: opts.outDir,
    // Size stats are `baler --size`'s job; the check only audits the built bundles.
    silent: true,
  });
  const ts = loadTs(`${cwd}/package.json`) as unknown as TsLike;
  const issues = audit(
    ts,
    built.map((entry) => ({ name: entry.name, text: decoder.decode(entry.out.plain) }))
  );
  const logs: Issue[] = [];
  const report = (issue: TreeIssue): void => {
    opts.onIssue?.(issue);
    logs.push(treeIssueLog(issue));
  };
  for (const entry of built) {
    const list = issues.get(entry.name);
    if (!list?.length) continue;
    for (const item of list)
      report({ file: entry.name, id: entry.id, line: item.line, text: item.text });
  }
  // Budgets compare the gzipped size (the number `baler --size` reports as `gzip`), rebuilt
  // through the selector engine so keys use the same spelling as `baler --size` arguments.
  let over = 0;
  if (budgets.length) {
    const singles = budgets.filter((budget) => budget.ids.length === 1);
    const combos = budgets.filter((budget) => budget.ids.length > 1);
    const measured = new Map<string, Built>();
    if (singles.length) {
      const picks: Built[] = [];
      await runSize({
        cwd: opts.cwd,
        // Multi-selector runs prepend a combined `selection` row; only the picks map to keys.
        onBuilt: (out) => {
          if (out.module !== 'selection') picks.push(out);
        },
        localOnly: true,
        only: singles.map((budget) => budget.ids[0]),
        outDir: opts.outDir,
        silent: true,
      });
      singles.forEach((budget, i) => measured.set(budget.id, picks[i]));
    }
    // Combined budgets need one run each: the `selection` row is per-invocation.
    for (const budget of combos) {
      let selection: Built | undefined;
      await runSize({
        cwd: opts.cwd,
        onBuilt: (out) => {
          if (out.module === 'selection') selection = out;
        },
        localOnly: true,
        only: budget.ids,
        outDir: opts.outDir,
        silent: true,
      });
      if (!selection) err(`no combined bundle produced for sizeLimits key: ${budget.id}`);
      measured.set(budget.id, selection!);
    }
    for (const budget of budgets) {
      const gz = gzipSync(measured.get(budget.id)!.min, { level: 9 }).length;
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
  }
  if (!issues.size && !over) return;
  if (!opts.quiet) for (const line of groupIssues('size', logs, wantColor())) console.error(line);
  const parts = [
    issues.size ? `found unused locals in ${issues.size} release bundles` : '',
    over ? `found ${over} bundle${over === 1 ? '' : 's'} over sizeLimits budget` : '',
  ].filter(Boolean);
  err(parts.join('; '));
};
export const runSizeCheckCli: typeof runSizeCheck = runSizeCheck;

// ── `--generate-jsbtrc`: produce or update the repo's `.jsbtrc.json`, one section
// per selector; the other section always carries over untouched.
// `size`: one sizeLimits entry per public module, budgeted at the current gzip size
// rounded up to the next 0.01kb; existing entries are hand-set budgets, never touched.
// `readme`/`tsdoc`: exampleDependencies compiled from third-party imports across ALL
// example sources — runnable README fences plus TSDoc @example fences in public
// declarations — and pinned to the installed versions (the package itself and runtime
// `dependencies` are already trusted). Both selectors compile the same union, so
// regenerating from one can never drop the deps the other's examples need; stale pins
// refresh and dropped imports fall out.
const budgetValue = (gz: number): string => `${(Math.ceil((gz / 1024) * 100) / 100).toFixed(2)}kb`;
const generateSizeLimits = async (
  cwd: string,
  pkgName: string,
  existing: Record<string, unknown>,
  outDir: string
): Promise<{ added: number; limits: Record<string, unknown> }> => {
  type Row = { export: string; gz: number; label: string };
  const byModule = new Map<string, Row[]>();
  await runSize({
    cwd,
    onBuilt: (out, meta) => {
      if (out.module === pkgName) return;
      const rows = byModule.get(out.module) || [];
      rows.push({
        export: out.export,
        gz: gzipSync(out.min, { level: 9 }).length,
        label: meta.label,
      });
      byModule.set(out.module, rows);
    },
    outDir,
    silent: true,
  });
  const limits: Record<string, unknown> = { ...existing };
  let added = 0;
  for (const rows of byModule.values()) {
    // The whole-module row when present; single-export modules have no `all` row, and
    // their sole export bundle is byte-identical to the module bundle.
    const all = rows.find((row) => row.export === 'all');
    const row = all ?? (rows.length === 1 ? rows[0] : undefined);
    if (!row) continue;
    const label = all ? row.label : row.label.slice(0, -(row.export.length + 1));
    if (label in limits) continue;
    limits[label] = budgetValue(row.gz);
    added += 1;
  }
  return { added, limits };
};
const generateExampleDeps = (
  cwd: string,
  pkgName: string,
  runtime: Set<string>,
  head: 'readme' | 'tsdoc'
): Record<string, string> => {
  const names = new Set<string>();
  const readmeFile = join(cwd, 'README.md');
  if (existsSync(readmeFile))
    for (const name of readmeImportNames(readText(readmeFile))) names.add(name);
  else if (head === 'readme') err(`missing README.md in ${cwd}`);
  for (const mod of listModules(publicCtx('package.json', cwd)))
    for (const name of docExampleImportNames(readText(mod.dtsFile))) names.add(name);
  const next: Record<string, string> = {};
  for (const dep of [...names].sort()) {
    if (dep === pkgName || runtime.has(dep)) continue;
    const version = installedVersion(cwd, dep);
    if (!version) err(`cannot pin example dependency ${dep}: not installed; run npm install`);
    next[dep] = version as string;
  }
  return next;
};
export const runGenerateJsbtRc = async (opts: {
  cwd?: string;
  head: 'readme' | 'size' | 'tsdoc';
  outDir?: string;
}): Promise<void> => {
  const cwd = opts.cwd ?? process.cwd();
  const pkg = readJson<{ dependencies?: Record<string, unknown>; name?: string }>(
    join(cwd, 'package.json')
  );
  const rc = readJsbtRc(cwd);
  const out: {
    exampleDependencies?: Record<string, unknown>;
    sizeLimits?: Record<string, unknown>;
  } = { ...rc };
  let summary: string;
  if (opts.head === 'size') {
    if (!opts.outDir) return err('expected outDir for the size check');
    const { added, limits } = await generateSizeLimits(
      cwd,
      pkg.name || '',
      rc.sizeLimits || {},
      opts.outDir
    );
    out.sizeLimits = limits;
    summary = `${Object.keys(limits).length} size limits (${added} new)`;
  } else {
    const deps = generateExampleDeps(
      cwd,
      pkg.name || '',
      new Set(Object.keys(pkg.dependencies || {})),
      opts.head
    );
    out.exampleDependencies = deps;
    summary = `${Object.keys(deps).length} example dependencies`;
  }
  if (!Object.keys(out.exampleDependencies || {}).length) delete out.exampleDependencies;
  if (!Object.keys(out.sizeLimits || {}).length) delete out.sizeLimits;
  writeJsbtRc(cwd, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${RC_FILE}: ${summary}`);
};

const usage = `usage:
  jsbt-check
  jsbt-check bigint
  jsbt-check bytes
  jsbt-check comments
  jsbt-check errors
  jsbt-check importtime
  jsbt-check jsdoc
  jsbt-check jsr
  jsbt-check jsrpublish
  jsbt-check mutate
  jsbt-check patterns
  jsbt-check readme
  jsbt-check size
  jsbt-check tsdoc
  jsbt-check typeimport

examples:
  jsbt-check
  npm run check bigint
  jsbt-check size

size limits:
  jsbt-check size enforces gzip budgets from "sizeLimits" in .jsbtrc.json:
    { "sizeLimits": { "index.js/add": "4kb", "index.js/sign index.js/verify": "6kb" } }
  keys are baler --size selectors; values are bytes (4096) or a kb string ("4kb").
  a space-separated key budgets the combined bundle of all its selectors
  (their cost when imported together, shared code counted once).
  debug over-budget entries with baler --size <selector...> (stats) and
  baler <selector> > out.js (the measured bundle bytes).
  jsbt-check size --generate-jsbtrc produces or updates .jsbtrc.json with
  per-module budgets at current sizes (existing entries are kept);
  jsbt-check readme --generate-jsbtrc (or tsdoc --generate-jsbtrc) compiles its
  exampleDependencies section from README and TSDoc @example imports, pinned
  to installed versions`;
const CHECK_OUT = 'out-treeshake';
const CHECK_WORKER = 'jsbt-check-worker';
const WORKER = `import { workerData } from 'node:worker_threads';
process.argv[1] = workerData.entry;
await import(workerData.self);`;
const QUIET_ENV = {
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_loglevel: 'silent',
  npm_config_progress: 'false',
  npm_config_update_notifier: 'false',
} as const;
const NPM_INSTALL_FAIL = /^npm install failed(?::|$)/;
const CHECK_ALIASES = {
  bigint: 'bigint',
  bytes: 'bytes',
  comments: 'comments',
  errors: 'errors',
  importtime: 'importtime',
  jsdoc: 'tsdoc',
  jsr: 'jsr',
  jsrpublish: 'jsrpublish',
  mutate: 'mutate',
  patterns: 'patterns',
  readme: 'readme',
  size: 'size',
  typeimport: 'typeimport',
  tsdoc: 'tsdoc',
} as const satisfies Record<string, CheckHead>;
const HARD_ERROR_CHECKS = new Set<CheckHead>(['jsr', 'jsrpublish']);
const issueLines = (text: string): { cont: string[]; line: string; plain: string }[] => {
  const out: { cont: string[]; line: string; plain: string }[] = [];
  let prev: { cont: string[]; line: string; plain: string } | undefined;
  for (const line of textLines(text, true)) {
    const plain = stripAnsi(line);
    if (/^\[(?:error|warn|ERROR|WARN)\]\s/.test(plain)) {
      prev = plain.includes('summary:') ? undefined : { cont: [], line, plain };
      if (prev) out.push(prev);
      continue;
    }
    // Some subchecks print actionable continuation lines, e.g. canonical helper snippets.
    if (prev) prev.cont.push(line);
  }
  return out;
};
const recolorShared = (line: string, level: Level, on: boolean): string =>
  line.replace(/^\[(?:ERROR|WARN|INFO)\]/, statusTag(level, on));
const downgradeErrorLine = (line: string, on: boolean): string =>
  line.replace(/^\[(?:\x1b\[\d+(?:;\d+)*m)?ERROR(?:\x1b\[0m)?\]/, statusTag('WARN', on));
const checkPick = (head: CheckHead, out: Pick, on: boolean): Pick =>
  HARD_ERROR_CHECKS.has(head) || out.hard
    ? out
    : { ...out, fatal: false, lines: out.lines.map((line) => downgradeErrorLine(line, on)) };
const sharedIssues = (head: string, text: string, on: boolean): SharedIssue | undefined => {
  let cur = false;
  const out: string[] = [];
  let count = 0;
  let fatal = false;
  for (const line of textLines(text, true)) {
    const plain = stripAnsi(line);
    const tag = plain.match(/^\[(ERROR|WARN|INFO)\] (\w+): (.+)$/);
    if (tag && tag[2] === head) {
      cur = true;
      out.push(recolorShared(line, tag[1] as Level, on));
      count += Number(tag[3].match(/^(\d+)x /)?.[1] || 1);
      if (tag[1] === 'ERROR') fatal = true;
      continue;
    }
    if (cur && !/^\[(?:error|warn|pass|ERROR|WARN|INFO)\]\s/.test(plain)) {
      out.push(line);
      continue;
    }
    cur = false;
  }
  return out.length ? { count, fatal, lines: out } : undefined;
};
const duration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (hours || minutes) parts.push(`${minutes}min`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
};
const secondsDuration = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))} sec`;
const SLOW_CHECK_MS = 10_000;
const slowCheckStats = (items: { head: CheckHead; ms: number }[], on: boolean): string => {
  const slow = items.filter((item) => item.ms > SLOW_CHECK_MS);
  if (!slow.length) return '';
  const stats = slow.map((item) => `${item.head} (${duration(item.ms)})`).join(', ');
  return `. ${paint(`Slow checks: ${stats}.`, color.yellow, on)}`;
};
const checkDone = (
  total: number,
  ms: number,
  on: boolean,
  stats: { head: CheckHead; ms: number }[] = []
): string => {
  const count = paint(String(total), color.green, on);
  const noun = `check${total === 1 ? '' : 's'}`;
  const base = `${count} ${noun} finished in ${secondsDuration(ms)}`;
  return `${base}${slowCheckStats(stats, on)}`;
};
const checkFastWorkers = (): number => {
  const fast = defaultFast();
  return fast ? fastWorkerCount(fast) : 0;
};
const checkQuiet = (): boolean => {
  const value = process.env.JSBT_QUIET;
  return value === '1' || value === 'true';
};
const checkHeader = (total: number, on: boolean, quiet: boolean): string => {
  const env = paint(
    `(JSBT_QUIET=${quiet ? 1 : 0}, JSBT_FAST=${checkFastWorkers()})`,
    color.gray,
    on
  );
  return `${paint(String(total), color.green, on)} check${total === 1 ? '' : 's'} started ${env}`;
};
const checkDot = (fail: boolean): void => {
  const out = fail ? process.stderr : process.stdout;
  out.write(fail ? '!' : '.');
};
const timed = async (fn: () => Promise<Capture>): Promise<TimedCapture> => {
  const start = Date.now();
  const res = await fn();
  return { ...res, ms: Date.now() - start };
};
const untag = (line: string): string =>
  line.replace(/^\[(?:error|pass|warn|ERROR|WARN|INFO)\]\s*/, '').replace(/^\([^)]+\)\s*/, '');
const parseRef = (msg: string): Ref | undefined => {
  const hit = msg.match(/^(.+?):(.+?) \((\d+)\): (.+)$/);
  if (hit) {
    const [, file, section, line, issue] = hit;
    const sym = section ? `${line}/${section}` : line;
    return { file, issue, sym };
  }
  const simple = msg.match(/^(.+?):(.+?): (.+)$/);
  if (simple) {
    const [, file, section, issue] = simple;
    return { file, issue, sym: section };
  }
  const shared = msg.match(/^(.+?):(\S+) (.+)$/);
  if (!shared) return;
  const [, file, section, issue] = shared;
  return { file, issue, sym: section };
};
const withQuiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(QUIET_ENV)) {
    prev.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const capture = async (fn: () => Promise<void>): Promise<Capture> => {
  const prevLog = console.log;
  const prevErr = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  try {
    await fn();
    return { error: undefined, ok: true, stderr, stdout };
  } catch (error) {
    return { error: (error as Error).message, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const pickIssues = (head: string, res: Capture, on: boolean): Pick => {
  const grouped = sharedIssues(head, res.stderr, on);
  if (grouped) return { ...grouped, fatal: grouped.fatal || !res.ok };
  let fatal = !res.ok;
  const issues = issueLines(res.stderr).map((item) => {
    const msg = untag(item.plain);
    const level: Level = /^\[(?:warn|WARN)\]\s/.test(item.plain) ? 'WARN' : 'ERROR';
    if (level === 'ERROR') fatal = true;
    const ref = parseRef(msg);
    if (ref && item.cont.length) ref.issue += `\n${item.cont.join('\n')}`;
    return { level, ref: ref || { file: 'unknown', issue: msg, sym: '0' } };
  });
  if (issues.length || !res.error)
    return { count: issues.length, fatal, lines: groupIssues(head, issues, on) };
  return {
    count: 1,
    fatal: true,
    hard: res.hard,
    lines: [formatIssue('ERROR', head, { file: 'unknown', issue: res.error, sym: '0' }, on)],
  };
};
const resultSummary = (text: string): { failures: number; warnings: number } | undefined => {
  const match = text.match(/summary: \d+ passed, (\d+) warnings?, (\d+) failures?, \d+ skipped/);
  return match ? { failures: Number(match[2]), warnings: Number(match[1]) } : undefined;
};
const pickErrors = (res: Capture, on: boolean): Pick => {
  const out = pickIssues('errors', res, on);
  const resSum = resultSummary(`${res.stderr}\n${res.stdout}`);
  if (!resSum) return out;
  const sentinel =
    out.count === 1 &&
    out.lines.length === 1 &&
    stripAnsi(out.lines[0]).includes('unknown:0 Errors check found issues');
  // errors audit rows carry accepted wrong values as stdout evidence, not `[ERROR]` issue lines.
  const count = Math.max(sentinel ? 0 : out.count, resSum.failures + resSum.warnings);
  return {
    ...out,
    count,
    fatal: (sentinel ? false : out.fatal) || !!resSum.failures,
    lines: sentinel ? [] : out.lines,
  };
};
const pickErrorExamples = (res: Capture, on: boolean): Pick => {
  const issues: Issue[] = [];
  for (const item of issueLines(res.stderr)) {
    if (!item.plain.includes('(errors-example)')) continue;
    if (!item.plain.includes('could not derive valid runtime probes')) continue;
    const ref = parseRef(untag(item.plain));
    issues.push({
      level: 'WARN',
      ref: ref || { file: 'unknown', issue: untag(item.plain), sym: '0' },
    });
  }
  return { count: issues.length, fatal: false, lines: groupIssues('errors', issues, on) };
};
const pickLogs = (head: CheckHead, res: Capture, full = false): string[] =>
  full || head === 'errors' ? textLines(res.stdout, full) : [];
const warnInfoLine = (line: string): boolean => /^\[(?:WARN|INFO)\]/.test(stripAnsi(line));
const checkHead = (name: string | undefined): CheckHead | undefined =>
  name && Object.hasOwn(CHECK_ALIASES, name)
    ? CHECK_ALIASES[name as keyof typeof CHECK_ALIASES]
    : undefined;
const checkArgs = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { generate: false, head: undefined, help: true, outArg: '', pkgArg: '' };
  const rest: string[] = [];
  let generate = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--generate-jsbtrc') {
      generate = true;
      continue;
    }
    if (arg.startsWith('-')) err(`unknown check option: ${arg}`);
    rest.push(arg);
  }
  if (rest.some((arg) => arg === 'package.json' || /[/\\]package\.json$/.test(arg)))
    err('package.json positional argument was removed; run jsbt-check from the package directory');
  if (rest.length > 1) err('expected a single [check-name]');
  const head = checkHead(rest[0]);
  if (generate && head !== 'size' && head !== 'readme' && head !== 'tsdoc')
    err(
      '--generate-jsbtrc requires the readme, size, or tsdoc selector: jsbt-check size --generate-jsbtrc'
    );
  if (head) return { generate, head, help: false, outArg: CHECK_OUT, pkgArg: 'package.json' };
  if (rest[0] === 'tests') err(`unknown check selector: ${rest[0]}`);
  if (rest[0]?.startsWith('check-')) err(`unknown check selector: ${rest[0]}`);
  if (rest[0]) err(`unknown check selector: ${rest[0]}`);
  return { generate, head: undefined, help: false, outArg: CHECK_OUT, pkgArg: 'package.json' };
};
const checkTasks = {
  bigint: (args, opts) => runBigInt([args.pkgArg], opts),
  bytes: (args, opts) => runBytes([args.pkgArg], opts),
  comments: (args, opts) => runComments([args.pkgArg], opts),
  errors: (args, opts) =>
    runErrors([args.pkgArg], {
      color: opts.color,
      cwd: opts.cwd,
      examplesOnly: !args.head,
      runDir: opts.runDir,
    }),
  importtime: (args, opts) =>
    runImportTime([args.pkgArg], { color: opts.color, cwd: opts.cwd, quiet: true }),
  jsr: (args, opts) => runJsr([args.pkgArg], opts),
  jsrpublish: (args, opts) =>
    (opts.runJsrPublish || runJsrPublish)([args.pkgArg], {
      color: opts.color,
      cwd: opts.cwd,
      full: !!args.head,
    }),
  mutate: (args, opts) => runMutate([args.pkgArg], opts),
  patterns: (args, opts) => runPatterns([args.pkgArg], opts),
  readme: (args, opts) =>
    runReadme([args.pkgArg], { color: opts.color, cwd: opts.cwd, runDir: opts.runDir }),
  size: (args, opts, tree) =>
    runSizeCheck({
      cwd: opts.cwd,
      onIssue: (issue) => tree.push(issue),
      outDir: opts.treeshakeOutDir,
      quiet: !args.head,
    }),
  tsdoc: (args, opts) =>
    runTSDoc([args.pkgArg], {
      color: opts.color,
      cwd: opts.cwd,
      loadTSDoc: () => TSDoc as any,
      runDir: opts.runDir,
    }),
  typeimport: (args, opts) => runTypeImport([args.pkgArg], opts),
} satisfies Record<CheckHead, CheckTask>;
const runCheckTask = async (head: CheckHead, args: CheckArgs, opts: Opts): Promise<Capture> => {
  const tree: TreeIssue[] = [];
  const res = await withQuiet(() => capture(() => checkTasks[head](args, opts, tree)));
  if (tree.length) res.tree = tree;
  else if (res.error && NPM_INSTALL_FAIL.test(res.error)) res.hard = true;
  else if (head === 'size' && !res.ok) res.hard = true;
  return res;
};
const runCheckTaskTimed = (head: CheckHead, args: CheckArgs, opts: Opts): Promise<TimedCapture> =>
  timed(() => runCheckTask(head, args, opts));
const runWorkerMain = async () => {
  const data = workerData as CheckWorkerData;
  try {
    if (data.heads) {
      const out = await withSourceFileCache(async () => {
        const captures: TimedCapture[] = [];
        for (const head of data.heads!)
          captures.push(await runCheckTaskTimed(head, data.args, data.opts));
        return captures;
      });
      parentPort?.postMessage(out);
      return;
    }
    if (!data.head) throw new Error('missing check worker head');
    parentPort?.postMessage(await runCheckTask(data.head, data.args, data.opts));
  } catch (error) {
    const res = {
      error: (error as Error).message,
      ok: false,
      stderr: '',
      stdout: '',
    } satisfies Capture;
    parentPort?.postMessage(data.heads ? data.heads.map(() => ({ ...res, ms: 0 })) : res);
  }
};
const runCheckWorker = (head: CheckHead, args: CheckArgs, opts: Opts): Promise<Capture> =>
  // Workers isolate console/env capture for independent checks. npm-installing example checks
  // share the run dir and use process.chdir(), so runCheck keeps them on one main-thread lane.
  runWorker<Capture>(WORKER, {
    data: {
      args,
      entry: fileURLToPath(import.meta.url),
      head,
      kind: CHECK_WORKER,
      opts: {
        color: opts.color,
        cwd: opts.cwd,
        runDir: opts.runDir,
        treeshakeOutDir: opts.treeshakeOutDir,
      },
      self: import.meta.url,
    },
    error: (error) => ({ error, ok: false, stderr: '', stdout: '' }),
  });
const runCheck = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const args = checkArgs(argv);
  if (args.help) return console.log(usage);
  const checkTmp = tempDir('check');
  try {
    const taskOpts = {
      ...opts,
      cwd: opts.cwd || process.cwd(),
      runDir: join(checkTmp, 'build'),
      treeshakeOutDir: join(checkTmp, 'out-treeshake'),
    };
    // Generation replaces the check run entirely: measure/compile, write the rc, done.
    if (args.generate)
      return await runGenerateJsbtRc({
        cwd: taskOpts.cwd,
        head: args.head as 'readme' | 'size' | 'tsdoc',
        outDir: taskOpts.treeshakeOutDir,
      });
    const colorOn = opts.color ?? wantColor();
    const quiet = checkQuiet();
    const progressStart = (head: string): void => {
      if (!quiet) console.log(`☆ ${head}`);
    };
    const progressDone = (head: string, ok: boolean, ms: number): void => {
      if (quiet) return checkDot(!ok);
      const spent = ms >= 5_000 ? ` ${duration(ms)}` : '';
      console.log(
        paint(`${ok ? '✓' : '☓'} ${head}${spent}`, ok ? color.green : color.red, colorOn)
      );
    };
    const totalStart = Date.now();
    let hasFail = false;
    const check = (head: CheckHead, serial?: boolean): CheckRun => ({
      head,
      pick: (res) =>
        head === 'errors'
          ? args.head
            ? pickErrors(res, colorOn)
            : pickErrorExamples(res, colorOn)
          : pickIssues(head, res, colorOn),
      serial,
    });
    const allChecks: CheckRun[] = [
      check('readme', true),
      {
        head: 'size',
        pick: (res) => {
          const issues: Issue[] = (res.tree || []).map((item) => treeIssueLog(item));
          if (issues.length || !res.error) {
            return {
              count: issues.length,
              fatal: !!issues.length,
              lines: groupIssues('size', issues, colorOn),
            };
          }
          return {
            count: 1,
            fatal: true,
            hard: true,
            lines: [
              formatIssue(
                'ERROR',
                'size',
                { file: 'unknown', issue: res.error, sym: '0' },
                colorOn
              ),
            ],
          };
        },
        serial: true,
      },
      check('tsdoc', true),
      check('typeimport'),
      check('jsr'),
      check('jsrpublish', true),
      check('comments'),
      check('patterns'),
      check('errors', true),
      check('bigint'),
      check('bytes'),
      check('mutate'),
      {
        head: 'importtime',
        pick: (res) => pickIssues('importtime', res, colorOn),
        // Keep this policy explicit: the regression test source-scans it because timing is fragile.
        serial: true,
      },
    ];
    const list = args.head
      ? allChecks.filter((item) => item.head === args.head)
      : allChecks.filter((item) => item.head !== 'patterns');
    console.log(checkHeader(list.length, colorOn, quiet));
    if (!quiet) console.log();
    const res: TimedCapture[] = [];
    const save = async (i: number, head: CheckHead, fn: () => Promise<Capture>): Promise<void> => {
      progressStart(head);
      res[i] = await timed(fn);
      progressDone(head, HARD_ERROR_CHECKS.has(head) || res[i].hard ? res[i].ok : true, res[i].ms);
    };
    const workers = checkFastWorkers();
    const saveParallel = async (jobs: CheckJob[]): Promise<void> => {
      if (workers < 2 || jobs.length < 2) {
        for (const { i, item } of jobs)
          await save(i, item.head, () => runCheckWorker(item.head, args, taskOpts));
        return;
      }
      if (!quiet) for (const { item } of jobs) progressStart(item.head);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(workers, jobs.length) }, async () => {
          for (;;) {
            const job = jobs[next++];
            if (!job) return;
            res[job.i] = await timed(() => runCheckWorker(job.item.head, args, taskOpts));
          }
        })
      );
      for (const { i, item } of jobs)
        progressDone(
          item.head,
          HARD_ERROR_CHECKS.has(item.head) || res[i].hard ? res[i].ok : true,
          res[i].ms
        );
    };
    for (let i = 0; i < list.length; ) {
      const item = list[i];
      if (item.serial) {
        await save(i++, item.head, () => runCheckTask(item.head, args, taskOpts));
        continue;
      }
      const jobs: CheckJob[] = [];
      while (i < list.length && !list[i].serial) {
        jobs.push({ i, item: list[i] });
        i++;
      }
      await saveParallel(jobs);
    }
    if (!quiet) console.log();
    const totalMs = Date.now() - totalStart;
    let diagnosticGap = false;
    let quietDiagnostics = false;
    const quietShows = (out: Pick): boolean => !!out.lines.length;
    const printDiagnostic = (line: string, log: (line?: string) => void): void => {
      if (quiet && !quietDiagnostics) {
        console.log();
        quietDiagnostics = true;
      }
      if (!diagnosticGap && warnInfoLine(line)) {
        log();
        diagnosticGap = true;
      }
      log(line);
    };
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const cur = res[i];
      const out = checkPick(item.head, item.pick(cur), colorOn);
      if (out.fatal) hasFail = true;
      if (quiet && !out.fatal && !quietShows(out)) continue;
      if (item.head === 'errors') {
        for (const line of out.lines) printDiagnostic(line, console.error);
        if (args.head)
          for (const line of pickLogs(item.head, cur)) printDiagnostic(line, console.log);
      } else {
        const full = !!args.head && item.head === 'size';
        for (const line of pickLogs(item.head, cur, full)) printDiagnostic(line, console.log);
        for (const line of out.lines) printDiagnostic(line, console.error);
      }
    }
    const stats = list.map((item, i) => ({ head: item.head, ms: res[i].ms }));
    const done = checkDone(list.length, totalMs, colorOn, stats);
    if (hasFail) {
      console.error();
      throw new Error(done);
    }
    console.log();
    console.log(done);
  } finally {
    rmTempDir(checkTmp);
  }
};

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const [head] = argv;
  if (head === '--help' || head === '-h') return console.log(usage);
  return runCheck(argv, opts);
};

const main = async (): Promise<void> => {
  // jsbt's env namespace stays JSBT_*: forward the CSV knob to the baler engine.
  if (process.env.JSBT_CSV !== undefined && process.env.BALER_CSV === undefined)
    process.env.BALER_CSV = process.env.JSBT_CSV;
  try {
    await runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
const data = workerData as Partial<CheckWorkerData> | undefined;
if (!isMainThread && data?.kind === CHECK_WORKER) await runWorkerMain();
else if (isMainThread && entry && realpathSync(resolve(entry)) === realpathSync(self)) await main();
