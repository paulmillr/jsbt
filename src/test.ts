/*! jsbt - MIT License (c) 2019 Paul Miller (paulmillr.com) */
/**
 * Micro testing framework with familiar syntax for browsers, node and others.
 * Supports fast mode (parallel), quiet mode (dot reporter), CLI self-run auto-detection.
 * @module
 */

/** A single test. */
export interface StackItem {
  message: string;
  test?: () => Promise<any> | any;
  skip?: boolean;
  only?: boolean;
  serial?: boolean;
  path?: StackItem[];
  beforeAll?: () => Promise<void> | void;
  afterAll?: () => Promise<void> | void;
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
  children: StackItem[];
}

/** A flattened test/suite with its ancestor chain resolved by stackFlatten. */
interface Task extends StackItem {
  path: Task[];
}

export interface Options {
  BAIL: boolean;
  QUIET: boolean;
  WORKERS: number;
  FILTER: string;
  DEBUG: boolean;
  COLOR: boolean;
}

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
  /** Registers test that is kept on a dedicated serial worker lane when tests run in parallel. */
  serial: (message: string, test: () => Promise<any> | any) => void;
  /**
   * Runs all registered tests.
   * After run, allows to run new tests without duplication: old test queue is cleaned up.
   * @param forceSequential - when `true`, disables automatic parallelization even when JSBT_WORKERS allows more than one worker.
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
type TaskTiming = { durationMs: number; path: string };
const taskTimings: TaskTiming[] = [];
// Set in parallel workers to batch quiet-mode dots for the primary; undefined = write directly.
let quietCounter: { pass: number; fail: number } | undefined;
let onlyStack: StackItem | undefined;
let isRunning = false;
let runIndex = 0; // run() calls seen by this process; workers count replayed calls the same way
const isCli = 'process' in globalThis;
// Dumb bundlers parse code and assume we have hard dependency on "process". We don't.
// The trick (also import(mod) below) ensures parsers can't see it.
// @ts-ignore
const pr = globalThis['process'];
const proc: Record<string, any> | undefined = isCli ? pr : undefined;
type Env = Record<string, string | undefined>;
const isNode = isCli && typeof proc?.versions?.node === 'string';
type NativeNodeTest = Record<string, any>;

function hasImportSearch(importMetaUrl: string): boolean {
  try {
    return new URL(importMetaUrl).search !== '';
  } catch (_) {
    return importMetaUrl.includes('?');
  }
}

function isNodeTestArg(arg: unknown): boolean {
  const str = String(arg);
  return str === '--test' || str.startsWith('--test-') || str.startsWith('--test=');
}

function resolveNativeNodeTest(): NativeNodeTest | undefined {
  if (!isNode || hasImportSearch(import.meta.url)) return;
  const env = proc?.env || {};
  const isTestContext =
    env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_WORKER_ID !== undefined;
  const hasTestArg = Array.isArray(proc?.execArgv) && proc!.execArgv.some(isNodeTestArg);
  if (!isTestContext || !hasTestArg || typeof proc?.getBuiltinModule !== 'function') return;
  return proc.getBuiltinModule('node:test');
}

const nativeNodeTest = resolveNativeNodeTest();
let nativeTestCount = 0;

function wantColor(env: Env = {}, tty = false): boolean {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
}
const opts: Options = {
  BAIL: isCli ? parseBoolEnv(proc?.env?.JSBT_BAIL, true) : true,
  QUIET: isCli && parseBoolEnv(proc?.env?.JSBT_QUIET, false),
  WORKERS: defaultWorkers(proc?.env),
  FILTER: isCli ? proc?.env?.JSBT_FILTER || '' : '',
  DEBUG: isCli && parseBoolEnv(proc?.env?.JSBT_DEBUG, false),
  COLOR: isCli && wantColor(proc?.env, !!proc?.stderr?.isTTY || !!proc?.stdout?.isTTY),
};
// Renamed option: fail loudly instead of silently ignoring stale configs.
// Non-enumerable, so Object.keys(opts) and spreads stay clean.
Object.defineProperty(opts, 'STOP_ON_ERROR', {
  get(): never {
    throw new Error('opts.STOP_ON_ERROR was renamed to opts.BAIL');
  },
  set(_value: unknown) {
    throw new Error('opts.STOP_ON_ERROR was renamed to opts.BAIL');
  },
});

// Web Worker lane (Deno): workers are spawned as `jsbt-worker:<generation>`. The entry
// URL comes from the worker's own location, which equals the spawned module URL; it lets
// runWhen distinguish the entry from imported test files, since worker argv is a shim.
const WEB_WORKER_PREFIX = 'jsbt-worker:';
const webWorker: { generation: number; mainModule: string } | undefined = (() => {
  if (typeof (globalThis as any).WorkerGlobalScope === 'undefined') return undefined;
  const g = globalThis as any;
  const name = g.name;
  if (typeof name !== 'string' || !name.startsWith(WEB_WORKER_PREFIX)) return undefined;
  return {
    generation: Number(name.slice(WEB_WORKER_PREFIX.length)),
    mainModule: String(g.location?.href ?? ''),
  };
})();

// A Web Worker's argv points at the runtime's shim, not the entry it replays. Point it
// back at the entry so "am I the CLI entry?" guards — runWhen or hand-rolled argv
// checks in user entries — behave exactly as they did in the primary.
if (webWorker !== undefined && isCli && Array.isArray(proc?.argv)) {
  try {
    const url = new URL(webWorker.mainModule);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1); // windows drive letters
    proc!.argv[1] = path;
  } catch (_) {
    // non-file entry URL: leave argv alone, runWhen still matches via webWorker.mainModule
  }
}

// Set on forked workers: the run() generation the worker was forked for. Cluster workers
// get an env var (read-and-delete, so processes spawned inside tests never inherit it);
// Web Workers carry it in their name.
const workerGeneration: number | undefined = (() => {
  const raw = proc?.env?.JSBT_RUN_GENERATION;
  if (raw !== undefined) {
    delete proc!.env.JSBT_RUN_GENERATION;
    return Number(raw);
  }
  return webWorker?.generation;
})();

// How long a forked worker may take to replay the entry script and send its first
// ready message. Generous: init is imports plus registration, never test bodies.
const workerInitTimeoutMs: number = (() => {
  const val = Number(proc?.env?.JSBT_WORKER_INIT_TIMEOUT_MS);
  return Number.isFinite(val) && val > 0 ? val : 60_000;
})();

function parseBoolEnv(str: string | undefined, defaultValue: boolean): boolean {
  if (str === undefined) return defaultValue;
  const raw = String(str).trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '' || raw === '0' || raw === 'false') return false;
  return defaultValue;
}

// `JSBT_WORKERS` is a literal worker count: `1` is serial, `N` is N workers. The other
// spellings are conveniences — unset/`auto` means all cores, `-N` means cores minus N,
// `50%` (or `0.5`) a share of cores; machine-relative spellings cap at 10 workers.
// A spec is `Infinity` for auto, a negative offset, a (0,1) ratio, or a count;
// `workerCount` resolves it against the machine.
function parseWorkers(str: string | number): number {
  if (!isCli) return 1;
  const raw = String(str ?? '')
    .trim()
    .toLowerCase();
  if (raw === '' || raw === 'auto') return Infinity;
  const percent = raw.endsWith('%');
  const val = Number.parseFloat(percent ? raw.slice(0, -1) : raw) / (percent ? 100 : 1);
  const ratio = val > 0 && val < 1;
  const valid =
    Number.isFinite(val) &&
    val !== 0 &&
    Math.abs(val) <= 256 &&
    (ratio || val === 1 || Number.isSafeInteger(val));
  if (!valid)
    throw new Error(
      `invalid JSBT_WORKERS: ${str}; use a count, -N for cores minus N, N% of cores, or auto`
    );
  return percent && val === 1 ? Infinity : val;
}

function defaultWorkers(env: Env = {}): number {
  if (!isNode) return 1;
  return env.JSBT_WORKERS === undefined ? Infinity : parseWorkers(env.JSBT_WORKERS);
}

function workerCount(spec: number, max: number): number {
  const count =
    spec === Infinity ? max : spec < 0 ? max + spec : spec < 1 ? Math.floor(max * spec) : spec;
  // Relative specs cap at 10: throughput flattens past ~10 workers while per-worker
  // startup cost keeps growing. Explicit counts are honored as written.
  const cap = spec === Infinity || spec < 1 ? 10 : 256;
  return Math.max(1, Math.min(count, cap));
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

// Colorize string for terminal.
function color(colorName: keyof typeof c, title: string | number) {
  return opts.COLOR ? `${c[colorName]}${title}${c.reset}` : title.toString();
}
const displaySep = () => color('gray', ' → ');
// CLI gets the inline reporter (title rewritten in place on finish); browsers get plain lines.
const SEQUENTIAL_INLINE = isCli;

function log(...args: (string | undefined)[]) {
  if (opts.QUIET) return; // dots are per finished test (logTaskDone), not per suppressed line
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
  if (quietCounter) {
    if (fail) quietCounter.fail++;
    else quietCounter.pass++;
  } else if (fail) {
    writeStderr(color('red', '!'));
  } else {
    writeStdout('.');
  }
}
function addToErrorLog(title = '', error: any): void {
  errorLog.push(`${title} ${error?.stack ? error.stack : error}`);
  if (!opts.QUIET) console.error(error); // loud = show error now. quiet = show in the end
}

// Failure banner shared by tests and beforeAll/afterAll hooks. Quiet + bail prints the
// full line before the throw; quiet without bail emits `!`; loud prints the line
// (tests override loud rendering via logTaskDone for the inline reporter).
function logFailLine(line: string, stopAtError: boolean): void {
  if (!opts.QUIET) return void console.error(line);
  if (stopAtError) {
    console.error();
    console.error(line);
  } else {
    logQuiet(true);
  }
}

function timingNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

async function runTest(info: Task, inline: boolean, stopAtError: boolean): Promise<boolean> {
  if (!opts.DEBUG) return runTestInner(info, inline, stopAtError);
  const start = timingNow();
  try {
    return await runTestInner(info, inline, stopAtError);
  } finally {
    taskTimings.push({ durationMs: timingNow() - start, path: taskPath(info) });
  }
}

async function runTestInner(info: Task, inline: boolean, stopAtError: boolean): Promise<boolean> {
  if (typeof info.test !== 'function') throw new Error('internal test error: invalid info.test');

  const parts: string[] = [];
  const beforeEachFns: EmptyFn[] = [];
  const afterEachFns: EmptyFn[] = []; // will be reversed
  for (const parent of info.path) {
    if (parent.message) parts.push(parent.message);
    if (parent.beforeEach) beforeEachFns.push(parent.beforeEach);
    if (parent.afterEach) afterEachFns.push(parent.afterEach);
  }
  afterEachFns.reverse();
  if (info.message) parts.push(info.message);

  const sep = displaySep();
  const path = parts.join(PATH_SEP);
  const displayPath = parts.join(sep);
  const isInline = inline && !info.skip && !opts.QUIET;

  if (isInline) {
    logInline(`${displayPath} `);
  } else if (info.skip) {
    log(`☆ ${displayPath} (skip)`);
    return true;
  }

  function formatTaskDone(fail = false, suffix = '') {
    const symbol = color(fail ? 'red' : 'green', fail ? '✕' : '✓');
    const full = suffix ? `${displayPath}${sep}${suffix}` : displayPath;
    return `${symbol} ${full}`;
  }

  function logTaskDone(fail = false, suffix = '') {
    if (opts.QUIET) return logQuiet(fail);
    const line = formatTaskDone(fail, suffix);
    if (isInline) logInline(line, true);
    else if (fail) console.error(line);
    else log(line);
  }

  function logErrorStack(suffix: string) {
    if (opts.QUIET) logFailLine(formatTaskDone(true, suffix), stopAtError);
    else logTaskDone(true, suffix);
  }

  const runStep = async (fn: () => Promise<any> | any, suffix: string): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (cause) {
      logErrorStack(suffix);
      if (stopAtError) throw cause;
      addToErrorLog(suffix ? `${path}/${suffix}` : path, cause);
      return false;
    }
  };

  for (const fn of beforeEachFns) if (!(await runStep(fn, 'beforeEach'))) return false;
  if (!(await runStep(info.test, ''))) return false;
  for (const fn of afterEachFns) if (!(await runStep(fn, 'afterEach'))) return false;
  logTaskDone();
  return true;
}

function stackTop() {
  return stack[stack.length - 1];
}
function stackAdd(info: { message: any; skip?: boolean }) {
  const item = { ...info, children: [] };
  stackTop().children.push(item);
  stack.push(item);
}

function stackFlatten(elm: StackItem): Task[] {
  const out: Task[] = [];
  const rootPath: Task[] =
    elm.beforeAll || elm.afterAll || elm.beforeEach || elm.afterEach ? [{ ...elm, path: [] }] : [];
  const walk = (elm: StackItem, path: Task[]) => {
    const newElm: Task = { ...elm, path };
    if (newElm.test) out.push(newElm); // suites travel via task.path, not as rows
    for (const child of elm.children) walk(child, path.concat([newElm]));
  };
  // Skip root
  for (const child of elm.children) walk(child, rootPath);
  return out;
}

const describe: DescribeFunction = (message: any, fn: EmptyFn): void => {
  if (nativeNodeTest) {
    nativeNodeTest.describe(message, fn);
    return;
  }
  stackAdd({ message });
  fn(); // Run function in the context of current stack path
  stack.pop();
};

function describeSkip(message: any, fn: EmptyFn): void {
  if (nativeNodeTest) {
    nativeNodeTest.describe.skip(message, fn);
    return;
  }
  stackAdd({ message, skip: true });
  // fn();
  stack.pop();
}
describe.skip = describeSkip;

type AllHookName = 'beforeAll' | 'afterAll';
type EachHookName = 'beforeEach' | 'afterEach';

function makeHook(key: AllHookName | EachHookName, nativeName: string): (fn: EmptyFn) => void {
  return (fn: EmptyFn): void => {
    if (nativeNodeTest) nativeNodeTest[nativeName](fn);
    else stackTop()[key] = fn;
  };
}
const beforeAll: (fn: EmptyFn) => void = makeHook('beforeAll', 'before');
const afterAll: (fn: EmptyFn) => void = makeHook('afterAll', 'after');
const beforeEach: (fn: EmptyFn) => void = makeHook('beforeEach', 'beforeEach');
const afterEach: (fn: EmptyFn) => void = makeHook('afterEach', 'afterEach');

function register(info: StackItem) {
  if (nativeNodeTest) {
    const options: Record<string, boolean> = {};
    if (info.only) options.only = true;
    if (info.skip) options.skip = true;
    if (info.serial) options.concurrency = false;
    nativeTestCount++;
    if (Object.keys(options).length) nativeNodeTest.test(info.message, options, info.test);
    else nativeNodeTest.test(info.message, info.test);
    return;
  }
  stackAdd(info);
  stack.pop(); // remove from stack since there are no children
}

function taskPath(info: Task, pathSep: string = PATH_SEP): string {
  return info.path
    .map((item) => item.message)
    .concat(info.message)
    .filter((item) => item)
    .join(pathSep);
}

function filterTasks(tasks: Task[]): Task[] {
  const filter = opts.FILTER;
  if (!filter) return tasks;
  return tasks.filter((task) => taskPath(task).includes(filter));
}

// Consumes the registration stack; returns the runnable tests.
function cloneAndReset(): Task[] {
  let tasks = stackFlatten(stack[0]);
  if (onlyStack) tasks = tasks.filter((i) => i.test === onlyStack!.test);
  tasks = filterTasks(tasks);
  stack.splice(0, stack.length);
  stack.push({ message: '', children: [] });
  onlyStack = undefined;
  return tasks;
}

function commonPathLen(a: Task[], b: Task[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function hookPath(suite: Task, hook: AllHookName, pathSep: string = PATH_SEP): string {
  return suite.path
    .map((i) => i.message)
    .concat(suite.message, hook)
    .filter((i) => i)
    .join(pathSep);
}

async function runAllHook(suite: Task, hook: AllHookName, stopAtError: boolean): Promise<boolean> {
  const fn = suite[hook];
  if (!fn) return true;
  try {
    await fn();
    return true;
  } catch (cause) {
    logFailLine(`${color('red', '✕')} ${hookPath(suite, hook, displaySep())}`, stopAtError);
    if (stopAtError) throw cause;
    addToErrorLog(hookPath(suite, hook), cause);
    return false;
  }
}

async function runTaskList(tasks: Task[], inline: boolean, stopAtError: boolean) {
  const active: Task[] = [];
  const failedBeforeAll = new Set<Task>();

  const closeInactive = async (path: Task[]) => {
    const keep = commonPathLen(active, path);
    for (let i = active.length - 1; i >= keep; i--) {
      const suite = active[i];
      if (!failedBeforeAll.has(suite)) await runAllHook(suite, 'afterAll', stopAtError);
      active.pop();
    }
  };

  const openSuites = async (path: Task[]) => {
    const keep = commonPathLen(active, path);
    for (let i = keep; i < path.length; i++) {
      const suite = path[i];
      active.push(suite);
      if (!(await runAllHook(suite, 'beforeAll', stopAtError))) {
        failedBeforeAll.add(suite);
        return false;
      }
    }
    return !path.some((suite) => failedBeforeAll.has(suite));
  };

  for (const task of tasks) {
    await closeInactive(task.path);
    if (task.skip || (await openSuites(task.path))) await runTest(task, inline, stopAtError);
  }
  await closeInactive([]);
}

function hasAllHooks(info: Task): boolean {
  return info.path.some((suite) => suite.beforeAll || suite.afterAll);
}

type ParallelRuntime =
  | { kind: 'cluster'; cluster: any; workers: number }
  | { kind: 'web'; mainModule: string; workers: number };

// Resolves the JSBT_WORKERS spec against the machine; FILTER caps the fleet at 3.
function resolveWorkerCount(cores: number): number {
  const workers = workerCount(opts.WORKERS, cores);
  return opts.FILTER ? Math.min(workers, 3) : workers;
}

// navigator.hardwareConcurrency (node 21+, deno, bun) respects cgroup CPU quotas and
// affinity masks; availableParallelism (node 18.14+) has the same semantics. No raw
// cpus() fallback — it over-forks in containers; ancient node throws here and the
// caller's catch degrades the run to sequential.
async function machineParallelism(): Promise<number> {
  const cores = (globalThis as any).navigator?.hardwareConcurrency;
  if (cores) return cores;
  // @ts-ignore
  return (await imp('node:os')).availableParallelism();
}

async function resolveParallelRuntime(): Promise<ParallelRuntime | undefined> {
  if ('deno' in (proc?.versions || {})) {
    // Deno has no node:cluster; its native Web Workers are real threads.
    const g = globalThis as any;
    const mainModule = g['Deno']?.mainModule;
    if (typeof mainModule !== 'string' || typeof g.Worker !== 'function') return undefined;
    return { kind: 'web', mainModule, workers: resolveWorkerCount(await machineParallelism()) };
  }
  try {
    // @ts-ignore
    const cluster = (await imp('node:cluster')).default;
    return { kind: 'cluster', cluster, workers: resolveWorkerCount(await machineParallelism()) };
  } catch (_) {
    return undefined;
  }
}

function splitParallelTasks(tasks: Task[]) {
  const parallelTasks: Task[] = [];
  const serialTasks: Task[] = [];
  for (const task of tasks) {
    (task.serial || hasAllHooks(task) ? serialTasks : parallelTasks).push(task);
  }
  return { parallelTasks, serialTasks };
}

// FNV-1a over the task paths. Assignments cross the IPC channel as bare indices,
// so a worker whose replayed task list diverges from the primary's would silently
// run the wrong tests; the primary compares fingerprints and fails loudly instead.
function taskFingerprint(parallelTasks: Task[], serialTasks: Task[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const tasks of [parallelTasks, serialTasks]) {
    for (const task of tasks) {
      mix(taskPath(task));
      mix('\n');
    }
    mix('--\n');
  }
  return `${(hash >>> 0).toString(16)}:${parallelTasks.length}:${serialTasks.length}`;
}

async function runSequentialFallback(items: Task[], total: number, startTime: number) {
  isRunning = true;
  begin(total);
  await runTaskList(items, SEQUENTIAL_INLINE, opts.BAIL);
  return finalize(total, startTime);
}

type ParallelReadyMessage = {
  name: 'parallelReady';
  fingerprint: string;
  quietPassCount?: number;
  quietFailCount?: number;
};

type ParallelTaskMessage =
  | { name: 'parallelTask'; taskIndex: number | null }
  | { name: 'parallelSerial' };

type ParallelTestsMessage = {
  name: 'parallelTests';
  tasksDone: number;
  serialTasksDone: number;
  quietPassCount?: number;
  quietFailCount?: number;
  errorLog: string[];
  taskTimings: TaskTiming[];
};

type ParallelWorkerMessage = ParallelReadyMessage | ParallelTestsMessage;

function isTaskCommand(msg: any): msg is ParallelTaskMessage {
  return !!msg && (msg.name === 'parallelTask' || msg.name === 'parallelSerial');
}

// Worker-side counterpart of SpawnedWorker: one object owns the transport dialect.
type WorkerChannel = {
  send: (msg: ParallelWorkerMessage) => Promise<void>;
  receiveTask: () => Promise<ParallelTaskMessage>;
  exit: () => void;
};

function makeWebWorkerChannel(): WorkerChannel {
  const g = globalThis as any;
  let pending: ((msg: ParallelTaskMessage) => void) | undefined;
  const queue: ParallelTaskMessage[] = [];
  // One persistent listener; per-task subscribe/unsubscribe would churn on large suites.
  g.addEventListener('message', (event: any) => {
    if (!isTaskCommand(event.data)) return;
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve(event.data);
    } else {
      queue.push(event.data);
    }
  });
  return {
    send: (msg) => {
      g.postMessage(msg);
      return Promise.resolve();
    },
    receiveTask: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : new Promise((resolve) => {
            pending = resolve;
          }),
    exit: () => g.close(),
  };
}

function makeClusterChannel(): WorkerChannel {
  proc!.on('error', (err: any) => console.log('internal error:', 'child crashed?', err));
  return {
    send: (msg) =>
      new Promise((resolve, reject) => {
        proc!.send(msg, (error: Error | null) => (error ? reject(error) : resolve()));
      }),
    receiveTask: () =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          proc!.off('message', onMessage);
          proc!.off('error', onError);
          proc!.off('disconnect', onDisconnect);
        };
        const onMessage = (msg: ParallelTaskMessage) => {
          if (!isTaskCommand(msg)) return;
          cleanup();
          resolve(msg);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onDisconnect = () => onError(new Error('primary process disconnected'));
        proc!.on('message', onMessage);
        proc!.once('error', onError);
        proc!.once('disconnect', onDisconnect);
      }),
    exit: () => proc!.exit(),
  };
}

async function requestParallelTask(
  channel: WorkerChannel,
  fingerprint: string
): Promise<ParallelTaskMessage> {
  const response = channel.receiveTask();
  const msg: ParallelReadyMessage = { name: 'parallelReady', fingerprint };
  if (quietCounter) {
    msg.quietPassCount = quietCounter.pass;
    msg.quietFailCount = quietCounter.fail;
    quietCounter.pass = 0;
    quietCounter.fail = 0;
  }
  await channel.send(msg);
  return response;
}

async function runParallelWorker(parallelTasks: Task[], serialTasks: Task[]) {
  const channel = webWorker !== undefined ? makeWebWorkerChannel() : makeClusterChannel();
  const fingerprint = taskFingerprint(parallelTasks, serialTasks);
  let tasksDone = 0;
  let serialTasksDone = 0;
  if (opts.QUIET) quietCounter = { pass: 0, fail: 0 };
  for (;;) {
    const command = await requestParallelTask(channel, fingerprint);
    if (command.name === 'parallelSerial') {
      await runTaskList(serialTasks, false, opts.BAIL);
      serialTasksDone = serialTasks.length;
      continue; // rejoin the parallel pool instead of idling until the run ends
    }
    const taskIndex = command.taskIndex;
    if (taskIndex === null) break;
    const task = parallelTasks[taskIndex];
    if (!task) throw new Error(`internal error: invalid parallel task index: ${taskIndex}`);
    await runTest(task, false, opts.BAIL);
    tasksDone++;
  }
  await channel.send({
    name: 'parallelTests',
    tasksDone,
    serialTasksDone,
    quietPassCount: quietCounter?.pass,
    quietFailCount: quietCounter?.fail,
    errorLog,
    taskTimings,
  });
  channel.exit();
}

function logParallelQuietCounts(msg: { quietPassCount?: number; quietFailCount?: number }) {
  if (!opts.QUIET) return;
  if (msg.quietPassCount) writeStdout('.'.repeat(msg.quietPassCount));
  if (msg.quietFailCount) writeStderr(color('red', '!'.repeat(msg.quietFailCount)));
}

// Runtime-neutral worker handle: cluster children and Web Workers speak different
// dialects (EventEmitter vs EventTarget, exit codes vs nothing); the primary loop
// only sees this shape.
type SpawnedWorker = {
  label: string;
  send: (msg: ParallelTaskMessage, onError: (err: Error) => void) => void;
  onMessage: (fn: (msg: ParallelWorkerMessage) => void) => void;
  onError: (fn: (err: Error) => void) => void;
  /** Web Workers cannot observe exits; their implementation never fires. */
  onExit: (fn: (cause: string) => void) => void;
  kill: () => void;
};

