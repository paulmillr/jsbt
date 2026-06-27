import { deepStrictEqual, rejects } from 'node:assert';
import { spawnSync } from 'node:child_process';
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
let runnerImportId = 0;
let multilineImportId = 0;
let treeImportId = 0;
let browserImportId = 0;
let processShimImportId = 0;
let filterImportId = 0;
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
const importTestRunner = (env: Record<string, string | undefined>) =>
  withEnv({ JSBT_BAIL: undefined, JSBT_FILTER: undefined, ...env }, () =>
    import(`../../src/test.ts?runner-defaults=${runnerImportId++}`)
  );
const runQuietTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv(
    { JSBT_BAIL: undefined, JSBT_QUIET: '1', JSBT_FAST: '', JSBT_FILTER: undefined, ...env },
    async () => {
      const mod = await import(`../../src/test.ts?quiet-layout=${quietImportId++}`);
      mod.should('2 + 2', () => {});
      mod.should('2 + 3', () => {});
      return captureProcess(() => mod.should.run());
    }
  );
};
const runMultilineTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv(
    {
      JSBT_BAIL: undefined,
      JSBT_FAST: '',
      JSBT_QUIET: undefined,
      JSBT_FILTER: undefined,
      FORCE_COLOR: '1',
      ...env,
    },
    async () => {
      const mod = await import(`../../src/test.ts?multiline-layout=${multilineImportId++}`);
      mod.should('ahash', () => {});
      return captureProcess(() => mod.should.run());
    }
  );
};
const runMultilineFailTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv(
    {
      JSBT_BAIL: undefined,
      JSBT_FAST: '',
      JSBT_QUIET: undefined,
      JSBT_FILTER: undefined,
      FORCE_COLOR: '1',
      ...env,
    },
    async () => {
      const mod = await import(`../../src/test.ts?multiline-fail-layout=${multilineImportId++}`);
      mod.should('broken', () => {
        throw new Error('broken test');
      });
      return captureProcess(() => mod.should.run());
    }
  );
};
const runTreeTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv(
    {
      CLICOLOR_FORCE: undefined,
      FORCE_COLOR: undefined,
      JSBT_BAIL: undefined,
      JSBT_FAST: '',
      JSBT_FILTER: undefined,
      JSBT_QUIET: undefined,
      NO_COLOR: '1',
      ...env,
    },
    async () => {
      const mod = await import(`../../src/test.ts?tree-layout=${treeImportId++}`);
      mod.describe('outer', () => {
        mod.describe('inner', () => {
          mod.should('leaf', () => {});
        });
      });
      return captureProcess(() => mod.should.run());
    }
  );
};
const runBrowserLikeTestModule = async () => {
  const globals = globalThis as typeof globalThis & { process?: NodeJS.Process };
  const prevProcess = globals.process;
  let mod: typeof import('../../src/test.ts');
  try {
    delete globals.process;
    mod = await import(`../../src/test.ts?browser-layout=${browserImportId++}`);
  } finally {
    globals.process = prevProcess;
  }
  mod.describe('outer', () => {
    mod.describe('inner', () => {
      mod.should('leaf', () => {});
    });
  });
  return capture(() => mod.should.run());
};
const runProcessShimTestModule = async (env: Record<string, string | undefined> = {}) => {
  const globals = globalThis as typeof globalThis & { process?: NodeJS.Process };
  const prevProcess = globals.process;
  let mod: typeof import('../../src/test.ts');
  try {
    globals.process = { env } as unknown as NodeJS.Process;
    mod = await import(`../../src/test.ts?process-shim-layout=${processShimImportId++}`);
  } finally {
    globals.process = prevProcess;
  }
  mod.describe('outer', () => {
    mod.describe('inner', () => {
      mod.should('leaf', () => {});
    });
  });
  const res = await capture(() => mod.should.run());
  return { mod, res };
};
const runFilterTestModule = async (filter: string, env: Record<string, string | undefined> = {}) => {
  return withEnv(
    {
      CLICOLOR_FORCE: undefined,
      FORCE_COLOR: undefined,
      JSBT_BAIL: undefined,
      JSBT_FAST: '',
      JSBT_FILTER: filter,
      JSBT_QUIET: undefined,
      NO_COLOR: '1',
      ...env,
    },
    async () => {
      const mod = await import(`../../src/test.ts?filter-layout=${filterImportId++}`);
      const ran: string[] = [];
      mod.describe('hash', () => {
        mod.should('ahash', () => ran.push('hash/ahash'));
        mod.should('xhash', () => ran.push('hash/xhash'));
      });
      mod.describe('sign', () => {
        mod.should('ahash', () => ran.push('sign/ahash'));
      });
      const res = await captureProcess(() => mod.should.run());
      return { ...res, ran };
    }
  );
};
const runParallelTestModule = (extraEnv: Record<string, string | undefined> = {}) => {
  const env = { ...process.env, FORCE_COLOR: '1', JSBT_FAST: '2', ...extraEnv };
  delete env.JSBT_BAIL;
  delete env.JSBT_QUIET;
  if (!('JSBT_FILTER' in extraEnv)) delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('parallel-reporter.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runRepeatedFastRunModule = () => {
  const env = { ...process.env };
  delete env.JSBT_BAIL;
  delete env.JSBT_FAST;
  delete env.JSBT_QUIET;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('repeated-fast-run.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
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

should.serial('tests reports crashed entries but treats timeout as smoke pass', async () => {
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

should('test runner defaults to fast in cli when JSBT_FAST is unset', async () => {
  const unset = await importTestRunner({ JSBT_FAST: undefined });
  deepStrictEqual(unset.should.opts.FAST, 1);
  deepStrictEqual(unset.should.opts.FILTER, '');
  deepStrictEqual(unset.should.opts.STOP_ON_ERROR, true);
  deepStrictEqual(Object.keys(unset.should.opts).sort(), [
    'FAST',
    'FILTER',
    'QUIET',
    'STOP_ON_ERROR',
  ]);
  const disabled = await importTestRunner({ JSBT_FAST: '' });
  deepStrictEqual(disabled.should.opts.FAST, 0);
  const workers = await importTestRunner({ JSBT_FAST: '3' });
  deepStrictEqual(workers.should.opts.FAST, 3);
  const filtered = await importTestRunner({ JSBT_FILTER: 'hash/ahash' });
  deepStrictEqual(filtered.should.opts.FILTER, 'hash/ahash');
  const noBail = await importTestRunner({ JSBT_BAIL: '0' });
  deepStrictEqual(noBail.should.opts.STOP_ON_ERROR, false);
  const noBailFalse = await importTestRunner({ JSBT_BAIL: 'false' });
  deepStrictEqual(noBailFalse.should.opts.STOP_ON_ERROR, false);
  const bail = await importTestRunner({ JSBT_BAIL: '1' });
  deepStrictEqual(bail.should.opts.STOP_ON_ERROR, true);
});

should('test multiline reporter rewrites started line on pass', async () => {
  const res = await runMultilineTestModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/☆/.test(all(res)), false, all(res));
  deepStrictEqual(/ahash:/.test(all(res)), false, all(res));
  deepStrictEqual(/\x1b\[32mahash/.test(all(res)), false, all(res));
  deepStrictEqual(
    /\x1b\[90mahash\x1b\[0m \r\x1b\[90mahash\x1b\[0m \x1b\[32m✓\x1b\[0m\n/.test(
      all(res)
    ),
    true,
    all(res)
  );
});

should('test multiline reporter uses failure symbol on fail', async () => {
  const res = await runMultilineFailTestModule();
  deepStrictEqual(res.ok, false, all(res));
  deepStrictEqual(/☓/.test(all(res)), false, all(res));
  deepStrictEqual(
    /\x1b\[90mbroken\x1b\[0m \r\x1b\[90mbroken\x1b\[0m \x1b\[31m✕\x1b\[0m\n/.test(
      all(res)
    ),
    true,
    all(res)
  );
});

should('test tree reporter defaults to indentation prefixes', async () => {
  const res = await runTreeTestModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/[├└│]/.test(all(res)), false, all(res));
  deepStrictEqual(/outer\n  inner\n    leaf \r    leaf ✓\n/.test(all(res)), true, all(res));
});

should('test tree reporter colors test cases gray', async () => {
  const res = await runTreeTestModule({ FORCE_COLOR: '1', NO_COLOR: undefined });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /outer\n  inner\n\x1b\[90m    leaf\x1b\[0m \r\x1b\[90m    leaf\x1b\[0m \x1b\[32m✓\x1b\[0m\n/.test(
      all(res)
    ),
    true,
    all(res)
  );
  deepStrictEqual(/\x1b\[90mouter/.test(all(res)), false, all(res));
  deepStrictEqual(/\x1b\[90m  inner/.test(all(res)), false, all(res));
});

should('test browser-like reporter uses flat paths', async () => {
  const res = await runBrowserLikeTestModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/outer\n  inner/.test(all(res)), false, all(res));
  deepStrictEqual(/outer\/inner\/leaf \nouter\/inner\/leaf ✓\n/.test(all(res)), true, all(res));
  const shim = await runProcessShimTestModule();
  deepStrictEqual(shim.mod.should.opts.FAST, 0);
  deepStrictEqual(shim.res.ok, true, all(shim.res));
  deepStrictEqual(
    /1 test started \(JSBT_QUIET=0, JSBT_FAST=0, JSBT_FILTER=''\)\nouter\n  inner\n    leaf \n    leaf ✓\n/.test(
      all(shim.res)
    ),
    true,
    all(shim.res)
  );
});

should('test filter matches full test paths', async () => {
  const res = await runFilterTestModule('hash/ahash');
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(res.ran, ['hash/ahash']);
  deepStrictEqual(
    /^1 test started \(JSBT_QUIET=0, JSBT_FAST=0, JSBT_FILTER='hash\/ahash'\)\n/.test(
      all(res)
    ),
    true,
    all(res)
  );
  deepStrictEqual(/hash\n  ahash \r  ahash ✓\n/.test(all(res)), true, all(res));
  deepStrictEqual(/xhash/.test(all(res)), false, all(res));
  deepStrictEqual(/sign/.test(all(res)), false, all(res));
});

should('test parallel reporter uses gray arrow path separator', () => {
  const res = runParallelTestModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(
    /^\x1b\[32m1\x1b\[0m test started \x1b\[90m\(JSBT_QUIET=0, JSBT_FAST=2, JSBT_FILTER=''\)\x1b\[0m\n/.test(
      res.text
    ),
    true,
    res.text
  );
  deepStrictEqual(/hash\/ahash/.test(res.text), false, res.text);
  deepStrictEqual(/\x1b\[90mhash/.test(res.text), false, res.text);
  deepStrictEqual(/\x1b\[90mahash/.test(res.text), false, res.text);
  deepStrictEqual(
    /\x1b\[32m✓\x1b\[0m hash\x1b\[90m → \x1b\[0mahash/.test(res.text),
    true,
    res.text
  );
  const filtered = runParallelTestModule({ JSBT_FAST: '8', JSBT_FILTER: 'hash' });
  if (filtered.errorCode === 'EPERM') return;
  deepStrictEqual(filtered.status, 0, filtered.text);
  deepStrictEqual(
    /^\x1b\[32m1\x1b\[0m test started \x1b\[90m\(JSBT_QUIET=0, JSBT_FAST=3, JSBT_FILTER='hash'\)\x1b\[0m\n/.test(
      filtered.text
    ),
    true,
    filtered.text
  );
});

should('test default fast runner supports repeated run calls', () => {
  const res = runRepeatedFastRunModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(/internal error: not all tasks have been completed/.test(res.text), false, res.text);
  deepStrictEqual((res.text.match(/2 tests passed/g) || []).length, 2, res.text);
});

should('test quiet reporter omits boundary blank lines', async () => {
  const res = await runQuietTestModule();
  deepStrictEqual(res.ok, true, all(res));
  const out = plain({ stdout: res.stdout, stderr: res.stderr });
  deepStrictEqual(
    /^2 tests started \(JSBT_QUIET=1, JSBT_FAST=0, JSBT_FILTER=''\)\n\.\.\n2 tests passed in \d+ sec\n$/.test(
      out
    ),
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
  deepStrictEqual(
    /^\x1b\[32m2\x1b\[0m tests started \x1b\[90m\(JSBT_QUIET=1, JSBT_FAST=0, JSBT_FILTER=''\)\x1b\[0m\n/.test(
      all(forced)
    ),
    true,
    all(forced)
  );
  const noColor = await runQuietTestModule({
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  });
  deepStrictEqual(/\x1b\[/.test(all(noColor)), false, all(noColor));
  const bail = await runQuietTestModule({
    JSBT_BAIL: '0',
    NO_COLOR: '1',
  });
  const out = plain({ stdout: bail.stdout, stderr: bail.stderr });
  deepStrictEqual(
    /^2 tests started \(JSBT_QUIET=1, JSBT_FAST=0, JSBT_FILTER='', JSBT_BAIL=0\)\n/.test(
      out
    ),
    true,
    out
  );
});

should.runWhen(import.meta.url);
