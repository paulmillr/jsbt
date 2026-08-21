import { deepStrictEqual } from 'node:assert';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { should as test } from '../../src/test.ts';

const BASE = resolve('.');
const ROOT = join(BASE, 'test/jsbt/vectors/check');
const JSBT_ENTRY = join(BASE, 'src/jsbt/index.ts');
process.env.JSBT_LOG_LEVEL = '0';
process.env.npm_config_audit = 'false';
process.env.npm_config_fund = 'false';
process.env.npm_config_loglevel = 'silent';
process.env.npm_config_progress = 'false';
process.env.npm_config_update_notifier = 'false';
const { runCli: runTSDoc } = await import('../../src/jsbt/jsdoc.ts');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');
const { runCli: runBigInt } = await import('../../src/jsbt/bigint.ts');
const { runCli: runComments } = await import('../../src/jsbt/comments.ts');
const { runCli: runImportTime } = await import('../../src/jsbt/importtime.ts');
const { runCli: runReadme } = await import('../../src/jsbt/readme.ts');
const { runCli: runTypeImport } = await import('../../src/jsbt/typeimport.ts');
const { runSizeCheck } = await import('../../src/jsbt/size.ts');
const { wantColor } = await import('../../src/jsbt/utils.ts');
const ts = await import('typescript');
const should = Object.assign(test.serial, { runWhen: test.runWhen });

const fixture = (name: string) => join(ROOT, name);
const capture = async (fn: () => Promise<void>) => {
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
    stderr += `${(error as Error).message}\n`;
    return { error: error as Error, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const captureProcess = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  const prevOut = process.stdout.write;
  const prevProcErr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return { error: undefined, ok: true, stderr, stdout };
  } catch (error) {
    stderr += `${(error as Error).message}\n`;
    return { error: error as Error, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    process.stdout.write = prevOut;
    process.stderr.write = prevProcErr;
  }
};
const run = async (_cwd: string, fn: () => Promise<void>) => {
  return capture(fn);
};
const runProcess = async (_cwd: string, fn: () => Promise<void>) => {
  return captureProcess(fn);
};
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const sizeRun = (cwd: string) => run(cwd, () => runSizeCheck({ cwd }));
// Through the CLI, not runGenerateJsbtRc directly: the root-command wiring is the contract.
const genRun = (cwd: string) => run(cwd, () => checkJsbt(['--gen-config'], cwd));
const workerJsbt = (
  cwd: string,
  argv: string[],
  timeoutMs = 6000
): Promise<{
  code: number | undefined;
  error?: string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}> =>
  new Promise((resolve) => {
    const worker = new Worker(
      `import { parentPort, workerData } from 'node:worker_threads';
process.argv[1] = workerData.main;
const { runCli } = await import(workerData.entry);
let stdout = '';
let stderr = '';
const prevLog = console.log;
const prevErr = console.error;
console.log = (...args) => { stdout += args.map((arg) => String(arg)).join(' ') + '\\n'; };
console.error = (...args) => { stderr += args.map((arg) => String(arg)).join(' ') + '\\n'; };
try {
  await runCli(workerData.argv, { color: false, cwd: workerData.cwd, runJsrPublish: async () => {} });
  parentPort.postMessage({ ok: true, stderr, stdout });
} catch (error) {
  parentPort.postMessage({ ok: false, stderr: stderr + error.message + '\\n', stdout });
} finally {
  console.log = prevLog;
  console.error = prevErr;
}`,
      {
        eval: true,
        type: 'module',
        workerData: {
          argv,
          cwd,
          entry: pathToFileURL(JSBT_ENTRY).href,
          main: JSBT_ENTRY,
        },
      }
    );
    let msg: { stderr: string; stdout: string } | undefined;
    let error: string | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      worker.terminate().then(() =>
        resolve({
          code: undefined,
          error,
          stderr: msg?.stderr || '',
          stdout: msg?.stdout || '',
          timedOut,
        })
      );
    }, timeoutMs);
    worker.once('message', (data) => {
      msg = data as { stderr: string; stdout: string };
    });
    worker.once('error', (err) => {
      error = err.message;
    });
    worker.once('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({
        code,
        error,
        stderr: msg?.stderr || '',
        stdout: msg?.stdout || '',
        timedOut,
      });
    });
  });
const spent = String.raw`\d+ sec`;
const checkSummary = (items: [string, number][]) =>
  new RegExp(`${items.length} check${items.length === 1 ? '' : 's'} finished in ${spent}`);
const okJsrPublish = async () => {};
const withEnv = async <T>(key: string, value: string | undefined, fn: () => Promise<T>) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};
const checkJsbt = (argv: string[], cwd: string, extra: Record<string, unknown> = {}) =>
  withEnv('JSBT_WORKERS', '1', () =>
    withEnv('JSBT_QUIET', '', () =>
      runJsbt(argv, { color: false, cwd, runJsrPublish: okJsrPublish, ...extra })
    )
  );
