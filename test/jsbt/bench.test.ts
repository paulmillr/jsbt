import { deepStrictEqual, rejects } from 'node:assert';
import { should } from '../../src/test.ts';

type BenchModule = typeof import('../../src/bench.ts');

const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  let stdout = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  try {
    await fn();
    return stdout;
  } finally {
    console.log = prevLog;
  }
};

let benchImportId = 0;
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
const loadBench = (env: Record<string, string | undefined>): Promise<BenchModule> =>
  withEnv({ JSBT_FILTER: undefined, ...env }, () =>
    import(`../../src/bench.ts?color=${benchImportId++}`)
  );
const loadBenchWithDurations = (
  env: Record<string, string | undefined>,
  durations: bigint[]
): Promise<BenchModule> => {
  const real = process.hrtime.bigint;
  let calls = 0;
  let index = 0;
  let now = 0n;
  process.hrtime.bigint = (() => {
    if (calls++ % 2 === 0) return now;
    now += durations[index++ % durations.length];
    return now;
  }) as typeof process.hrtime.bigint;
  return loadBench(env).finally(() => {
    process.hrtime.bigint = real;
  });
};

should('bench respects NO_COLOR', async () => {
  const forced = await loadBench({
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: '1',
    NO_COLOR: undefined,
  });
  const forcedOutput = await capture(() => forced.default('noop', () => {}, { mode: 'runOnce' }));
  deepStrictEqual(/\x1b\[34m/.test(forcedOutput), true, forcedOutput);
  deepStrictEqual(/\x1b\[31m/.test(forced.utils.calcStats([1n, 2n]).formatted), true);
  forced.utils.setMaxRunTime(0.1);
  const forcedRate = await capture(() => forced.default('noop', () => {}));
  deepStrictEqual(/x \x1b\[32m[\d,]*,[\d,]*\x1b\[0m ops\/sec/.test(forcedRate), true, forcedRate);

  const noColor = await loadBench({
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  });
  const noColorOutput = await capture(() => noColor.default('noop', () => {}, { mode: 'runOnce' }));
  deepStrictEqual(/\x1b\[/.test(noColorOutput), false, noColorOutput);
  deepStrictEqual(/\x1b\[/.test(noColor.utils.calcStats([1n, 2n]).formatted), false);
  noColor.utils.setMaxRunTime(0.1);
  const noColorRate = await capture(() => noColor.default('noop', () => {}));
  deepStrictEqual(/x \d+ ops\/sec/.test(noColorRate), true, noColorRate);
  deepStrictEqual(/x [\d,]*,[\d,]* ops\/sec/.test(noColorRate), false, noColorRate);
});

should('bench only displays variability at 5 percent or higher', async () => {
  const env = {
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  };
  const low = await loadBenchWithDurations(env, [9_500_000n, 10_500_000n]);
  const lowOutput = await capture(() => low.default('low', () => {}, { maxRunTimeSec: 0.1 }));
  deepStrictEqual(/±/.test(lowOutput), false, lowOutput);

  const high = await loadBenchWithDurations(env, [8_500_000n, 11_500_000n]);
  const highOutput = await capture(() => high.default('high', () => {}, { maxRunTimeSec: 0.1 }));
  deepStrictEqual(/±/.test(highOutput), true, highOutput);
});

should('bench formats byte throughput and custom throughput rates', async () => {
  const env = {
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  };
  const bytes = await loadBenchWithDurations(env, [10_000_000n]);
  const bytesOutput = await capture(() =>
    bytes.default('hash', () => {}, { bytes: 1024 * 1024, maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(/hash x 100 mib\/sec/.test(bytesOutput), true, bytesOutput);

  const custom = await loadBenchWithDurations(env, [10_000_000n]);
  const customOutput = await capture(() =>
    custom.default('cipher', () => {}, {
      throughput: { amount: 10, unit: 'blocks' },
      maxRunTimeSec: 0.1,
    })
  );
  deepStrictEqual(/cipher x 1000 blocks\/sec/.test(customOutput), true, customOutput);

  await rejects(
    () => custom.default('legacy', () => {}, { unit: 'mb', multiplier: 1 } as any),
    /unit\/multiplier options were removed/
  );
});

should('bench filters labels with JSBT_FILTER', async () => {
  const bench = await loadBench({
    CLICOLOR_FORCE: undefined,
    FORCE_COLOR: undefined,
    JSBT_FILTER: 'hash',
    NO_COLOR: '1',
  });
  let calls = 0;
  bench.utils.setMaxRunTime(0.1);
  try {
    const skipped = await capture(() =>
      bench.default('cipher', () => {
        calls++;
      })
    );
    deepStrictEqual(skipped, '');
    deepStrictEqual(calls, 0);

    const matched = await capture(() =>
      bench.default('hash', () => {
        calls++;
      })
    );
    deepStrictEqual(/hash x \d+ ops\/sec/.test(matched), true, matched);
    deepStrictEqual(calls > 0, true);
  } finally {
    bench.utils.setMaxRunTime(1);
  }
});

should.runWhen(import.meta.url);
