// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt` dispatches the shared build and audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt bundle test/build`
 *   `jsbt check package.json`
 *   `jsbt check package.json bigint`
 *   `jsbt check package.json bytes`
 *   `jsbt check package.json comments`
 *   `jsbt check package.json errors`
 *   `jsbt check package.json importtime`
 *   `jsbt check package.json jsdoc`
 *   `jsbt check package.json jsr`
 *   `jsbt check package.json jsrpublish`
 *   `jsbt check package.json mutate`
 *   `jsbt check package.json patterns`
 *   `jsbt check package.json readme`
 *   `jsbt check package.json tests`
 *   `jsbt check package.json treeshake`
 *   `jsbt check package.json tsdoc`
 *   `jsbt check package.json typeimport`
 *   `jsbt check-install package.json`
 * @module
 */
import * as TSDoc from '@microsoft/tsdoc';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runCli as runBigInt } from './bigint.ts';
import { runCli as runBuild } from './bundle.ts';
import { runCli as runBytes } from './bytes.ts';
import { runCli as runCheckInstall } from './check-install.ts';
import { runCli as runComments } from './comments.ts';
import { runCli as runErrors } from './errors.ts';
import { runCli as runImportTime } from './importtime.ts';
import { runCli as runTSDoc } from './jsdoc.ts';
import { runCli as runJsr } from './jsr.ts';
import { runCli as runJsrPublish } from './jsrpublish.ts';
import { runCli as runMutate } from './mutate.ts';
import { runCli as runPatterns } from './patterns.ts';
import { runCli as runReadme } from './readme.ts';
import { runCli as runTests } from './tests.ts';
import { runCli as runTreeShaking, treeIssueLog, type TreeIssue } from './treeshake.ts';
import { runCli as runTypeImport } from './typeimport.ts';
import {
  color,
  err,
  formatIssue,
  groupIssues,
  paint,
  runWorker,
  tag as statusTag,
  stripAnsi,
  textLines,
  wantColor,
  type Issue,
  type Level,
  type Ref,
} from './utils.ts';

type Opts = { color?: boolean; cwd?: string; runJsrPublish?: typeof runJsrPublish };
type Capture = { error?: string; ok: boolean; stderr: string; stdout: string; tree?: TreeIssue[] };
type TimedCapture = Capture & { ms: number };
type Pick = { count: number; fatal: boolean; lines: string[] };
type SharedIssue = { count: number; fatal: boolean; lines: string[] };
type CmdRun = (argv: string[], opts: Opts) => Promise<void>;
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
  | 'tests'
  | 'treeshake'
  | 'typeimport'
  | 'tsdoc';
type CheckRun = { head: CheckHead; pick: (res: Capture) => Pick; serial?: boolean };
type CheckCount = { count: number; head: string; ms: number };
type CheckArgs = ReturnType<typeof checkArgs>;
type CheckTask = (args: CheckArgs, opts: Opts, tree: TreeIssue[]) => Promise<void>;
type CheckWorkerData = {
  args: CheckArgs;
  entry: string;
  head: CheckHead;
  kind: typeof CHECK_WORKER;
  opts: { color?: boolean; cwd?: string };
  self: string;
};

const usage = `usage:
  jsbt bundle <build-dir> [--auto] [--no-prefix]
  jsbt check <package.json>
  jsbt check <package.json> bigint
  jsbt check <package.json> bytes
  jsbt check <package.json> comments
  jsbt check <package.json> errors
  jsbt check <package.json> importtime
  jsbt check <package.json> jsdoc
  jsbt check <package.json> jsr
  jsbt check <package.json> jsrpublish
  jsbt check <package.json> mutate
  jsbt check <package.json> patterns
  jsbt check <package.json> readme
  jsbt check <package.json> tests
  jsbt check <package.json> treeshake [out-dir]
  jsbt check <package.json> tsdoc
  jsbt check <package.json> typeimport
  jsbt check-install <package.json>

examples:
  npx --no @paulmillr/jsbt bundle test/build
  npx --no @paulmillr/jsbt check package.json
  npm run check bigint
  npx --no @paulmillr/jsbt check package.json treeshake`;
