/*! jsbt - MIT License (c) 2019 Paul Miller (paulmillr.com) */
/**
 * Micro testing framework with familiar syntax for browsers, node and others.
 * Supports fast mode (parallel), quiet mode (dot reporter), tree structures, CLI self-run auto-detection.
 * @module
 */

/** A single test. */
export interface StackItem {
  message: string;
  test?: () => Promise<any> | any;
  skip?: boolean;
  only?: boolean;
  serial?: boolean;
  prefix?: string;
  childPrefix?: string;
  path?: StackItem[];
  beforeAll?: () => Promise<void> | void;
  afterAll?: () => Promise<void> | void;
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
  children: StackItem[];
}

export interface Options {
  STOP_ON_ERROR: boolean;
  QUIET: boolean;
  FAST: number;
  FILTER: string;
}

type ReportStyle = {
  tree: boolean;
  inline: boolean;
  pathSep: string;
};

export interface DescribeFunction {
  (message: string, testFunctions: () => Promise<any> | any): void;
  skip: (message: string, test: () => Promise<any> | any) => void;
}
export interface TestFunction {
  (message: string, test: () => Promise<any> | any): void;
  /**
   * Registers test for "only" queue. When the queue is not empty,
   * it would ignore all other tests. Is limited to just one registered test.
   */
  only: (message: string, test: () => Promise<any> | any) => void;
  /** Registers test, but skips it while running. Can be used instead of commenting out the code. */
  skip: (message: string, test: () => Promise<any> | any) => void;
  /** Registers test that is kept on the primary process even when JSBT_FAST is enabled. */
  serial: (message: string, test: () => Promise<any> | any) => void;
  /**
   * Runs all registered tests.
   * After run, allows to run new tests without duplication: old test queue is cleaned up.
   * @param forceSequential - when `true`, disables automatic parallelization even when JSBT_FAST=1.
   * @returns resolved promise, after all tests have finished
   */
  run: (forceSequential?: boolean) => Promise<number>;
  /**
   * Executes .run() when passed argument is equal to CLI-passed file name.
   * Consider a project with 3 test files: a.test.js, b.test.js, all.js.
   * all.js imports a.test.js and b.test.js.
   * User runs node a.test.js; then node all.js;
   * Writing `it.run()` everywhere would fail, because it would try to run same tests twice.
   * However, `it.runWhen(import.meta.url)` would succeed, because it detects whether
   * current file is launched from CLI and not imported.
   * @example
   * it.runWhen(import.meta.url)
   */
  runWhen: (importMetaUrl: string) => Promise<number | undefined>;
  opts: Options;
}
export type EmptyFn = () => Promise<void> | void;

declare const console: any;

const stack: StackItem[] = [{ message: '', children: [] }];
const errorLog: string[] = [];
let quietPassCount: number | undefined;
let quietFailCount: number | undefined;
let onlyStack: StackItem | undefined;
let isRunning = false;
const isCli = 'process' in globalThis;
// Dumb bundlers parse code and assume we have hard dependency on "process". We don't.
// The trick (also import(mod) below) ensures parsers can't see it.
// @ts-ignore
const pr = globalThis['process'];
const proc: Record<string, any> | undefined = isCli ? pr : undefined;
type Env = Record<string, string | undefined>;
const isNode = isCli && typeof proc?.versions?.node === 'string';
function wantColor(env: Env = {}, tty = false): boolean {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
}
const colorOn = isCli && wantColor(proc?.env, !!proc?.stderr?.isTTY || !!proc?.stdout?.isTTY);
const opts: Options = {
  STOP_ON_ERROR: isCli ? parseBoolEnv(proc?.env?.JSBT_BAIL, true) : true,
  QUIET: isCli && parseBoolEnv(proc?.env?.JSBT_QUIET, false),
  FAST: defaultFast(proc?.env),
  FILTER: isCli ? proc?.env?.JSBT_FILTER || '' : '',
};

function parseBoolEnv(str: string | undefined, defaultValue: boolean): boolean {
  if (str === undefined) return defaultValue;
  const raw = String(str).trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '' || raw === '0' || raw === 'false') return false;
  return defaultValue;
}

