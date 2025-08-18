/*! micro-should - MIT License (c) 2019 Paul Miller (paulmillr.com) */
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
  prefix?: string;
  childPrefix?: string;
  path?: StackItem[];
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
  children: StackItem[];
}

export interface Options {
  PRINT_TREE: boolean;
  PRINT_MULTILINE: boolean;
  STOP_ON_ERROR: boolean;
  QUIET: boolean;
  FAST: number;
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
  /**
   * Runs all registered tests.
   * After run, allows to run new tests without duplication: old test queue is cleaned up.
   * @param forceSequential - when `true`, disables automatic parallelization even when MSHOULD_FAST=1.
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
  /** Parallel version, using node:cluster. Auto-selected when env var MSHOULD_FAST=1 is set. */
  runParallel: () => Promise<number>;
  opts: Options;
}
export type EmptyFn = () => Promise<void> | void;

declare const console: any;

const stack: StackItem[] = [{ message: '', children: [] }];
const errorLog: string[] = [];
let onlyStack: StackItem | undefined;
let isRunning = false;
const isCli = 'process' in globalThis;
// Dumb bundlers parse code and assume we have hard dependency on "process". We don't.
// The trick (also import(mod) below) ensures parsers can't see it.
// @ts-ignore
const pr = globalThis['process'];
const proc: Record<string, any> | undefined = isCli ? pr : undefined;
const opts: Options = {
  PRINT_TREE: true,
  PRINT_MULTILINE: true,
  STOP_ON_ERROR: true,
  QUIET: isCli && ['1', 'true'].includes(proc?.env?.MSHOULD_QUIET),
  FAST: parseFast(proc?.env?.MSHOULD_FAST),
};

function parseFast(str: string | number): number {
  if (!isCli) return 0;
  let val = str === 'true' ? 1 : Number.parseInt(str as string, 10);
  if (!Number.isSafeInteger(val) || val < 1 || val > 256) return 0;
  return val;
}

function imp(moduleName: string): any {
  return import(moduleName);
}

// String formatting utils
const _c = String.fromCharCode(27); // x1b, control code for terminal colors
const c = {
  // colors
  red: _c + '[31m',
  green: _c + '[32m',
  reset: _c + '[0m',
} as const;
// We can write 'pending' test name and then overwrite it with actual result by using ${up}.
// However, if test prints something to STDOUT, last line would get removed.
// We can wrap process.stdout also, but in that case there can be issues with non-node.js env.
// But we already use node modules for parallel cases, so maybe worth investigating.
// const up = _c + '[A';
const LEAF_N = '├─';
const LEAF_E = '│ ';
const LEAF_L = '└─';
const LEAF_S = '  ';
// With padding
// const LEAF_N = '├─ ';
// const LEAF_E = '│  ';
// const LEAF_L = '└─ ';
// const LEAF_S = '   ';

// Colorize string for terminal.
function color(colorName: keyof typeof c, title: string | number) {
  return isCli ? `${c[colorName]}${title}${c.reset}` : title.toString();
}

function log(...args: (string | undefined)[]) {
  if (opts.QUIET) return logQuiet(false);
  // @ts-ignore
  console.log(...args);
}
function logQuiet(fail = false) {
  if (fail) {
    const msg = color('red', '!');
    if (isCli) proc!.stderr.write(msg);
    else console.error(msg);
  } else {
    const msg = '.';
    if (isCli) proc!.stdout.write(msg);
    else console.log(msg);
  }
}
function addToErrorLog(title = '', error: any): void {
  errorLog.push(`${title} ${error?.stack ? error.stack : error}`);
  // @ts-ignore
  if (!opts.QUIET) console.error(error); // loud = show error now. quiet = show in the end
}

function formatPrefix(depth: number, prefix: string, isLast: boolean) {
  if (depth === 0) return { prefix: '', childPrefix: '' };
  return {
    prefix: `${prefix}${isLast ? LEAF_L : LEAF_N}`,
    childPrefix: `${prefix}${isLast ? LEAF_S : LEAF_E}`,
  };
}

