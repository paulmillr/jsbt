import { deepStrictEqual } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { should } from '../../src/test.ts';

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
const { runCli: runTreeshake } = await import('../../src/jsbt/treeshake.ts');
const { wantColor } = await import('../../src/jsbt/utils.ts');
const ts = await import('typescript');

const fixture = (name: string) => join(ROOT, name);
const cleanup = (cwd: string) => {
  const build = join(cwd, 'test/build');
  rmSync(join(build, 'node_modules'), { force: true, recursive: true });
  rmSync(join(build, 'out-treeshake'), { force: true, recursive: true });
  rmSync(join(build, 'package-lock.json'), { force: true });
  if (!existsSync(build)) return;
  for (const ent of readdirSync(build))
    if (ent.startsWith('.__')) rmSync(join(build, ent), { force: true, recursive: true });
};
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
const run = async (cwd: string, fn: () => Promise<void>) => {
  cleanup(cwd);
  const res = await capture(fn);
  cleanup(cwd);
  return res;
};
const runProcess = async (cwd: string, fn: () => Promise<void>) => {
  cleanup(cwd);
  const res = await captureProcess(fn);
  cleanup(cwd);
  return res;
};
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
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
const checkJsbt = (argv: string[], cwd: string, extra: Record<string, unknown> = {}) =>
  runJsbt(argv, { color: false, cwd, runJsrPublish: okJsrPublish, ...extra });
const withEnv = async <T>(key: string, value: string, fn: () => Promise<T>) => {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};
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

should('treeshake passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () =>
    runTreeshake(['package.json', 'test/build/out-treeshake'], { cwd })
  );
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/found unused locals/.test(all(res)), false);
});

should('treeshake ignores declaration-only type exports', async () => {
  const cwd = fixture('pass-typeonly-runtime');
  const res = await run(cwd, () =>
    runTreeshake(['package.json', 'test/build/out-treeshake'], { cwd })
  );
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/TypeOnly/.test(all(res)), false);
  deepStrictEqual(/found unused locals/.test(all(res)), false);
});

should('treeshake reports unused locals on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () =>
    runTreeshake(['package.json', 'test/build/out-treeshake'], { cwd })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] treeshake: 3x unused \(treeshake\)\n  test\/build\/out-treeshake\/_tree_shaking_jsbt-test-check-src\.js:\d+\/retained \(@jsbt-test\/check-src\)\n  test\/build\/out-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)\n  test\/build\/out-treeshake\/broken\/_tree_shaking_broken\.js:\d+\/retained \(broken\/broken\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/found unused locals in 3 release bundles/.test(all(res)), true);
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
  const res = await run(cwd, () => checkJsbt(['check'], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^12 checks started\.\.\./.test(plain(res)), true);
  deepStrictEqual(/^12 checks started\.\.\.\n\n☆ readme/.test(plain(res)), true);
  deepStrictEqual(/preparing summary/.test(plain(res)), false);
  deepStrictEqual(
    checkSummary([
      ['readme', 0],
      ['treeshake', 0],
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

should('check uses dot reporter when JSBT_QUIET is set', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_QUIET', '1', () =>
    runProcess(cwd, () => checkJsbt(['check'], cwd))
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /^12 checks \(\+quiet\) started\.\.\.\n\.{12}\n\n12 checks finished in \d+ sec/.test(out),
    true
  );
  deepStrictEqual(/☆/.test(out), false);
  deepStrictEqual(/✓/.test(out), false);
  deepStrictEqual(/preparing summary/.test(out), false);
});

should('check accepts --project directory and runs from another cwd', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () =>
    checkJsbt(['check', '--project=test/jsbt/vectors/check/pass-root', 'comments'], BASE)
  );
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(checkSummary([['comments', 0]]).test(plain(res)), true);
});

should('check rejects the removed package.json positional argument', async () => {
  const cwd = fixture('pass-root');
  const res = await capture(() => checkJsbt(['check', 'package.json'], cwd));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/package\.json positional argument was removed/.test(plain(res)), true);
});

should('check accepts a second-arg selector and reports tsdoc warnings', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['check', 'tsdoc'], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] tsdoc: broken\.d\.mts:1\/broken missing JSDoc \(docs\)/.test(plain(res)),
    true
  );
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] treeshake:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] jsr:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] comments:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] bytes:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] mutate:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tests:/.test(plain(res)), false);
  deepStrictEqual(/\[(?:ERROR|WARN)\] importtime:/.test(plain(res)), false);
  deepStrictEqual(checkSummary([['tsdoc', 4]]).test(plain(res)), true);
});

