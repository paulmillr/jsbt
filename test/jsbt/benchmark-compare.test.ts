import { deepStrictEqual, rejects } from 'node:assert';
import { isBenchmarkMeasuring, setMaxRunTime } from '../../src/benchmark.ts';
import compare from '../../src/benchmark-compare.ts';
import { should } from '../../src/test.ts';

const capture = async (fn: () => Promise<void> | void) => {
  const prevLog = console.log;
  const lines: string[] = [];
  try {
    console.log = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));
    await fn();
    return lines;
  } finally {
    console.log = prevLog;
  }
};

const benchmarkEnv = [
  'FILTER',
  'JSBT_ORDER',
  'JSBT_BENCHMARK_DRY_RUN',
  'JSBT_CSV',
  'JSBT_LIVE',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
];

const withBenchmarkEnv = async (
  values: Record<string, string>,
  fn: () => Promise<string[]> | string[]
) => {
  // JSBT_LIVE=0: live terminal rewrites bypass console.log and would escape capture()
  const next = { NO_COLOR: '1', JSBT_LIVE: '0', ...values };
  const envNames = [...new Set([...benchmarkEnv, ...Object.keys(next)])];
  const prev = new Map(envNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of envNames) delete process.env[name];
    for (const [name, value] of Object.entries(next)) process.env[name] = value;
    return await fn();
  } finally {
    for (const [name, value] of prev) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

should('bench-compare defaults to CSV output', async () => {
  const data = new Uint8Array(1024 * 1024);
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'CSV Bench',
        { js: () => {} },
        {
          inputs: { size: { 'a,b': data } },
          dryRun: true,
          bytes: ({ args }) => args[0].byteLength,
        }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,mib/sec,nanoseconds,rme', '"a,b",js,0,0,0.00']);
});

should('bench-compare ignores removed benchmark env options', async () => {
  const optsWithRemovedPrevFile = {
    inputs: { size: { one: 1 } },
    dryRun: true,
    ['json' + 'Only']: true,
    ['prev' + 'File']: '/tmp/jsbt-bench-compare-missing-prev-file.json',
  };
  const lines = await withBenchmarkEnv(
    Object.fromEntries(
      ['JSON', 'DIFF', 'UPDATE', 'UNCHANGED'].map((suffix) => [`JSBT_BENCHMARK_${suffix}`, '1'])
    ),
    () => capture(() => compare('Removed Env Bench', { js: () => {} }, optsWithRemovedPrevFile))
  );

  deepStrictEqual(lines, ['size,name,nanoseconds,rme', 'one,js,0,0.00']);
});

should('bench-compare treats empty dimensions env as unset', async () => {
  const lines = await withBenchmarkEnv({ JSBT_ORDER: '' }, () =>
    capture(() =>
      compare(
        'Empty Dimensions Bench',
        { js: () => {} },
        { inputs: { size: { one: 1 } }, dryRun: true }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,nanoseconds,rme', 'one,js,0,0.00']);
});

should('bench-compare CSV reports raw nanoseconds', async () => {
  setMaxRunTime(0.1);
  try {
    const lines = await withBenchmarkEnv({}, () =>
      capture(() => compare('Nano Bench', { js: () => {} }, { inputs: { size: { one: 1 } } }))
    );
    const row = lines[1].split(',');
    deepStrictEqual(lines[0], 'size,name,nanoseconds,rme');
    deepStrictEqual(/^\d+$/.test(row[2]), true);
    deepStrictEqual(Number(row[2]) > 0, true);
  } finally {
    setMaxRunTime(1);
  }
});

should('bench-compare defaults to row output when colors are enabled', async () => {
  const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
    capture(() =>
      compare('Table Bench', { js: () => {} }, { inputs: { size: { one: 1 } }, dryRun: true })
    )
  );

  const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
  // title line carries case count and env hints, test.ts-style
  deepStrictEqual(
    plain[0],
    "Table Bench — 1 case (FILTER='', JSBT_ORDER='', JSBT_BENCHMARK_DRY_RUN=1)"
  );
  deepStrictEqual(plain.includes('  size  one'), true);
  deepStrictEqual(plain.includes('  name  js'), true);
  // old scaffolding is gone
  deepStrictEqual(
    plain.some((line) => /benchmark plan|varies|against fastest|from benchmark cases/.test(line)),
    false
  );
  deepStrictEqual(
    lines.some((line) => line.includes('│')),
    false
  );
  // selected dims are size x name: size becomes the group header, name the row label
  deepStrictEqual(plain.includes('# size=one'), true);
  deepStrictEqual(plain.at(-1), 'js'); // dryRun: label only, no metrics
  deepStrictEqual(
    lines.some((line) => line.includes('/op')),
    false
  );
});

should('bench-compare prints group headers and per-case rows', async () => {
  setMaxRunTime(0.1);
  try {
    const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
      capture(() =>
        compare(
          'Row Bench',
          { alpha: () => {}, b: () => {} },
          { inputs: { size: { '16': 16, '32': 32 } } }
        )
      )
    );
    const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
    deepStrictEqual(plain.filter((line) => line === '# size=16').length, 1);
    deepStrictEqual(plain.filter((line) => line === '# size=32').length, 1);
    deepStrictEqual(plain[plain.indexOf('# size=32') - 1], ''); // blank line between groups
    // rows print sorted: the fastest first with no diff, the rest tied or slower
    const duration = String.raw`[\d.]+ (?:ns|μs|ms|s|min)`;
    const bare = new RegExp(`^(alpha {2}|b {6})[\\d,.]+ ops/sec · ${duration}/op$`);
    const withDiff = new RegExp(
      `^(alpha {2}|b {6})[\\d,.]+ ops/sec · ${duration}/op · (≈|-[\\d.]+x)$`
    );
    deepStrictEqual(plain.filter((line) => bare.test(line)).length, 2);
    deepStrictEqual(plain.filter((line) => withDiff.test(line)).length, 2);
    for (const header of ['# size=16', '# size=32']) {
      deepStrictEqual(bare.test(plain[plain.indexOf(header) + 1]), true);
      deepStrictEqual(withDiff.test(plain[plain.indexOf(header) + 2]), true);
    }
  } finally {
    setMaxRunTime(1);
  }
});

should('bench-compare warms every case before timing', async () => {
  setMaxRunTime(0.1);
  // Warmup calls run outside the measured window, so isBenchmarkMeasuring()
  // classifies each call deterministically — no wall-clock counting.
  const calls = {
    a: { measured: 0, warmup: 0, warmedFirst: false },
    b: { measured: 0, warmup: 0, warmedFirst: false },
  };
  const track = (name: keyof typeof calls) => {
    const c = calls[name];
    if (!isBenchmarkMeasuring()) c.warmup++;
    else {
      if (c.measured === 0) c.warmedFirst = c.warmup > 0;
      c.measured++;
    }
  };
  try {
    await withBenchmarkEnv({}, () =>
      capture(() => compare('Warmup Bench', { a: () => track('a'), b: () => track('b') }))
    );
  } finally {
    setMaxRunTime(1);
  }
  for (const [name, c] of Object.entries(calls)) {
    deepStrictEqual(c.warmedFirst, true, `${name}: ${JSON.stringify(c)}`);
    deepStrictEqual(c.measured >= 1, true, `${name}: ${JSON.stringify(c)}`);
  }
});

should('bench-compare focus highlights the first declared label by default', async () => {
  setMaxRunTime(0.1);
  try {
    const run = (opts: object = {}) =>
      withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
        capture(() =>
          compare(
            'Focus Bench',
            { alpha: () => {}, b: () => {} },
            { inputs: { size: { one: 1 } }, ...opts }
          )
        )
      );
    const lines = await run();
    deepStrictEqual(
      lines.some((line) => line.includes(`${'\x1b[36m'}alpha${'\x1b[0m'}`)),
      true
    );
    deepStrictEqual(
      lines.some((line) => line.includes(`${'\x1b[36m'}b${'\x1b[0m'}`)),
      false
    );
    const off = await run({ focus: false });
    deepStrictEqual(
      off.some((line) => line.includes(`${'\x1b[36m'}alpha${'\x1b[0m'}`)),
      false
    );
  } finally {
    setMaxRunTime(1);
  }
});

should('bench-compare highlights active filter and dimensions in table summary', async () => {
  const lines = await withBenchmarkEnv(
    { FORCE_COLOR: '1', FILTER: 'one', JSBT_ORDER: 'name' },
    () =>
      capture(() =>
        compare(
          'Filtered Table Bench',
          { js: () => {} },
          { inputs: { size: { one: 1 } }, dryRun: true }
        )
      )
  );

  const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
  // active env values surface in the title-line hints
  deepStrictEqual(
    plain[0],
    "Filtered Table Bench — 1 case (FILTER='one', JSBT_ORDER='name', JSBT_BENCHMARK_DRY_RUN=1)"
  );
  // explicitly ordered dim name is blue and listed first
  deepStrictEqual(
    lines.some((line) => line.includes(`${'\x1b[36m'}name${'\x1b[0m'}  js`)),
    true
  );
  deepStrictEqual(plain.indexOf('  name  js') < plain.indexOf('  size  one'), true);
  // filter-matched value is blue
  deepStrictEqual(
    lines.some(
      (line) =>
        line.replace(/\x1b\[\d+(;\d+)*m/g, '').includes('size') &&
        line.includes(`${'\x1b[36m'}one${'\x1b[0m'}`)
    ),
    true
  );
});

should('bench-compare header shows fixed dimensions only when set', async () => {
  const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
    capture(() =>
      compare(
        'Fixed Bench',
        { a: () => {}, b: () => {} },
        { inputs: { size: { one: 1, two: 2 } }, defaults: { size: 'one' }, dryRun: true }
      )
    )
  );
  const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
  deepStrictEqual(
    plain[0],
    "Fixed Bench — 2 cases (FILTER='', JSBT_ORDER='', JSBT_BENCHMARK_DRY_RUN=1)"
  );
  deepStrictEqual(plain.includes('  fixed  size=one'), true);
  // the fixed dimension's value list is not repeated
  deepStrictEqual(
    plain.some((line) => line.includes('one, two')),
    false
  );
});

should('bench-compare uses CSV when JSBT_CSV is set', async () => {
  const lines = await withBenchmarkEnv({ FORCE_COLOR: '1', JSBT_CSV: '1' }, () =>
    capture(() =>
      compare('Env CSV Bench', { js: () => {} }, { inputs: { size: { one: 1 } }, dryRun: true })
    )
  );

  deepStrictEqual(lines, ['size,name,nanoseconds,rme', 'one,js,0,0.00']);
});

should('bench-compare crossValidate accepts matching results, runs each case once', async () => {
  const calls = { a: 0, b: 0 };
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Validated Bench',
        {
          a: (n: number) => {
            calls.a++;
            return new Uint8Array(n);
          },
          b: async (n: number) => {
            calls.b++;
            return new Uint8Array(n);
          },
        },
        { inputs: { size: { '16': 16, '32': 32 } }, dryRun: true, crossValidate: ['name'] }
      )
    )
  );
  // one validation run per case; results differ across size but only name is compared
  deepStrictEqual(calls, { a: 2, b: 2 });
  deepStrictEqual(lines, [
    'size,name,nanoseconds,rme',
    '16,a,0,0.00',
    '16,b,0,0.00',
    '32,a,0,0.00',
    '32,b,0,0.00',
  ]);
});