async function runTest(
  info: StackItem,
  printTree: boolean = false,
  multiLine: boolean = false,
  stopAtError: boolean = true
): Promise<boolean | undefined> {
  if (!printTree && multiLine) log();
  let title = info.message;
  if (typeof info.test !== 'function') throw new Error('internal test error: invalid info.test');

  let messages: string[] = [];
  let onlyStackToLog: string[] = [];
  let beforeEachFns: Function[] = [];
  let afterEachFns: Function[] = []; // will be reversed
  for (const parent of info.path!) {
    messages.push(parent.message);
    if (printTree && info.only) onlyStackToLog.push(`${parent.prefix}${parent.message}`);
    if (parent.beforeEach) beforeEachFns.push(parent.beforeEach);
    if (parent.afterEach) afterEachFns.push(parent.afterEach);
  }
  afterEachFns.reverse();
  if (onlyStackToLog.length) onlyStackToLog.forEach((l) => log(l));

  const path = messages.slice().concat(title).join('/');

  // Skip is always single-line
  if (multiLine && !info.skip && !opts.QUIET) {
    log(printTree ? `${info.prefix}${title}: ☆` : `☆ ${path}:`);
  } else if (info.skip) {
    log(printTree ? `${info.prefix}${title} (skip)` : `☆ ${path} (skip)`);
    return true;
  }

  // variables influencing state / print output:
  // fail = true | false
  // quiet = true | false
  // printTree = true | false (true when fast mode)
  // stopAtError = true | false
  function formatTaskDone(fail = false, suffix = '') {
    const symbol = fail ? '☓' : '✓';
    const clr = fail ? 'red' : 'green';
    const title_ = suffix ? [title, suffix].join('/') : title;
    const full_ = suffix ? [path, suffix].join('/') : path;
    return printTree
      ? `${info.childPrefix}` + color(clr, `${title_}: ${symbol}`)
      : color(clr, `${symbol} ${full_}`);
  }

  // Emit
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
      console.error(formatTaskDone(true, suffix));
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
    // possible to do let result = ... in the future to save test outputs
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
  log(formatTaskDone());
  return true;
}

function stackTop() {
  return stack[stack.length - 1];
}
function stackPop() {
  return stack.pop();
}
function stackAdd(info: { message: any; skip?: boolean }) {
  const c = { ...info, children: [] };
  stackTop().children.push(c);
  stack.push(c);
}

function stackFlatten(elm: StackItem): StackItem[] {
  const out: StackItem[] = [];
  const walk = (
    elm: StackItem,
    depth = 0,
    isLast = false,
    prevPrefix = '',
    path: StackItem[] = []
  ) => {
    const { prefix, childPrefix } = formatPrefix(depth, prevPrefix, isLast);
    const newElm: StackItem = { ...elm, prefix, childPrefix, path };
    out.push(newElm);
    path = path.concat([newElm]); // Save prefixes so we can print path in 'only' case

    const chl = elm.children;
    for (let i = 0; i < chl.length; i++)
      walk(chl[i], depth + 1, i === chl.length - 1, childPrefix, path);
  };
  // Skip root
  for (const child of elm.children) walk(child);
  return out;
}

const describe: DescribeFunction = (message: any, fn: EmptyFn): void => {
  stackAdd({ message });
  fn(); // Run function in the context of current stack path
  stackPop();
};

function describeSkip(message: any, _fn: EmptyFn): void {
  stackAdd({ message, skip: true });
  // fn();
  stackPop();
}
describe.skip = describeSkip;

function beforeEach(fn: EmptyFn): void {
  stackTop().beforeEach = fn;
}

function afterEach(fn: EmptyFn): void {
  stackTop().afterEach = fn;
}

function register(info: StackItem) {
  stackAdd(info);
  stackPop(); // remove from stack since there are no children
}

function cloneAndReset() {
  let items = stackFlatten(stack[0]).slice();
  if (onlyStack) items = items.filter((i) => i.test === onlyStack!.test);
  stack.splice(0, stack.length);
  stack.push({ message: '', children: [] } as unknown as StackItem);
  onlyStack = undefined;
  return items;
}

