import { deepStrictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/jsr');
const { runCli: runJsrPublish } = await import('../../src/jsbt/jsrpublish.ts');

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
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const run = (cwd: string, extra: Record<string, unknown> = {}) =>
  capture(() => runJsrPublish(['package.json'], { color: false, cwd, ...extra }));

should('jsrpublish passes when plain deno publish dry-run passes', async () => {
  let calls = 0;
  const res = await run(fixture('pass-root'), {
    runPublish: (_cwd: string, allowSlow: boolean) => {
      calls++;
      deepStrictEqual(allowSlow, false);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(calls, 1);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(plain(res)), true);
});

should('jsrpublish warns in compact mode when only --allow-slow-types passes', async () => {
  const cwd = fixture('pass-root');
  const file = resolve(cwd, 'src/index.ts').replace(/\\/g, '/');
  const res = await run(cwd, {
    full: false,
    runPublish: (_cwd: string, allowSlow: boolean) =>
      allowSlow
        ? { status: 0, stdout: '', stderr: '' }
        : {
            status: 1,
            stdout: [
              'Check src/index.ts',
              'error[missing-explicit-type]: missing explicit type in the public API',
              `   --> ${file}:7:14`,
              '    |',
              '7 | export const foo = 1;',
              '    |              ^^^ this symbol is missing an explicit type',
              '  info: all symbols in the public API must have an explicit type',
            ].join('\n'),
            stderr: '',
          },
  });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[WARN\] jsrpublish: src\/index\.ts:7:14 deno publish fails without --allow-slow-types; rerun passes with --allow-slow-types; see npm run check jsrpublish for full output \(jsrpublish-slow\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /error\[missing-explicit-type\]: missing explicit type in the public API/.test(plain(res)),
    true
  );
  deepStrictEqual(/summary: 0 passed, 1 warning, 0 failures, 0 skipped/.test(plain(res)), true);
});

should(
  'jsrpublish fails in compact mode when publish still fails with --allow-slow-types',
  async () => {
    const cwd = fixture('pass-root');
    const file = resolve(cwd, 'src/index.ts').replace(/\\/g, '/');
    const res = await run(cwd, {
      full: false,
      runPublish: (_cwd: string, allowSlow: boolean) => ({
        status: 1,
        stdout: allowSlow
          ? [
              'Check src/index.ts',
              'error[excluded-module]: Module is excluded from publish',
              `   --> ${file}:7:14`,
              '  info: fix publish.exclude or graph',
            ].join('\n')
          : [
              'Check src/index.ts',
              'error[missing-explicit-type]: missing explicit type in the public API',
              `   --> ${file}:7:14`,
            ].join('\n'),
        stderr: '',
      }),
    });
    deepStrictEqual(res.ok, false);
    deepStrictEqual(
      /\[ERROR\] jsrpublish: src\/index\.ts:7:14 deno publish fails even with --allow-slow-types; see npm run check jsrpublish for full output \(jsrpublish\)/.test(
        plain(res)
      ),
      true
    );
    deepStrictEqual(
      /error\[excluded-module\]: Module is excluded from publish/.test(plain(res)),
      true
    );
    deepStrictEqual(/missing explicit type in the public API/.test(plain(res)), false);
    deepStrictEqual(/summary: 0 passed, 0 warnings, 1 failure, 0 skipped/.test(plain(res)), true);
  }
);

should('jsrpublish full mode keeps full relevant output without the compact hint', async () => {
  const cwd = fixture('pass-root');
  const file = resolve(cwd, 'src/index.ts').replace(/\\/g, '/');
  const res = await run(cwd, {
    full: true,
    runPublish: (_cwd: string, allowSlow: boolean) =>
      allowSlow
        ? { status: 0, stdout: '', stderr: '' }
        : {
            status: 1,
            stdout: [
              'Check src/index.ts',
              'error[missing-explicit-type]: missing explicit type in the public API',
              `   --> ${file}:7:14`,
              '    |',
              '7 | export const foo = 1;',
              '    |              ^^^ this symbol is missing an explicit type',
              '  info: all symbols in the public API must have an explicit type',
              '  docs: https://jsr.io/go/slow-type-missing-explicit-type',
              '  more: line eight',
              '  more: line nine',
            ].join('\n'),
            stderr: '',
          },
  });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/more: line nine/.test(plain(res)), true);
  deepStrictEqual(/see npm run check jsrpublish for full output/.test(plain(res)), false);
  deepStrictEqual(/summary: 0 passed, 1 warning, 0 failures, 0 skipped/.test(plain(res)), true);
});

should('jsrpublish reports skipped runs when deno is unavailable', async () => {
  const res = await run(fixture('pass-root'), {
    runPublish: () => ({
      skipped: 'missing deno on PATH; install deno to run publish dry-run',
      status: -1,
      stdout: '',
      stderr: '',
    }),
  });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\[INFO\] jsrpublish: jsr\.json:publish deno publish dry-run skipped; missing deno on PATH; install deno to run publish dry-run \(jsrpublish-skip\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/summary: 0 passed, 0 warnings, 0 failures, 1 skipped/.test(plain(res)), true);
});

should.runWhen(import.meta.url);
