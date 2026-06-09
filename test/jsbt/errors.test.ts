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
  const seq: string[] = [];
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    const line = args.map((arg) => String(arg)).join(' ');
    stdout += `${line}\n`;
    seq.push(line);
  };
  console.error = (...args) => {
    const line = args.map((arg) => String(arg)).join(' ');
    stderr += `${line}\n`;
    seq.push(line);
  };
  try {
    await fn();
    return { error: undefined, ok: true, seq, stderr, stdout };
  } catch (error) {
    const line = (error as Error).message;
    stderr += `${line}\n`;
    seq.push(line);
    return { error: error as Error, ok: false, seq, stderr, stdout };
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
  assert.match(plain(res), /summary: 15 passed, 0 warnings, 0 failures, 0 skipped/);
});

should(
  'errors reports accepted wrong types, rejected-value audit, mutation, and aliasing',
  async () => {
    const cwd = fixture('fail');
    const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
    const out = plain(res);
    assert.equal(res.ok, false);
    assert.match(out, /wrong secretKey=false\n- index\.ts:isValidSecretKey: NO ERROR!/);
    assert.match(out, /- index\.ts:vague\s+: bad/);
    assert.match(out, /wrong msg=null\n- index\.ts:badReturnedCoder\.encode: NO ERROR!/);
    assert.match(
      out,
      new RegExp(
        '\\[WARNING\\] \\(errors\\) src/index\\.ts:\\d+/mutates ' +
          'valid call mutates input at arg\\[0\\]; ' +
          'document explicit mutation or copy input \\(errors-mutation\\)'
      )
    );
    assert.match(
      out,
      new RegExp(
        '\\[WARNING\\] \\(errors\\) src/index\\.ts:\\d+/aliases ' +
          'return value aliases input; ' +
          'document returned-input aliasing or copy output \\(errors-alias\\)'
      )
    );
    assert.match(out, /summary: 4 passed, 2 warnings, 8 failures, 0 skipped/);
    assert.match(out, /Errors check found issues/);
  }
);

should('check errors selector runs the standalone errors checker', async () => {
  const cwd = fixture('fail');
  const res = await capture(() =>
    runJsbt(['check', 'package.json', 'errors'], { color: false, cwd })
  );
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(out, /\[INFO\] \(check\) package\.json:note Checker may return not real errors/);
  assert.match(out, /wrong secretKey=false/);
  assert.match(out, /- index\.ts:isValidSecretKey: NO ERROR!/);
  assert.doesNotMatch(out, /unknown:0 Errors check found issues/);
  assert.match(out, /jsbt check done in \d+s: errors\(10, \d+s\)/);
});

should('check errors selector reports unprobeable examples before audit rows', async () => {
  const cwd = fixture('mixed-no-calls');
  const res = await capture(() =>
    runJsbt(['check', 'package.json', 'errors'], { color: false, cwd })
  );
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.match(
    res.seq.join('\n'),
    /could not derive valid runtime probes from TSDoc example[\s\S]*wrong bytesLength=true/
  );
  assert.match(
    out,
    /wrong bytesLength=true\n- index\.ts:randomBytes: "bytesLength" expected number, got boolean/
  );
  assert.doesNotMatch(out, /wrong 32=/);
});

should.runWhen(import.meta.url);
