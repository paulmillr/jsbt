import { deepStrictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/tests');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');
const { runCli: runTests } = await import('../../src/jsbt/tests.ts');

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

should('tests passes runnable test and benchmark entries', async () => {
  const cwd = fixture('pass');
  const res = await capture(() =>
    runTests(['package.json'], { color: false, cwd, limit: 2, timeoutMs: 1000 })
  );
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/summary: 3 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/benchmark helper should not run/.test(all(res)), false);
});

should('tests reports crashed entries but treats timeout as smoke pass', async () => {
  const cwd = fixture('fail');
  const res = await capture(() =>
    runTests(['package.json'], { color: false, cwd, limit: 2, timeoutMs: 100 })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] \(tests\) test\/benchmark\/crash\.ts:exec exited 1 Error: broken benchmark fixture \(tests\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] \(tests\) test\/broken\.test\.ts:exec exited 1 Error: broken test fixture \(tests\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/test\/hang\.test\.ts:timeout/.test(plain(res)), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 2 failures, 0 skipped/.test(plain(res)), true);
  deepStrictEqual(/Tests check found issues/.test(plain(res)), true);
});

should('check-tests alias runs tests checker', async () => {
  const cwd = fixture('pass');
  const res = await capture(() => runJsbt(['check-tests', 'package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/summary: 3 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should.runWhen(import.meta.url);
