import * as assert from 'node:assert';
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
  assert.equal(res.ok, true, all(res));
  assert.match(all(res), /summary: 3 passed, 0 warnings, 0 failures, 0 skipped/);
  assert.doesNotMatch(all(res), /benchmark helper should not run/);
});

should('tests reports crashed entries but treats timeout as smoke pass', async () => {
  const cwd = fixture('fail');
  const res = await capture(() =>
    runTests(['package.json'], { color: false, cwd, limit: 2, timeoutMs: 100 })
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(tests\) test\/benchmark\/crash\.ts:exec exited 1 Error: broken benchmark fixture \(tests\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(tests\) test\/broken\.test\.ts:exec exited 1 Error: broken test fixture \(tests\)/
  );
  assert.doesNotMatch(plain(res), /test\/hang\.test\.ts:timeout/);
  assert.match(plain(res), /summary: 1 passed, 0 warnings, 2 failures, 0 skipped/);
  assert.match(plain(res), /Tests check found issues/);
});

should('check-tests alias runs tests checker', async () => {
  const cwd = fixture('pass');
  const res = await capture(() => runJsbt(['check-tests', 'package.json'], { color: false, cwd }));
  assert.equal(res.ok, true, all(res));
  assert.match(all(res), /summary: 3 passed, 0 warnings, 0 failures, 0 skipped/);
});

should.runWhen(import.meta.url);