const typeImportProof = () => {
  const root = resolve('test/jsbt/build/typeimport-proof');
  const goodOut = join(root, 'good');
  const badOut = join(root, 'bad');
  const fmt = (diags: readonly import('typescript').Diagnostic[]) =>
    diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
  const run = (file: string, outDir: string) => {
    const prog = ts.createProgram([file], {
      allowImportingTsExtensions: true,
      declaration: true,
      emitDeclarationOnly: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmitOnError: true,
      outDir,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    });
    const emit = prog.emit(undefined, undefined, undefined, true);
    return { diags: [...ts.getPreEmitDiagnostics(prog), ...emit.diagnostics], emit };
  };
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'x.ts'), 'export type Foo = { x: number };\n');
  writeFileSync(
    join(root, 'good.ts'),
    "import type { Foo } from './x.ts';\nexport type { Foo };\nexport const value = (arg: Foo) => arg;\n"
  );
  writeFileSync(
    join(root, 'bad.ts'),
    "export type { Foo } from './x.ts';\nexport const value = (arg: Foo) => arg;\n"
  );
  const good = run(join(root, 'good.ts'), goodOut);
  const bad = run(join(root, 'bad.ts'), badOut);
  return {
    bad: { ok: !bad.diags.length && !bad.emit.emitSkipped, text: fmt(bad.diags) },
    good: {
      dts: readFileSync(join(goodOut, 'good.d.ts'), 'utf8'),
      ok: !good.diags.length && !good.emit.emitSkipped,
      text: fmt(good.diags),
    },
  };
};

should('readme passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runReadme(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('readme reports wrong example on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => runReadme(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/README\.md:\d+\/usage/.test(all(res)), true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 1 failure, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/README check found issues/.test(all(res)), true);
});

should('tsdoc passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 5 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('tsdoc reports missing docs on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/broken\.d\.mts:\d+\/broken/.test(all(res)), true);
  deepStrictEqual(/missing JSDoc/.test(all(res)), true);
  deepStrictEqual(/missing @param value/.test(all(res)), true);
  deepStrictEqual(/missing @returns/.test(all(res)), true);
  deepStrictEqual(/missing @example/.test(all(res)), true);
  deepStrictEqual(/summary: 2 passed, 0 warnings, 4 failures, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/JSDoc check found issues/.test(all(res)), true);
});

should('tsdoc unwraps TArg and TRet in bag link targets', async () => {
  const cwd = fixture('fail-wrapper-link');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] tsdoc: index\.d\.mts:\d+\/Surface @param sign\.options should link to \{@link SignOptions\} \(param\)/.test(
      out
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] tsdoc: index\.d\.mts:\d+\/Surface @param verify\.options should link to \{@link VerifyOptions\} \(param\)/.test(
      out
    ),
    true
  );
  deepStrictEqual(/\{@link TArg\}/.test(out), false);
  deepStrictEqual(/\{@link TRet\}/.test(out), false);
  deepStrictEqual(/summary: 4 passed, 0 warnings, 2 failures, 0 skipped/.test(out), true);
});

should('tsdoc unwraps nested TRet callable intersections', async () => {
  const cwd = fixture('pass-nested-wrapper');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/missing @param args/.test(out), false);
  deepStrictEqual(/missing @param hash\.msg/.test(out), false);
  deepStrictEqual(/missing @param hash\.opts/.test(out), false);
  deepStrictEqual(/unknown @param log\.url/.test(out), false);
  deepStrictEqual(/unknown @param log\.opts/.test(out), false);
  deepStrictEqual(/unknown @param msg/.test(out), false);
  deepStrictEqual(/unknown @param opts/.test(out), false);
  deepStrictEqual(/summary: 3 passed, 0 warnings, 0 failures, 0 skipped/.test(out), true);
});

should('tsdoc rejects synthetic args docs for nested wrappers', async () => {
  const cwd = fixture('fail-nested-wrapper-args');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] tsdoc: index\.d\.mts:\d+\/sha missing @param msg \(param\)/.test(out),
    true
  );
  deepStrictEqual(
    /\[ERROR\] tsdoc: index\.d\.mts:\d+\/sha missing @param opts \(param\)/.test(out),
    true
  );
  deepStrictEqual(
    /\[ERROR\] tsdoc: index\.d\.mts:\d+\/sha unknown @param args \(param\)/.test(out),
    true
  );
  deepStrictEqual(/summary: 0 passed, 0 warnings, 3 failures, 0 skipped/.test(out), true);
});

should('tsdoc rejects wrapper links for nested callable option bags', async () => {
  const cwd = fixture('fail-nested-wrapper-link');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] tsdoc: index\.d\.mts:\d+\/sha @param opts should link to \{@link OutputOpts\} \(param\)/.test(
      out
    ),
    true
  );
  deepStrictEqual(/summary: 0 passed, 0 warnings, 1 failure, 0 skipped/.test(out), true);
});

should('tsdoc blames original typed declarations instead of re-exports', async () => {
  const cwd = fixture('fail-reexport-member');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] tsdoc: types\.ts:\d+\/OutputOpts missing member JSDoc for dkLen \(member\)/.test(
      out
    ),
    true
  );
  deepStrictEqual(/index\.d\.mts:\d+\/OutputOpts missing member JSDoc for dkLen/.test(out), false);
  deepStrictEqual(/web\.d\.mts:\d+\/OutputOpts missing member JSDoc for dkLen/.test(out), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 1 failure, 0 skipped/.test(out), true);
});