function parseFast(str: string | number): number {
  if (!isCli) return 0;
  const raw = String(str || '')
    .trim()
    .toLowerCase();
  if (raw === 'true') return 1;
  const val = Number.parseFloat(raw);
  const ratio = val > 0 && val < 1;
  if (!Number.isFinite(val) || val === 0 || Math.abs(val) > 256) return 0;
  if (!ratio && !Number.isSafeInteger(val)) return 0;
  return val;
}

function defaultFast(env: Env = {}): number {
  if (!isNode) return 0;
  return env.JSBT_FAST === undefined ? 1 : parseFast(env.JSBT_FAST);
}

function fastWorkerCount(fast: number, max: number): number {
  const count = fast === 1 ? max : fast < 0 ? max + fast : fast < 1 ? Math.floor(max * fast) : fast;
  return Math.max(1, Math.min(count, 256));
}

function imp(moduleName: string): any {
  return import(moduleName);
}

// String formatting utils
const _c = String.fromCharCode(27); // x1b, control code for terminal colors
const c = {
  // colors
  gray: _c + '[90m',
  red: _c + '[31m',
  green: _c + '[32m',
  reset: _c + '[0m',
} as const;
const PATH_SEP = '/';
const INDENT = '  ';

// Colorize string for terminal.
function color(colorName: keyof typeof c, title: string | number) {
  return colorOn ? `${c[colorName]}${title}${c.reset}` : title.toString();
}
function parallelPathSep() {
  return color('gray', ' → ');
}
const SEQUENTIAL_STYLE: ReportStyle = { tree: isCli, inline: true, pathSep: PATH_SEP };
function flatStyle(pathSep: string = PATH_SEP): ReportStyle {
  return { tree: false, inline: false, pathSep };
}

function log(...args: (string | undefined)[]) {
  if (opts.QUIET) return logQuiet(false);
  // @ts-ignore
  console.log(...args);
}

function writeStream(streamName: 'stdout' | 'stderr', text: string, fallback: string = text) {
  const stream = proc?.[streamName];
  if (isCli && typeof stream?.write === 'function') stream.write(text);
  else console[streamName === 'stdout' ? 'log' : 'error'](fallback);
}

function writeStdout(text: string, fallback: string = text) {
  writeStream('stdout', text, fallback);
}

function writeStderr(text: string, fallback: string = text) {
  writeStream('stderr', text, fallback);
}

function logInline(line: string, done = false) {
  if (opts.QUIET) return;
  writeStdout(done ? `\r${line}\n` : line, line);
}
function logQuiet(fail = false) {
  if (fail) {
    if (quietFailCount !== undefined) return void quietFailCount++;
    const msg = color('red', '!');
    writeStderr(msg);
  } else {
    if (quietPassCount !== undefined) return void quietPassCount++;
    const msg = '.';
    writeStdout(msg);
  }
}
function addToErrorLog(title = '', error: any): void {
  errorLog.push(`${title} ${error?.stack ? error.stack : error}`);
  // @ts-ignore
  if (!opts.QUIET) console.error(error); // loud = show error now. quiet = show in the end
}

function formatPrefix(depth: number, prefix: string) {
  if (depth === 0) return { prefix: '', childPrefix: '' };
  return { prefix: `${prefix}${INDENT}`, childPrefix: `${prefix}${INDENT}` };
}