should('bench-compare crossValidate rejects mismatched results', async () => {
  await rejects(
    () =>
      withBenchmarkEnv({}, () =>
        capture(() =>
          compare(
            'Mismatch Bench',
            { a: () => new Uint8Array([1]), b: () => new Uint8Array([2]) },
            { inputs: { size: { one: 1 } }, dryRun: true, crossValidate: ['name'] }
          )
        )
      ),
    /results differ: size=one-name=a vs size=one-name=b/
  );
});

should('bench-compare crossValidate rejects input mutation', async () => {
  await rejects(
    () =>
      withBenchmarkEnv({}, () =>
        capture(() =>
          compare(
            'Mutation Bench',
            {
              js: (data: Uint8Array) => {
                data[0] ^= 0xff;
                return data.length;
              },
            },
            {
              inputs: { data: { buf: new Uint8Array([1, 2, 3]) } },
              dryRun: true,
              crossValidate: ['name'],
            }
          )
        )
      ),
    /mutates its Uint8Array input: data=buf-name=js/
  );
});

should('bench-compare crossValidate rejects unknown dimensions', async () => {
  await rejects(
    () =>
      withBenchmarkEnv({}, () =>
        capture(() =>
          compare(
            'Unknown Dim Bench',
            { js: () => {} },
            { inputs: { size: { one: 1 } }, dryRun: true, crossValidate: ['nope'] }
          )
        )
      ),
    /Unknown dimension: nope/
  );
});