should('size passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await sizeRun(cwd);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/found unused locals/.test(all(res)), false);
});

should('size ignores declaration-only type exports', async () => {
  const cwd = fixture('pass-typeonly-runtime');
  const res = await sizeRun(cwd);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/TypeOnly/.test(all(res)), false);
  deepStrictEqual(/found unused locals/.test(all(res)), false);
});

should('size reports unused locals on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await sizeRun(cwd);
  deepStrictEqual(res.ok, false);
  // Bundle names come from the in-memory measurement, not from files on disk.
  deepStrictEqual(
    /\[ERROR\] size: 2x unused \(size\)\n  jsbt-test-check-src\.js:\d+\/retained \(@jsbt-test\/check-src\)\n  broken\/broken\.js:\d+\/retained \(broken\/broken\)/.test(
      plain(res)
    ),
    true,
    plain(res)
  );
  deepStrictEqual(/found unused locals in 2 release bundles/.test(all(res)), true);
});

should('size passes bundles within sizeLimits budgets', async () => {
  const cwd = fixture('pass-size-limit');
  const res = await sizeRun(cwd);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/sizeLimits/.test(all(res)), false);
});

should('size reports bundles over sizeLimits budgets', async () => {
  const cwd = fixture('fail-size-limit');
  const res = await sizeRun(cwd);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] size: "index\.js\/add": max allowed size is 0\.02kb gzipped, currently 0\.\d+kb/.test(
      plain(res)
    ),
    true,
    plain(res)
  );
  deepStrictEqual(
    /\[ERROR\] size: "index\.js\/add index\.js\/mul": max allowed size is 0\.02kb gzipped, currently 0\.\d+kb/.test(
      plain(res)
    ),
    true,
    plain(res)
  );
  deepStrictEqual(/found 2 bundles over sizeLimits budget/.test(all(res)), true);
});

