import * as assert from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/errors');
process.env.JSBT_LOG_LEVEL = '0';
const { runCli: runErrors } = await import('../../src/jsbt/errors.ts');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');

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

should('errors passes when examples reject wrong runtime types and return copies', async () => {
  const cwd = fixture('pass');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(plain(res), /summary: 14 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('errors reports accepted wrong types, vague messages, mutation, and aliasing', async () => {
  const cwd = fixture('fail');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(
    out,
    /\[ERROR\] \(errors\) src\/index\.ts:\d+\/isValidSecretKey wrong runtime type accepted for secretKey \(errors-type\)/
  );
  assert.match(
    out,
    /\[ERROR\] \(errors\) src\/index\.ts:\d+\/badReturnedCoder\.encode wrong runtime type accepted for arg0 \(errors-type\)/
  );
  assert.match(
    out,
    /\[WARNING\] \(errors\) src\/index\.ts:\d+\/vague error message should mention secretKey: bad \(errors-message\)/
  );
  assert.match(
    out,
    /\[WARNING\] \(errors\) src\/index\.ts:\d+\/mutates valid call mutates input at arg\[0\]; document explicit mutation or copy input \(errors-mutation\)/
  );
  assert.match(
    out,
    /\[WARNING\] \(errors\) src\/index\.ts:\d+\/aliases return value aliases input; document returned-input aliasing or copy output \(errors-alias\)/
  );
  assert.match(out, /summary: 0 passed, 4 warnings, 2 failures, 0 skipped/);
  assert.match(out, /Errors check found issues/);
});

should('check errors selector runs the standalone errors checker', async () => {
  const cwd = fixture('fail');
  const res = await capture(() =>
    runJsbt(['check', 'package.json', 'errors'], { color: false, cwd })
  );
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(out, /\[INFO\] \(check\) package\.json:note Checker may return not real errors/);
  assert.match(out, /\[ERROR\] \(errors\) src\/index\.ts:\d+\/isValidSecretKey/);
  assert.match(out, /jsbt check done in \d+s: errors\(\d+, \d+s\)/);
});

should.runWhen(import.meta.url);