const CHECK_OUT = 'test/build/out-treeshake';
const CHECK_WORKER = 'jsbt-check-worker';
const WORKER = `import { workerData } from 'node:worker_threads';
process.argv[1] = workerData.entry;
await import(workerData.self);`;
const CHECK_NOTE =
  'Checker may return not real errors or flag correct code; it is here to point at issues, not something that should have strict zero errors';
const QUIET_ENV = {
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_loglevel: 'silent',
  npm_config_progress: 'false',
  npm_config_update_notifier: 'false',
} as const;
const MUTATION_LOG = /^(?:delete\t|write\t|> cd |>\s+npm install$)/;
const CHECK_ALIASES = {
  'check-bigint': 'bigint',
  'check-bytes': 'bytes',
  'check-comments': 'comments',
  'check-errors': 'errors',
  'check-importtime': 'importtime',
  'check-jsdoc': 'tsdoc',
  'check-jsr': 'jsr',
  'check-jsrpublish': 'jsrpublish',
  'check-mutate': 'mutate',
  'check-patterns': 'patterns',
  'check-readme': 'readme',
  'check-tests': 'tests',
  'check-typeimport': 'typeimport',

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
  tests: 'tests',
  treeshake: 'treeshake',
  typeimport: 'typeimport',
  tsdoc: 'tsdoc',
} as const satisfies Record<string, CheckHead>;
const issueLines = (text: string): { cont: string[]; line: string; plain: string }[] => {
  const out: { cont: string[]; line: string; plain: string }[] = [];
  let prev: { cont: string[]; line: string; plain: string } | undefined;
  for (const line of textLines(text, true)) {
    const plain = stripAnsi(line);
    if (/^\[(?:error|warn|ERROR|WARNING)\]\s/.test(plain)) {
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
  line.replace(/^\[(?:ERROR|WARNING|INFO)\]/, statusTag(level, on));
const sharedIssues = (head: string, text: string, on: boolean): SharedIssue | undefined => {
  let cur = false;
  const out: string[] = [];
  let count = 0;
  let fatal = false;
  for (const line of textLines(text, true)) {
    const plain = stripAnsi(line);
    const tag = plain.match(/^\[(ERROR|WARNING|INFO)\] \(([^)]+)\) (.+)$/);
    if (tag && tag[2] === head) {
      cur = true;
      out.push(recolorShared(line, tag[1] as Level, on));
      count += Number(tag[3].match(/^(\d+)x /)?.[1] || 1);
      if (tag[1] === 'ERROR') fatal = true;
      continue;
    }
    if (cur && !/^\[(?:error|warn|pass|ERROR|WARNING|INFO)\]\s/.test(plain)) {
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
const timed = async (fn: () => Promise<Capture>): Promise<TimedCapture> => {
  const start = Date.now();
  const res = await fn();
  return { ...res, ms: Date.now() - start };
};
const elapsed = (ms: number, on: boolean): string => paint(duration(ms), color.yellow, on);
const untag = (line: string): string =>
  line.replace(/^\[(?:error|pass|warn|ERROR|WARNING|INFO)\]\s*/, '').replace(/^\([^)]+\)\s*/, '');
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
    const level: Level = /^\[(?:warn|WARNING)\]\s/.test(item.plain) ? 'WARNING' : 'ERROR';
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
      level: 'WARNING',
      ref: ref || { file: 'unknown', issue: untag(item.plain), sym: '0' },
    });
  }
  return { count: issues.length, fatal: false, lines: groupIssues('errors', issues, on) };
};
const pickLogs = (head: CheckHead, res: Capture, full = false): string[] =>
  textLines(res.stdout, full).filter(
    (line) => full || head === 'errors' || MUTATION_LOG.test(line)
  );
