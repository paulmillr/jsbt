import { deepStrictEqual } from 'node:assert';
import { utils } from '../../src/bench.ts';
import compare from '../../src/bench-compare.ts';
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
  'JSBT_FILTER',
  'JSBT_BENCHMARK_DIMENSIONS',
  'JSBT_BENCHMARK_DRY_RUN',
  'JSBT_CSV',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
];

const withBenchmarkEnv = async (
  values: Record<string, string>,
  fn: () => Promise<string[]> | string[]
) => {
  const next = { NO_COLOR: '1', ...values };
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
        {
          size: { 'a,b': data },
        },
        { js: () => {} },
        {
          dryRun: true,
          bytes: ({ args }) => args[0].byteLength,
        }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,mib/sec,nanoseconds', '"a,b",js,0,0']);
});

should('bench-compare supports context metrics and normalizes legacy MiB labels', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Metric Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        {
          dryRun: true,
          iterations: ({ args }) => args[0] + 1,
          metrics: [
            {
              name: 'score',
              unit: 'MiB/s',
              diff: true,
              compute: ({ args, iterations }) => args[0] + iterations,
            },
          ],
        }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,score mib/sec,nanoseconds', 'one,js,3,0']);
});

should('bench-compare supports custom throughput rates', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Throughput Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        {
          dryRun: true,
          throughput: { amount: ({ args }) => args[0] * 2, unit: 'blocks' },
        }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,blocks/sec,nanoseconds', 'one,js,0,0']);
});

should('bench-compare ignores removed benchmark env options', async () => {
  const optsWithRemovedPrevFile = {
    dryRun: true,
    ['json' + 'Only']: true,
    ['prev' + 'File']: '/tmp/jsbt-bench-compare-missing-prev-file.json',
  };
  const lines = await withBenchmarkEnv(
    Object.fromEntries(
      ['JSON', 'DIFF', 'UPDATE', 'UNCHANGED'].map((suffix) => [`JSBT_BENCHMARK_${suffix}`, '1'])
    ),
    () =>
      capture(() =>
        compare(
          'Removed Env Bench',
          {
            size: { one: 1 },
          },
          { js: () => {} },
          optsWithRemovedPrevFile
        )
      )
  );

  deepStrictEqual(lines, ['size,name,nanoseconds', 'one,js,0']);
});

should('bench-compare treats empty dimensions env as unset', async () => {
  const lines = await withBenchmarkEnv({ JSBT_BENCHMARK_DIMENSIONS: '' }, () =>
    capture(() =>
      compare(
        'Empty Dimensions Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        { dryRun: true }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,nanoseconds', 'one,js,0']);
});

should('bench-compare CSV reports raw nanoseconds', async () => {
  utils.setMaxRunTime(0.1);
  try {
    const lines = await withBenchmarkEnv({}, () =>
      capture(() =>
        compare(
          'Nano Bench',
          {
            size: { one: 1 },
          },
          { js: () => {} },
          {}
        )
      )
    );
    const row = lines[1].split(',');
    deepStrictEqual(lines[0], 'size,name,nanoseconds');
    deepStrictEqual(/^\d+$/.test(row[2]), true);
    deepStrictEqual(Number(row[2]) > 0, true);
  } finally {
    utils.setMaxRunTime(1);
  }
});

should('bench-compare iterations repeat one measured operation', async () => {
  utils.setMaxRunTime(0.1);
  let calls = 0;
  try {
    await withBenchmarkEnv({}, () =>
      capture(() =>
        compare(
          'Iterations Bench',
          {
            size: { one: 1 },
          },
          {
            js: () => {
              calls++;
            },
          },
          { iterations: 3 }
        )
      )
    );
  } finally {
    utils.setMaxRunTime(1);
  }

  deepStrictEqual(calls > 0, true);
  deepStrictEqual(calls % 3, 0);
});

should('bench-compare defaults to table output when colors are enabled', async () => {
  const lines = await withBenchmarkEnv({ FORCE_COLOR: '1' }, () =>
    capture(() =>
      compare(
        'Table Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        { dryRun: true }
      )
    )
  );

  deepStrictEqual(lines[0], 'Table Bench');
  deepStrictEqual(
    lines.some((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '') === 'benchmark plan'),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '').includes('varies   size x name')),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '').includes('compare  against first row')),
    true
  );
  const envLine = lines.find((line) => line.includes('JSBT_FILTER'));
  deepStrictEqual(!!envLine, true);
  deepStrictEqual(envLine!.includes('JSBT_BENCHMARK_DIMENSIONS'), true);
  deepStrictEqual(envLine!.includes('JSBT_CSV'), false);
  deepStrictEqual(envLine!.includes('DRY_RUN'), false);
  deepStrictEqual(
    lines.some((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '') === 'dimensions'),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '').includes('name  js (from benchmark cases)')),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.includes('│')),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.includes('Variability')),
    false
  );
  deepStrictEqual(
    lines.some((line) => line.includes('diff %')),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.includes('/op')),
    false
  );
});

should('bench-compare highlights active filter and dimensions in table summary', async () => {
  const lines = await withBenchmarkEnv(
    { FORCE_COLOR: '1', JSBT_FILTER: 'one', JSBT_BENCHMARK_DIMENSIONS: 'name' },
    () =>
      capture(() =>
        compare(
          'Filtered Table Bench',
          {
            size: { one: 1 },
          },
          { js: () => {} },
          { dryRun: true }
        )
      )
  );

  deepStrictEqual(
    lines.some((line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '').trimStart().startsWith('filter')),
    false
  );
  deepStrictEqual(lines.some((line) => line.includes(`${'\x1b[34m'}name${'\x1b[0m'} x size`)), true);
  deepStrictEqual(
    lines.some((line) => line.includes(`${'\x1b[34m'}name${'\x1b[0m'}  js (from benchmark cases)`)),
    true
  );
  deepStrictEqual(
    lines.some(
      (line) =>
        line.replace(/\x1b\[\d+(;\d+)*m/g, '').includes('size') &&
        line.includes(`${'\x1b[34m'}one${'\x1b[0m'}`)
    ),
    true
  );
  deepStrictEqual(lines.some((line) => line.includes(`${'\x1b[34m'}JSBT_FILTER${'\x1b[0m'}`)), true);
  deepStrictEqual(lines.some((line) => line.includes(`${'\x1b[34m'}JSBT_BENCHMARK_DIMENSIONS${'\x1b[0m'}`)), true);
});

should('bench-compare uses CSV when JSBT_CSV is set', async () => {
  const lines = await withBenchmarkEnv({ FORCE_COLOR: '1', JSBT_CSV: '1' }, () =>
    capture(() =>
      compare(
        'Env CSV Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        { dryRun: true }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,nanoseconds', 'one,js,0']);
});

should.runWhen(import.meta.url);
