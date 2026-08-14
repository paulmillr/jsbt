import { deepStrictEqual, rejects, throws } from 'node:assert';
import { should } from '../../src/test.ts';

type BenchModule = typeof import('../../src/benchmark.ts');

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
      FILTER: undefined,
      NO_COLOR: undefined,
      ...env,
    },
    () => import(`../../src/benchmark.ts?color=${benchImportId++}`)
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
const loadBenchWithTickingClock = (
  env: Record<string, string | undefined>
): Promise<BenchModule> => {
  const real = process.hrtime.bigint;
  let now = 0n;
  process.hrtime.bigint = (() => now++) as typeof process.hrtime.bigint;
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
  deepStrictEqual(/\x1b\[31m/.test(forced.calcStats(Float64Array.of(1, 2)).formatted), true);
  forced.setMaxRunTime(0.1);
  const forcedRate = await capture(() => forced.default('noop', () => {}));
  deepStrictEqual(/x \x1b\[32m[\d,]*,[\d,]*\x1b\[0m ops\/sec/.test(forcedRate), true, forcedRate);
});

should('bench accepts positional mode: bench(title, mode, fn)', async () => {
  const bench = await loadBenchWithDurations({ FORCE_COLOR: '1' }, [10_000_000n]);
  const once = await capture(() => bench.default('single', 'once', () => {}));
  deepStrictEqual(bench.stripAnsi(once), 'single 10 ms\n');
  deepStrictEqual(once, 'single \x1b[34m10\x1b[0m ms\n');
  const timed = await capture(() => bench.default('timed', 'time', () => {}));
  deepStrictEqual(bench.stripAnsi(timed), 'timed 10 ms\n');
  // 'once' also works through opts; 'runOnce' stays as a compat alias elsewhere
  const viaOpts = await capture(() => bench.default('legacy', () => {}, { mode: 'once' }));
  deepStrictEqual(bench.stripAnsi(viaOpts), 'legacy 10 ms\n');
  await rejects(
    () => bench.default('bad', 'fast' as any, () => {}),
    /benchmark mode must be one of/
  );
});

should('bench formats durations consistently with three significant digits', async () => {
  const bench = await loadBench({ NO_COLOR: '1' });
  const durations = [
    153n,
    9_870n,
    10_400n,
    103_000n,
    1_350_000n,
    15_200_000n,
    152_000_000n,
    1_520_000_000n,
    15_200_000_000n,
  ];
  deepStrictEqual(durations.map(bench.formatDuration), [
    '153 ns',
    '9870 ns',
    '10.4 μs',
    '103 μs',
    '1.35 ms',
    '15.2 ms',
    '152 ms',
    '1.52 s',
    '15.2 s',
  ]);
  deepStrictEqual(bench.formatDuration(6_912n), '6912 ns');
  deepStrictEqual(bench.formatDuration(9_999n), '9999 ns');
  deepStrictEqual(bench.formatDuration(10_000n), '10 μs');
  deepStrictEqual(bench.formatDuration(999_500n), '1 ms');
  deepStrictEqual(bench.formatDuration(999_500_000n), '1 s');
});

should('bench rounds displayed throughput to four significant digits', async () => {
  const bench = await loadBenchWithDurations({ FORCE_COLOR: '1' }, [4_932n]);
  const result = await bench.benchmarkRaw(() => {}, 4_932n);
  deepStrictEqual(result.perSec, 202_757n, 'underlying throughput remains exact');
  deepStrictEqual(result.perSecStr, '202,800');
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
  const plain = bench.stripAnsi(output);
  deepStrictEqual(/^# math\nsqrt /.test(plain), true, plain);
  deepStrictEqual(/math; sqrt/.test(plain), false, plain);
  deepStrictEqual(/\nplain /.test(plain), true, plain);
});

should('bench section owns spacing and heading levels in text mode', async () => {
  const bench = await loadBenchWithDurations({ FORCE_COLOR: '1' }, [10_000_000n]);
  const output = await capture(async () => {
    bench.section('alpha');
    await bench.default('one', () => {}, { mode: 'runOnce' });
    bench.subsection('beta');
    await bench.default('two', () => {}, { mode: 'runOnce' });
    bench.section('gamma');
    await bench.default('three', () => {}, { mode: 'runOnce' });
  });
  // first section: no leading blank; new section: blank line; subsection: tight
  deepStrictEqual(
    bench.stripAnsi(output),
    '# alpha\none 10 ms\n## beta\ntwo 10 ms\n\n# gamma\nthree 10 ms\n'
  );
});

should('bench section opts become bench defaults and csv labels stack', async () => {
  const bench = await loadBenchWithDurations({ NO_COLOR: '1' }, [10_000_000n]);
  const output = await capture(async () => {
    bench.section('sized', { bytes: 1024 * 1024 });
    await bench.default('hash', () => {}, { maxRunTimeSec: 0.1 });
    // per-bench throughput replaces the section's bytes instead of erroring
    await bench.default('blocks', () => {}, {
      throughput: { amount: 10, unit: 'blocks' },
      maxRunTimeSec: 0.1,
    });
    bench.subsection('inner');
    await bench.default('deep', () => {}, { maxRunTimeSec: 0.1 });
    bench.section('next');
    await bench.default('top', () => {}, { maxRunTimeSec: 0.1 });
  });
  deepStrictEqual(
    output,
    [
      'name,mib/sec,rme',
      'sized; hash,100,0.00',
      'name,blocks/sec,rme',
      'sized; blocks,1000,0.00',
      'name,mib/sec,rme',
      'sized; inner; deep,100,0.00',
      'name,nanoseconds,rme',
      'next; top,10000000,0.00',
      '',
    ].join('\n')
  );
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
  deepStrictEqual(noColorOutput, 'name,nanoseconds,rme\n"a,b",10000000,0.00\n');
  deepStrictEqual(/\x1b\[/.test(noColorOutput), false, noColorOutput);
  deepStrictEqual(/\x1b\[/.test(noColor.calcStats(Float64Array.of(1, 2)).formatted), false);

  const runOnce = await loadBenchWithDurations(
    {
      FORCE_COLOR: undefined,
      NO_COLOR: '1',
    },
    [1234n]
  );
  const runOnceOutput = await capture(() => runOnce.default('once', () => {}, { mode: 'runOnce' }));
  deepStrictEqual(runOnceOutput, 'name,nanoseconds,rme\nonce,1234,0.00\n');
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
  deepStrictEqual(output, 'name,nanoseconds,rme\ndefault runtime,100000000,0.00\n');
});

should('bench warms for one quarter of measurement time', async () => {
  const bench = await loadBenchWithTickingClock({ NO_COLOR: '1' });
  let calls = 0;
  const result = await bench.benchmarkRun(() => {
    calls++;
  }, 8n);
  deepStrictEqual(result.iterations, 8);
  deepStrictEqual(result.elapsed, 8n);
  deepStrictEqual(calls, 9, 'one warmup call plus eight measured calls');
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
      'name,nanoseconds,rme',
      'math; sqrt,10000000,0.00',
      'name,mib/sec,rme',
      'math; hash,100,0.00',
      'name,nanoseconds,rme',
      'plain,10000000,0.00',
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
  deepStrictEqual(output, 'name,nanoseconds,rme\n"quote ""x""",10000000,0.00\n');
  deepStrictEqual(/\x1b\[/.test(output), false, output);
});

should('bench respects NO_COLOR in stats helpers', async () => {
  const noColor = await loadBench({
    NO_COLOR: '1',
  });
  deepStrictEqual(/\x1b\[/.test(noColor.calcStats(Float64Array.of(1, 2)).formatted), false);
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
  deepStrictEqual(bytesOutput, 'name,mib/sec,rme\nhash,100,0.00\n');

  const custom = await loadBenchWithDurations(env, [10_000_000n]);
  const customOutput = await capture(() =>
    custom.default('cipher', () => {}, {
      throughput: { amount: 10, unit: 'blocks' },
      maxRunTimeSec: 0.1,
    })
  );
  deepStrictEqual(customOutput, 'name,blocks/sec,rme\ncipher,1000,0.00\n');

  await rejects(
    () => custom.default('legacy', () => {}, { unit: 'mb', multiplier: 1 } as any),
    /unit\/multiplier options were removed/
  );
});

should('bench pseudoRandomBytes and buf are deterministic', async () => {
  const bench = await loadBench({ NO_COLOR: '1' });
  const differs = (x: Uint8Array, y: Uint8Array) =>
    x.length !== y.length || x.some((value, i) => value !== y[i]);
  const a = bench.pseudoRandomBytes(64, 1);
  deepStrictEqual(a, bench.pseudoRandomBytes(64, 1));
  deepStrictEqual(a.length, 64);
  deepStrictEqual(differs(a, bench.pseudoRandomBytes(64, 2)), true);
  deepStrictEqual(new Set(a).size > 16, true, 'content should not be constant');
  deepStrictEqual(bench.pseudoRandomBytes(0).length, 0);
  // seed 0 is a valid mulberry32 seed, not a degenerate all-zero stream
  deepStrictEqual(new Set(bench.pseudoRandomBytes(64, 0)).size > 16, true);
  throws(() => bench.pseudoRandomBytes(-1), /non-negative safe integer/);
  throws(() => bench.pseudoRandomBytes(1.5), /non-negative safe integer/);
  throws(() => bench.pseudoRandomBytes(1, 0.5), /seed must be a safe integer/);

  deepStrictEqual(bench.buf(32), bench.pseudoRandomBytes(32, 32));
  deepStrictEqual(differs(bench.buf(32), bench.buf(33).subarray(0, 32)), true);
});

should('bench calcStats computes nearest-rank p95', async () => {
  const bench = await loadBench({ NO_COLOR: '1' });
  const list = Float64Array.from({ length: 20 }, (_, i) => 20 - i); // unsorted 20..1
  const stats = bench.calcStats(list);
  deepStrictEqual(stats.min, 1n);
  deepStrictEqual(stats.max, 20n);
  deepStrictEqual(stats.p50, 11n);
  deepStrictEqual(stats.p95, 20n);
  deepStrictEqual(bench.calcStats(Float64Array.of(3, 1)).p95, 3n);
  deepStrictEqual(bench.calcStats(Float64Array.of(7)).p95, 7n);
});

should('bench observeGc counts gc events under allocation churn', async () => {
  const bench = await loadBench({ NO_COLOR: '1' });
  const gc = await bench.observeGc();
  let sink = 0;
  for (let i = 0; i < 100_000; i++) {
    const arr = new Array(256).fill(i);
    sink += arr[0];
  }
  const stats = await gc.stop();
  deepStrictEqual(sink > 0, true, 'keep the allocation loop observable');
  deepStrictEqual(stats === gc.stats, true, 'stop returns the live stats object');
  deepStrictEqual(stats.count > 0, true, 'expected at least one gc event');
  deepStrictEqual(stats.pauseMs >= 0, true);
  deepStrictEqual(
    stats.minor + stats.major + stats.incremental + stats.weakcb <= stats.count,
    true
  );
});

should('bench makeRng and shuffled are deterministic and seed-flexible', async () => {
  const bench = await loadBench({ NO_COLOR: '1' });
  const seq = (seed: number | string, n = 8) => {
    const rng = bench.makeRng(seed);
    return Array.from({ length: n }, () => rng());
  };
  deepStrictEqual(seq(1), seq(1));
  deepStrictEqual(seq(0).length, 8);
  deepStrictEqual(
    seq(0).join() === seq(1).join(),
    false,
    'nearby seeds should produce different streams'
  );
  deepStrictEqual(seq('glare'), seq('glare'));
  deepStrictEqual(seq('glare').join() === seq('blur').join(), false);
  deepStrictEqual(
    seq(42, 1000).every((value) => value >= 0 && value < 1),
    true
  );
  throws(() => bench.makeRng(1.5), /seed must be a safe integer or string/);

  const items = Array.from({ length: 16 }, (_, i) => i);
  const a = bench.shuffled(items, 1);
  deepStrictEqual(a, bench.shuffled(items, 1));
  deepStrictEqual(
    [...a].sort((x, y) => x - y),
    items,
    'must be a permutation'
  );
  deepStrictEqual(
    items,
    Array.from({ length: 16 }, (_, i) => i),
    'must not mutate input'
  );
  deepStrictEqual(a.join() === bench.shuffled(items, 2).join(), false);
  deepStrictEqual(bench.shuffled(items, 'seed'), bench.shuffled(items, 'seed'));

  // pseudoRandomBytes shares the same core: string seeds work there too
  deepStrictEqual(bench.pseudoRandomBytes(16, 'seed'), bench.pseudoRandomBytes(16, 'seed'));
});

should('bench warmup runs sync and async callbacks until its deadline', async () => {
  const bench = await loadBenchWithDurations({ NO_COLOR: '1' }, [10_000_000n]);
  let calls = 0;
  await bench.warmup(() => {
    calls++;
  }, 0.1);
  deepStrictEqual(calls > 0, true);
  let asyncCalls = 0;
  await bench.warmup(async () => {
    asyncCalls++;
  }, 0.1);
  deepStrictEqual(asyncCalls > 0, true);
  await rejects(() => bench.warmup(() => {}, 0.01), /between 0.1 and 60/);
  await rejects(() => bench.warmup(undefined as any), /callback must be a function/);
});

should('bench accepts Uint8Array for bytes', async () => {
  const bench = await loadBenchWithDurations({ NO_COLOR: '1' }, [10_000_000n]);
  const output = await capture(() =>
    bench.default('hash', () => {}, { bytes: new Uint8Array(1024 * 1024), maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(output, 'name,mib/sec,rme\nhash,100,0.00\n');
});

should('bench mode time prints formatted mean duration per op', async () => {
  const bench = await loadBenchWithDurations({ FORCE_COLOR: '1' }, [10_000_000n]);
  const output = await capture(() =>
    bench.default('sha512', () => {}, { mode: 'time', maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(bench.stripAnsi(output), 'sha512 10 ms\n');
  // CSV ignores the display mode and keeps the uniform nanoseconds schema
  const csv = await loadBenchWithDurations({ NO_COLOR: '1' }, [10_000_000n]);
  const csvOutput = await capture(() =>
    csv.default('sha512', () => {}, { mode: 'time', bytes: 32, maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(csvOutput, 'name,nanoseconds,rme\nsha512,10000000,0.00\n');
});

should('bench uses aggregate mean for time and throughput', async () => {
  const raw = await loadBenchWithDurations({ NO_COLOR: '1' }, [1_000_000n, 3_000_000n]);
  const result = await raw.benchmarkRaw(() => {}, 100_000_000n);
  deepStrictEqual(result.stats.mean, 2_000_000n);
  deepStrictEqual(result.stats.p50, 3_000_000n, 'prove aggregate mean differs from median');
  deepStrictEqual(result.perSec, 500n);
  deepStrictEqual(result.perItemStr, '2 ms');

  const fractional = await loadBenchWithDurations({ NO_COLOR: '1' }, [1n, 2n]);
  const exactRate = await fractional.benchmarkRaw(() => {}, 3n);
  deepStrictEqual(exactRate.stats.mean, 2n, 'displayed integer mean rounds 1.5ns');
  deepStrictEqual(exactRate.perSec, 666_666_666n, 'throughput uses exact 2 calls / 3ns');

  const bytes = await loadBenchWithDurations({ NO_COLOR: '1' }, [1_000_000n, 3_000_000n]);
  const bytesOutput = await capture(() =>
    bytes.default('hash', () => {}, { bytes: 1024 * 1024, maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(bytesOutput, 'name,mib/sec,rme\nhash,500,14.00\n');

  const custom = await loadBenchWithDurations({ NO_COLOR: '1' }, [1_000_000n, 3_000_000n]);
  const customOutput = await capture(() =>
    custom.default('blocks', () => {}, {
      throughput: { amount: 10, unit: 'blocks' },
      maxRunTimeSec: 0.1,
    })
  );
  deepStrictEqual(customOutput, 'name,blocks/sec,rme\nblocks,5000,14.00\n');
});

should('bench mode latency prints p50, p95, and p100', async () => {
  const durations = Array.from({ length: 20 }, (_, i) => BigInt((i + 1) * 100_000));
  const bench = await loadBenchWithDurations({ FORCE_COLOR: '1' }, durations);
  const output = await capture(() =>
    bench.default('decode', 'latency', () => {}, { maxRunTimeSec: 0.1 })
  );
  deepStrictEqual(bench.stripAnsi(output), 'decode p50 1.1 ms · p95 2 ms · p100 2 ms\n');
});

should('bench filters labels with FILTER', async () => {
  const bench = await loadBench({
    FILTER: 'hash',
    NO_COLOR: '1',
  });
  let calls = 0;
  bench.setMaxRunTime(0.1);
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
    deepStrictEqual(/^name,nanoseconds,rme\nhash,\d+,[\d.]+\n$/.test(matched), true, matched);
    deepStrictEqual(calls > 0, true);
  } finally {
    bench.setMaxRunTime(1);
  }
});

should.runWhen(import.meta.url);
