import * as assert from 'node:assert';
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
const run = async (cwd: string, fn: () => Promise<void>) => {
  cleanup(cwd);
  const res = await capture(fn);
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
const spent = String.raw`(?:\d+h \d+min \d+s|\d+min \d+s|\d+s)`;
const checkItem = (name: string, count: number) => `${name}\\(${count}, ${spent}\\)`;
const checkSummary = (items: [string, number][]) =>
  new RegExp(
    `jsbt check done in ${spent}: ${items.map(([name, count]) => checkItem(name, count)).join(', ')}`
  );
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
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('readme reports wrong example on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => runReadme(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(all(res), /README\.md:\d+\/usage/);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 1 failure, 0 skipped/);
  assert.match(all(res), /README check found issues/);
});

should('tsdoc passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 5 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('tsdoc reports missing docs on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(all(res), /broken\.d\.mts:\d+\/broken/);
  assert.match(all(res), /missing JSDoc/);
  assert.match(all(res), /missing @param value/);
  assert.match(all(res), /missing @returns/);
  assert.match(all(res), /missing @example/);
  assert.match(all(res), /summary: 2 passed, 0 warnings, 4 failures, 0 skipped/);
  assert.match(all(res), /JSDoc check found issues/);
});

should('tsdoc unwraps TArg and TRet in bag link targets', async () => {
  const cwd = fixture('fail-wrapper-link');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(
    out,
    /\[ERROR\] \(tsdoc\) index\.d\.mts:\d+\/Surface @param sign\.options should link to \{@link SignOptions\} \(param\)/
  );
  assert.match(
    out,
    /\[ERROR\] \(tsdoc\) index\.d\.mts:\d+\/Surface @param verify\.options should link to \{@link VerifyOptions\} \(param\)/
  );
  assert.doesNotMatch(out, /\{@link TArg\}/);
  assert.doesNotMatch(out, /\{@link TRet\}/);
  assert.match(out, /summary: 4 passed, 0 warnings, 2 failures, 0 skipped/);
});

should('tsdoc unwraps nested TRet callable intersections', async () => {
  const cwd = fixture('pass-nested-wrapper');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, true);
  assert.doesNotMatch(out, /missing @param args/);
  assert.doesNotMatch(out, /missing @param hash\.msg/);
  assert.doesNotMatch(out, /missing @param hash\.opts/);
  assert.doesNotMatch(out, /unknown @param log\.url/);
  assert.doesNotMatch(out, /unknown @param log\.opts/);
  assert.doesNotMatch(out, /unknown @param msg/);
  assert.doesNotMatch(out, /unknown @param opts/);
  assert.match(out, /summary: 3 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('tsdoc rejects synthetic args docs for nested wrappers', async () => {
  const cwd = fixture('fail-nested-wrapper-args');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(out, /\[ERROR\] \(tsdoc\) index\.d\.mts:\d+\/sha missing @param msg \(param\)/);
  assert.match(out, /\[ERROR\] \(tsdoc\) index\.d\.mts:\d+\/sha missing @param opts \(param\)/);
  assert.match(out, /\[ERROR\] \(tsdoc\) index\.d\.mts:\d+\/sha unknown @param args \(param\)/);
  assert.match(out, /summary: 0 passed, 0 warnings, 3 failures, 0 skipped/);
});

should('tsdoc rejects wrapper links for nested callable option bags', async () => {
  const cwd = fixture('fail-nested-wrapper-link');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(
    out,
    /\[ERROR\] \(tsdoc\) index\.d\.mts:\d+\/sha @param opts should link to \{@link OutputOpts\} \(param\)/
  );
  assert.match(out, /summary: 0 passed, 0 warnings, 1 failure, 0 skipped/);
});

should('tsdoc blames original typed declarations instead of re-exports', async () => {
  const cwd = fixture('fail-reexport-member');
  const res = await run(cwd, () => runTSDoc(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(
    out,
    /\[ERROR\] \(tsdoc\) types\.ts:\d+\/OutputOpts missing member JSDoc for dkLen \(member\)/
  );
  assert.doesNotMatch(out, /index\.d\.mts:\d+\/OutputOpts missing member JSDoc for dkLen/);
  assert.doesNotMatch(out, /web\.d\.mts:\d+\/OutputOpts missing member JSDoc for dkLen/);
  assert.match(out, /summary: 1 passed, 0 warnings, 1 failure, 0 skipped/);
});

should('treeshake passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () =>
    runTreeshake(['package.json', 'test/build/out-treeshake'], { cwd })
  );
  assert.equal(res.ok, true);
  assert.doesNotMatch(all(res), /found unused locals/);
});

should('treeshake ignores declaration-only type exports', async () => {
  const cwd = fixture('pass-typeonly-runtime');
  const res = await run(cwd, () =>
    runTreeshake(['package.json', 'test/build/out-treeshake'], { cwd })
  );
  assert.equal(res.ok, true);
  assert.doesNotMatch(all(res), /TypeOnly/);
  assert.doesNotMatch(all(res), /found unused locals/);
});

should('treeshake reports unused locals on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () =>
    runTreeshake(['package.json', 'test/build/out-treeshake'], { cwd })
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(treeshake\) 3x unused \(treeshake\)\n  test\/build\/out-treeshake\/_tree_shaking_jsbt-test-check-src\.js:\d+\/retained \(@jsbt-test\/check-src\)\n  test\/build\/out-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)\n  test\/build\/out-treeshake\/broken\/_tree_shaking_broken\.js:\d+\/retained \(broken\/broken\)/
  );
  assert.match(all(res), /found unused locals in 3 release bundles/);
});