function spawnClusterWorker(cluster: any, generation: number): SpawnedWorker {
  const worker = cluster.fork({ JSBT_RUN_GENERATION: String(generation) });
  return {
    label: `W${worker.id} (pid: ${worker.process.pid})`,
    send: (msg, onError) =>
      worker.send(msg, (err: Error | null) => {
        if (err) onError(err);
      }),
    onMessage: (fn) => worker.on('message', fn),
    onError: (fn) => worker.on('error', fn),
    onExit: (fn) =>
      worker.on('exit', (code: number | null, signal: string | null) =>
        fn(signal ? `signal: ${signal}` : `code: ${code}`)
      ),
    kill: () => worker.kill(),
  };
}

function spawnWebWorker(mainModule: string, generation: number, index: number): SpawnedWorker {
  const worker = new (globalThis as any).Worker(mainModule, {
    type: 'module',
    name: WEB_WORKER_PREFIX + generation,
  });
  return {
    label: `W${index + 1}`,
    send: (msg, _onError) => worker.postMessage(msg),
    onMessage: (fn) => worker.addEventListener('message', (event: any) => fn(event.data)),
    onError: (fn) =>
      worker.addEventListener('error', (event: any) => {
        event.preventDefault?.(); // an unhandled worker error would kill this process too
        fn(new Error(event.message || 'worker crashed'));
      }),
    onExit: () => {},
    kill: () => worker.terminate(),
  };
}

