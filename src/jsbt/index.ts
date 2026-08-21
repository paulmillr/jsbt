// Destructive ops SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, or `writeFileSync` directly here.
/**
 * `jsbt-check` dispatches the audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt-check`
 *   `jsbt-check bigint`
 *   `jsbt-check bytes`
 *   `jsbt-check comments`
 *   `jsbt-check errors`
 *   `jsbt-check importtime`
 *   `jsbt-check jsdoc`
 *   `jsbt-check jsr`
 *   `jsbt-check jsrpublish`
 *   `jsbt-check mutate`
 *   `jsbt-check patterns`
 *   `jsbt-check readme`
 *   `jsbt-check size`
 *   `jsbt-check tsdoc`
 *   `jsbt-check typeimport`
 *   `jsbt-check --ignore=readme,tsdoc`
 *   `jsbt-check --gen-config`
 * @module
 */
import * as TSDoc from '@microsoft/tsdoc';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { checkTempDir, rmCheckTempDir } from '../fs-modify.ts';
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
import { runCli as runReadme } from './readme.ts';
import { runGenerateJsbtRc } from './genconfig.ts';
import { runSizeCheck, sizeIssueLog, type SizeIssue } from './size.ts';
import { runCli as runTypeImport } from './typeimport.ts';
import {
  color,
  defaultWorkers,
  err,
  workerCount,
  formatIssue,
  groupIssues,
  paint,
  RC_FILE,
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
};
type Capture = {
  error?: string;
  hard?: boolean;
  ok: boolean;
  stderr: string;
  stdout: string;
  sizeIssues?: SizeIssue[];
};
type TimedCapture = Capture & { ms: number };
type Pick = { count: number; fatal: boolean; hard?: boolean; lines: string[] };
type SharedIssue = { count: number; fatal: boolean; lines: string[] };
// type CmdRun = (argv: string[], opts: Opts) => Promise<void>;
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
type CheckTask = (args: CheckArgs, opts: Opts, sizeIssues: SizeIssue[]) => Promise<void>;
type CheckWorkerData = {
  args: CheckArgs;
  entry: string;
  head?: CheckHead;
  heads?: CheckHead[];
  kind: typeof CHECK_WORKER;
  opts: { color?: boolean; cwd?: string; runDir?: string };
  self: string;
};
type CheckJob = { i: number; item: CheckRun };

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

  checks run against the package in the current directory: cd into it first.

options:
  --ignore=<a,b>   skip the listed selectors
  --gen-config     add missing exampleDependencies to .jsbtrc.json instead of running checks

examples:
  npx --no jsbt-check
  cd packages/pkg-a && npx --no jsbt-check
  npm run check bigint
  npx --no jsbt-check size
  npx --no jsbt-check --ignore=readme,tsdoc
  npx --no jsbt-check --gen-config

size limits:
  jsbt-check size enforces gzip budgets from "sizeLimits" in .jsbtrc.json:
    { "sizeLimits": { "index.js/add": "4kb", "index.js/sign index.js/verify": "6kb" } }
  keys are bismar --size selectors; values are bytes (4096) or a kb string ("4kb").
  a space-separated key budgets the combined bundle of all its selectors
  (their cost when imported together, shared code counted once).
  debug over-budget entries with bismar -bs <selector...> (stats) and
  bismar <selector> > out.js (the measured bundle bytes).