should('check treeshake selector prints standalone treeshake table', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => checkJsbt(['check', 'treeshake'], cwd));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /module\s+\u2502export\s+\u2502min bundle\s+\u2502LOC\s+\u2502min KB/.test(out),
    true
  );
  deepStrictEqual(/@jsbt-test\/check-root\s+\u2502/.test(out), true);
  deepStrictEqual(/_tree_shaking_jsbt-test-check-root\.min\.js/.test(out), true);
  deepStrictEqual(/index\s+\u2502all\s+\u2502\s+index\/_tree_shaking_all\.min\.js/.test(out), true);
  deepStrictEqual(checkSummary([['treeshake', 0]]).test(out), true);
});

should('check accepts a patterns selector without defaulting to all checks', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['check', 'patterns'], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] treeshake:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] tsdoc:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] jsr:/.test(plain(res)), false);
  deepStrictEqual(checkSummary([['patterns', 0]]).test(plain(res)), true);
});

should('check accepts a jsrpublish selector and asks for full output', async () => {
  const cwd = fixture('pass-root');
  let full = false;
  const res = await run(cwd, () =>
    runJsbt(['check', 'jsrpublish'], {
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
  const res = await run(cwd, () => checkJsbt(['check', 'test/build/custom-treeshake'], cwd));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/unknown check selector: test\/build\/custom-treeshake/.test(plain(res)), true);
});

should('check keeps fs-modify activity inside os tmpdir', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_LOG_LEVEL', '0', () => run(cwd, () => checkJsbt(['check'], cwd)));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/(?:delete|install|write)\t/.test(all(res)), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), false);
});

should('check reports importtime warnings without failing', async () => {
  const cwd = fixture('warn-import');
  const res = await run(cwd, () => checkJsbt(['check'], cwd));
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
      ['treeshake', 0],
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
  const res = await run(cwd, () => checkJsbt(['check'], cwd));
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
      ['treeshake', 0],
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
  for (const argv of [
    ['importtime', 'package.json'],
    ['mutate', 'package.json'],
    ['check', 'mutate'],
  ]) {
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
  const res = await run(cwd, () => checkJsbt(['check'], cwd));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] bigint: 3x replace raw bigint literal with helper const; use const _1n = \/\* @__PURE__ \*\/ BigInt\(1\) for simple values, or const NAME = \/\* @__PURE__ \*\/ BigInt\(\.\.\.\) for specific ones \(bigint\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/\[ERROR\] readme:/.test(plain(res)), false);
  deepStrictEqual(/\[ERROR\] treeshake:/.test(plain(res)), false);
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
      ['treeshake', 0],
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
  const res = await run(cwd, () => checkJsbt(['check'], cwd));
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
  deepStrictEqual(/\[ERROR\] treeshake:/.test(plain(res)), false);
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
      ['treeshake', 0],
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
  const res = await run(cwd, () => checkJsbt(['check'], cwd));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[WARN\] readme: README\.md:12\/usage Argument of type 'string' is not assignable to parameter of type 'number'\. \(type\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[WARN\] treeshake: 3x unused \(treeshake\)\n  (?:\.\.\/)+tmp\/jsbt-check-[^/]+\/out-treeshake\/_tree_shaking_jsbt-test-check-src\.js:\d+\/retained \(@jsbt-test\/check-src\)\n  (?:\.\.\/)+tmp\/jsbt-check-[^/]+\/out-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)\n  (?:\.\.\/)+tmp\/jsbt-check-[^/]+\/out-treeshake\/broken\/_tree_shaking_broken\.js:\d+\/retained \(broken\/broken\)/.test(
      plain(res)
    ),
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
      ['treeshake', 3],
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
  const res = await run(cwd, () =>
    runJsbt(['check'], { color: true, cwd, runJsrPublish: okJsrPublish })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/\[\x1b\[33mWARN\x1b\[0m\] readme:/.test(all(res)), true);
  deepStrictEqual(/\[WARN\] readme: README\.md:12\/usage/.test(plain(res)), true);
  deepStrictEqual(
    /\[WARN\] treeshake: 3x unused \(treeshake\)\n(?:  .+\n)*  (?:\.\.\/)+tmp\/jsbt-check-[^/]+\/out-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)/.test(
      plain(res)
    ),
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
  deepStrictEqual(/\x1b\[33m(?:\d+h \d+min \d+s|\d+min \d+s|\d+s)\x1b\[0m/.test(all(res)), true);
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
  const prevArgv = process.argv.slice();
  const prevCwd = process.cwd();
  try {
    const cwd = fixture('skip-import');
    const res = await capture(async () => {
      process.chdir(cwd);
      process.argv = [process.execPath, out, 'importtime', 'package.json'];
      await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const text = all(res);
    deepStrictEqual(res.ok, true, text);
    deepStrictEqual(/expected <package\.json>/.test(text), false);
    deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 1 skipped/.test(text), true);
  } finally {
    process.argv = prevArgv;
    process.chdir(prevCwd);
    rmSync(out, { force: true });
  }
});

should.runWhen(import.meta.url);