// 123 tests (+quiet +fast-x8) started...
function begin(total: number, workers?: number | undefined) {
  const features = [opts.QUIET ? '+quiet' : '', workers ? `+fast-x${workers}` : ''].filter(
    (a) => a
  );
  const modes = features.length ? `(${features.join(' ')}) ` : '';
  const sfx = total > 1 ? 's' : '';
  console.log(`${color('green', total.toString())} test${sfx} ${modes}started...`);
}

function finalize(total: number, startTime: number) {
  isRunning = false;
  console.log();
  if (opts.QUIET) console.log();
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
  if (isRunning) throw new Error('should.run() has already been called, wait for end');
  if (!forceSequential && opts.FAST) return runTestsInParallel();
  isRunning = true;
  const tasks = cloneAndReset();
  const total = tasks.filter((i) => !!i.test).length;
  begin(total);
  const startTime = Date.now();
  for (const test of tasks) {
    if (opts.PRINT_TREE && !test.test) log(`${test.prefix}${test.message}`);
    if (!test.test) continue;
    await runTest(test, opts.PRINT_TREE, opts.PRINT_MULTILINE, opts.STOP_ON_ERROR);
  }
  return finalize(total, startTime);
}

async function runTestsWhen(importMetaUrl: string) {
  if (!isCli) return; // Ignore in browser
  // @ts-ignore
  const { pathToFileURL } = await imp('node:url');
  return importMetaUrl === pathToFileURL(proc!.argv[1]).href ? runTests() : undefined;
}

// Doesn't support tree and multiline
// TODO: support beforeEach, afterEach
async function runTestsInParallel(): Promise<number> {
  if (!isCli) throw new Error('must run in cli');
  if ('deno' in proc!.versions) return runTests(true);
  const tasks = cloneAndReset().filter((i) => !!i.test); // Filter describe elements
  const total = tasks.length;
  const startTime = Date.now();
  const runTestPar = (info: StackItem) => runTest(info, false, false, opts.STOP_ON_ERROR);

  let cluster: any, err: any;
  let totalW = opts.FAST;
  try {
    // @ts-ignore
    cluster = (await imp('node:cluster')).default;
    // @ts-ignore
    if (totalW === 1) totalW = (await imp('node:os')).cpus().length;
  } catch (error) {
    err = error;
  }
  if (!cluster || !parseFast(totalW)) throw new Error('parallel tests are not supported: ' + err);

  // the code is ran in workers
  if (!cluster.isPrimary) {
    proc!.on('error', (err: any) => console.log('internal error:', 'child crashed?', err));
    let tasksDone = 0;
    const id = cluster.worker.id;
    const strId = 'W' + id;
    for (let i = 0; i < tasks.length; i++) {
      if (i % totalW !== id - 1) continue;
      await runTestPar(tasks[i]);
      tasksDone++;
    }
    proc!.send({ name: 'parallelTests', worker: strId, tasksDone, errorLog });
    proc!.exit();
  }

  // the code is ran in primary proc
  const pr: Promise<any> = new Promise((resolve, reject) => {
    begin(total, totalW);
    console.log();
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
      const worker = cluster.fork();
      workers.push(worker);
      worker.on('error', (err: any) => reject(err));
      worker.on('message', (msg: { name: string; tasksDone: number; errorLog: string[] }) => {
        if (!msg || msg.name !== 'parallelTests') return;
        workersDone++;
        tasksDone += msg.tasksDone;
        msg.errorLog.forEach((item) => errorLog.push(item));
        if (workersDone !== totalW) return;
        if (tasksDone !== total)
          return reject(new Error('internal error: not all tasks have been completed'));
        // @ts-ignore
        globalThis.setTimeout(() => {
          resolve(finalize(total, startTime));
        }, 0);
      });
    }
  });

  return pr.catch((err: Error) => {
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
it.run = runTests;
it.runWhen = runTestsWhen;
it.runParallel = runTestsInParallel;
it.opts = opts;

export { afterEach, beforeEach, describe, it, it as should };
export default it;