should('size rejects invalid sizeLimits entries before measuring', async () => {
  const root = resolve('test/jsbt/build/badrc');
  rmSync(root, { force: true, recursive: true });
  const cwd = join(root, 'pkg');
  cpSync(fixture('pass-size-limit'), cwd, { recursive: true });
  try {
    writeFileSync(
      join(cwd, '.jsbtrc.json'),
      JSON.stringify({ sizeLimits: { 'index.js': 'four' } })
    );
    const bad = await sizeRun(cwd);
    deepStrictEqual(bad.ok, false);
    deepStrictEqual(
      /invalid sizeLimits value for index\.js: use bytes \(4096\) or "4kb"/.test(all(bad)),
      true,
      all(bad)
    );
    // Budgeting a package we do not own pins nothing about ours.
    writeFileSync(
      join(cwd, '.jsbtrc.json'),
      JSON.stringify({ sizeLimits: { 'npm:preact': '4kb' } })
    );
    const foreign = await sizeRun(cwd);
    deepStrictEqual(foreign.ok, false);
    deepStrictEqual(
      /sizeLimits must name local modules or exports: npm:preact/.test(all(foreign)),
      true,
      all(foreign)
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

should('check --gen-config populates exampleDependencies from examples', async () => {
  const root = resolve('test/jsbt/build/genrc');
  rmSync(root, { force: true, recursive: true });
  const cwd = join(root, 'pkg');
  cpSync(fixture('pass-readme-deps'), cwd, { recursive: true });
  rmSync(join(cwd, '.jsbtrc.json'));
  const readRc = () => JSON.parse(readFileSync(join(cwd, '.jsbtrc.json'), 'utf8'));
  try {
    // README imports the package itself, a runtime dependency, and @jsbt-test/dep;
    // only the last one lands, pinned to the installed version. No sizeLimits appear.
    const first = await genRun(cwd);
    deepStrictEqual(first.ok, true, all(first));
    deepStrictEqual(readRc(), { exampleDependencies: { '@jsbt-test/dep': '1.2.3' } });
    // The generated config immediately passes the check it feeds.
    const readme = await run(cwd, () => checkJsbt(['readme'], cwd));
    deepStrictEqual(readme.ok, true, all(readme));
    // Regeneration keeps hand-set pins and every other section untouched.
    writeFileSync(
      join(cwd, '.jsbtrc.json'),
      JSON.stringify({
        exampleDependencies: { '@jsbt-test/dep': '9.9.9' },
        sizeLimits: { 'index.js': '9kb' },
      })
    );
    const second = await genRun(cwd);
    deepStrictEqual(second.ok, true, all(second));
    deepStrictEqual(readRc(), {
      exampleDependencies: { '@jsbt-test/dep': '9.9.9' },
      sizeLimits: { 'index.js': '9kb' },
    });
    // TSDoc @example blocks are scanned too: the .d.mts example alone still finds the dep.
    rmSync(join(cwd, '.jsbtrc.json'));
    rmSync(join(cwd, 'README.md'));
    const tsdocOnly = await genRun(cwd);
    deepStrictEqual(tsdocOnly.ok, true, all(tsdocOnly));
    deepStrictEqual(readRc(), { exampleDependencies: { '@jsbt-test/dep': '1.2.3' } });
    // An example import that is not installed cannot be pinned: the pinnable entries
    // are still written, then the run fails naming every missing package.
    rmSync(join(cwd, '.jsbtrc.json'));
    writeFileSync(
      join(cwd, 'README.md'),
      '# x\n\n```js\nimport { nope } from "@jsbt-test/missing";\n```\n'
    );
    const missing = await genRun(cwd);
    deepStrictEqual(missing.ok, false, all(missing));
    deepStrictEqual(
      /not installed and could not be pinned: @jsbt-test\/missing; run npm install -D @jsbt-test\/missing/.test(
        all(missing)
      ),
      true,
      all(missing)
    );
    deepStrictEqual(readRc(), { exampleDependencies: { '@jsbt-test/dep': '1.2.3' } });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

should('check rejects --gen-config combined with a check selector', async () => {
  const cwd = fixture('pass-size-limit');
  for (const selector of ['bigint', 'size']) {
    const res = await run(cwd, () => runJsbt([selector, '--gen-config'], { color: false, cwd }));
    deepStrictEqual(res.ok, false, all(res));
    deepStrictEqual(
      new RegExp(`--gen-config takes no check selector: got ${selector}`).test(all(res)),
      true,
      all(res)
    );
  }
});

should('comments passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runComments(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('comments reports long prose and inline comments on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => runComments(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] comments: 3x comment line exceeds 100 chars; reword comment \(comment\)\n  src\/alpha\.ts:\d+\/comment\n  src\/index\.ts:\d+\/comment\n  src\/note\.ts:\d+\/comment/.test(
      all(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] comments: src\/broken\.ts:\d+\/inline-comment line exceeds 100 chars with inline comment; move comment above the code \(inline-comment\)/.test(
      all(res)
    ),
    true
  );
  deepStrictEqual(/src\/dupe\.ts:inline-comment/.test(all(res)), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 4 failures, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/Comments check found issues/.test(all(res)), true);
});

should('bigint passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runBigInt(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('bigint reports raw bigint literals and suggests BigInt helpers', async () => {
  const cwd = fixture('fail-bigint');
  const res = await run(cwd, () => runBigInt(['package.json'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] bigint: 3x replace raw bigint literal with helper const; use const _1n = \/\* @__PURE__ \*\/ BigInt\(1\) for simple values, or const NAME = \/\* @__PURE__ \*\/ BigInt\(\.\.\.\) for specific ones \(bigint\)/.test(
      out
    ),
    true
  );
  deepStrictEqual(/1n -> \/\* @__PURE__ \*\/ BigInt\(1\)/.test(out), true);
  deepStrictEqual(/-1n -> \/\* @__PURE__ \*\/ BigInt\(-1\)/.test(out), true);
  deepStrictEqual(
    /0x123456789abcdef123456789n -> \/\* @__PURE__ \*\/ BigInt\('0x123456789abcdef123456789'\)/.test(
      out
    ),
    true
  );
  deepStrictEqual(/summary: 0 passed, 0 warnings, 3 failures, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/BigInt check found issues/.test(all(res)), true);
});

should('importtime passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/module/.test(all(res)), true);
  deepStrictEqual(/index\.js/.test(all(res)), true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('importtime warns on slow public entry and prints table', async () => {
  const cwd = fixture('warn-import');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/module/.test(all(res)), true);
  deepStrictEqual(/slow\.js/.test(all(res)), true);
  deepStrictEqual(/limit/.test(all(res)), true);
  deepStrictEqual(/slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/.test(all(res)), true);
  deepStrictEqual(/import exceeds/.test(all(res)), false);
  deepStrictEqual(/summary: 1 passed, 1 warning, 0 failures, 0 skipped/.test(all(res)), true);
});

should('importtime skips root trap modules', async () => {
  const cwd = fixture('skip-import');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/index\.js/.test(all(res)), true);
  deepStrictEqual(/\bskip\b/.test(all(res)), true);
  deepStrictEqual(/failed to import root module cannot be imported/.test(all(res)), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 1 skipped/.test(all(res)), true);
});

should('importtime fails on very slow public entry', async () => {
  const cwd = fixture('fail-import');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/.test(all(res)), true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 1 failure, 0 skipped/.test(all(res)), true);
});

should('typeimport passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runTypeImport(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('typeimport reports local import(...) types in public declarations', async () => {
  const cwd = fixture('fail-typeimport');
  const res = await run(cwd, () => runTypeImport(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] typeimport: index\.d\.mts:\d+\/typeimport add import type \{ Shape \} from '\.\/types\.ts'; export type \{ Shape \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] typeimport: index\.d\.mts:\d+\/typeimport add import type \{ Pair \} from '\.\/types\.ts'; export type \{ Pair \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/summary: 0 passed, 0 warnings, 2 failures, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/Type import check found issues/.test(all(res)), true);
});

should('typeimport proof prefers local import type plus local export type', () => {
  const res = typeImportProof();
  deepStrictEqual(res.good.ok, true, res.good.text);
  deepStrictEqual(/import\("\.\/x\.ts"\)\.Foo/.test(res.good.dts), false);
  deepStrictEqual(/import type \{ Foo \} from '\.\/x\.ts';/.test(res.good.dts), true);
  deepStrictEqual(res.bad.ok, false);
  deepStrictEqual(/Cannot find name 'Foo'/.test(res.bad.text), true);
});

should('check passes on root-entry fixture with default out dir', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_QUIET', '', () => run(cwd, () => checkJsbt([], cwd)));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^12 checks started \(JSBT_QUIET=0, JSBT_WORKERS=1\)/.test(plain(res)), true);
  deepStrictEqual(
    /^12 checks started \(JSBT_QUIET=0, JSBT_WORKERS=1\)\n\n☆ readme/.test(plain(res)),
    true
  );
  deepStrictEqual(/preparing summary/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['readme', 0],
      ['size', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['errors', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['importtime', 0],
    ]).test(all(res)),
    true
  );
});

should('check defaults JSBT_WORKERS like the test runner', async () => {
  const cwd = fixture('pass-root');
  const workers = Math.max(1, Math.min(availableParallelism(), 10));
  const res = await withEnv('JSBT_QUIET', '', () =>
    withEnv('JSBT_WORKERS', undefined, () =>
      run(cwd, () => runJsbt(['comments'], { color: false, cwd }))
    )
  );
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    new RegExp(`^1 check started \\(JSBT_QUIET=0, JSBT_WORKERS=${workers}\\)`).test(plain(res)),
    true
  );
});

should('check parses JSBT_WORKERS offsets and ratios like the test runner', async () => {
  const cwd = fixture('pass-root');
  const max = availableParallelism();
  const expected = {
    negative: Math.max(1, Math.min(max - 1, 10)),
    ratio: Math.max(1, Math.min(Math.floor(max * 0.5), 10)),
  };
  const negative = await withEnv('JSBT_QUIET', '', () =>
    withEnv('JSBT_WORKERS', '-1', () =>
      run(cwd, () => runJsbt(['comments'], { color: false, cwd }))
    )
  );
  deepStrictEqual(negative.ok, true, all(negative));
  deepStrictEqual(
    new RegExp(`^1 check started \\(JSBT_QUIET=0, JSBT_WORKERS=${expected.negative}\\)`).test(
      plain(negative)
    ),
    true
  );

  const ratio = await withEnv('JSBT_QUIET', '', () =>
    withEnv('JSBT_WORKERS', '0.5', () =>
      run(cwd, () => runJsbt(['comments'], { color: false, cwd }))
    )
  );
  deepStrictEqual(ratio.ok, true, all(ratio));
  deepStrictEqual(
    new RegExp(`^1 check started \\(JSBT_QUIET=0, JSBT_WORKERS=${expected.ratio}\\)`).test(
      plain(ratio)
    ),
    true
  );
});

should('check reports timing stats only for selectors over ten seconds', async () => {
  const cwd = fixture('pass-root');
  const prevNow = Date.now;
  let now = 0;
  Date.now = () => (now += 11_000);
  try {
    const res = await withEnv('JSBT_QUIET', '', () =>
      withEnv('JSBT_WORKERS', '1', () =>
        run(cwd, () => runJsbt(['comments'], { color: true, cwd, runJsrPublish: okJsrPublish }))
      )
    );
    const out = plain(res);
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(
      /^\x1b\[32m1\x1b\[0m check started \x1b\[90m\(JSBT_QUIET=0, JSBT_WORKERS=1\)\x1b\[0m\n/.test(
        all(res)
      ),
      true
    );
    deepStrictEqual(/\[INFO\] check: slow checks/.test(out), false);
    deepStrictEqual(
      /1\x1b\[0m check finished in \d+ sec\. \x1b\[33mSlow checks: comments \(11s\)\.\x1b\[0m/.test(
        all(res)
      ),
      true
    );
    deepStrictEqual(
      /1 check finished in \d+ sec\. Slow checks: comments \(11s\)\./.test(out),
      true
    );
  } finally {
    Date.now = prevNow;
  }
});

should('check uses dot reporter when JSBT_QUIET is set', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_QUIET', '1', () =>
    withEnv('JSBT_WORKERS', '1', () =>
      runProcess(cwd, () => runJsbt([], { color: false, cwd, runJsrPublish: okJsrPublish }))
    )
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /^12 checks started \(JSBT_QUIET=1, JSBT_WORKERS=1\)\n\.{12}\n12 checks finished in \d+ sec/.test(
      out
    ),
    true
  );
  deepStrictEqual(/☆/.test(out), false);
  deepStrictEqual(/✓/.test(out), false);
  deepStrictEqual(/preparing summary/.test(out), false);
});

should('check shows warnings when JSBT_QUIET is set', async () => {
  const cwd = fixture('fail-src');
  const res = await withEnv('JSBT_QUIET', '1', () =>
    withEnv('JSBT_WORKERS', '1', () =>
      runProcess(cwd, () => runJsbt([], { color: false, cwd, runJsrPublish: okJsrPublish }))
    )
  );
  const out = plain(res);
  deepStrictEqual(res.ok, false, all(res));
  deepStrictEqual(/\[WARN\] size: 2x unused \(size\)/.test(out), true);
  deepStrictEqual(/broken\/broken\.js:\d+\/retained \(broken\/broken\)/.test(out), true);
  deepStrictEqual(/\[WARN\] readme:/.test(out), true);
  deepStrictEqual(/\[WARN\] comments:/.test(out), true);
  deepStrictEqual(/\[ERROR\] jsr:/.test(out), true);
});

should('check rejects the removed package.json positional argument', async () => {
  const cwd = fixture('pass-root');
  const res = await capture(() => checkJsbt(['package.json'], cwd));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/package\.json positional argument was removed/.test(plain(res)), true);
});

should('check accepts a second-arg selector and reports tsdoc warnings', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['tsdoc'], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] tsdoc: broken\.d\.mts:1\/broken missing JSDoc \(docs\)/.test(plain(res)),
    true
  );
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] size:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] jsr:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] comments:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] bytes:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] mutate:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tests:/.test(plain(res)), false);
  deepStrictEqual(/\[(?:ERROR|WARN)\] importtime:/.test(plain(res)), false);
  deepStrictEqual(checkSummary([['tsdoc', 4]]).test(plain(res)), true);
});