async function runTest(
  info: StackItem,
  style: ReportStyle,
  stopAtError: boolean = true
): Promise<boolean | undefined> {
  if (!style.tree && style.inline) log();
  const title = info.message;
  if (typeof info.test !== 'function') throw new Error('internal test error: invalid info.test');

  const messages: string[] = [];
  const onlyStackToLog: string[] = [];
  const beforeEachFns: Function[] = [];
  const afterEachFns: Function[] = []; // will be reversed
  for (const parent of info.path!) {
    if (parent.message) {
      messages.push(parent.message);
      if (style.tree && info.only) onlyStackToLog.push(`${parent.prefix}${parent.message}`);
    }
    if (parent.beforeEach) beforeEachFns.push(parent.beforeEach);
    if (parent.afterEach) afterEachFns.push(parent.afterEach);
  }
  afterEachFns.reverse();
  if (onlyStackToLog.length) onlyStackToLog.forEach((l) => log(l));

  const pathParts = messages.slice().concat(title);
  const path = pathParts.join(PATH_SEP);
  const displayPath = pathParts.join(style.pathSep);

  const inline = style.inline && !info.skip && !opts.QUIET;

  function formatTaskStart(suffix = '') {
    const title_ = suffix ? [title, suffix].join(PATH_SEP) : title;
    const full_ = suffix ? pathParts.concat(suffix).join(style.pathSep) : displayPath;
    return style.tree ? color('gray', `${info.prefix}${title_}`) : full_;
  }

  // Skip is always single-line
  if (inline) {
    logInline(`${formatTaskStart()} `);
  } else if (info.skip) {
    log(style.tree ? color('gray', `${info.prefix}${title} (skip)`) : `☆ ${displayPath} (skip)`);
    return true;
  }

  function formatTaskDone(fail = false, suffix = '') {
    const symbol = fail ? '✕' : '✓';
    const clr = fail ? 'red' : 'green';
    const title_ = suffix ? [title, suffix].join(PATH_SEP) : title;
    const full_ = formatTaskStart(suffix);
    const coloredSymbol = color(clr, symbol);
    if (inline) return `${full_} ${coloredSymbol}`;
    return style.tree
      ? `${color('gray', `${info.childPrefix}${title_}`)}: ${coloredSymbol}`
      : `${coloredSymbol} ${full_}`;
  }

  function logTaskDone(fail = false, suffix = '') {
    const line = formatTaskDone(fail, suffix);
    if (inline) logInline(line, true);
    else if (fail) console.error(line);
    else log(line);
  }

  function logErrorStack(suffix: string) {
    if (opts.QUIET) {
      // when quiet, either stop & log trace; or log !
      if (stopAtError) {
        // stop, log whole path and trace
        console.error();
        console.error(formatTaskDone(true, suffix));
      } else {
        // log !, continue
        logQuiet(true);
      }
    } else {
      // when loud, log (maybe formatted) tree structure
      logTaskDone(true, suffix);
    }
  }

  // Run beforeEach hooks from parent contexts
  for (const beforeFn of beforeEachFns) {
    try {
      await beforeFn();
    } catch (cause) {
      logErrorStack('beforeEach');
      // @ts-ignore
      if (stopAtError) throw cause;
      else addToErrorLog(`${path}/beforeEach`, cause);

      return false;
    }
  }

  // Run test task
  try {
    await info.test();
  } catch (cause) {
    logErrorStack('');
    // @ts-ignore
    if (stopAtError) throw cause;
    else addToErrorLog(`${path}`, cause);
    return false;
  }

  // Run afterEach hooks from parent contexts (in reverse order)
  for (const afterFn of afterEachFns) {
    try {
      await afterFn();
    } catch (cause) {
      logErrorStack('afterEach');
      // @ts-ignore
      if (stopAtError) throw cause;
      else addToErrorLog(`${path}/afterEach`, cause);
      return false;
    }
  }
  logTaskDone();
  return true;
}

function stackTop() {
  return stack[stack.length - 1];
}
function stackAdd(info: { message: any; skip?: boolean }) {
  const c = { ...info, children: [] };
  stackTop().children.push(c);
  stack.push(c);
}

function stackFlatten(elm: StackItem): StackItem[] {
  const out: StackItem[] = [];
  const root: StackItem = { ...elm, prefix: '', childPrefix: '', path: [] };
  const rootPath =
    root.beforeAll || root.afterAll || root.beforeEach || root.afterEach ? [root] : [];
  const walk = (elm: StackItem, depth = 0, prevPrefix = '', path: StackItem[] = []) => {
    const { prefix, childPrefix } = formatPrefix(depth, prevPrefix);
    const newElm: StackItem = { ...elm, prefix, childPrefix, path };
    out.push(newElm);
    path = path.concat([newElm]); // Save prefixes so we can print path in 'only' case

    const chl = elm.children;
    for (let i = 0; i < chl.length; i++) walk(chl[i], depth + 1, childPrefix, path);
  };
  // Skip root
  for (const child of elm.children) walk(child, 0, '', rootPath);
  return out;
}

const describe: DescribeFunction = (message: any, fn: EmptyFn): void => {
  stackAdd({ message });
  fn(); // Run function in the context of current stack path
  stack.pop();
};

function describeSkip(message: any, _fn: EmptyFn): void {
  stackAdd({ message, skip: true });
  // fn();
  stack.pop();
}
describe.skip = describeSkip;

function beforeAll(fn: EmptyFn): void {
  stackTop().beforeAll = fn;
}