async function runPrimaryParallel(
  spawnWorker: (index: number) => SpawnedWorker,
  totalW: number,
  total: number,
  startTime: number,
  parallelTasks: Task[],
  serialTasks: Task[]
): Promise<number> {
  begin(total, totalW);
  if (!opts.QUIET) console.log();
  const expectedFingerprint = taskFingerprint(parallelTasks, serialTasks);
  const workers: SpawnedWorker[] = [];
  let nextTask = 0;
  let tasksDone = 0;
  let serialTasksDone = 0;
  const claimTask = () => (nextTask < parallelTasks.length ? nextTask++ : null);
  // The serial lane goes to the first worker that reports ready — once. That worker
  // rejoins the parallel pool afterwards, so a 2-worker run is not 1 serial + 1 parallel.
  let serialAssigned = serialTasks.length === 0;
  const workerRun = new Promise<void>((resolve, reject) => {
    let workersDone = 0;

    for (let i = 0; i < totalW; i++) {
      const worker = spawnWorker(i);
      workers.push(worker);
      let reportedResults = false;
      // A worker stuck before its first ready message would stall the run forever;
      // unlike slow tests, init has no excuse to take this long.
      const initTimer = setTimeout(() => {
        const secs = workerInitTimeoutMs / 1000;
        reject(new Error(`Worker ${worker.label} did not initialize within ${secs} sec`));
      }, workerInitTimeoutMs);
      (initTimer as any).unref?.();
      worker.onError((err) => reject(err));
      // Any exit before the results message loses that worker's claimed tasks —
      // crash (nonzero), signal death (OOM kill), or a test calling process.exit(0).
      // After a reject, cleanup kills land here too; the settled promise ignores them.
      worker.onExit((cause) => {
        clearTimeout(initTimer);
        if (reportedResults) return;
        reject(new Error(`Worker ${worker.label} exited before reporting results (${cause})`));
      });
      worker.onMessage((msg) => {
        if (!msg) return;
        if (msg.name === 'parallelReady') {
          clearTimeout(initTimer);
          if (msg.fingerprint !== expectedFingerprint) {
            const detail = `worker ${worker.label} task list differs from primary`;
            return reject(new Error(`${detail}; test registration must be deterministic`));
          }
          logParallelQuietCounts(msg);
          const command: ParallelTaskMessage = serialAssigned
            ? { name: 'parallelTask', taskIndex: claimTask() }
            : { name: 'parallelSerial' };
          serialAssigned = true;
          worker.send(command, reject);
          return;
        }
        if (msg.name !== 'parallelTests') return;
        reportedResults = true;
        logParallelQuietCounts(msg);
        workersDone++;
        tasksDone += msg.tasksDone;
        serialTasksDone += msg.serialTasksDone;
        msg.errorLog.forEach((item) => errorLog.push(item));
        taskTimings.push(...msg.taskTimings);
        if (workersDone !== totalW) return;
        resolve();
      });
    }
  });
  try {
    await workerRun;
    if (tasksDone !== parallelTasks.length)
      throw new Error('internal error: not all tasks have been completed');
    if (serialTasksDone !== serialTasks.length)
      throw new Error('internal error: not all serial tasks have been completed');
    return finalize(total, startTime);
  } catch (error) {
    workers.forEach((worker) => worker.kill());
    throw error;
  }
}

