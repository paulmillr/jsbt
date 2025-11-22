import compare from '../src/bench-compare.ts';

(async () => {
  const SIZES: Record<string, Uint8Array[]> = {};
  for (const [name, sz] of [
    ['32B', 32],
    ['1KB', 1024],
    //    ['8KB', 1024 * 8],
    ['1MB', 1024 * 1024],
  ] as [string, number][]) {
    for (const chunks of [2, 4, 8, 16, 32, 128, 512, 1024, 10 * 1024]) {
      if (chunks * sz > 100 * 1024 * 1024) continue;
      const res: Uint8Array[] = [];
      for (let i = 0; i < chunks; i++) {
        res.push(new Uint8Array(sz).fill(i));
      }
      SIZES[`${name}/${chunks}`] = res;
    }
  }
  const ALGOS = {
    add: {
      js: {
        unix: (...args: []) => {
          //  console.log('ARGS', args);
        },
        mac: () => {},
      },
      wasm: {
        unix: () => {},
        mac: () => {},
      },
    },
    multiply: {
      js: {
        unix: () => {},
        mac: () => {},
      },
      wasm: {
        unix: () => {},
        mac: () => {},
      },
    },
  };
  const KB = 1024;
  const MB = 1024 * KB;
  await compare(
    'Test',
    {
      chunkSize: [2, 4, 8, 16, 32, 128, 512, 1024, 10 * 1024],
      buffer: {
        '32B': new Uint8Array(32),
        '1KB': new Uint8Array(KB),
        '8KB': new Uint8Array(8 * KB),
        '1MB': new Uint8Array(1 * MB),
      },
    }, //
    ALGOS,
    {
      libDims: ['algorithm', 'platform', 'library'],
      defaults: {},
      samples: 10_000,
      metrics: {
        Speed: {
          unit: 'MiB/s', // For header/value suffix
          rev: true, // Bigger = better (green +%, red -%)
          width: 14, // Optional; auto-fallback if omitted
          diff: true,
          compute: (_obj, stats, perSec, chunkSize, buffer) => {
            const MiB = 1024 * 1024;
            const bytesPerOp = chunkSize * buffer.byteLength;
            if (stats.mean === 0n) return 0; // Edge: infinite speed
            const speed = (bytesPerOp * 1e9) / (Number(stats.mean) * MiB); // MiB/s
            return speed > 1024 ? +speed.toFixed(0) : +speed.toFixed(2);
          },
        },
      },
      //prevFile: 'bench.json',
    }
  );
})();
