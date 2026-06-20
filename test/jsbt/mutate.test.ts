import { deepStrictEqual, rejects } from 'node:assert';
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
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('mutate reports mutable object and array exports', async () => {
  const cwd = fixture('fail-mutate');
  const res = await capture(() => runMutate(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] mutate: 2x mutable array export; add Object\.freeze around it \(mutate\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] mutate: 3x mutable object export; add Object\.freeze around it \(mutate\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/\n  index\.js:mutableArray/.test(plain(res)), true);
  deepStrictEqual(/\n  index\.js:mutableObject/.test(plain(res)), true);
  deepStrictEqual(/\n  sub\.js:mutableSub/.test(plain(res)), true);
  deepStrictEqual(/\n  index\.js:frozenShallow\.nestedArray/.test(plain(res)), true);
  deepStrictEqual(/\n  index\.js:frozenShallow\.nestedObject/.test(plain(res)), true);
  deepStrictEqual(/frozenArray/.test(plain(res)), false);
  deepStrictEqual(/frozenObject/.test(plain(res)), false);
  deepStrictEqual(/nestedBytes/.test(plain(res)), false);
  deepStrictEqual(/bytes/.test(plain(res)), false);
  deepStrictEqual(/words/.test(plain(res)), false);
  deepStrictEqual(/summary: 0 passed, 0 warnings, 5 failures, 0 skipped/.test(plain(res)), true);
  deepStrictEqual(/Mutate check found issues/.test(plain(res)), true);
});

should('check-mutate alias is rejected by jsbt dispatcher', async () => {
  const cwd = fixture('fail-mutate');
  await rejects(
    () => runJsbt(['check-mutate', 'package.json'], { color: false, cwd }),
    /unknown jsbt command: check-mutate/
  );
});

should.runWhen(import.meta.url);
