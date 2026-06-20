import { deepStrictEqual } from 'node:assert';
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
  'JSBT_BENCHMARK_FILTER',
  'JSBT_BENCHMARK_DIMENSIONS',
  'JSBT_BENCHMARK_DRY_RUN',
  'JSBT_BENCHMARK_TABLE',
  'JSBT_BENCHMARK_COMPACT',
];

const withBenchmarkEnv = async (
  values: Record<string, string>,
  fn: () => Promise<string[]> | string[]
) => {
  const envNames = [...new Set([...benchmarkEnv, ...Object.keys(values)])];
  const prev = new Map(envNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of envNames) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return await fn();
  } finally {
    for (const [name, value] of prev) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

should('bench-compare defaults to CSV output', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'CSV Bench',
        {
          size: { 'a,b': 1 },
        },
        { js: () => {} },
        {
          dryRun: true,
          metrics: {
            'MiB/s': {
              diff: true,
              compute: () => 12.5,
            },
          },
        }
      )
    )
  );

  deepStrictEqual(lines, ['size,name,MiB/s,Ops/sec,Per op', '"a,b",js,12.5,0,0ns/op']);
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

  deepStrictEqual(lines, ['size,name,Ops/sec,Per op', 'one,js,0,0ns/op']);
});

should('bench-compare keeps table output when requested', async () => {
  const lines = await withBenchmarkEnv({}, () =>
    capture(() =>
      compare(
        'Table Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        { dryRun: true, format: 'table' }
      )
    )
  );

  deepStrictEqual(lines[0], 'Table Bench');
  deepStrictEqual(
    lines.some((line) => line.includes('│')),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.includes('Variability')),
    false
  );
  deepStrictEqual(
    lines.some((line) => line.includes('Diff %')),
    true
  );
});

should('bench-compare reads JSBT_BENCHMARK_TABLE env', async () => {
  const lines = await withBenchmarkEnv({ JSBT_BENCHMARK_TABLE: '1' }, () =>
    capture(() =>
      compare(
        'Env Table Bench',
        {
          size: { one: 1 },
        },
        { js: () => {} },
        { dryRun: true }
      )
    )
  );

  deepStrictEqual(lines[0], 'Env Table Bench');
  deepStrictEqual(
    lines.some((line) => line.includes('│')),
    true
  );
  deepStrictEqual(
    lines.some((line) => line.includes('Variability')),
    false
  );
});

should.runWhen(import.meta.url);