should('check size selector audits without printing size stats', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => checkJsbt(['size'], cwd));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  // Size stats are `bismar --size`'s job; the check runs the audit and reports only that.
  deepStrictEqual(/min bundle|min KB|gzip KB/.test(out), false, out);
  deepStrictEqual(checkSummary([['size', 0]]).test(out), true, out);
});

should('check treeshake selector is rejected after the size rename', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => checkJsbt(['treeshake'], cwd));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/unknown check selector: treeshake/.test(plain(res)), true, plain(res));
});

should('check readme links exampleDependencies and runtime deps into the run dir', async () => {
  const cwd = fixture('pass-readme-deps');
  const res = await run(cwd, () => runReadme(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(plain(res)), true);
});

should('check hints at .jsbtrc.json when an example import is unavailable', async () => {
  const root = resolve('test/jsbt/build/missing-dep');
  rmSync(root, { force: true, recursive: true });
  const cwd = join(root, 'pkg');
  cpSync(fixture('pass-readme-deps'), cwd, { recursive: true });
  const hint = /hint: examples may only import "dependencies" and "exampleDependencies"/;
  try {
    // Dropping the entry leaves the README example importing a package examples cannot see.
    writeFileSync(join(cwd, '.jsbtrc.json'), '{}\n');
    const res = await run(cwd, () => checkJsbt(['readme'], cwd));
    deepStrictEqual(/ERR_MODULE_NOT_FOUND/.test(plain(res)), true, all(res));
    deepStrictEqual(hint.test(plain(res)), true, all(res));
    deepStrictEqual(/jsbt-check --gen-config/.test(plain(res)), true, all(res));
    // Restoring it removes the diagnostic, and the hint with it.
    writeFileSync(
      join(cwd, '.jsbtrc.json'),
      JSON.stringify({ exampleDependencies: { '@jsbt-test/dep': '1.2.3' } })
    );
    const ok = await run(cwd, () => checkJsbt(['readme'], cwd));
    deepStrictEqual(ok.ok, true, all(ok));
    deepStrictEqual(hint.test(plain(ok)), false, all(ok));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

should('check accepts a patterns selector without defaulting to all checks', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['patterns'], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] size:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tsdoc:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] jsr:/.test(plain(res)), false);
  deepStrictEqual(checkSummary([['patterns', 0]]).test(plain(res)), true);
});