// 123 tests started (JSBT_QUIET=1, JSBT_WORKERS=8, JSBT_FILTER='hash')
function begin(total: number, workers?: number | undefined) {
  const quiet = opts.QUIET ? 1 : 0;
  const count = workers || 1;
  const envVars = [`JSBT_QUIET=${quiet}`, `JSBT_WORKERS=${count}`, `JSBT_FILTER='${opts.FILTER}'`];
  if (!opts.BAIL) envVars.push('JSBT_BAIL=0');
  if (opts.DEBUG) envVars.push('JSBT_DEBUG=1');
  const env = color('gray', `(${envVars.join(', ')})`);
  const sfx = total > 1 ? 's' : '';
  console.log(`${color('green', total.toString())} test${sfx} started ${env}`);
}

function formatTestDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function logLongTestReport(): void {
  if (!opts.DEBUG || !taskTimings.length) return;
  const durationsAsc = taskTimings.map((timing) => timing.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(durationsAsc.length / 2);
  const median =
    durationsAsc.length % 2
      ? durationsAsc[middle]
      : (durationsAsc[middle - 1] + durationsAsc[middle]) / 2;
  const slowest = taskTimings
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs || a.path.localeCompare(b.path))
    .slice(0, 10);
  const durations = slowest.map((timing) => formatTestDuration(timing.durationMs));
  const width = Math.max(...durations.map((duration) => duration.length));
  console.log('Long test report:');
  console.log(`  Median test time: ${formatTestDuration(median)}`);
  console.log(`  Slowest ${slowest.length} test${slowest.length === 1 ? '' : 's'}:`);
  for (let i = 0; i < slowest.length; i++) {
    console.log(`    ${durations[i].padStart(width)}  ${slowest[i].path}`);
  }
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
  logLongTestReport();
  return total;
}