should('comments passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runComments(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('comments reports long prose and inline comments on multi-module fixture', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => runComments(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(
    all(res),
    /\[ERROR\] \(comments\) 3x comment line exceeds 100 chars; reword comment \(comment\)\n  src\/alpha\.ts:\d+\/comment\n  src\/index\.ts:\d+\/comment\n  src\/note\.ts:\d+\/comment/
  );
  assert.match(
    all(res),
    /\[ERROR\] \(comments\) src\/broken\.ts:\d+\/inline-comment line exceeds 100 chars with inline comment; move comment above the code \(inline-comment\)/
  );
  assert.doesNotMatch(all(res), /src\/dupe\.ts:inline-comment/);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 4 failures, 0 skipped/);
  assert.match(all(res), /Comments check found issues/);
});

should('bigint passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runBigInt(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('bigint reports raw bigint literals and suggests BigInt helpers', async () => {
  const cwd = fixture('fail-bigint');
  const res = await run(cwd, () => runBigInt(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(
    out,
    /\[ERROR\] \(bigint\) 3x replace raw bigint literal with helper const; use const _1n = \/\* @__PURE__ \*\/ BigInt\(1\) for simple values, or const NAME = \/\* @__PURE__ \*\/ BigInt\(\.\.\.\) for specific ones \(bigint\)/
  );
  assert.match(out, /1n -> \/\* @__PURE__ \*\/ BigInt\(1\)/);
  assert.match(out, /-1n -> \/\* @__PURE__ \*\/ BigInt\(-1\)/);
  assert.match(
    out,
    /0x123456789abcdef123456789n -> \/\* @__PURE__ \*\/ BigInt\('0x123456789abcdef123456789'\)/
  );
  assert.match(all(res), /summary: 0 passed, 0 warnings, 3 failures, 0 skipped/);
  assert.match(all(res), /BigInt check found issues/);
});

should('importtime passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /module/);
  assert.match(all(res), /index\.js/);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('importtime warns on slow public entry and prints table', async () => {
  const cwd = fixture('warn-import');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /module/);
  assert.match(all(res), /slow\.js/);
  assert.match(all(res), /limit/);
  assert.match(all(res), /slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/);
  assert.doesNotMatch(all(res), /import exceeds/);
  assert.match(all(res), /summary: 1 passed, 1 warning, 0 failures, 0 skipped/);
});

should('importtime skips root trap modules', async () => {
  const cwd = fixture('skip-import');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /index\.js/);
  assert.match(all(res), /\bskip\b/);
  assert.doesNotMatch(all(res), /failed to import root module cannot be imported/);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 1 skipped/);
});

