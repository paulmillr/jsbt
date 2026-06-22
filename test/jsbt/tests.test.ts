import { deepStrictEqual, rejects } from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const BASE = resolve('.');
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
let quietImportId = 0;
const withEnv = async <T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> => {
  const prev = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const runQuietTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv({ JSBT_QUIET: '1', JSBT_FAST: '', ...env }, async () => {
    const mod = await import(`../../src/test.ts?quiet-layout=${quietImportId++}`);
    mod.should('2 + 2', () => {});
    mod.should('2 + 3', () => {});
    return captureProcess(() => mod.should.run());
  });
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
    /\[ERROR\] tests: test\/benchmark\/crash\.ts:exec exited 1 Error: broken benchmark fixture \(tests\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] tests: test\/broken\.test\.ts:exec exited 1 Error: broken test fixture \(tests\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/test\/hang\.test\.ts:timeout/.test(plain(res)), false);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 2 failures, 0 skipped/.test(plain(res)), true);
  deepStrictEqual(/Tests check found issues/.test(plain(res)), true);
});

should('check-tests alias is rejected by jsbt dispatcher', async () => {
  const cwd = fixture('pass');
  await rejects(
    () => runJsbt(['check-tests', 'package.json'], { color: false, cwd }),
    /unknown jsbt command: check-tests/
  );
  await rejects(
    () => runJsbt(['check', 'tests'], { color: false, cwd }),
    /unknown check selector: tests/
  );
});

should('test quiet reporter omits boundary blank lines', async () => {
  const res = await runQuietTestModule();
  deepStrictEqual(res.ok, true, all(res));
  const out = plain({ stdout: res.stdout, stderr: res.stderr });
  deepStrictEqual(
    /^2 tests \(\+quiet\) started\.\.\.\n\.\.\n2 tests passed in \d+ sec\n$/.test(out),
    true,
    out
  );
});

should('test quiet reporter respects NO_COLOR', async () => {
  const forced = await runQuietTestModule({
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: '1',
    NO_COLOR: undefined,
  });
  deepStrictEqual(/\x1b\[32m/.test(all(forced)), true, all(forced));
  const noColor = await runQuietTestModule({
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  });
  deepStrictEqual(/\x1b\[/.test(all(noColor)), false, all(noColor));
});

should.runWhen(import.meta.url);