should('bench-compare terminates when defaults fix every dimension', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Single Case Bench',
        { js: () => {} },
        {
          inputs: { size: { one: 1 } },
          dryRun: true,
          defaults: { size: 'one', name: 'js' },
        }
      )
    )
  );
  deepStrictEqual(lines, ['nanoseconds,rme', '0,0.00']);
});

should('bench-compare mode time prints formatted mean duration', async () => {
  setMaxRunTime(0.1);
  try {
    const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
      capture(() =>
        compare(
          'Time Bench',
          { a: () => {}, b: () => {} },
          {
            inputs: { size: { one: 1 } },
            bytes: 1024 * 1024,
            mode: ({ obj }) => (obj.size === 'one' ? 'time' : 'normal'),
          }
        )
      )
    );
    const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
    // bytes is set, but time mode displays duration instead of mib/sec
    const rows = plain.filter((line) =>
      /^[ab]  [\d.]+ (?:ns|μs|ms|s|min)( · (≈|-[\d.]+x))?$/.test(line)
    );
    deepStrictEqual(rows.length, 2);
    deepStrictEqual(
      lines.some((line) => /(?:ns|μs|ms|min)\x1b\[0m/.test(line)),
      false,
      'duration unit must be outside the highlight'
    );
  } finally {
    setMaxRunTime(1);
  }
});