gen config:
  jsbt-check --gen-config scans runnable README fences and TSDoc @example blocks
  and adds their missing imports to "exampleDependencies" in .jsbtrc.json,
  pinned to exact installed versions (existing entries are kept)`;
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
const checkWorkers = (): number => workerCount(defaultWorkers());
const checkQuiet = (): boolean => {
  const value = process.env.JSBT_QUIET;
  return value === '1' || value === 'true';
};
const checkHeader = (total: number, on: boolean, quiet: boolean): string => {
  const env = paint(
    `(JSBT_QUIET=${quiet ? 1 : 0}, JSBT_WORKERS=${checkWorkers()})`,
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
const pickLogs = (head: CheckHead, res: Capture): string[] =>
  textLines(res.stdout).filter((line) => head === 'errors' || MUTATION_LOG.test(line));
const warnInfoLine = (line: string): boolean => /^\[(?:WARN|INFO)\]/.test(stripAnsi(line));
// Examples run against a temp node_modules built only from `dependencies` plus
// `exampleDependencies`, so an unlisted import fails at run time instead of at parse time.
// The message names a package, never the config it is missing from; say so once at the end.
const MISSING_EXAMPLE_DEP = /ERR_MODULE_NOT_FOUND/;
const missingDepHint = (on: boolean): string[] => [
  paint(
    `hint: examples may only import "dependencies" and "exampleDependencies" from ${RC_FILE}`,
    color.gray,
    on
  ),
  paint(
    `      jsbt-check --gen-config adds the missing packages to that file`,
    color.gray,
    on
  ),
];
const checkHead = (name: string | undefined): CheckHead | undefined =>
  name && Object.hasOwn(CHECK_ALIASES, name)
    ? CHECK_ALIASES[name as keyof typeof CHECK_ALIASES]
    : undefined;
// Aliases resolve here too, so `--ignore=jsdoc` drops the same check `jsbt-check jsdoc` runs.
const ignoreHeads = (value: string): CheckHead[] => {
  const names = value.split(',').map((name) => name.trim());
  if (!names.length || names.some((name) => !name)) err(`expected selectors after --ignore=`);
  return names.map((name) => checkHead(name) ?? err(`unknown check selector: ${name}`));
};
const checkArgs = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { generate: false, head: undefined, help: true, ignore: [] as CheckHead[], pkgArg: '' };
  const rest: string[] = [];
  const ignore: CheckHead[] = [];
  let generate = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--gen-config') {
      generate = true;
      continue;
    }
    if (arg === '--ignore') {
      const value = argv[++i];
      if (!value) err('expected selectors after --ignore');
      ignore.push(...ignoreHeads(value));
      continue;
    }
    if (arg.startsWith('--ignore=')) {
      ignore.push(...ignoreHeads(arg.slice('--ignore='.length)));
      continue;
    }
    if (arg.startsWith('-')) err(`unknown check option: ${arg}`);
    rest.push(arg);
  }
  if (rest.some((arg) => arg === 'package.json' || /[/\\]package\.json$/.test(arg)))
    err(
      'package.json positional argument was removed; cd into the package directory and run jsbt-check'
    );
  if (rest.length > 1) err('expected [check-name]');
  // A mode of its own rather than a modifier on a check: it writes .jsbtrc.json and runs no audit.
  if (generate && rest[0]) err(`--gen-config takes no check selector: got ${rest[0]}`);
  if (generate && ignore.length) err('--gen-config runs no checks, so --ignore does nothing');
  const head = checkHead(rest[0]);
  if (head) {
    if (ignore.includes(head)) err(`--ignore=${rest[0]} leaves no checks to run`);
    return { generate, head, help: false, ignore, pkgArg: 'package.json' };
  }
  if (rest[0] === 'tests') err(`unknown check selector: ${rest[0]}`);
  if (rest[0]?.startsWith('check-')) err(`unknown check selector: ${rest[0]}`);
  if (rest[0]) err(`unknown check selector: ${rest[0]}`);
  return {
    generate,
    head: undefined,
    help: false,
    ignore,
    pkgArg: 'package.json',
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
  size: (args, opts, sizeIssues) =>
    runSizeCheck({
      cwd: opts.cwd,
      onIssue: (issue) => sizeIssues.push(issue),
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
  const sizeIssues: SizeIssue[] = [];
  const res = await withQuiet(() => capture(() => checkTasks[head](args, opts, sizeIssues)));
  if (sizeIssues.length) res.sizeIssues = sizeIssues;
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
  // Workers isolate console/env capture for independent checks. Example checks share the
  // symlink-assembled temp run dir and use process.chdir(), so runCheck keeps them on one
  // main-thread lane.
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
      },
      self: import.meta.url,
    },
    error: (error) => ({ error, ok: false, stderr: '', stdout: '' }),
  });
const runCheck = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const args = checkArgs(argv);
  if (args.help) return console.log(usage);
  const projectCwd = resolve(opts.cwd || process.cwd());
  // A mode of its own, not a check: it scans examples, writes the rc, and never needs the run dir.
  if (args.generate) return runGenerateJsbtRc({ cwd: projectCwd });
  const checkTmp = checkTempDir();
  try {
    const taskOpts = { ...opts, cwd: projectCwd, runDir: join(checkTmp, 'build') };
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
          const issues: Issue[] = (res.sizeIssues || []).map(sizeIssueLog);
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
    const ignored = new Set<CheckHead>(args.ignore);
    const list = (
      args.head
        ? allChecks.filter((item) => item.head === args.head)
        : allChecks.filter((item) => item.head !== 'patterns')
    ).filter((item) => !ignored.has(item.head));
    if (!list.length) err('--ignore leaves no checks to run');
    console.log(checkHeader(list.length, colorOn, quiet));
    if (!quiet) console.log();
    const res: TimedCapture[] = [];
    const save = async (i: number, head: CheckHead, fn: () => Promise<Capture>): Promise<void> => {
      progressStart(head);
      res[i] = await timed(fn);
      progressDone(head, HARD_ERROR_CHECKS.has(head) || res[i].hard ? res[i].ok : true, res[i].ms);
    };
    const workers = checkWorkers();
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
    let missingExampleDep = false;
    const printDiagnostic = (line: string, log: (line?: string) => void): void => {
      if (quiet && !quietDiagnostics) {
        console.log();
        quietDiagnostics = true;
      }
      if (!diagnosticGap && warnInfoLine(line)) {
        log();
        diagnosticGap = true;
      }
      // Tracked on the printed line, not the captured one: no hint for a hidden diagnostic.
      if (MISSING_EXAMPLE_DEP.test(line)) missingExampleDep = true;
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
        for (const line of pickLogs(item.head, cur)) printDiagnostic(line, console.log);
        for (const line of out.lines) printDiagnostic(line, console.error);
      }
    }
    if (missingExampleDep) {
      console.error();
      for (const line of missingDepHint(colorOn)) console.error(line);
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

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  return runCheck(argv, opts);
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