should('check --ignore drops the listed selectors from the run', async () => {
  const cwd = fixture('pass-root');
  const heads = (res: { stderr: string; stdout: string }) =>
    Array.from(plain(res).matchAll(/^☆ (\w+)$/gm)).map((item) => item[1]);
  const full = await run(cwd, () => checkJsbt([], cwd));
  const some = await run(cwd, () => checkJsbt(['--ignore=readme,tsdoc'], cwd));
  deepStrictEqual(some.ok, true, all(some));
  deepStrictEqual(
    heads(some),
    heads(full).filter((head) => head !== 'readme' && head !== 'tsdoc')
  );
  // The header count follows the filtered list, not the full one.
  deepStrictEqual(
    new RegExp(`${heads(full).length - 2} checks started`).test(plain(some)),
    true,
    all(some)
  );
  // A space-separated value and an alias resolve the same way as the selector argument.
  const spaced = await run(cwd, () => checkJsbt(['--ignore', 'jsdoc'], cwd));
  deepStrictEqual(spaced.ok, true, all(spaced));
  deepStrictEqual(heads(spaced).includes('tsdoc'), false, all(spaced));
});

should('check rejects --ignore values that name no runnable check', async () => {
  const cwd = fixture('pass-root');
  const cases: [string[], RegExp][] = [
    [['--ignore=nope'], /unknown check selector: nope/],
    [['--ignore='], /expected selectors after --ignore=/],
    [['--ignore=size,,readme'], /expected selectors after --ignore=/],
    [['readme', '--ignore=readme'], /--ignore=readme leaves no checks to run/],
    [['--gen-config', '--ignore=size'], /--gen-config runs no checks, so --ignore does nothing/],
  ];
  for (const [argv, expected] of cases) {
    const res = await run(cwd, () => runJsbt(argv, { color: false, cwd }));
    deepStrictEqual(res.ok, false, `${argv.join(' ')}\n${all(res)}`);
    deepStrictEqual(expected.test(all(res)), true, `${argv.join(' ')}\n${all(res)}`);
  }
});