function afterAll(fn: EmptyFn): void {
  stackTop().afterAll = fn;
}

function beforeEach(fn: EmptyFn): void {
  stackTop().beforeEach = fn;
}

function afterEach(fn: EmptyFn): void {
  stackTop().afterEach = fn;
}

function register(info: StackItem) {
  stackAdd(info);
  stack.pop(); // remove from stack since there are no children
}

function taskPath(info: StackItem, pathSep: string = PATH_SEP): string {
  return (info.path || [])
    .map((item) => item.message)
    .concat(info.message)
    .filter((item) => item)
    .join(pathSep);
}

function filterTasks(items: StackItem[]): StackItem[] {
  const filter = opts.FILTER;
  if (!filter) return items;
  const keep = new Set<StackItem>();
  for (const item of items) {
    if (!item.test || !taskPath(item).includes(filter)) continue;
    keep.add(item);
    for (const parent of item.path || []) keep.add(parent);
  }
  return items.filter((item) => keep.has(item));
}

function cloneAndReset() {
  let items = stackFlatten(stack[0]).slice();
  if (onlyStack) items = items.filter((i) => i.test === onlyStack!.test);
  items = filterTasks(items);
  stack.splice(0, stack.length);
  stack.push({ message: '', children: [] } as unknown as StackItem);
  onlyStack = undefined;
  return items;
}

type AllHookName = 'beforeAll' | 'afterAll';