should('importtime fails on very slow public entry', async () => {
  const cwd = fixture('fail-import');
  const res = await run(cwd, () => runImportTime(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(all(res), /slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 1 failure, 0 skipped/);
});

should('typeimport passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runTypeImport(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('typeimport reports local import(...) types in public declarations', async () => {
  const cwd = fixture('fail-typeimport');
  const res = await run(cwd, () => runTypeImport(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(typeimport\) index\.d\.mts:\d+\/typeimport add import type \{ Shape \} from '\.\/types\.ts'; export type \{ Shape \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(typeimport\) index\.d\.mts:\d+\/typeimport add import type \{ Pair \} from '\.\/types\.ts'; export type \{ Pair \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/
  );
  assert.match(all(res), /summary: 0 passed, 0 warnings, 2 failures, 0 skipped/);
  assert.match(all(res), /Type import check found issues/);
});

should('typeimport proof prefers local import type plus local export type', () => {
  const res = typeImportProof();
  assert.equal(res.good.ok, true, res.good.text);
  assert.doesNotMatch(res.good.dts, /import\("\.\/x\.ts"\)\.Foo/);
  assert.match(res.good.dts, /import type \{ Foo \} from '\.\/x\.ts';/);
  assert.equal(res.bad.ok, false);
  assert.match(res.bad.text, /Cannot find name 'Foo'/);
});

should('check passes on root-entry fixture with default out dir', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json'], cwd));
  assert.equal(res.ok, true, all(res));
  assert.match(
    plain(res),
    /\[INFO\] \(check\) package\.json:note Checker may return not real errors or flag correct code; it is here to point at issues, not something that should have strict zero errors/
  );
  assert.match(
    all(res),
    checkSummary([
      ['readme', 0],
      ['treeshake', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
      ['importtime', 0],
    ])
  );
});

should('check accepts a second-arg selector and runs only tsdoc', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json', 'tsdoc'], cwd));
  assert.equal(res.ok, false);
  assert.match(plain(res), /\[ERROR\] \(tsdoc\) broken\.d\.mts:1\/broken missing JSDoc \(docs\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(readme\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(treeshake\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(jsr\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(comments\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(bytes\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(mutate\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(tests\)/);
  assert.doesNotMatch(plain(res), /\[(?:ERROR|WARNING)\] \(importtime\)/);
  assert.match(plain(res), checkSummary([['tsdoc', 4]]));
});

should('check accepts a jsrpublish selector and asks for full output', async () => {
  const cwd = fixture('pass-root');
  let full = false;
  const res = await run(cwd, () =>
    runJsbt(['check', 'package.json', 'jsrpublish'], {
      color: false,
      cwd,
      runJsrPublish: async (_argv, opts) => {
        full = !!opts?.full;
      },
    })
  );
  assert.equal(res.ok, true, all(res));
  assert.equal(full, true);
  assert.match(plain(res), checkSummary([['jsrpublish', 0]]));
});

should('check keeps a non-selector second arg as treeshake out dir', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () =>
    checkJsbt(['check', 'package.json', 'test/build/custom-treeshake'], cwd)
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(treeshake\) 3x unused \(treeshake\)\n  test\/build\/custom-treeshake\/_tree_shaking_jsbt-test-check-src\.js:\d+\/retained \(@jsbt-test\/check-src\)\n  test\/build\/custom-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)\n  test\/build\/custom-treeshake\/broken\/_tree_shaking_broken\.js:\d+\/retained \(broken\/broken\)/
  );
  assert.match(
    plain(res),
    checkSummary([
      ['tsdoc', 4],
      ['comments', 4],
      ['treeshake', 3],
      ['readme', 1],
      ['jsr', 1],
      ['typeimport', 0],
      ['jsrpublish', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
      ['importtime', 0],
    ])
  );
});

should('check replays fs-modify activity when log level allows it', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_LOG_LEVEL', '1', () =>
    run(cwd, () => checkJsbt(['check', 'package.json'], cwd))
  );
  assert.equal(res.ok, true);
  assert.match(all(res), /> cd /);
  assert.match(all(res), /> npm install/);
  assert.doesNotMatch(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('check reports importtime warnings without failing', async () => {
  const cwd = fixture('warn-import');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json'], cwd));
  assert.equal(res.ok, true);
  assert.match(
    plain(res),
    /\[WARNING\] \(importtime\) slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/
  );
  assert.doesNotMatch(plain(res), /import exceeds/);
  assert.doesNotMatch(plain(res), /module\s+│file/);
  assert.match(
    plain(res),
    checkSummary([
      ['importtime', 1],
      ['readme', 0],
      ['treeshake', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
    ])
  );
});

should('check fails on importtime errors without table', async () => {
  const cwd = fixture('fail-import');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json'], cwd));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(importtime\) slow\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/
  );
  assert.doesNotMatch(plain(res), /module\s+│file/);
  assert.match(
    plain(res),
    checkSummary([
      ['importtime', 1],
      ['readme', 0],
      ['treeshake', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
    ])
  );
});

should('check keeps importtime on the serial lane', () => {
  const src = readFileSync(resolve('src/jsbt/index.ts'), 'utf8');
  assert.match(
    src,
    /{\s*head: 'importtime',[\s\S]*?pick: \(res\) => pickIssues\('importtime', res, colorOn\),[\s\S]*?serial: true,\s*}/
  );
});

should('worker-backed checks exit after imported modules leave handles open', async () => {
  const cwd = fixture('pass-worker-handle');
  for (const argv of [
    ['importtime', 'package.json'],
    ['mutate', 'package.json'],
    ['check', 'package.json', 'mutate'],
  ]) {
    const res = await workerJsbt(cwd, argv);
    const text = [all(res), res.error].filter(Boolean).join('\n');
    assert.equal(res.timedOut, false, text);
    assert.equal(res.code, 0, text);
    assert.match(text, /summary: 1 passed, 0 warnings, 0 failures, 0 skipped|jsbt check done in/);
  }
});

should('check reports bigint issues and keeps other checks green', async () => {
  const cwd = fixture('fail-bigint');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json'], cwd));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(bigint\) 3x replace raw bigint literal with helper const; use const _1n = \/\* @__PURE__ \*\/ BigInt\(1\) for simple values, or const NAME = \/\* @__PURE__ \*\/ BigInt\(\.\.\.\) for specific ones \(bigint\)/
  );
  assert.doesNotMatch(plain(res), /\[ERROR\] \(readme\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(treeshake\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(tsdoc\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(typeimport\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(jsr\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(comments\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(bytes\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(mutate\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(tests\)/);
  assert.doesNotMatch(plain(res), /\[(?:ERROR|WARNING)\] \(importtime\)/);
  assert.match(
    plain(res),
    checkSummary([
      ['bigint', 3],
      ['readme', 0],
      ['treeshake', 0],
      ['tsdoc', 0],
      ['typeimport', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
      ['importtime', 0],
    ])
  );
});

should('check reports typeimport issues and keeps other checks green', async () => {
  const cwd = fixture('fail-typeimport');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json'], cwd));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(typeimport\) index\.d\.mts:\d+\/typeimport add import type \{ Shape \} from '\.\/types\.ts'; export type \{ Shape \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(typeimport\) index\.d\.mts:\d+\/typeimport add import type \{ Pair \} from '\.\/types\.ts'; export type \{ Pair \}; to avoid import\(\.\.\.\) in public types \(typeimport\)/
  );
  assert.doesNotMatch(plain(res), /\[ERROR\] \(readme\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(treeshake\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(tsdoc\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(jsr\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(comments\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(bigint\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(bytes\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(mutate\)/);
  assert.doesNotMatch(plain(res), /\[ERROR\] \(tests\)/);
  assert.doesNotMatch(plain(res), /\[(?:ERROR|WARNING)\] \(importtime\)/);
  assert.match(
    plain(res),
    checkSummary([
      ['typeimport', 2],
      ['readme', 0],
      ['treeshake', 0],
      ['tsdoc', 0],
      ['jsr', 0],
      ['jsrpublish', 0],
      ['comments', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
      ['importtime', 0],
    ])
  );
});

should('check runs all checks before failing', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () => checkJsbt(['check', 'package.json'], cwd));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(readme\) README\.md:12\/usage Argument of type 'string' is not assignable to parameter of type 'number'\. \(type\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(treeshake\) 3x unused \(treeshake\)\n  test\/build\/out-treeshake\/_tree_shaking_jsbt-test-check-src\.js:\d+\/retained \(@jsbt-test\/check-src\)\n  test\/build\/out-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)\n  test\/build\/out-treeshake\/broken\/_tree_shaking_broken\.js:\d+\/retained \(broken\/broken\)/
  );
  assert.match(plain(res), /\[ERROR\] \(tsdoc\) broken\.d\.mts:1\/broken missing JSDoc \(docs\)/);
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) missing jsr export mapping \(jsr-export\)\n  jsr\.json:exports \.\/broken\.js -> \.\/src\/broken\.ts/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(comments\) 3x comment line exceeds 100 chars; reword comment \(comment\)\n  src\/alpha\.ts:\d+\/comment\n  src\/index\.ts:\d+\/comment\n  src\/note\.ts:\d+\/comment/
  );
  assert.doesNotMatch(plain(res), /\[ERROR\] \(bigint\)/);
  assert.match(
    plain(res),
    /\[ERROR\] \(comments\) src\/broken\.ts:\d+\/inline-comment line exceeds 100 chars with inline comment; move comment above the code \(inline-comment\)/
  );
  assert.doesNotMatch(
    plain(res),
    /\[ERROR\] \(comments\) src\/alpha\.ts:\d+\/comment comment line exceeds 100 chars; reword comment \(comment\)/
  );
  assert.doesNotMatch(plain(res), /src\/dupe\.ts:\d+\/inline-comment/);
  assert.doesNotMatch(plain(res), /module\s+│export/);
  assert.doesNotMatch(plain(res), /summary:/);
  assert.match(
    plain(res),
    checkSummary([
      ['tsdoc', 4],
      ['comments', 4],
      ['treeshake', 3],
      ['readme', 1],
      ['jsr', 1],
      ['typeimport', 0],
      ['jsrpublish', 0],
      ['bigint', 0],
      ['bytes', 0],
      ['mutate', 0],
      ['tests', 0],
      ['importtime', 0],
    ])
  );
});

should('check keeps detailed issues when color is enabled', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd, () =>
    runJsbt(['check', 'package.json'], { color: true, cwd, runJsrPublish: okJsrPublish })
  );
  assert.equal(res.ok, false);
  assert.match(all(res), /\[\x1b\[31mERROR\x1b\[0m\] \(readme\)/);
  assert.match(plain(res), /\[ERROR\] \(readme\) README\.md:12\/usage/);
  assert.match(
    plain(res),
    /\[ERROR\] \(treeshake\) 3x unused \(treeshake\)\n(?:  .+\n)*  test\/build\/out-treeshake\/broken\/_tree_shaking_all\.js:\d+\/retained \(broken\/all\)/
  );
  assert.match(plain(res), /\[ERROR\] \(tsdoc\) broken\.d\.mts:1\/broken missing JSDoc \(docs\)/);
  assert.match(
    plain(res),
    /\[ERROR\] \(comments\) 3x comment line exceeds 100 chars; reword comment \(comment\)\n  src\/alpha\.ts:\d+\/comment\n  src\/index\.ts:\d+\/comment\n  src\/note\.ts:\d+\/comment/
  );
  assert.doesNotMatch(plain(res), /src\/dupe\.ts:\d+\/inline-comment/);
  assert.match(all(res), /\x1b\[33m(?:\d+h \d+min \d+s|\d+min \d+s|\d+s)\x1b\[0m/);
});

should('FORCE_COLOR overrides NO_COLOR', () => {
  assert.equal(wantColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, false), true);
  assert.equal(wantColor({ CLICOLOR_FORCE: '1', NO_COLOR: '1' }, false), true);
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
    assert.equal(res.ok, true, text);
    assert.doesNotMatch(text, /expected <package\.json>/);
    assert.match(text, /summary: 1 passed, 0 warnings, 0 failures, 1 skipped/);
  } finally {
    process.argv = prevArgv;
    process.chdir(prevCwd);
    rmSync(out, { force: true });
  }
});

should.runWhen(import.meta.url);
