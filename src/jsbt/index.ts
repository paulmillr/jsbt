// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt` dispatches the shared build and audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt esbuild test/build`
 *   `jsbt check package.json`
 *   `jsbt check package.json tsdoc`
 *   `jsbt check-install package.json`
 *   `jsbt bigint package.json`
 *   `jsbt comments package.json`
 *   `jsbt errors package.json`
 *   `jsbt importtime package.json`
 *   `jsbt jsr package.json`
 *   `jsbt jsrpublish package.json`
 *   `jsbt mutate package.json`
 *   `jsbt readme package.json`
 *   `jsbt tests package.json`
 *   `jsbt treeshake package.json test/build/out-treeshake`
 *   `jsbt typeimport package.json`
 *   `jsbt tsdoc package.json`
 * @module
 */
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import * as TSDoc from '@microsoft/tsdoc';
import { runCli as runBuild } from './esbuild.ts';
import { runCli as runBigInt } from './bigint.ts';
import { runCli as runBytes } from './bytes.ts';
import { runCli as runCheckInstall } from './check-install.ts';
import { runCli as runComments } from './comments.ts';
import { runCli as runErrors } from './errors.ts';
import { runCli as runImportTime } from './importtime.ts';
import { runCli as runTSDoc } from './jsdoc.ts';
import { runCli as runJsr } from './jsr.ts';
import { runCli as runJsrPublish } from './jsrpublish.ts';
import { runCli as runMutate } from './mutate.ts';
import { runCli as runReadme } from './readme.ts';
import { runCli as runTests } from './tests.ts';
import { runCli as runTreeShaking } from './treeshake.ts';
import { runCli as runTypeImport } from './typeimport.ts';
import {
  color,
  formatIssue,
  groupIssues,
  issueKind,
  paint,
  stripAnsi,
  tag as statusTag,
  type Issue,
  type Level,
  type Ref,
  wantColor,
} from './utils.ts';

type Cmd =
  | 'build'
  | 'check'
  | 'check-install'
  | 'check-bigint'
  | 'check-bytes'
  | 'check-comments'
  | 'check-error'
  | 'check-errors'
  | 'check-importtime'
  | 'check-jsdoc'
  | 'check-jsr'
  | 'check-jsrpublish'
  | 'check-mutate'
  | 'check-readme'
  | 'check-tests'
  | 'check-typeimport'
  | 'check-tree-shaking'
  | 'bytes'
  | 'bigint'
  | 'comments'
  | 'error'
  | 'errors'
  | 'esbuild'
  | 'importtime'
  | 'jsr'
  | 'jsrpublish'
  | 'mutate'
  | 'readme'
  | 'tests'
  | 'treeshake'
  | 'typeimport'
  | 'tsdoc';
type Opts = { color?: boolean; cwd?: string; runJsrPublish?: typeof runJsrPublish };
type TreeIssue = { file: string; id: string; line: number; text: string };
type Capture = { error?: string; ok: boolean; stderr: string; stdout: string; tree?: TreeIssue[] };
type TimedCapture = Capture & { ms: number };
type Pick = { count: number; fatal: boolean; lines: string[] };
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
  | 'readme'
  | 'tests'
  | 'treeshake'
  | 'typeimport'
  | 'tsdoc';
type CheckRun = { head: CheckHead; pick: (res: Capture) => Pick; serial?: boolean };
type CheckCount = { count: number; head: string; ms: number };
type CheckArgs = ReturnType<typeof checkArgs>;
type CheckWorkerData = {
  args: CheckArgs;
  entry: string;
  head: CheckHead;
  kind: typeof CHECK_WORKER;
  opts: { color?: boolean; cwd?: string };
  self: string;
};