const checkHead = (name: string | undefined): CheckHead | undefined =>
  name && Object.hasOwn(CHECK_ALIASES, name)
    ? CHECK_ALIASES[name as keyof typeof CHECK_ALIASES]
    : undefined;
const checkArgs = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { head: undefined, help: true, outArg: '', pkgArg: '' };
  if (argv.length < 1 || argv.length > 3)
    err('expected <package.json> [check-name|out-dir] [out-dir]');
  const head = checkHead(argv[1]);
  if (head) return { head, help: false, outArg: argv[2] || CHECK_OUT, pkgArg: argv[0] };
  return { head: undefined, help: false, outArg: argv[1] || CHECK_OUT, pkgArg: argv[0] };
};
const checkTasks = {
  bigint: (args, opts) => runBigInt([args.pkgArg], opts),
  bytes: (args, opts) => runBytes([args.pkgArg], opts),
  comments: (args, opts) => runComments([args.pkgArg], opts),
  errors: (args, opts) => runErrors([args.pkgArg], opts),
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
  readme: (args, opts) => runReadme([args.pkgArg], opts),
  tests: (args, opts) => runTests([args.pkgArg], opts),
  treeshake: (args, opts, tree) =>
    runTreeShaking([args.pkgArg, args.outArg], {
      cwd: opts.cwd,
      onIssue: (issue) => tree.push(issue),
      quiet: !args.head,
    }),
  tsdoc: (args, opts) =>
    runTSDoc([args.pkgArg], {
      color: opts.color,
      cwd: opts.cwd,
      loadTSDoc: () => TSDoc as any,
    }),
  typeimport: (args, opts) => runTypeImport([args.pkgArg], opts),
} satisfies Record<CheckHead, CheckTask>;
const runCheckTask = async (head: CheckHead, args: CheckArgs, opts: Opts): Promise<Capture> => {
  const tree: TreeIssue[] = [];
  const res = await withQuiet(() => capture(() => checkTasks[head](args, opts, tree)));
  if (tree.length) res.tree = tree;
  return res;
};
const runWorkerMain = async () => {
  const data = workerData as CheckWorkerData;
  try {
    parentPort?.postMessage(await runCheckTask(data.head, data.args, data.opts));
  } catch (error) {
    parentPort?.postMessage({
      error: (error as Error).message,
      ok: false,
      stderr: '',
      stdout: '',
    } satisfies Capture);
  }
};
const runCheckWorker = (head: CheckHead, args: CheckArgs, opts: Opts): Promise<Capture> =>
  // Workers isolate console/env capture for independent checks. npm-installing example checks
  // share test/build and use process.chdir(), so runCheck keeps them on one main-thread lane.
  runWorker<Capture>(WORKER, {
    data: {
      args,
      entry: fileURLToPath(import.meta.url),
      head,
      kind: CHECK_WORKER,
      opts: { color: opts.color, cwd: opts.cwd },
      self: import.meta.url,
    },
    error: (error) => ({ error, ok: false, stderr: '', stdout: '' }),
  });
