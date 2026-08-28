import { deepStrictEqual, ok, throws } from 'node:assert';
import * as random from '../src/random.ts';
import { describe, it, should } from '../src/test.ts';

const SEED = 12345;

describe('random', () => {
  describe('generators', () => {
    it('int stays in bounds and is deterministic per seed', () => {
      const values: number[] = [];
      random.assert(
        random.property(random.int({ min: -5, max: 17 }), (n) => {
          values.push(n);
          return Number.isSafeInteger(n) && n >= -5 && n <= 17;
        }),
        { seed: SEED }
      );
      const replay: number[] = [];
      random.assert(
        random.property(random.int({ min: -5, max: 17 }), (n) => {
          replay.push(n);
          return true;
        }),
        { seed: SEED }
      );
      deepStrictEqual(values, replay);
    });

    it('int hits range boundaries via edge bias', () => {
      const seen = new Set<number>();
      random.assert(
        random.property(random.int({ min: 0, max: 1_000_000 }), (n) => {
          seen.add(n);
          return true;
        }),
        { seed: SEED, numRuns: 200 }
      );
      ok(seen.has(0), 'min boundary generated');
      ok(seen.has(1_000_000), 'max boundary generated');
    });

    it('bigint supports positional and options signatures', () => {
      for (const arb of [random.bigint(1n, 1n << 64n), random.bigint({ min: 1n, max: 1n << 64n })]) {
        random.assert(
          random.property(arb, (n) => typeof n === 'bigint' && n >= 1n && n <= 1n << 64n),
          { seed: SEED }
        );
      }
    });

    it('bigint hits boundaries via edge bias', () => {
      const seen = new Set<bigint>();
      random.assert(
        random.property(random.bigint(1n, 1n << 128n), (n) => {
          seen.add(n);
          return true;
        }),
        { seed: SEED, numRuns: 200 }
      );
      ok(seen.has(1n), 'min boundary generated');
      ok(seen.has(1n << 128n), 'max boundary generated');
    });

    it('bytes produces Uint8Array within length bounds', () => {
      random.assert(
        random.property(random.bytes({ minLength: 3, maxLength: 32 }), (b) => {
          return b instanceof Uint8Array && b.length >= 3 && b.length <= 32;
        }),
        { seed: SEED }
      );
    });

    it('string respects length and custom unit', () => {
      const hexa = random.int({ min: 0, max: 15 }).map((n) => '0123456789abcdef'[n]);
      random.assert(
        random.property(random.string({ unit: hexa, minLength: 1, maxLength: 8 }), (s) => {
          return /^[0-9a-f]{1,8}$/.test(s);
        }),
        { seed: SEED }
      );
    });

    it('array and tuple compose', () => {
      random.assert(
        random.property(
          random.array(random.tuple(random.int({ min: 0, max: 9 }), random.bigint(0n, 9n)), {
            minLength: 2,
            maxLength: 2,
          }),
          (pairs) => {
            return (
              pairs.length === 2 &&
              pairs.every(([a, b]) => typeof a === 'number' && typeof b === 'bigint')
            );
          }
        ),
        { seed: SEED }
      );
    });

    it('exposes fast-check-compatible aliases', () => {
      deepStrictEqual(random.integer, random.int);
      deepStrictEqual(random.bigInt, random.bigint);
      deepStrictEqual(random.uint8Array, random.bytes);
      deepStrictEqual(random.configureGlobal, random.config);
      random.assert(
        random.property(
          random.uint8Array(),
          random.bigInt(1n, 100n),
          random.integer({ min: 0, max: 9 }),
          (b, n, i) => b instanceof Uint8Array && typeof n === 'bigint' && typeof i === 'number'
        ),
        { seed: SEED }
      );
    });

    it('map and filter transform generated values', () => {
      const evens = random.int({ min: 0, max: 1000 }).filter((n) => n % 2 === 0);
      const doubled = random.int({ min: 0, max: 1000 }).map((n) => n * 2);
      random.assert(random.property(evens, (n) => n % 2 === 0), { seed: SEED });
      random.assert(random.property(doubled, (n) => n % 2 === 0 && n <= 2000), { seed: SEED });
    });
  });

  describe('runner', () => {
    it('shrinks a failing int to the minimal counterexample', () => {
      let message = '';
      try {
        random.assert(
          random.property(random.int({ min: 0, max: 100000 }), (n) => n < 42),
          { seed: SEED }
        );
      } catch (e) {
        message = (e as Error).message;
      }
      ok(message.includes('Counterexample: [42]'), `shrunk to 42: ${message}`);
      ok(message.includes('seed: "0x3039"'), `reports seed as hex: ${message}`);
    });

    it('shrinks arrays toward minimal length', () => {
      let message = '';
      try {
        random.assert(
          random.property(random.array(random.int({ min: 0, max: 9 })), (a) => a.length < 3),
          { seed: SEED }
        );
      } catch (e) {
        message = (e as Error).message;
      }
      ok(message.includes('Counterexample: [[0, 0, 0]]'), `minimal 3-element array: ${message}`);
    });

    it('replays a failure from seed and path', () => {
      let seed = '';
      let path = 0;
      try {
        random.assert(random.property(random.bigint(0n, 1n << 64n), (n) => n < 1000n), {
          seed: SEED,
        });
        throw new Error('unreachable');
      } catch (e) {
        const m = (e as Error).message.match(/seed: "(0x[0-9a-f]+)", path: (\d+)/)!;
        seed = m[1];
        path = Number(m[2]);
      }
      throws(
        () =>
          random.assert(random.property(random.bigint(0n, 1n << 64n), (n) => n < 1000n), {
            seed,
            path,
          }),
        /Property failed after 1 runs/
      );
    });

    it('reports thrown errors as the failure cause', () => {
      throws(
        () =>
          random.assert(
            random.property(random.int(), () => {
              throw new Error('boom-inside');
            }),
            { seed: SEED }
          ),
        /boom-inside/
      );
    });

    it('rejects promise-returning predicates in sync properties', () => {
      throws(
        () =>
          random.assert(
            random.property(random.int(), (async () => true) as unknown as () => boolean),
            { seed: SEED }
          ),
        /use asyncProperty/
      );
    });

    it('supports asyncProperty', async () => {
      let runs = 0;
      await random.assert(
        random.asyncProperty(random.bytes({ maxLength: 8 }), async (b) => {
          runs++;
          return b.length <= 8;
        }),
        { seed: SEED, numRuns: 25 }
      );
      deepStrictEqual(runs, 25);
    });

    it('async failures shrink and report like sync ones', async () => {
      let message = '';
      try {
        await random.assert(
          random.asyncProperty(random.int({ min: 0, max: 100000 }), async (n) => n < 42),
          { seed: SEED }
        );
      } catch (e) {
        message = (e as Error).message;
      }
      ok(message.includes('Counterexample: [42]'), `shrunk to 42: ${message}`);
    });

    it('config sets global numRuns', () => {
      const prev = random.config();
      let runs = 0;
      random.config({ numRuns: 7 });
      try {
        random.assert(
          random.property(random.int(), () => {
            runs++;
            return true;
          }),
          { seed: SEED }
        );
      } finally {
        random.config({ numRuns: prev.numRuns, seed: prev.seed });
      }
      deepStrictEqual(runs, 7);
    });

    it('filter throws when predicate is too strict', () => {
      throws(
        () =>
          random.assert(random.property(random.int().filter(() => false), () => true), {
            seed: SEED,
          }),
        /filter predicate rejected/
      );
    });
  });
});

should.runWhen(import.meta.url);
