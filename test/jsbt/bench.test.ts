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
  withEnv(
    {
      CLICOLOR_FORCE: undefined,
      FORCE_COLOR: undefined,
      JSBT_CSV: undefined,
      JSBT_FILTER: undefined,
      NO_COLOR: undefined,
      ...env,
    },
    () => import(`../../src/bench.ts?color=${benchImportId++}`)
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

should('bench uses text output when colors are enabled', async () => {
  const forced = await loadBench({
    FORCE_COLOR: '1',
  });
  const forcedOutput = await capture(() => forced.default('noop', () => {}, { mode: 'runOnce' }));
  deepStrictEqual(/\x1b\[34m/.test(forcedOutput), true, forcedOutput);
  deepStrictEqual(/\x1b\[31m/.test(forced.utils.calcStats([1n, 2n]).formatted), true);
  forced.utils.setMaxRunTime(0.1);
  const forcedRate = await capture(() => forced.default('noop', () => {}));
  deepStrictEqual(/x \x1b\[32m[\d,]*,[\d,]*\x1b\[0m ops\/sec/.test(forcedRate), true, forcedRate);
});

should('bench section prints text heading and can be disabled', async () => {
  const bench = await loadBenchWithDurations({ FORCE_COLOR: '1' }, [10_000_000n]);
  deepStrictEqual('section' in bench.default, false);
  const output = await capture(async () => {
    bench.section('math');
    await bench.default('sqrt', () => {}, { mode: 'runOnce' });
    bench.section();
    await bench.default('plain', () => {}, { mode: 'runOnce' });
  });
  deepStrictEqual(/^# math\nsqrt /.test(output), true, output);
  deepStrictEqual(/math; sqrt/.test(output), false, output);
  deepStrictEqual(/\nplain /.test(output), true, output);
});

should('bench defaults to CSV output when color is disabled', async () => {
  const noColor = await loadBenchWithDurations(
    {
      NO_COLOR: '1',
    },
    [10_000_000n]
  );
  const noColorOutput = await capture(() =>
    noColor.default('a,b', () => {}, { maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(noColorOutput, 'name,nanoseconds\n"a,b",10000000\n');
  deepStrictEqual(/\x1b\[/.test(noColorOutput), false, noColorOutput);
  deepStrictEqual(/\x1b\[/.test(noColor.utils.calcStats([1n, 2n]).formatted), false);

  const runOnce = await loadBenchWithDurations(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: '1',
    },
    [1234n]
  );
  const runOnceOutput = await capture(() => runOnce.default('once', () => {}, { mode: 'runOnce' }));
  deepStrictEqual(runOnceOutput, 'name,nanoseconds\nonce,1234\n');
});

should('bench defaults max runtime to 0.4 seconds', async () => {
  const bench = await loadBenchWithDurations({ NO_COLOR: '1' }, [100_000_000n]);
  let calls = 0;
  const output = await capture(() =>
    bench.default('default runtime', () => {
      calls++;
    })
  );
  deepStrictEqual(calls, 4);
  deepStrictEqual(output, 'name,nanoseconds\ndefault runtime,100000000\n');
});

should('bench section prefixes CSV name cells and can be disabled', async () => {
  const bench = await loadBenchWithDurations({ NO_COLOR: '1' }, [10_000_000n]);
  const output = await capture(async () => {
    bench.section('math');
    await bench.default('sqrt', () => {}, { maxRunTimeSec: 0.1 });
    await bench.default('hash', () => {}, { bytes: 1024 * 1024, maxRunTimeSec: 0.1 });
    bench.section('');
    await bench.default('plain', () => {}, { maxRunTimeSec: 0.1 });
  });
  deepStrictEqual(
    output,
    [
      'name,nanoseconds',
      'math; sqrt,10000000',
      'name,mib/sec',
      'math; hash,100',
      'name,nanoseconds',
      'plain,10000000',
      '',
    ].join('\n')
  );
});

should('bench uses CSV when JSBT_CSV is set', async () => {
  const csv = await loadBenchWithDurations(
    {
      FORCE_COLOR: '1',
      JSBT_CSV: '1',
    },
    [10_000_000n]
  );
  const output = await capture(() => csv.default('quote "x"', () => {}, { maxRunTimeSec: 0.1 }));
  deepStrictEqual(output, 'name,nanoseconds\n"quote ""x""",10000000\n');
  deepStrictEqual(/\x1b\[/.test(output), false, output);
});

should('bench respects NO_COLOR in stats helpers', async () => {
  const noColor = await loadBench({
    NO_COLOR: '1',
  });
  deepStrictEqual(/\x1b\[/.test(noColor.utils.calcStats([1n, 2n]).formatted), false);
});

should('bench only displays variability at 5 percent or higher', async () => {
  const env = {
    FORCE_COLOR: '1',
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
    NO_COLOR: '1',
  };
  const bytes = await loadBenchWithDurations(env, [10_000_000n]);
  const bytesOutput = await capture(() =>
    bytes.default('hash', () => {}, { bytes: 1024 * 1024, maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(bytesOutput, 'name,mib/sec\nhash,100\n');

  const custom = await loadBenchWithDurations(env, [10_000_000n]);
  const customOutput = await capture(() =>
    custom.default('cipher', () => {}, {
      throughput: { amount: 10, unit: 'blocks' },
      maxRunTimeSec: 0.1,
    })
  );
  deepStrictEqual(customOutput, 'name,blocks/sec\ncipher,1000\n');

  await rejects(
    () => custom.default('legacy', () => {}, { unit: 'mb', multiplier: 1 } as any),
    /unit\/multiplier options were removed/
  );
});

should('bench filters labels with JSBT_FILTER', async () => {
  const bench = await loadBench({
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
    deepStrictEqual(/^name,nanoseconds\nhash,\d+\n$/.test(matched), true, matched);
    deepStrictEqual(calls > 0, true);
  } finally {
    bench.utils.setMaxRunTime(1);
  }
});

should.runWhen(import.meta.url);