const runCheck = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const args = checkArgs(argv);
  if (args.help) return console.log(usage);
  const colorOn = opts.color ?? wantColor();
  console.log(
    formatIssue('INFO', 'check', { file: args.pkgArg, issue: CHECK_NOTE, sym: 'note' }, colorOn)
  );
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
      head: 'treeshake',
      pick: (res) => {
        const issues: Issue[] = (res.tree || []).map((item) => treeIssueLog(opts.cwd, item));
        if (issues.length || !res.error) {
          return {
            count: issues.length,
            fatal: !!issues.length,
            lines: groupIssues('treeshake', issues, colorOn),
          };
        }
        return {
          count: 1,
          fatal: true,
          lines: [
            formatIssue(
              'ERROR',
              'treeshake',
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
    check('tests'),
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
  const res: TimedCapture[] = [];
  const save = async (i: number, fn: () => Promise<Capture>): Promise<void> => {
    res[i] = await timed(fn);
  };
  const serial = async () => {
    for (const [i, item] of list.entries())
      if (item.serial) await save(i, () => runCheckTask(item.head, args, opts));
  };
  const parallel = list.map((item, i) =>
    item.serial ? Promise.resolve() : save(i, () => runCheckWorker(item.head, args, opts))
  );
  await Promise.all([...parallel, serial()]);
  const totalMs = Date.now() - totalStart;
  const counts: CheckCount[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const cur = res[i];
    const out = item.pick(cur);
    if (out.fatal) hasFail = true;
    if (item.head === 'errors') {
      for (const line of out.lines) console.error(line);
      if (args.head) for (const line of pickLogs(item.head, cur)) console.log(line);
    } else {
      const full = !!args.head && item.head === 'treeshake';
      for (const line of pickLogs(item.head, cur, full)) console.log(line);
      for (const line of out.lines) console.error(line);
    }
    counts.push({ count: out.count, head: item.head, ms: cur.ms });
  }
  const summary = counts
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((item) => `${item.head}(${item.count}, ${elapsed(item.ms, colorOn)})`)
    .join(', ');
  const done = `jsbt check done in ${elapsed(totalMs, colorOn)}: ${summary}`;
  if (!hasFail) return console.log(done);
  throw new Error(done);
};

const cmdRun = {
  bigint: runBigInt,
  bytes: runBytes,
  check: runCheck,
  'check-bigint': runBigInt,
  'check-bytes': runBytes,
  'check-comments': runComments,
  'check-error': runErrors,
  'check-errors': runErrors,
  'check-importtime': runImportTime,
  'check-install': (argv, opts) => runCheckInstall(argv, { cwd: opts.cwd }),
  'check-jsdoc': (argv, opts) =>
    runTSDoc(argv, { color: opts.color, cwd: opts.cwd, loadTSDoc: () => TSDoc as any }),
  'check-jsr': runJsr,
  'check-jsrpublish': (argv, opts) =>
    (opts.runJsrPublish || runJsrPublish)(argv, {
      color: opts.color,
      cwd: opts.cwd,
      full: true,
    }),
  'check-mutate': runMutate,
  'check-patterns': runPatterns,
  'check-readme': runReadme,
  'check-tests': runTests,
  'check-typeimport': runTypeImport,
  comments: runComments,
  error: runErrors,
  errors: runErrors,
  bundle: runBuild,
  build: runBuild,
  esbuild: runBuild,
  importtime: runImportTime,
  jsr: runJsr,
  jsrpublish: (argv, opts) =>
    (opts.runJsrPublish || runJsrPublish)(argv, {
      color: opts.color,
      cwd: opts.cwd,
      full: true,
    }),
  mutate: runMutate,
  patterns: runPatterns,
  readme: runReadme,
  tests: runTests,
  treeshake: (argv, opts) => runTreeShaking(argv, { cwd: opts.cwd }),
  tsdoc: (argv, opts) =>
    runTSDoc(argv, { color: opts.color, cwd: opts.cwd, loadTSDoc: () => TSDoc as any }),
  typeimport: runTypeImport,
} satisfies Record<string, CmdRun>;
type Cmd = keyof typeof cmdRun;
const COMMANDS = new Set<Cmd>(Object.keys(cmdRun) as Cmd[]);
const cmd = (name: string): Cmd | undefined =>
  COMMANDS.has(name as Cmd) ? (name as Cmd) : undefined;

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const [head, ...rest] = argv;
  if (!head || head === '--help' || head === '-h') return console.log(usage);
  const sub = cmd(head);
  if (!sub) throw new Error(`unknown jsbt command: ${head}\n\n${usage}`);
  return cmdRun[sub](rest, opts);
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
const data = workerData as Partial<CheckWorkerData> | undefined;
if (!isMainThread && data?.kind === CHECK_WORKER) void runWorkerMain();
else if (isMainThread && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
