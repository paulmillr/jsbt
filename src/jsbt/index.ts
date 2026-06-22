// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt` dispatches the shared build and audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt bundle`
 *   `jsbt check`
 *   `jsbt check --project=directory`
 *   `jsbt check bigint`
 *   `jsbt check bytes`
 *   `jsbt check comments`
 *   `jsbt check errors`
 *   `jsbt check importtime`
 *   `jsbt check jsdoc`
 *   `jsbt check jsr`
 *   `jsbt check jsrpublish`
 *   `jsbt check mutate`
 *   `jsbt check patterns`
 *   `jsbt check readme`
 *   `jsbt check treeshake`
 *   `jsbt check tsdoc`
 *   `jsbt check typeimport`
 *   `jsbt check-install package.json`
 * @module
 */
import * as TSDoc from '@microsoft/tsdoc';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { checkTempDir, rmCheckTempDir } from '../fs-modify.ts';
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
import { runCli as runTreeShaking, treeIssueLog, type TreeIssue } from './treeshake.ts';
import { runCli as runTypeImport } from './typeimport.ts';
import {
  color,
  err,
  formatIssue,
  groupIssues,
  jsbtWorkerLimit,
  paint,
  parseFast,
  runWorker,
  tag as statusTag,
  stripAnsi,
  textLines,
  wantColor,
  withSourceFileCache,
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
  | 'treeshake'
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

const usage = `usage:
  jsbt bundle [--dir=<build-dir>] [--no-prefix] [--stats]
  jsbt check [--project=<directory>]
  jsbt check [--project=<directory>] bigint
  jsbt check [--project=<directory>] bytes
  jsbt check [--project=<directory>] comments
  jsbt check [--project=<directory>] errors
  jsbt check [--project=<directory>] importtime
  jsbt check [--project=<directory>] jsdoc
  jsbt check [--project=<directory>] jsr
  jsbt check [--project=<directory>] jsrpublish
  jsbt check [--project=<directory>] mutate
  jsbt check [--project=<directory>] patterns
  jsbt check [--project=<directory>] readme
  jsbt check [--project=<directory>] treeshake
  jsbt check [--project=<directory>] tsdoc
  jsbt check [--project=<directory>] typeimport
  jsbt check-install <package.json>

examples:
  npx --no @paulmillr/jsbt bundle
  npx --no @paulmillr/jsbt check
  npx --no @paulmillr/jsbt check --project=packages/pkg-a
  npm run check bigint
  npx --no @paulmillr/jsbt check treeshake`;
const CHECK_OUT = 'test/build/out-treeshake';
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
const MUTATION_LOG = /^(?:delete\t|install\t|write\t)/;
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
  treeshake: 'treeshake',
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
  HARD_ERROR_CHECKS.has(head)
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
  const fast = parseFast(process.env.JSBT_FAST);
  return fast ? jsbtWorkerLimit(1) : 0;
};
const checkQuiet = (): boolean => {
  const value = process.env.JSBT_QUIET;
  return value === '1' || value === 'true';
};
const checkHeader = (total: number, on: boolean, quiet: boolean): string => {
  const workers = checkFastWorkers();
  const features = [quiet ? '+quiet' : '', workers ? `+fast-x${workers}` : ''].filter(Boolean);
  const modes = features.length ? `(${features.join(' ')}) ` : '';
  return `${paint(String(total), color.green, on)} check${total === 1 ? '' : 's'} ${modes}started...`;
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
  textLines(res.stdout, full).filter(
    (line) => full || head === 'errors' || MUTATION_LOG.test(line)
  );
const warnInfoLine = (line: string): boolean => /^\[(?:WARN|INFO)\]/.test(stripAnsi(line));
const checkHead = (name: string | undefined): CheckHead | undefined =>
  name && Object.hasOwn(CHECK_ALIASES, name)
    ? CHECK_ALIASES[name as keyof typeof CHECK_ALIASES]
    : undefined;
const checkArgs = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { head: undefined, help: true, outArg: '', pkgArg: '', projectArg: '.' };
  const rest: string[] = [];
  let projectArg = '.';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') {
      const value = argv[++i];
      if (!value) err('expected directory after --project');
      projectArg = value;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectArg = arg.slice('--project='.length);
      if (!projectArg) err('expected directory after --project=');
      continue;
    }
    if (arg.startsWith('-')) err(`unknown check option: ${arg}`);
    rest.push(arg);
  }
  if (rest.some((arg) => arg === 'package.json' || /[/\\]package\.json$/.test(arg)))
    err(
      'package.json positional argument was removed; use jsbt check or jsbt check --project=<directory>'
    );
  if (rest.length > 1) err('expected [--project=<directory>] [check-name]');
  const head = checkHead(rest[0]);
  if (head) return { head, help: false, outArg: CHECK_OUT, pkgArg: 'package.json', projectArg };
  if (rest[0] === 'tests') err(`unknown check selector: ${rest[0]}`);
  if (rest[0]?.startsWith('check-')) err(`unknown check selector: ${rest[0]}`);
  if (rest[0]) err(`unknown check selector: ${rest[0]}`);
  return {
    head: undefined,
    help: false,
    outArg: CHECK_OUT,
    pkgArg: 'package.json',
    projectArg,
  };
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
  treeshake: (args, opts, tree) =>
    runTreeShaking([args.pkgArg, args.outArg], {
      cwd: opts.cwd,
      onIssue: (issue) => tree.push(issue),
      outDir: opts.treeshakeOutDir,
      quiet: !args.head,
      runDir: opts.runDir,
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
  // share test/build and use process.chdir(), so runCheck keeps them on one main-thread lane.
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
  const checkTmp = checkTempDir();
  try {
    const projectCwd = resolve(opts.cwd || process.cwd(), args.projectArg);
    const taskOpts = {
      ...opts,
      cwd: projectCwd,
      runDir: join(checkTmp, 'build'),
      treeshakeOutDir: join(checkTmp, 'out-treeshake'),
    };
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
        head: 'treeshake',
        pick: (res) => {
          const issues: Issue[] = (res.tree || []).map((item) => treeIssueLog(taskOpts.cwd, item));
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
      progressDone(head, HARD_ERROR_CHECKS.has(head) ? res[i].ok : true, res[i].ms);
    };
    for (const [i, item] of list.entries()) {
      await save(i, item.head, () =>
        item.serial
          ? runCheckTask(item.head, args, taskOpts)
          : runCheckWorker(item.head, args, taskOpts)
      );
    }
    if (!quiet) console.log();
    const totalMs = Date.now() - totalStart;
    let diagnosticGap = false;
    const printDiagnostic = (line: string, log: (line?: string) => void): void => {
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
      if (quiet && !out.fatal) continue;
      if (item.head === 'errors') {
        for (const line of out.lines) printDiagnostic(line, console.error);
        if (args.head)
          for (const line of pickLogs(item.head, cur)) printDiagnostic(line, console.log);
      } else {
        const full = !!args.head && item.head === 'treeshake';
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
    rmCheckTempDir(checkTmp);
  }
};

const cmdRun = {
  check: runCheck,
  'check-install': (argv, opts) => runCheckInstall(argv, { cwd: opts.cwd }),
  bundle: runBuild,
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
if (!isMainThread && data?.kind === CHECK_WORKER) await runWorkerMain();
else if (isMainThread && entry && realpathSync(resolve(entry)) === realpathSync(self)) await main();