async function runTests(forceSequential = false) {
  if (nativeNodeTest) return nativeTestCount;
  const generation = runIndex++;
  // Workers replay the whole entry script: run() calls before this worker's
  // generation belong to batches it does not own — consume their registrations, skip.
  if (workerGeneration !== undefined && generation < workerGeneration) {
    return cloneAndReset().length;
  }
  if (isRunning) throw new Error('it.run() has already been called, wait for end');
  errorLog.splice(0, errorLog.length);
  taskTimings.splice(0, taskTimings.length);
  // A replay worker always takes the parallel path: its own opts may differ from
  // the primary's (e.g. a Web Worker without inherited env), but its role does not.
  const parallel = workerGeneration !== undefined || (!forceSequential && opts.WORKERS !== 1);
  if (parallel) return runTestsInParallel(generation);
  const tasks = cloneAndReset();
  return runSequentialFallback(tasks, tasks.length, Date.now());
}

async function runTestsWhen(importMetaUrl: string) {
  if (nativeNodeTest) return;
  if (!isCli) return; // Ignore in browser
  // A Web Worker's argv does not point at the entry; compare against the URL it
  // was spawned with, so imported test files' runWhen calls stay no-ops.
  if (webWorker !== undefined)
    return importMetaUrl === webWorker.mainModule ? runTests() : undefined;
  // @ts-ignore
  const { pathToFileURL } = await imp('node:url');
  return importMetaUrl === pathToFileURL(proc!.argv[1]).href ? runTests() : undefined;
}

