import * as assert from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/check');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');
const { runCli: runMutate } = await import('../../src/jsbt/mutate.ts');

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

should('mutate passes on immutable root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await capture(() => runMutate(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('mutate reports mutable object and array exports', async () => {
  const cwd = fixture('fail-mutate');
  const res = await capture(() => runMutate(['package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(mutate\) 2x mutable array export; add Object\.freeze around it \(mutate\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(mutate\) 3x mutable object export; add Object\.freeze around it \(mutate\)/
  );
  assert.match(plain(res), /\n  index\.js:mutableArray/);
  assert.match(plain(res), /\n  index\.js:mutableObject/);
  assert.match(plain(res), /\n  sub\.js:mutableSub/);
  assert.match(plain(res), /\n  index\.js:frozenShallow\.nestedArray/);
  assert.match(plain(res), /\n  index\.js:frozenShallow\.nestedObject/);
  assert.doesNotMatch(plain(res), /frozenArray/);
  assert.doesNotMatch(plain(res), /frozenObject/);
  assert.doesNotMatch(plain(res), /nestedBytes/);
  assert.doesNotMatch(plain(res), /bytes/);
  assert.doesNotMatch(plain(res), /words/);
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 5 failures, 0 skipped/);
  assert.match(plain(res), /Mutate check found issues/);
});

should('check-mutate alias reports mutable exports', async () => {
  const cwd = fixture('fail-mutate');
  const res = await capture(() => runJsbt(['check-mutate', 'package.json'], { color: false, cwd }));
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(mutate\) 3x mutable object export; add Object\.freeze around it \(mutate\)/
  );
  assert.match(plain(res), /\n  index\.js:mutableObject/);
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 5 failures, 0 skipped/);
});

should.runWhen(import.meta.url);