should('bench-compare mode latency prints p50, p95, and p100', async () => {
  setMaxRunTime(0.1);
  try {
    const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
      capture(() =>
        compare(
          'Latency Bench',
          { a: () => {}, b: () => {} },
          {
            inputs: { size: { one: 1 } },
            bytes: 1024 * 1024,
            mode: 'latency',
          }
        )
      )
    );
    const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
    const rows = plain.filter((line) =>
      /^[ab]  p50 [\d.]+ (?:ns|μs|ms|s|min) · p95 [\d.]+ (?:ns|μs|ms|s|min) · p100 [\d.]+ (?:ns|μs|ms|s|min)( · (≈|-[\d.]+x))?$/.test(
        line
      )
    );
    deepStrictEqual(rows.length, 2, plain.join('|'));
    deepStrictEqual(
      rows.every((line) => !/mib\/sec|ops\/sec/.test(line)),
      true
    );
  } finally {
    setMaxRunTime(1);
  }
});

should('bench-compare accepts Uint8Array bytes', async () => {
  const data = new Uint8Array(1024 * 1024);
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'U8A Bytes Bench',
        { js: () => {} },
        { inputs: { size: { '1mb': data } }, dryRun: true, bytes: data }
      )
    )
  );
  deepStrictEqual(lines, ['size,name,mib/sec,nanoseconds,rme', '1mb,js,0,0,0.00']);
});

should('bench-compare sizes shorthand generates buffers, bytes and mode', async () => {
  setMaxRunTime(0.1);
  const lens = new Set<number>();
  try {
    const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
      capture(() =>
        compare(
          'Sizes Bench',
          {
            a: (data: Uint8Array) => lens.add(data.byteLength),
            b: (data: Uint8Array) => data.byteLength,
          },
          { sizes: ['32B', '1KB'] }
        )
      )
    );
    // cases receive the deterministic buffers as first arg
    deepStrictEqual(lens, new Set([32, 1024]));
    const plain = lines.map((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, ''));
    deepStrictEqual(plain.includes('# size=32B'), true);
    deepStrictEqual(plain.includes('# size=1KB'), true);
    // auto mode: below 1KB rows print duration, from 1KB on mib/sec
    const small = plain.slice(plain.indexOf('# size=32B') + 1, plain.indexOf('# size=32B') + 3);
    deepStrictEqual(
      small.every((line) => /^[ab]  [\d.]+ (?:ns|μs|ms|s|min)( · (≈|-[\d.]+x))?$/.test(line)),
      true,
      small.join('|')
    );
    const large = plain.slice(plain.indexOf('# size=1KB') + 1, plain.indexOf('# size=1KB') + 3);
    deepStrictEqual(
      large.every((line) => /^[ab]  [\d,.]+ mib\/sec( · (≈|-[\d.]+x))?$/.test(line)),
      true,
      large.join('|')
    );
  } finally {
    setMaxRunTime(1);
  }
});

should('bench-compare sizes shorthand fills the CSV mib/sec column', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() => compare('Sizes CSV Bench', { js: () => {} }, { sizes: ['32B'], dryRun: true }))
  );
  deepStrictEqual(lines, ['size,name,mib/sec,nanoseconds,rme', '32B,js,0,0,0.00']);
});

should('bench-compare rejects unparseable size labels', async () => {
  await rejects(
    () =>
      withBenchmarkEnv({}, () =>
        capture(() => compare('Bad Sizes Bench', { js: () => {} }, { sizes: ['32 bytes'] }))
      ),
    /cannot parse size label: 32 bytes/
  );
});

should('bench-compare dimension arrays label values by String(value)', async () => {
  const seen: unknown[] = [];
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Array Dim Bench',
        { js: (r: number) => seen.push(r) },
        { inputs: { r: [8, 4] }, dryRun: true, crossValidate: [] }
      )
    )
  );
  // crossValidate: [] runs each case once, proving args carry the raw values
  deepStrictEqual(seen, [8, 4]);
  deepStrictEqual(lines, ['r,name,nanoseconds,rme', '8,js,0,0.00', '4,js,0,0.00']);
});

should('bench-compare order controls dimension precedence', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Order Bench',
        { js: () => {} },
        { inputs: { size: { one: 1 } }, order: ['name'], dryRun: true }
      )
    )
  );
  deepStrictEqual(lines, ['name,size,nanoseconds,rme', 'js,one,0,0.00']);
});

should.runWhen(import.meta.url);