// Workers never render inline start/end output
async function runTestsInParallel(generation: number): Promise<number> {
  if (!isCli) throw new Error('must run in cli');
  const tasks = cloneAndReset();
  const total = tasks.length;
  const startTime = Date.now();

  // Replay workers (cluster env or Web Worker name) know their role before any
  // runtime resolution — a cluster child never needs to import node:cluster.
  if (workerGeneration !== undefined) {
    const { parallelTasks, serialTasks } = splitParallelTasks(tasks);
    await runParallelWorker(parallelTasks, serialTasks);
    return total;
  }

  const runtime = await resolveParallelRuntime();
  if (!runtime || runtime.workers <= 1) return runSequentialFallback(tasks, total, startTime);

  const { parallelTasks, serialTasks } = splitParallelTasks(tasks);
  if (!parallelTasks.length) return runSequentialFallback(serialTasks, total, startTime);

  const spawnWorker =
    runtime.kind === 'cluster'
      ? (_index: number) => spawnClusterWorker(runtime.cluster, generation)
      : (index: number) => spawnWebWorker(runtime.mainModule, generation, index);

  // the code is ran in primary proc
  return runPrimaryParallel(
    spawnWorker,
    runtime.workers,
    total,
    startTime,
    parallelTasks,
    serialTasks
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