const usage = `usage:
  jsbt esbuild <build-dir> [--auto] [--no-prefix]
  jsbt check <package.json> [check-name|out-dir] [out-dir]
  jsbt check-install <package.json>
  jsbt bigint <package.json>
  jsbt bytes <package.json>
  jsbt comments <package.json>
  jsbt errors <package.json>
  jsbt importtime <package.json>
  jsbt jsr <package.json>
  jsbt jsrpublish <package.json>
  jsbt mutate <package.json>
  jsbt readme <package.json>
  jsbt tests <package.json>
  jsbt treeshake <package.json> <out-dir>
  jsbt typeimport <package.json>
  jsbt tsdoc <package.json>

aliases:
  jsbt build <build-dir> ...
  jsbt check-install <package.json>
  jsbt check-bigint <package.json>
  jsbt check-bytes <package.json>
  jsbt check-comments <package.json>
  jsbt check-errors <package.json>
  jsbt check-importtime <package.json>
  jsbt check-jsr <package.json>
  jsbt check-jsrpublish <package.json>
  jsbt check-mutate <package.json>
  jsbt check-readme <package.json>
  jsbt check-tests <package.json>
  jsbt check-typeimport <package.json>
  jsbt check-tree-shaking <package.json> <out-dir>
  jsbt check-jsdoc <package.json>

examples:
  npx --no @paulmillr/jsbt esbuild test/build
  npx --no @paulmillr/jsbt check package.json
  npx --no @paulmillr/jsbt check package.json tsdoc
  npx --no @paulmillr/jsbt check-install package.json
  npx --no @paulmillr/jsbt bigint package.json
  npx --no @paulmillr/jsbt bytes package.json
  npx --no @paulmillr/jsbt comments package.json
  npx --no @paulmillr/jsbt errors package.json
  npx --no @paulmillr/jsbt importtime package.json
  npx --no @paulmillr/jsbt jsr package.json
  npx --no @paulmillr/jsbt jsrpublish package.json
  npx --no @paulmillr/jsbt mutate package.json
  npx --no @paulmillr/jsbt readme package.json
  npx --no @paulmillr/jsbt tests package.json
  npx --no @paulmillr/jsbt treeshake package.json test/build/out-treeshake
  npx --no @paulmillr/jsbt typeimport package.json
  npx --no @paulmillr/jsbt tsdoc package.json`;
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
const err = (msg: string): never => {
  throw new Error(msg);
};
const splitLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const issueLines = (text: string): { cont: string[]; line: string; plain: string }[] => {
  const out: { cont: string[]; line: string; plain: string }[] = [];
  let prev: { cont: string[]; line: string; plain: string } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
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
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
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
const relFile = (cwd: string | undefined, file: string): string => {
  const rel = cwd ? relative(cwd, file) : file;
  return rel && rel !== '.' ? rel : file;
};
const refOf = (msg: string): Ref | undefined => {
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
    const ref = refOf(msg);
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
const pickLogs = (res: Capture): string[] =>
  splitLines(res.stdout).filter((line) => MUTATION_LOG.test(line));
const checkHead = (name: string | undefined): CheckHead | undefined => {
  switch (name) {
    case 'bytes':
    case 'check:bytes':
    case 'check-bytes':
      return 'bytes';
    case 'bigint':
    case 'check:bigint':
    case 'check-bigint':
      return 'bigint';
    case 'comments':
    case 'check:comments':
    case 'check-comments':
      return 'comments';
    case 'errors':
    case 'error':
    case 'check:errors':
    case 'check:error':
    case 'check-errors':
    case 'check-error':
      return 'errors';
    case 'importtime':
    case 'check:importtime':
    case 'check-importtime':
      return 'importtime';
    case 'jsr':
    case 'check:jsr':
    case 'check-jsr':
      return 'jsr';
    case 'jsrpublish':
    case 'check:jsrpublish':
    case 'check-jsrpublish':
      return 'jsrpublish';
    case 'mutate':
    case 'check:mutate':
    case 'check-mutate':
      return 'mutate';
    case 'readme':
    case 'check:readme':
    case 'check-readme':
      return 'readme';
    case 'tests':
    case 'check:tests':
    case 'check-tests':
      return 'tests';
    case 'typeimport':
    case 'check:typeimport':
    case 'check-typeimport':
      return 'typeimport';
    case 'treeshake':
    case 'tree-shaking':
    case 'check:treeshake':
    case 'check:tree-shaking':
    case 'check-tree-shaking':
      return 'treeshake';
    case 'tsdoc':
    case 'jsdoc':
    case 'check:tsdoc':
    case 'check:jsdoc':
    case 'check-jsdoc':
      return 'tsdoc';
  }
  return;
};
const checkArgs = (argv: string[]) => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { head: undefined, help: true, outArg: '', pkgArg: '' };
  if (argv.length < 1 || argv.length > 3)
    err('expected <package.json> [check-name|out-dir] [out-dir]');
  const head = checkHead(argv[1]);
  if (head) return { head, help: false, outArg: argv[2] || CHECK_OUT, pkgArg: argv[0] };
  return { head: undefined, help: false, outArg: argv[1] || CHECK_OUT, pkgArg: argv[0] };
};
const runCheckTask = async (head: CheckHead, args: CheckArgs, opts: Opts): Promise<Capture> => {
  const tree: TreeIssue[] = [];
  const run = (): Promise<void> => {
    switch (head) {
      case 'readme':
        return runReadme([args.pkgArg], opts);
      case 'treeshake':
        return runTreeShaking([args.pkgArg, args.outArg], {
          cwd: opts.cwd,
          onIssue: (issue) => tree.push(issue),
          quiet: true,
        });
      case 'tsdoc':
        return runTSDoc([args.pkgArg], {
          color: opts.color,
          cwd: opts.cwd,
          loadTSDoc: () => TSDoc as any,
        });
      case 'jsr':
        return runJsr([args.pkgArg], opts);
      case 'jsrpublish':
        return (opts.runJsrPublish || runJsrPublish)([args.pkgArg], {
          color: opts.color,
          cwd: opts.cwd,
          full: !!args.head,
        });
      case 'comments':
        return runComments([args.pkgArg], opts);
      case 'errors':
        return runErrors([args.pkgArg], opts);
      case 'bigint':
        return runBigInt([args.pkgArg], opts);
      case 'bytes':
        return runBytes([args.pkgArg], opts);
      case 'mutate':
        return runMutate([args.pkgArg], opts);
      case 'tests':
        return runTests([args.pkgArg], opts);
      case 'importtime':
        return runImportTime([args.pkgArg], { color: opts.color, cwd: opts.cwd, quiet: true });
      case 'typeimport':
        return runTypeImport([args.pkgArg], opts);
    }
  };
  const res = await withQuiet(() => capture(run));
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
  new Promise((resolve) => {
    // Workers isolate console/env capture for independent checks. npm-installing example checks
    // share test/build and use process.chdir(), so runCheck keeps them on one main-thread lane.
    const worker = new Worker(WORKER, {
      eval: true,
      type: 'module',
      workerData: {
        args,
        entry: fileURLToPath(import.meta.url),
        head,
        kind: CHECK_WORKER,
        opts: { color: opts.color, cwd: opts.cwd },
        self: import.meta.url,
      },
    } as any);
    let done = false;
    const finish = (res: Capture, exited = false) => {
      if (done) return;
      done = true;
      resolve(res);
      // Imported check code can leave timers/sockets open; once the result is posted, kill the
      // worker so aggregate `jsbt check` can exit after printing the final summary.
      if (!exited) worker.terminate().catch(() => {});
    };
    worker.once('message', (msg) => finish(msg as Capture));
    worker.once('error', (error) =>
      finish({ error: error.message, ok: false, stderr: '', stdout: '' })
    );
    worker.once('exit', (code) => {
      if (done) return;
      finish(
        {
          error: code ? `worker exited with code ${code}` : 'worker exited without result',
          ok: false,
          stderr: '',
          stdout: '',
        },
        true
      );
    });
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
  const allChecks: CheckRun[] = [
    {
      head: 'readme',
      pick: (res) => pickIssues('readme', res, colorOn),
      serial: true,
    },
    {
      head: 'treeshake',
      pick: (res) => {
        const issues: Issue[] = (res.tree || []).map((item) => ({
          level: 'ERROR',
          ref: {
            file: relFile(opts.cwd, item.file),
            issue: issueKind(`unused (${item.id})`, 'treeshake'),
            sym: `${item.line}/${item.text}`,
          },
        }));
        if (issues.length || !res.error)
          return {
            count: issues.length,
            fatal: !!issues.length,
            lines: groupIssues('treeshake', issues, colorOn),
          };
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
    {
      head: 'tsdoc',
      pick: (res) => pickIssues('tsdoc', res, colorOn),
      serial: true,
    },
    {
      head: 'typeimport',
      pick: (res) => pickIssues('typeimport', res, colorOn),
    },
    {
      head: 'jsr',
      pick: (res) => pickIssues('jsr', res, colorOn),
    },
    {
      head: 'jsrpublish',
      pick: (res) => pickIssues('jsrpublish', res, colorOn),
      serial: true,
    },
    {
      head: 'comments',
      pick: (res) => pickIssues('comments', res, colorOn),
    },
    {
      head: 'errors',
      pick: (res) => pickIssues('errors', res, colorOn),
      serial: true,
    },
    {
      head: 'bigint',
      pick: (res) => pickIssues('bigint', res, colorOn),
    },
    {
      head: 'bytes',
      pick: (res) => pickIssues('bytes', res, colorOn),
    },
    {
      head: 'mutate',
      pick: (res) => pickIssues('mutate', res, colorOn),
    },
    {
      head: 'tests',
      pick: (res) => pickIssues('tests', res, colorOn),
    },
    {
      head: 'importtime',
      pick: (res) => pickIssues('importtime', res, colorOn),
      // Import timing must not share the worker-parallel lane with other runtime checks.
      serial: true,
    },
  ];
  const list = args.head
    ? allChecks.filter((item) => item.head === args.head)
    : allChecks.filter((item) => item.head !== 'errors');
  const res: TimedCapture[] = [];
  const serial = async () => {
    for (const [i, item] of list.entries())
      if (item.serial) res[i] = await timed(() => runCheckTask(item.head, args, opts));
  };
  const parallel = list.map((item, i) =>
    item.serial
      ? Promise.resolve()
      : timed(() => runCheckWorker(item.head, args, opts)).then((out) => {
          res[i] = out;
        })
  );
  await Promise.all([...parallel, serial()]);
  const totalMs = Date.now() - totalStart;
  const counts: CheckCount[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const cur = res[i];
    for (const line of pickLogs(cur)) console.log(line);
    const out = item.pick(cur);
    if (out.fatal) hasFail = true;
    for (const line of out.lines) console.error(line);
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

const cmd = (name: string): Cmd | undefined => {
  switch (name) {
    case 'build':
    case 'check':
    case 'check-install':
    case 'check-bigint':
    case 'check-bytes':
    case 'check-comments':
    case 'check-error':
    case 'check-errors':
    case 'check-importtime':
    case 'check-jsdoc':
    case 'check-jsr':
    case 'check-jsrpublish':
    case 'check-mutate':
    case 'check-readme':
    case 'check-tests':
    case 'check-typeimport':
    case 'check-tree-shaking':
    case 'bytes':
    case 'bigint':
    case 'comments':
    case 'error':
    case 'errors':
    case 'esbuild':
    case 'importtime':
    case 'jsr':
    case 'jsrpublish':
    case 'mutate':
    case 'readme':
    case 'tests':
    case 'treeshake':
    case 'typeimport':
    case 'tsdoc':
      return name;
  }
  return undefined;
};

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const [head, ...rest] = argv;
  if (!head || head === '--help' || head === '-h') return console.log(usage);
  const sub = cmd(head);
  if (!sub) throw new Error(`unknown jsbt command: ${head}\n\n${usage}`);
  switch (sub) {
    case 'build':
    case 'esbuild':
      return runBuild(rest);
    case 'check':
      return runCheck(rest, opts);
    case 'check-install':
      return runCheckInstall(rest, { cwd: opts.cwd });
    case 'check-bigint':
    case 'bigint':
      return runBigInt(rest, opts);
    case 'check-bytes':
    case 'bytes':
      return runBytes(rest, opts);
    case 'check-comments':
    case 'comments':
      return runComments(rest, opts);
    case 'check-error':
    case 'check-errors':
    case 'error':
    case 'errors':
      return runErrors(rest, opts);
    case 'check-importtime':
    case 'importtime':
      return runImportTime(rest, opts);
    case 'check-jsr':
    case 'jsr':
      return runJsr(rest, opts);
    case 'check-jsrpublish':
    case 'jsrpublish':
      return (opts.runJsrPublish || runJsrPublish)(rest, {
        color: opts.color,
        cwd: opts.cwd,
        full: true,
      });
    case 'check-mutate':
    case 'mutate':
      return runMutate(rest, opts);
    case 'check-tests':
    case 'tests':
      return runTests(rest, opts);
    case 'check-typeimport':
    case 'typeimport':
      return runTypeImport(rest, opts);
    case 'check-readme':
    case 'readme':
      return runReadme(rest, opts);
    case 'check-tree-shaking':
    case 'treeshake':
      return runTreeShaking(rest, { cwd: opts.cwd });
    case 'check-jsdoc':
    case 'tsdoc':
      return runTSDoc(rest, { color: opts.color, cwd: opts.cwd, loadTSDoc: () => TSDoc as any });
  }
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
