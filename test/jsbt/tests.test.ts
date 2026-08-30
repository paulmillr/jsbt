import { deepStrictEqual, rejects, throws } from 'node:assert';
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
let nestedImportId = 0;
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
  withEnv(
    {
      JSBT_BAIL: undefined,
      JSBT_FILTER: undefined,
      JSBT_DEBUG: undefined,
      ...env,
    },
    () => import(`../../src/test.ts?runner-defaults=${runnerImportId++}`)
  );
const runQuietTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv(
    { JSBT_BAIL: undefined, JSBT_QUIET: '1', JSBT_WORKERS: '1', JSBT_FILTER: undefined, ...env },
    async () => {
      const mod = await import(`../../src/test.ts?quiet-layout=${quietImportId++}`);
      mod.should('2 + 2', () => {});
      mod.should('2 + 3', () => {});
      return captureProcess(() => mod.should.run());
    }
  );
};
const runQuietTreeTestModule = async () => {
  return withEnv(
    { JSBT_BAIL: undefined, JSBT_QUIET: '1', JSBT_WORKERS: '1', JSBT_FILTER: undefined },
    async () => {
      const mod = await import(`../../src/test.ts?quiet-nested-layout=${quietImportId++}`);
      mod.describe('outer', () => {
        mod.should('a', () => {});
        mod.should.skip('b', () => {});
        mod.describe('inner', () => {
          mod.should('c', () => {});
        });
      });
      return captureProcess(() => mod.should.run());
    }
  );
};
const runMultilineTestModule = async (env: Record<string, string | undefined> = {}) => {
  return withEnv(
    {
      JSBT_BAIL: undefined,
      JSBT_WORKERS: '1',
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
      JSBT_WORKERS: '1',
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
const runNestedTestModule = async (
  env: Record<string, string | undefined> = {},
  mutate?: (mod: typeof import('../../src/test.ts')) => void
) => {
  return withEnv(
    {
      CLICOLOR_FORCE: undefined,
      FORCE_COLOR: undefined,
      JSBT_BAIL: undefined,
      JSBT_WORKERS: '1',
      JSBT_FILTER: undefined,
      JSBT_QUIET: undefined,
      NO_COLOR: '1',
      ...env,
    },
    async () => {
      const mod = await import(`../../src/test.ts?nested-layout=${nestedImportId++}`);
      mod.describe('outer', () => {
        mod.describe('inner', () => {
          mod.should('leaf', () => {});
        });
      });
      mutate?.(mod);
      return captureProcess(() => mod.should.run());
    }
  );
};
const runHookOrderModule = async () => {
  return withEnv(
    { JSBT_BAIL: undefined, JSBT_QUIET: undefined, JSBT_WORKERS: '1', JSBT_FILTER: undefined },
    async () => {
      const mod = await import(`../../src/test.ts?hook-order=${nestedImportId++}`);
      const events: string[] = [];
      mod.describe('outer', () => {
        mod.beforeEach(() => void events.push('outer:before'));
        mod.afterEach(() => void events.push('outer:after'));
        mod.describe('inner', () => {
          mod.beforeEach(() => void events.push('inner:before'));
          mod.afterEach(() => void events.push('inner:after'));
          mod.should('one', () => void events.push('one'));
          mod.should('two', () => void events.push('two'));
        });
        mod.should('three', () => void events.push('three'));
      });
      const res = await captureProcess(() => mod.should.run());
      return { ...res, events };
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
const runFilterTestModule = async (
  filter: string,
  env: Record<string, string | undefined> = {}
) => {
  return withEnv(
    {
      CLICOLOR_FORCE: undefined,
      FORCE_COLOR: undefined,
      JSBT_BAIL: undefined,
      JSBT_WORKERS: '1',
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
  const env = { ...process.env, FORCE_COLOR: '1', JSBT_WORKERS: '2', ...extraEnv };
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
const runParallelQuietProgressModule = () => {
  const env = {
    ...process.env,
    JSBT_WORKERS: '2',
    JSBT_QUIET: '1',
    NO_COLOR: '1',
  };
  delete env.JSBT_BAIL;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('parallel-quiet-progress.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runParallelDynamicModule = () => {
  const env = {
    ...process.env,
    JSBT_WORKERS: '2',
    JSBT_QUIET: '1',
    NO_COLOR: '1',
  };
  delete env.JSBT_BAIL;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('parallel-dynamic.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runParallelSerialOverlapModule = () => {
  const env = {
    ...process.env,
    JSBT_WORKERS: '2',
    JSBT_QUIET: '1',
    NO_COLOR: '1',
  };
  delete env.JSBT_BAIL;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('parallel-serial-overlap.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runParallelTimingModule = () => {
  const env = {
    ...process.env,
    JSBT_WORKERS: '2',
    JSBT_QUIET: '1',
    JSBT_DEBUG: '1',
    NO_COLOR: '1',
  };
  delete env.JSBT_BAIL;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('parallel-timing.ts')], {
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
  delete env.JSBT_WORKERS;
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
const runNondeterministicModule = (name = 'nondeterministic-registration.ts') => {
  const env = { ...process.env, JSBT_WORKERS: '2', NO_COLOR: '1' };
  delete env.JSBT_BAIL;
  delete env.JSBT_QUIET;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture(name)], {
    cwd: BASE,
    encoding: 'utf8',
    env,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runWorkerDeathModule = (mode: 'exit' | 'signal') => {
  const env = { ...process.env, JSBT_WORKERS: '2', NO_COLOR: '1', WORKER_DEATH_MODE: mode };
  delete env.JSBT_BAIL;
  delete env.JSBT_QUIET;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('worker-death.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runManyRunsModule = () => {
  const env = { ...process.env, JSBT_WORKERS: '2', NO_COLOR: '1' };
  delete env.JSBT_BAIL;
  delete env.JSBT_QUIET;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('many-runs.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
    timeout: 120000,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runSerialRejoinModule = () => {
  const env = { ...process.env, JSBT_WORKERS: '2', JSBT_QUIET: '1', NO_COLOR: '1' };
  delete env.JSBT_BAIL;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('serial-rejoin.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runWorkerInitHangModule = () => {
  const env = {
    ...process.env,
    JSBT_WORKERS: '2',
    JSBT_WORKER_INIT_TIMEOUT_MS: '500',
    NO_COLOR: '1',
  };
  delete env.JSBT_BAIL;
  delete env.JSBT_QUIET;
  delete env.JSBT_FILTER;
  const res = spawnSync(process.execPath, [fixture('worker-init-hang.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runDenoParallelModule = () => {
  const env = { ...process.env, JSBT_WORKERS: '4', NO_COLOR: '1' };
  delete env.JSBT_BAIL;
  delete env.JSBT_QUIET;
  delete env.JSBT_FILTER;
  const res = spawnSync('deno', ['run', '-A', fixture('repeated-fast-run.ts')], {
    cwd: BASE,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runNativeNodeTestModule = () => {
  const res = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-isolation=none',
      '--test-reporter=spec',
      fixture('native-node-test.test.ts'),
    ],
    {
      cwd: BASE,
      encoding: 'utf8',
      env: { ...process.env, JSBT_WORKERS: '1' },
    }
  );
  const error = res.error as NodeJS.ErrnoException | undefined;
  const text = `${res.stdout || ''}${res.stderr || ''}${error ? `\n${error.message}` : ''}`;
  return { errorCode: error?.code, status: res.status, text };
};
const runInheritedNodeTestEnvModule = () => {
  const env = {
    ...process.env,
    JSBT_WORKERS: '1',
    NODE_TEST_CONTEXT: 'child-v8',
    NODE_TEST_WORKER_ID: '1',
  };
  const res = spawnSync(process.execPath, [fixture('inherited-node-test-env.ts')], {
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

should('check-tests alias is rejected by jsbt-check dispatcher', async () => {
  const cwd = fixture('pass');
  await rejects(
    () => runJsbt(['check-tests'], { color: false, cwd }),
    /unknown check selector: check-tests/
  );
  await rejects(() => runJsbt(['tests'], { color: false, cwd }), /unknown check selector: tests/);
});

should('test runner defaults to all cores in cli when JSBT_WORKERS is unset', async () => {
  const unset = await importTestRunner({ JSBT_WORKERS: undefined });
  deepStrictEqual(unset.should.opts.WORKERS, Infinity);
  deepStrictEqual(unset.should.opts.FILTER, '');
  deepStrictEqual(unset.should.opts.BAIL, true);
  deepStrictEqual(unset.should.opts.DEBUG, false);
  deepStrictEqual(Object.keys(unset.should.opts).sort(), [
    'BAIL',
    'COLOR',
    'DEBUG',
    'FILTER',
    'QUIET',
    'WORKERS',
  ]);
  const stale = unset.should.opts as Record<string, unknown>;
  throws(() => void stale.STOP_ON_ERROR, /renamed to opts\.BAIL/);
  throws(() => {
    stale.STOP_ON_ERROR = false;
  }, /renamed to opts\.BAIL/);
  const disabled = await importTestRunner({ JSBT_WORKERS: '1' });
  deepStrictEqual(disabled.should.opts.WORKERS, 1);
  const workers = await importTestRunner({ JSBT_WORKERS: '3' });
  deepStrictEqual(workers.should.opts.WORKERS, 3);
  const filtered = await importTestRunner({ JSBT_FILTER: 'hash/ahash' });
  deepStrictEqual(filtered.should.opts.FILTER, 'hash/ahash');
  const noBail = await importTestRunner({ JSBT_BAIL: '0' });
  deepStrictEqual(noBail.should.opts.BAIL, false);
  const noBailFalse = await importTestRunner({ JSBT_BAIL: 'false' });
  deepStrictEqual(noBailFalse.should.opts.BAIL, false);
  const bail = await importTestRunner({ JSBT_BAIL: '1' });
  deepStrictEqual(bail.should.opts.BAIL, true);
  const debug = await importTestRunner({ JSBT_DEBUG: '1' });
  deepStrictEqual(debug.should.opts.DEBUG, true);
});

should('test runner registers with node:test under node --test', () => {
  const res = runNativeNodeTestModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(/native node test bridge/.test(res.text), true, res.text);
  deepStrictEqual(/runs first test through node:test/.test(res.text), true, res.text);
  deepStrictEqual(/keeps skipped tests skipped/.test(res.text), true, res.text);
  deepStrictEqual(/# SKIP/.test(res.text), true, res.text);
  deepStrictEqual(/JSBT_WORKERS/.test(res.text), false, res.text);
});

should('test runner ignores inherited node:test env without node --test exec args', () => {
  const res = runInheritedNodeTestEnvModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(
    /1 test started \(JSBT_QUIET=0, JSBT_WORKERS=1, JSBT_FILTER=''\)/.test(res.text),
    true,
    res.text
  );
  deepStrictEqual(/1 tests passed/.test(res.text), true, res.text);
});

should('test multiline reporter rewrites started line on pass', async () => {
  const res = await runMultilineTestModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/☆/.test(all(res)), false, all(res));
  deepStrictEqual(/ahash:/.test(all(res)), false, all(res));
  deepStrictEqual(/\x1b\[32mahash/.test(all(res)), false, all(res));
  deepStrictEqual(/\x1b\[90mahash/.test(all(res)), false, all(res));
  deepStrictEqual(/ahash \r\x1b\[32m✓\x1b\[0m ahash\n/.test(all(res)), true, all(res));
});

should('test multiline reporter uses failure symbol on fail', async () => {
  const res = await runMultilineFailTestModule();
  deepStrictEqual(res.ok, false, all(res));
  deepStrictEqual(/☓/.test(all(res)), false, all(res));
  deepStrictEqual(/broken \r\x1b\[31m✕\x1b\[0m broken\n/.test(all(res)), true, all(res));
});

should('test sequential reporter flattens nested describes', async () => {
  const res = await runNestedTestModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/outer\n  inner/.test(all(res)), false, all(res));
  deepStrictEqual(/outer → inner → leaf \r✓ outer → inner → leaf\n/.test(all(res)), true, all(res));
});

should('test sequential reporter colors path arrows gray', async () => {
  const res = await runNestedTestModule({ FORCE_COLOR: '1', NO_COLOR: undefined });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /outer\x1b\[90m → \x1b\[0minner\x1b\[90m → \x1b\[0mleaf \r/.test(all(res)),
    true,
    all(res)
  );
  deepStrictEqual(
    /\r\x1b\[32m✓\x1b\[0m outer\x1b\[90m → \x1b\[0minner\x1b\[90m → \x1b\[0mleaf\n/.test(all(res)),
    true,
    all(res)
  );
  deepStrictEqual(/\x1b\[90mouter/.test(all(res)), false, all(res));
  deepStrictEqual(/\x1b\[90mleaf/.test(all(res)), false, all(res));
});

should('test color is a runtime option', async () => {
  // NO_COLOR seeds opts.COLOR = false; flipping it after import must win.
  const res = await runNestedTestModule({}, (mod) => {
    mod.should.opts.COLOR = true;
  });
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(
    /\x1b\[32m✓\x1b\[0m outer\x1b\[90m → \x1b\[0minner\x1b\[90m → \x1b\[0mleaf\n/.test(all(res)),
    true,
    all(res)
  );
});

should('test beforeEach/afterEach run outermost-first and unwind in reverse', async () => {
  const res = await runHookOrderModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(res.events, [
    ...['outer:before', 'inner:before', 'one', 'inner:after', 'outer:after'],
    ...['outer:before', 'inner:before', 'two', 'inner:after', 'outer:after'],
    ...['outer:before', 'three', 'outer:after'],
  ]);
});

should('test browser-like reporter uses flat completed lines', async () => {
  const res = await runBrowserLikeTestModule();
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/outer\n  inner/.test(all(res)), false, all(res));
  deepStrictEqual(/outer → inner → leaf \n/.test(all(res)), false, all(res));
  deepStrictEqual(/✓ outer → inner → leaf\n/.test(all(res)), true, all(res));
  const shim = await runProcessShimTestModule();
  deepStrictEqual(shim.mod.should.opts.WORKERS, 1);
  deepStrictEqual(shim.res.ok, true, all(shim.res));
  deepStrictEqual(
    /1 test started \(JSBT_QUIET=0, JSBT_WORKERS=1, JSBT_FILTER=''\)\nouter → inner → leaf \n✓ outer → inner → leaf\n/.test(
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
    /^1 test started \(JSBT_QUIET=0, JSBT_WORKERS=1, JSBT_FILTER='hash\/ahash'\)\n/.test(all(res)),
    true,
    all(res)
  );
  deepStrictEqual(/hash → ahash \r✓ hash → ahash\n/.test(all(res)), true, all(res));
  deepStrictEqual(/xhash/.test(all(res)), false, all(res));
  deepStrictEqual(/sign/.test(all(res)), false, all(res));
});

should('test parallel reporter uses gray arrow path separator', () => {
  const res = runParallelTestModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(
    /^\x1b\[32m1\x1b\[0m test started \x1b\[90m\(JSBT_QUIET=0, JSBT_WORKERS=2, JSBT_FILTER=''\)\x1b\[0m\n/.test(
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
  const filtered = runParallelTestModule({ JSBT_WORKERS: '8', JSBT_FILTER: 'hash' });
  if (filtered.errorCode === 'EPERM') return;
  deepStrictEqual(filtered.status, 0, filtered.text);
  deepStrictEqual(
    /^\x1b\[32m1\x1b\[0m test started \x1b\[90m\(JSBT_QUIET=0, JSBT_WORKERS=3, JSBT_FILTER='hash'\)\x1b\[0m\n/.test(
      filtered.text
    ),
    true,
    filtered.text
  );
});

should('test parallel quiet reporter streams dots as tests finish', () => {
  const res = runParallelQuietProgressModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  const progress = res.text.slice(res.text.indexOf('\n') + 1);
  deepStrictEqual(progress.indexOf('.') < progress.indexOf('S'), true, res.text);
  deepStrictEqual((progress.match(/\./g) || []).length, 4, res.text);
});

should('test parallel runner dynamically dispatches work to idle workers', () => {
  const res = runParallelDynamicModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  const assignments = new Map(
    [...res.text.matchAll(/assignment:([\w-]+):(\d+)/g)].map((match) => [match[1], match[2]])
  );
  deepStrictEqual(assignments.size, 4, res.text);
  deepStrictEqual(assignments.get('fast-1'), assignments.get('fast-2'), res.text);
  deepStrictEqual(assignments.get('fast-2'), assignments.get('fast-3'), res.text);
  deepStrictEqual(assignments.get('slow') === assignments.get('fast-1'), false, res.text);
});

should('test serial worker rejoins the parallel pool when its lane finishes', () => {
  const res = runSerialRejoinModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  const marks = [...res.text.matchAll(/mark:(\w+):(\d+)/g)];
  const serial = marks.find((m) => m[1] === 'serial');
  deepStrictEqual(serial !== undefined, true, res.text);
  const parallelPids = new Set(marks.filter((m) => m[1] !== 'serial').map((m) => m[2]));
  deepStrictEqual(parallelPids.size >= 2, true, res.text);
  deepStrictEqual(parallelPids.has(serial![2]), true, res.text);
});

should('test internal serial worker lane overlaps the parallel worker lane', () => {
  const res = runParallelSerialOverlapModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  const markers = new Map(
    [...res.text.matchAll(/lane:(parallel|serial):(start|end):(\d+):(true|false):(\d+)/g)].map(
      (match) =>
        [
          `${match[1]}:${match[2]}`,
          { time: Number(match[3]), primary: match[4] === 'true', pid: Number(match[5]) },
        ] as const
    )
  );
  deepStrictEqual(markers.size, 4, res.text);
  deepStrictEqual(markers.get('serial:start')!.primary, false, res.text);
  deepStrictEqual(markers.get('parallel:start')!.primary, false, res.text);
  deepStrictEqual(
    markers.get('serial:start')!.pid === markers.get('parallel:start')!.pid,
    false,
    res.text
  );
  deepStrictEqual(
    markers.get('serial:start')!.time < markers.get('parallel:end')!.time,
    true,
    res.text
  );
  deepStrictEqual(
    markers.get('parallel:start')!.time < markers.get('serial:end')!.time,
    true,
    res.text
  );
});

should('test long-test report merges workers, writes the median, and sorts slowest tests', () => {
  const res = runParallelTimingModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(
    /Long test report:\n  Median test time: \d+(?:\.\d+)?ms/.test(res.text),
    true,
    res.text
  );
  deepStrictEqual(/  Slowest 3 tests:/.test(res.text), true, res.text);
  const slow = res.text.indexOf('timing/slow');
  const medium = res.text.indexOf('timing/medium');
  const fast = res.text.indexOf('timing/fast');
  deepStrictEqual(slow !== -1 && slow < medium && medium < fast, true, res.text);
  deepStrictEqual(/\d+(?:\.\d+)?ms\s+timing\/slow/.test(res.text), true, res.text);
});

should('test default fast runner supports repeated run calls', () => {
  const res = runRepeatedFastRunModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(
    /internal error: not all tasks have been completed/.test(res.text),
    false,
    res.text
  );
  deepStrictEqual((res.text.match(/2 tests passed/g) || []).length, 2, res.text);
  // Workers of run #2 must reconstruct batch 2, not replay batch 1.
  deepStrictEqual((res.text.match(/first a/g) || []).length, 1, res.text);
  deepStrictEqual((res.text.match(/first b/g) || []).length, 1, res.text);
  deepStrictEqual((res.text.match(/second a/g) || []).length, 1, res.text);
  deepStrictEqual((res.text.match(/second b/g) || []).length, 1, res.text);
});

should('test parallel runner fails loudly when a worker dies before reporting', () => {
  const clean = runWorkerDeathModule('exit');
  if (clean.errorCode === 'EPERM') return;
  deepStrictEqual(clean.status, 0, clean.text);
  deepStrictEqual(/RESULT: resolved/.test(clean.text), false, clean.text);
  deepStrictEqual(/exited before reporting results \(code: 0\)/.test(clean.text), true, clean.text);
  const killed = runWorkerDeathModule('signal');
  if (killed.errorCode === 'EPERM') return;
  deepStrictEqual(killed.status, 0, killed.text);
  deepStrictEqual(/RESULT: resolved/.test(killed.text), false, killed.text);
  deepStrictEqual(
    /exited before reporting results \(signal: SIGKILL\)/.test(killed.text),
    true,
    killed.text
  );
});

should('test deno lane runs parallel batches in web workers', () => {
  const res = runDenoParallelModule();
  // no deno installed (or sandboxed): the lane is deno-only, skip silently
  if (res.errorCode === 'ENOENT' || res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual((res.text.match(/2 tests passed/g) || []).length, 2, res.text);
  deepStrictEqual((res.text.match(/first a/g) || []).length, 1, res.text);
  deepStrictEqual((res.text.match(/second a/g) || []).length, 1, res.text);
  deepStrictEqual(/JSBT_WORKERS=4/.test(res.text), true, res.text);
});

should('test repeated parallel runs do not accumulate listeners', () => {
  const res = runManyRunsModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(/MaxListenersExceededWarning/.test(res.text), false, res.text);
  deepStrictEqual(/ALL DONE/.test(res.text), true, res.text);
  deepStrictEqual((res.text.match(/2 tests passed/g) || []).length, 12, res.text);
});

should('test parallel runner bounds worker initialization time', () => {
  const res = runWorkerInitHangModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(/RESULT: resolved/.test(res.text), false, res.text);
  deepStrictEqual(/did not initialize within 0\.5 sec/.test(res.text), true, res.text);
});

should('test parallel runner rejects diverging worker task lists', () => {
  const res = runNondeterministicModule();
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(/RESULT: resolved/.test(res.text), false, res.text);
  deepStrictEqual(/task list differs from primary/.test(res.text), true, res.text);
});

should('test parallel runner rejects diverging worker task metadata', () => {
  const res = runNondeterministicModule('nondeterministic-metadata.ts');
  if (res.errorCode === 'EPERM') return;
  deepStrictEqual(res.status, 0, res.text);
  deepStrictEqual(/RESULT: resolved/.test(res.text), false, res.text);
  deepStrictEqual(/task list differs from primary/.test(res.text), true, res.text);
});

should('test quiet reporter omits boundary blank lines', async () => {
  const res = await runQuietTestModule();
  deepStrictEqual(res.ok, true, all(res));
  const out = plain({ stdout: res.stdout, stderr: res.stderr });
  deepStrictEqual(
    /^2 tests started \(JSBT_QUIET=1, JSBT_WORKERS=1, JSBT_FILTER=''\)\n\.\.\n2 tests passed in \d+ sec\n$/.test(
      out
    ),
    true,
    out
  );
});

should('test quiet reporter emits one dot per finished test', async () => {
  const res = await runQuietTreeTestModule();
  deepStrictEqual(res.ok, true, all(res));
  const out = plain({ stdout: res.stdout, stderr: res.stderr });
  // describe headers and skip lines must not inflate the dot count: 2 dots for 2 runs
  deepStrictEqual(
    /^3 tests started \(JSBT_QUIET=1, JSBT_WORKERS=1, JSBT_FILTER=''\)\n\.\.\n3 tests passed in \d+ sec\n$/.test(
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
    /^\x1b\[32m2\x1b\[0m tests started \x1b\[90m\(JSBT_QUIET=1, JSBT_WORKERS=1, JSBT_FILTER=''\)\x1b\[0m\n/.test(
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
    /^2 tests started \(JSBT_QUIET=1, JSBT_WORKERS=1, JSBT_FILTER='', JSBT_BAIL=0\)\n/.test(out),
    true,
    out
  );
});

should.runWhen(import.meta.url);