should('check accepts a jsrpublish selector and asks for full output', async () => {
  const cwd = fixture('pass-root');
  let full = false;
  const res = await run(cwd, () =>
    runJsbt(['jsrpublish'], {
      color: false,
      cwd,
      runJsrPublish: async (_argv, opts) => {
        full = !!opts?.full;
      },
    })
  );
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(full, true);
  deepStrictEqual(checkSummary([['jsrpublish', 0]]).test(plain(res)), true);
});

should('check rejects non-selector output directory args', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['test/build/custom-treeshake'], cwd));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/unknown check selector: test\/build\/custom-treeshake/.test(plain(res)), true);
});

should('check keeps fs-modify activity inside os tmpdir', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_LOG_LEVEL', '0', () => run(cwd, () => checkJsbt([], cwd)));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/(?:delete|install|write)\t/.test(all(res)), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), false);
});

should('check reports importtime warnings without failing', async () => {
  const cwd = fixture('warn-import');
  const res = await run(cwd, () => checkJsbt([], cwd));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    /\[WARN\] importtime: slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/.test(plain(res)),
    true
  );
  deepStrictEqual(/import exceeds/.test(plain(res)), false);
  deepStrictEqual(/module\s+│file/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['importtime', 1],
      ['readme', 0],
      ['size', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['errors', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
    ]).test(plain(res)),
    true
  );
});

should('check reports importtime errors as warnings without table', async () => {
  const cwd = fixture('fail-import');
  const res = await run(cwd, () => checkJsbt([], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] importtime: slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/.test(plain(res)),
    true
  );
  deepStrictEqual(/module\s+│file/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['importtime', 1],
      ['readme', 0],
      ['size', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['errors', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
    ]).test(plain(res)),
    true
  );
});

should('check keeps importtime on the serial lane', () => {
  const src = readFileSync(resolve('src/jsbt/index.ts'), 'utf8');
  deepStrictEqual(
    /{\s*head: 'importtime',[\s\S]*?pick: \(res\) => pickIssues\('importtime', res, colorOn\),[\s\S]*?serial: true,\s*}/.test(
      src
    ),
    true
  );
});

should('worker-backed checks exit after imported modules leave handles open', async () => {
  const cwd = fixture('pass-worker-handle');
  for (const argv of [['importtime'], ['mutate']]) {
    const res = await workerJsbt(cwd, argv);
    const text = [all(res), res.error].filter(Boolean).join('\n');
    deepStrictEqual(res.timedOut, false, text);
    deepStrictEqual(res.code, 0, text);
    deepStrictEqual(
      /summary: 1 passed, 0 warnings, 0 failures, 0 skipped|1 check finished in \d+ sec/.test(text),
      true
    );
  }
});

should('check reports bigint issues as warnings and keeps other checks green', async () => {
  const cwd = fixture('fail-bigint');
  const res = await run(cwd, () => checkJsbt([], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] bigint: 3x replace raw bigint literal with helper const; use const _1n = \/\* @__PURE__ \*\/ BigInt\(1\) for simple values, or const NAME = \/\* @__PURE__ \*\/ BigInt\(\.\.\.\) for specific ones \(bigint\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] size:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tsdoc:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] typeimport:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] jsr:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] comments:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] bytes:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] mutate:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tests:/.test(plain(res)), false);
  deepStrictEqual(/\[(?:ERROR|WARN)\] importtime:/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['bigint', 3],
      ['readme', 0],
      ['size', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['errors', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['importtime', 0],
    ]).test(plain(res)),
    true
  );
});

should('check reports typeimport issues as warnings and keeps other checks green', async () => {
  const cwd = fixture('fail-typeimport');
  const res = await run(cwd, () => checkJsbt([], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] typeimport: index\.d\.mts:\d+\/typeimport add import type \{ Shape \} from '\.\/types\.ts'; export type \{ Shape \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[WARN\] typeimport: index\.d\.mts:\d+\/typeimport add import type \{ Pair \} from '\.\/types\.ts'; export type \{ Pair \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] size:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tsdoc:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] jsr:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] comments:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] bigint:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] bytes:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] mutate:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tests:/.test(plain(res)), false);
  deepStrictEqual(/\[(?:ERROR|WARN)\] importtime:/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['typeimport', 2],
      ['readme', 0],
      ['size', 0],
      ['tsdoc', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['errors', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['importtime', 0],
    ]).test(plain(res)),
    true
  );
});