function commonPathLen(a: StackItem[], b: StackItem[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function hookPath(suite: StackItem, hook: AllHookName, pathSep: string = PATH_SEP): string {
  return (suite.path || [])
    .map((i) => i.message)
    .concat(suite.message, hook)
    .filter((i) => i)
    .join(pathSep);
}

function formatHookFail(suite: StackItem, hook: AllHookName, style: ReportStyle) {
  const title = hookPath(suite, hook, style.pathSep);
  const symbol = color('red', '✕');
  return style.tree && suite.message
    ? `${suite.childPrefix}${hook}: ${symbol}`
    : `${symbol} ${title}`;
}

async function runAllHook(
  suite: StackItem,
  hook: AllHookName,
  style: ReportStyle,
  stopAtError: boolean
): Promise<boolean> {
  const fn = suite[hook];
  if (!fn) return true;
  try {
    await fn();
    return true;
  } catch (cause) {
    if (opts.QUIET) {
      if (stopAtError) {
        console.error();
        console.error(formatHookFail(suite, hook, style));
      } else {
        logQuiet(true);
      }
    } else {
      console.error(formatHookFail(suite, hook, style));
    }
    if (stopAtError) throw cause;
    addToErrorLog(hookPath(suite, hook), cause);
    return false;
  }
}

async function runTaskList(tasks: StackItem[], style: ReportStyle, stopAtError: boolean) {
  const active: StackItem[] = [];
  const failedBeforeAll = new Set<StackItem>();

  const closeInactive = async (path: StackItem[]) => {
    const keep = commonPathLen(active, path);
    for (let i = active.length - 1; i >= keep; i--) {
      const suite = active[i];
      if (!failedBeforeAll.has(suite)) await runAllHook(suite, 'afterAll', style, stopAtError);
      active.pop();
    }
  };

  const openSuites = async (path: StackItem[]) => {
    const keep = commonPathLen(active, path);
    for (let i = keep; i < path.length; i++) {
      const suite = path[i];
      active.push(suite);
      if (!(await runAllHook(suite, 'beforeAll', style, stopAtError))) {
        failedBeforeAll.add(suite);
        return false;
      }
    }
    return !path.some((suite) => failedBeforeAll.has(suite));
  };

  for (const task of tasks) {
    const path = task.path || [];
    await closeInactive(path);
    if (!task.test) {
      if (style.tree) log(`${task.prefix}${task.message}`);
      continue;
    }
    if (task.skip || (await openSuites(path))) await runTest(task, style, stopAtError);
  }
  await closeInactive([]);
}

function hasAllHooks(info: StackItem): boolean {
  return !!info.path?.some((suite) => suite.beforeAll || suite.afterAll);
}

function hasDynamicWorkerCount(fast: number): boolean {
  return fast === 1 || fast < 0 || (fast > 0 && fast < 1);
}

async function resolveParallelRuntime(): Promise<{ cluster?: any; workers: number }> {
  try {
    // @ts-ignore
    const cluster = (await imp('node:cluster')).default;
    let workers = opts.FAST;
    if (hasDynamicWorkerCount(workers)) {
      // @ts-ignore
      workers = fastWorkerCount(workers, (await imp('node:os')).cpus().length);
    }
    if (opts.FILTER) workers = Math.min(workers, 3);
    return { cluster, workers: parseFast(workers) ? workers : 0 };
  } catch (_) {
    return { workers: 0 };
  }
}

function splitParallelTasks(tasks: StackItem[]) {
  const parallelTasks: StackItem[] = [];
  const serialTasks: StackItem[] = [];
  for (const task of tasks) {
    (task.serial || hasAllHooks(task) ? serialTasks : parallelTasks).push(task);
  }
  return { parallelTasks, serialTasks };
}

async function runSequentialFallback(items: StackItem[], total: number, startTime: number) {
  isRunning = true;
  begin(total);
  await runTaskList(items, SEQUENTIAL_STYLE, opts.STOP_ON_ERROR);
  return finalize(total, startTime);
}

type ParallelMessage = {
  name: string;
  tasksDone: number;
  errorLog: string[];
  quietPassCount?: number;
  quietFailCount?: number;
};

async function runParallelWorker(
  cluster: any,
  totalW: number,
  parallelTasks: StackItem[],
  style: ReportStyle
) {
  proc!.on('error', (err: any) => console.log('internal error:', 'child crashed?', err));
  let tasksDone = 0;
  const workerIndex = Number.parseInt(proc!.env.JSBT_WORKER_INDEX || '', 10);
  const id =
    Number.isSafeInteger(workerIndex) && workerIndex >= 0 && workerIndex < totalW
      ? workerIndex
      : cluster.worker.id - 1;
  if (opts.QUIET) {
    quietPassCount = 0;
    quietFailCount = 0;
  }
  for (let i = id; i < parallelTasks.length; i += totalW) {
    await runTest(parallelTasks[i], style, opts.STOP_ON_ERROR);
    tasksDone++;
  }
  proc!.send({
    name: 'parallelTests',
    tasksDone,
    errorLog,
    quietPassCount,
    quietFailCount,
  });
  proc!.exit();
}

function logParallelQuietCounts(msg: ParallelMessage) {
  if (!opts.QUIET) return;
  if (msg.quietPassCount) writeStdout('.'.repeat(msg.quietPassCount));
  if (msg.quietFailCount) writeStderr(color('red', '!'.repeat(msg.quietFailCount)));
}

async function runPrimaryParallel(
  cluster: any,
  totalW: number,
  total: number,
  startTime: number,
  parallelTasks: StackItem[],
  serialTasks: StackItem[],
  style: ReportStyle
): Promise<number> {
  return new Promise((resolve, reject) => {
    begin(total, totalW);
    if (!opts.QUIET) console.log();
    const workers: any[] = [];
    let tasksDone = 0;
    let workersDone = 0;

    cluster.on('exit', (worker: { id: any; process: { pid: any } }, code: any) => {
      if (!code) return;
      const msg = `Worker W${worker.id} (pid: ${worker.process.pid}) crashed with code: ${code}`;
      workers.forEach((w) => w.kill()); // Shutdown other workers
      reject(new Error(msg));
    });
    for (let i = 0; i < totalW; i++) {
      const worker = cluster.fork({ JSBT_WORKER_INDEX: String(i) });
      workers.push(worker);
      worker.on('error', (err: any) => reject(err));
      worker.on('message', (msg: ParallelMessage) => {
        if (!msg || msg.name !== 'parallelTests') return;
        workersDone++;
        tasksDone += msg.tasksDone;
        logParallelQuietCounts(msg);
        msg.errorLog.forEach((item) => errorLog.push(item));
        if (workersDone !== totalW) return;
        if (tasksDone !== parallelTasks.length)
          return reject(new Error('internal error: not all tasks have been completed'));
        // @ts-ignore
        globalThis.setTimeout(async () => {
          try {
            await runTaskList(serialTasks, style, opts.STOP_ON_ERROR);
            resolve(finalize(total, startTime));
          } catch (error) {
            reject(error);
          }
        }, 0);
      });
    }
  });
}

// 123 tests started (JSBT_QUIET=1, JSBT_FAST=8, JSBT_FILTER='hash')
function begin(total: number, workers?: number | undefined) {
  const quiet = opts.QUIET ? 1 : 0;
  const fast = workers || 0;
  const envVars = [`JSBT_QUIET=${quiet}`, `JSBT_FAST=${fast}`, `JSBT_FILTER='${opts.FILTER}'`];
  if (isCli && proc?.env?.JSBT_BAIL !== undefined) {
    envVars.push(`JSBT_BAIL=${opts.STOP_ON_ERROR ? 1 : 0}`);
  }
  const env = color('gray', `(${envVars.join(', ')})`);
  const sfx = total > 1 ? 's' : '';
  console.log(`${color('green', total.toString())} test${sfx} started ${env}`);
}

function finalize(total: number, startTime: number) {
  isRunning = false;
  console.log();
  const totalFailed = errorLog.length;
  const sec = Math.ceil((Date.now() - startTime) / 1000);
  const tdiff = sec < 60 ? `in ${sec} sec` : `in ${Math.floor(sec / 60)} min ${sec % 60} sec`;
  if (totalFailed) {
    if (opts.QUIET) {
      errorLog.forEach((err) => console.error(err));
    }
    if (errorLog.length > 0)
      throw new Error(`${errorLog.length} of ${total} tests failed ${tdiff}`);
  } else {
    console.log(`${color('green', total)} tests passed ${tdiff}`);
  }
  return total;
}

async function runTests(forceSequential = false) {
  if (isRunning) throw new Error('it.run() has already been called, wait for end');
  errorLog.splice(0, errorLog.length);
  if (!forceSequential && opts.FAST) return runTestsInParallel();
  isRunning = true;
  const tasks = cloneAndReset();
  const total = tasks.filter((i) => !!i.test).length;
  begin(total);
  const startTime = Date.now();
  await runTaskList(tasks, SEQUENTIAL_STYLE, opts.STOP_ON_ERROR);
  return finalize(total, startTime);
}

async function runTestsWhen(importMetaUrl: string) {
  if (!isCli) return; // Ignore in browser
  // @ts-ignore
  const { pathToFileURL } = await imp('node:url');
  return importMetaUrl === pathToFileURL(proc!.argv[1]).href ? runTests() : undefined;
}

// Doesn't support tree and inline start/end output
async function runTestsInParallel(): Promise<number> {
  if (!isCli) throw new Error('must run in cli');
  errorLog.splice(0, errorLog.length);
  if ('deno' in (proc?.versions || {})) return runTests(true);
  const items = cloneAndReset();
  const tasks = items.filter((i) => !!i.test); // Filter describe elements
  const total = tasks.length;
  const startTime = Date.now();

  const { cluster, workers: totalW } = await resolveParallelRuntime();
  if (!cluster || !totalW) return runSequentialFallback(items, total, startTime);

  const { parallelTasks, serialTasks } = splitParallelTasks(tasks);
  const pathSep = parallelPathSep();
  if (!parallelTasks.length) {
    begin(total);
    await runTaskList(serialTasks, SEQUENTIAL_STYLE, opts.STOP_ON_ERROR);
    return finalize(total, startTime);
  }
  const style = flatStyle(pathSep);

  // the code is ran in workers
  if (!cluster.isPrimary) {
    await runParallelWorker(cluster, totalW, parallelTasks, style);
    return total;
  }

  // the code is ran in primary proc
  return runPrimaryParallel(
    cluster,
    totalW,
    total,
    startTime,
    parallelTasks,
    serialTasks,
    style
  ).catch((err: Error) => {
    console.error();
    console.error(color('red', 'Tests failed: ' + err.message));
    err.stack = '';
    throw err;
  });
}

/**
 * Registers test for future running.
 * Would not auto-run, needs `it.run()` to be called at some point.
 * See {@link TestFunction} for methods.
 * @param message test title
 * @param test function, may be async
 */
const it: TestFunction = (message, test) => register({ message, test, children: [] });
it.only = (message, test) => register((onlyStack = { message, test, children: [], only: true }));
it.skip = (message, test) => register({ message, test, children: [], skip: true });
it.serial = (message, test) => register({ message, test, children: [], serial: true });
it.run = runTests;
it.runWhen = runTestsWhen;
it.opts = opts;

export { afterAll, afterEach, beforeAll, beforeEach, describe, it, it as should };
export default it;