should('check runs all checks before failing', async () => {
  const cwd = fixture('fail-src');
  const res = await withEnv('JSBT_QUIET', '', () => run(cwd, () => checkJsbt([], cwd)));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[WARN\] readme: README\.md:12\/usage Argument of type 'string' is not assignable to parameter of type 'number'\. \(type\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    new RegExp(
      `\\[WARN\\] size: 2x unused \\(size\\)\\n  jsbt-test-check-src\\.js:\\d+/retained \\(@jsbt-test/check-src\\)\\n  broken/broken\\.js:\\d+/retained \\(broken/broken\\)`
    ).test(plain(res)),
    true
  );
  deepStrictEqual(
    /\[WARN\] tsdoc: broken\.d\.mts:1\/broken missing JSDoc \(docs\)/.test(plain(res)),
    true
  );
  deepStrictEqual(
    /\[ERROR\] jsr: missing jsr export mapping \(jsr-export\)\n  jsr\.json:exports \.\/broken\.js -> \.\/src\/broken\.ts/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[WARN\] comments: 3x comment line exceeds 100 chars; reword comment \(comment\)\n  src\/alpha\.ts:\d+\/comment\n  src\/index\.ts:\d+\/comment\n  src\/note\.ts:\d+\/comment/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/\[ERROR\] bigint:/.test(plain(res)), false);
  deepStrictEqual(
    /\[WARN\] comments: src\/broken\.ts:\d+\/inline-comment line exceeds 100 chars with inline comment; move comment above the code \(inline-comment\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[WARN\] comments: src\/alpha\.ts:\d+\/comment comment line exceeds 100 chars; reword comment \(comment\)/.test(
      plain(res)
    ),
    false
  );
  deepStrictEqual(/src\/dupe\.ts:\d+\/inline-comment/.test(plain(res)), false);
  deepStrictEqual(/module\s+│export/.test(plain(res)), false);
  deepStrictEqual(/summary:/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['tsdoc', 4],
      ['comments', 4],
      ['size', 2],
      ['readme', 1],
      ['jsr', 1],
      ['typeimport', 0],
      ['jsrpublish', 0],
      ['errors', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['importtime', 0],
    ]).test(plain(res)),
    true
  );
});

should('check keeps detailed issues when color is enabled', async () => {
  const cwd = fixture('fail-src');
  const res = await withEnv('JSBT_QUIET', '', () =>
    run(cwd, () => runJsbt([], { color: true, cwd, runJsrPublish: okJsrPublish }))
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/\[\x1b\[33mWARN\x1b\[0m\] readme:/.test(all(res)), true);
  deepStrictEqual(/\[WARN\] readme: README\.md:12\/usage/.test(plain(res)), true);
  deepStrictEqual(
    new RegExp(
      `\\[WARN\\] size: 2x unused \\(size\\)\\n(?:  .+\\n)*  broken/broken\\.js:\\d+/retained \\(broken/broken\\)`
    ).test(plain(res)),
    true
  );
  deepStrictEqual(
    /\[WARN\] tsdoc: broken\.d\.mts:1\/broken missing JSDoc \(docs\)/.test(plain(res)),
    true
  );
  deepStrictEqual(
    /\[WARN\] comments: 3x comment line exceeds 100 chars; reword comment \(comment\)\n  src\/alpha\.ts:\d+\/comment\n  src\/index\.ts:\d+\/comment\n  src\/note\.ts:\d+\/comment/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/src\/dupe\.ts:\d+\/inline-comment/.test(plain(res)), false);
  deepStrictEqual(/\x1b\[32m12\x1b\[0m checks finished in \d+ sec/.test(all(res)), true);
});

should('FORCE_COLOR overrides NO_COLOR', () => {
  deepStrictEqual(wantColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, false), true);
  deepStrictEqual(wantColor({ CLICOLOR_FORCE: '1', NO_COLOR: '1' }, false), true);
});

should('bundled importtime does not run imported subcommands', async () => {
  const { build } = await import('esbuild');
  const out = resolve('test/jsbt/build/.__jsbt-bin-test.mjs');
  rmSync(out, { force: true });
  await build({
    banner: { js: '#!/usr/bin/env node' },
    bundle: true,
    define: { __JSBT_BUNDLE__: 'true' },
    entryPoints: ['src/jsbt/index.ts'],
    format: 'esm',
    outfile: out,
    platform: 'node',
    target: 'node22',
  });
  const cwd = fixture('skip-import');
  const env = {
    CLICOLOR_FORCE: '0',
    FORCE_COLOR: '0',
    JSBT_WORKERS: '1',
    JSBT_LOG_LEVEL: '0',
    NO_COLOR: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_loglevel: 'silent',
    npm_config_progress: 'false',
    npm_config_update_notifier: 'false',
  };
  const prevArgv = process.argv.slice();
  const prevCwd = process.cwd();
  const prevEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const res = await capture(async () => {
      // The bundle reads the CLI path, so the target package comes from cwd, not an option.
      process.chdir(cwd);
      process.argv = [process.execPath, out, 'importtime'];
      await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
    });
    const text = all(res);
    const plainText = text.replace(/\x1b\[\d+(;\d+)*m/g, '');
    deepStrictEqual(res.ok, true, text);
    deepStrictEqual(/expected <package\.json>/.test(plainText), false, text);
    deepStrictEqual(/1 check finished in \d+ sec/.test(plainText), true, text);
  } finally {
    process.chdir(prevCwd);
    for (const [key, value] of prevEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.argv = prevArgv;
    rmSync(out, { force: true });
  }
});

should.runWhen(import.meta.url);
