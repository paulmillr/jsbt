/*! jsbt - MIT License (c) 2019 Paul Miller (paulmillr.com) */
/**
 * Micro property-based testing: seeded generators with edge-case bias,
 * counterexample shrinking and replayable failures.
 *
 * ```js
 * import * as random from '@paulmillr/jsbt/random.js';
 * random.assert(random.property(random.bigint(1n, 65537n), (a) => mod(a * inv(a)) === 1n));
 * ```
 *
 * On failure, throws with a minimal counterexample and `{ seed, path }`;
 * replay with `random.assert(prop, { seed, path })`.
 * @module
 */

// ---------------------------------------------------------------- PRNG

/** Deterministic PRNG (sfc32, 128-bit state, 64-bit seed) plus range helpers. */
export interface Rng {
  /** Uniform 32-bit unsigned integer. */
  u32(): number;
  /** Uniform integer in [min, max], inclusive. Range must fit in 2^53. */
  int(min: number, max: number): number;
  /** Uniform bigint in [0, span). */
  big(span: bigint): bigint;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: T[]): T;
}

const MASK64 = (1n << 64n) - 1n;

// splitmix64: hashes a 64-bit counter into decorrelated 64-bit words.
function splitmix64(state: bigint): () => bigint {
  let s = state & MASK64;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK64;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  };
}

function createRng(seed: bigint): Rng {
  const mix = splitmix64(seed);
  const w0 = mix();
  const w1 = mix();
  let a = Number(w0 >> 32n) >>> 0;
  let b = Number(w0 & 0xffffffffn) >>> 0;
  let c = Number(w1 >> 32n) >>> 0;
  let d = Number(w1 & 0xffffffffn) >>> 0;
  const u32 = (): number => {
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = (b ^ (b >>> 9)) >>> 0;
    b = (c + (c << 3)) >>> 0;
    c = (((c << 21) | (c >>> 11)) + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 12; i++) u32(); // sfc32 warm-up: escape low-entropy states
  const int = (min: number, max: number): number => {
    const span = max - min + 1;
    const r = u32() * 0x200000 + (u32() >>> 11); // 53 uniform bits
    return min + (r % span);
  };
  const big = (span: bigint): bigint => {
    let bits = 0;
    for (let s = span - 1n; s > 0n; s >>= 1n) bits++;
    const mask = (1n << BigInt(bits)) - 1n;
    for (;;) {
      let v = 0n;
      for (let got = 0; got < bits; got += 32) v = (v << 32n) | BigInt(u32());
      v &= mask;
      if (v < span) return v;
    }
  };
  return {
    u32,
    int,
    big,
    chance: (p) => u32() / 0x100000000 < p,
    pick: (items) => items[int(0, items.length - 1)],
  };
}

// ---------------------------------------------------------- shrink trees

/** A generated value with its lazy tree of simpler candidates, simplest-first. */
export interface Shrinkable<T> {
  value: T;
  shrink(): Shrinkable<T>[];
}

function leaf<T>(value: T): Shrinkable<T> {
  return { value, shrink: () => [] };
}

function towardNum(value: number, target: number): Shrinkable<number>[] {
  const out: Shrinkable<number>[] = [];
  for (let d = value - target; d !== 0; d = Math.trunc(d / 2)) {
    const c = value - d;
    out.push({ value: c, shrink: () => towardNum(c, target) });
  }
  return out;
}

function towardBig(value: bigint, target: bigint): Shrinkable<bigint>[] {
  const out: Shrinkable<bigint>[] = [];
  for (let d = value - target; d !== 0n; d /= 2n) {
    const c = value - d;
    out.push({ value: c, shrink: () => towardBig(c, target) });
  }
  return out;
}

function arrayNode<T>(items: Shrinkable<T>[], minLength: number): Shrinkable<T[]> {
  return {
    value: items.map((i) => i.value),
    shrink: () => {
      const out: Shrinkable<T[]>[] = [];
      const n = items.length;
      if (n > minLength) {
        out.push(arrayNode(items.slice(0, minLength), minLength)); // minimal prefix
        const half = Math.max(minLength, Math.floor(n / 2));
        if (half < n && half > minLength) out.push(arrayNode(items.slice(0, half), minLength));
        for (let i = 0; i < n && out.length < 16; i++)
          out.push(arrayNode(items.slice(0, i).concat(items.slice(i + 1)), minLength));
      }
      for (let i = 0; i < n; i++) {
        for (const s of items[i].shrink().slice(0, 3)) {
          const copy = items.slice();
          copy[i] = s;
          out.push(arrayNode(copy, minLength));
        }
      }
      return out;
    },
  };
}

function mapNode<T, U>(node: Shrinkable<T>, fn: (value: T) => U): Shrinkable<U> {
  return { value: fn(node.value), shrink: () => node.shrink().map((c) => mapNode(c, fn)) };
}

// ------------------------------------------------------------ arbitraries

/** Composable generator of random values with shrinking support. */
export class Arbitrary<T> {
  /** Generate one value; when biased, edge cases (bounds, zero, …) are favored. */
  sample: (rng: Rng, biased: boolean) => Shrinkable<T>;
  constructor(sample: (rng: Rng, biased: boolean) => Shrinkable<T>) {
    this.sample = sample;
  }
  /** Transform generated values; shrinking happens in the source domain. */
  map<U>(fn: (value: T) => U): Arbitrary<U> {
    return new Arbitrary((rng, biased) => mapNode(this.sample(rng, biased), fn));
  }
  /** Keep only values matching the predicate. Throws if <1% of values match. */
  filter(predicate: (value: T) => boolean): Arbitrary<T> {
    return new Arbitrary((rng, biased) => {
      for (let i = 0; i < 100; i++) {
        const node = this.sample(rng, biased);
        if (predicate(node.value)) return filterNode(node, predicate);
      }
      throw new Error('random: filter predicate rejected 100 samples in a row');
    });
  }
}

function filterNode<T>(node: Shrinkable<T>, predicate: (value: T) => boolean): Shrinkable<T> {
  return {
    value: node.value,
    shrink: () =>
      node
        .shrink()
        .filter((c) => predicate(c.value))
        .map((c) => filterNode(c, predicate)),
  };
}

/** Constraints for {@link int}. */
export interface IntOptions {
  min?: number;
  max?: number;
}

/** Integer in [min, max]; defaults to signed 32-bit range. Shrinks toward 0. */
export function int(options: IntOptions = {}): Arbitrary<number> {
  const { min = -0x80000000, max = 0x7fffffff } = options;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max)
    throw new Error('random.int: expected safe integers with min <= max');
  const target = min > 0 ? min : max < 0 ? max : 0;
  const edges = [...new Set([target, min, max, min + 1, max - 1])].filter(
    (v) => v >= min && v <= max
  );
  return new Arbitrary((rng, biased) => {
    const v = biased && rng.chance(0.25) ? rng.pick(edges) : rng.int(min, max);
    return { value: v, shrink: () => towardNum(v, target) };
  });
}

/** Constraints for {@link bigint}. */
export interface BigintOptions {
  min?: bigint;
  max?: bigint;
}

/**
 * Bigint in [min, max]; accepts `bigint(min, max)` or `bigint({ min, max })`.
 * Defaults to ±2^256. Shrinks toward 0.
 */
export function bigint(min?: bigint | BigintOptions, max?: bigint): Arbitrary<bigint> {
  let lo: bigint;
  let hi: bigint;
  if (typeof min === 'object') ({ min: lo = -(1n << 256n), max: hi = 1n << 256n } = min);
  else {
    lo = min ?? -(1n << 256n);
    hi = max ?? 1n << 256n;
  }
  if (lo > hi) throw new Error('random.bigint: expected min <= max');
  const target = lo > 0n ? lo : hi < 0n ? hi : 0n;
  const edges = [...new Set([target, lo, hi, lo + 1n, hi - 1n])].filter((v) => v >= lo && v <= hi);
  return new Arbitrary((rng, biased) => {
    const v = biased && rng.chance(0.25) ? rng.pick(edges) : lo + rng.big(hi - lo + 1n);
    return { value: v, shrink: () => towardBig(v, target) };
  });
}

/** Constraints for length-bounded arbitraries. */
export interface LengthOptions {
  minLength?: number;
  maxLength?: number;
}

/** Array of values from `item`; length in [minLength, maxLength], default [0, 10]. */
export function array<T>(item: Arbitrary<T>, options: LengthOptions = {}): Arbitrary<T[]> {
  const { minLength = 0, maxLength = 10 } = options;
  if (minLength < 0 || minLength > maxLength)
    throw new Error('random.array: expected 0 <= minLength <= maxLength');
  return new Arbitrary((rng, biased) => {
    const n =
      biased && rng.chance(0.25) ? rng.pick([minLength, maxLength]) : rng.int(minLength, maxLength);
    let items: Shrinkable<T>[];
    if (biased && rng.chance(0.2)) {
      // constant fill: surfaces all-zero / all-max inputs that uniform sampling never hits
      const one = item.sample(rng, true);
      items = Array.from({ length: n }, () => leaf(one.value));
    } else {
      items = Array.from({ length: n }, () => item.sample(rng, biased));
    }
    return arrayNode(items, minLength);
  });
}

/** Uint8Array with length in [minLength, maxLength], default [0, 64]. */
export function bytes(options: LengthOptions = {}): Arbitrary<Uint8Array> {
  const { minLength = 0, maxLength = 64 } = options;
  return array(int({ min: 0, max: 0xff }), { minLength, maxLength }).map((a) =>
    Uint8Array.from(a)
  );
}

/** Constraints for {@link string}. */
export interface StringOptions extends LengthOptions {
  /** Arbitrary producing one unit (character / substring); default printable ASCII char. */
  unit?: Arbitrary<string>;
}

const asciiChar: Arbitrary<string> = int({ min: 0x20, max: 0x7e }).map((c) =>
  String.fromCharCode(c)
);

/** String of `unit`s; length in [minLength, maxLength] units, default [0, 10]. */
export function string(options: StringOptions = {}): Arbitrary<string> {
  const { unit = asciiChar, minLength, maxLength } = options;
  return array(unit, { minLength, maxLength }).map((units) => units.join(''));
}

/** Maps a value tuple to the matching tuple of arbitraries. */
export type ArbitraryTuple<T extends unknown[]> = { [K in keyof T]: Arbitrary<T[K]> };

/** Fixed-length tuple drawing each position from its own arbitrary. */
export function tuple<T extends unknown[]>(...items: ArbitraryTuple<T>): Arbitrary<T> {
  return new Arbitrary((rng, biased) => {
    const nodes = items.map((a) => a.sample(rng, biased));
    return tupleNode(nodes) as Shrinkable<T>;
  });
}

function tupleNode(nodes: Shrinkable<unknown>[]): Shrinkable<unknown[]> {
  return {
    value: nodes.map((n) => n.value),
    shrink: () => {
      const out: Shrinkable<unknown[]>[] = [];
      for (let i = 0; i < nodes.length; i++) {
        for (const s of nodes[i].shrink()) {
          const copy = nodes.slice();
          copy[i] = s;
          out.push(tupleNode(copy));
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- runner

/** Synchronous property: arbitraries plus a predicate over their values. */
export interface Property<T extends unknown[]> {
  arbitraries: Arbitrary<unknown>[];
  predicate: (...values: T) => boolean | void;
  isAsync: false;
}

/** Asynchronous property; run with `await assert(...)`. */
export interface AsyncProperty<T extends unknown[]> {
  arbitraries: Arbitrary<unknown>[];
  predicate: (...values: T) => Promise<boolean | void>;
  isAsync: true;
}

/**
 * Declare "for all values from these arbitraries, the predicate holds".
 * Predicate fails by returning `false` or throwing.
 */
export function property<T extends unknown[]>(
  ...args: [...arbitraries: ArbitraryTuple<T>, predicate: (...values: T) => boolean | void]
): Property<T> {
  const predicate = args[args.length - 1] as (...values: T) => boolean | void;
  const arbitraries = args.slice(0, -1) as unknown as Arbitrary<unknown>[];
  return { arbitraries, predicate, isAsync: false };
}

/** Like {@link property}, for async predicates. */
export function asyncProperty<T extends unknown[]>(
  ...args: [...arbitraries: ArbitraryTuple<T>, predicate: (...values: T) => Promise<boolean | void>]
): AsyncProperty<T> {
  const predicate = args[args.length - 1] as (...values: T) => Promise<boolean | void>;
  const arbitraries = args.slice(0, -1) as unknown as Arbitrary<unknown>[];
  return { arbitraries, predicate, isAsync: true };
}

/** Global and per-assert run configuration. */
export interface Config {
  /** Runs per assert; default 100. */
  numRuns: number;
  /**
   * Fixed 64-bit seed (number, or hex/decimal string) for deterministic runs;
   * default: fresh CSPRNG seed per assert.
   */
  seed?: number | string;
}

const GLOBAL: Config = { numRuns: 100 };

/** Merge options into the global config; returns a snapshot of the result. */
export function config(options: Partial<Config> = {}): Config {
  Object.assign(GLOBAL, options);
  return { ...GLOBAL };
}

/** Options for a single {@link assert} call. */
export interface AssertOptions extends Partial<Config> {
  /** Run index from a failure report; replays only that run. */
  path?: number;
}

// fast-check-compatible aliases, easing migration of `import * as fc` call sites.
/** Alias of {@link int} (fast-check name). */
export const integer: typeof int = int;
/** Alias of {@link bigint} (fast-check name). */
export const bigInt: typeof bigint = bigint;
/** Alias of {@link bytes} (fast-check name). */
export const uint8Array: typeof bytes = bytes;
/** Alias of {@link config} (fast-check name). */
export const configureGlobal: typeof config = config;

// ------------------------------------------------- deterministic helpers

/**
 * Deterministic PRNG: returns floats in [0, 1).
 * Seed with a number or a string (labels are hashed internally): `makeRng('glare')`.
 * Use separate rngs with separate seeds for independent purposes.
 */
export function makeRng(seed: number | string = 0): () => number {
  const rng = createRng(normalizeSeed(seed));
  return () => rng.u32() / 0x100000000;
}

/** Deterministic Fisher–Yates shuffle; returns a new array. */
export function shuffled<T>(items: readonly T[], seed: number | string): T[] {
  const rng = makeRng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deterministic pseudo-random bytes over the same PRNG as makeRng.
 * Constant or sequential data can bias benchmarks: AES table & cache access patterns,
 * branch prediction, memcmp fast paths. Same seed always produces the same bytes,
 * keeping runs comparable across libraries and versions.
 */
export function pseudoRandomBytes(length: number, seed: number | string = 0x9e3779b9): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error('pseudoRandomBytes length must be a non-negative safe integer');
  const rng = createRng(normalizeSeed(seed));
  const out = new Uint8Array(length);
  let x = 0;
  for (let i = 0; i < length; i++) {
    if ((i & 3) === 0) x = rng.u32();
    out[i] = x & 0xff;
    x >>>= 8;
  }
  return out;
}

const SHRINK_EVALS_MAX = 1000;

interface Outcome {
  ok: boolean;
  error?: unknown;
}

function show(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array)
    return `bytes(${value.length}) 0x${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function failure(
  values: unknown[],
  seed: bigint,
  path: number,
  runs: number,
  shrinks: number,
  error: unknown
): Error {
  const cause = error instanceof Error ? error.message : String(error);
  const err = new Error(
    `Property failed after ${runs} runs and ${shrinks} shrinks ` +
      `{ seed: "0x${seed.toString(16)}", path: ${path} }\n` +
      `Counterexample: [${values.map(show).join(', ')}]\n` +
      (error === undefined ? 'Predicate returned false' : cause)
  );
  if (error !== undefined) err.cause = error;
  return err;
}

// FNV-1a, for deriving numeric seeds from label strings.
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Numbers must be safe integers; strings parse as hex/decimal ("0x1f", "123"),
// anything else is treated as a label and hashed.
function normalizeSeed(seed: number | string): bigint {
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer or string');
    return BigInt.asUintN(64, BigInt(seed));
  }
  try {
    return BigInt.asUintN(64, BigInt(seed));
  } catch {
    return BigInt(hashString(seed));
  }
}

function randomSeed(): bigint {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint32Array): Uint32Array } }).crypto;
  if (c !== undefined) {
    const w = c.getRandomValues(new Uint32Array(2));
    return (BigInt(w[0]) << 32n) | BigInt(w[1]);
  }
  return normalizeSeed(Date.now() ^ ((Math.random() * 0x100000000) | 0));
}

function runSeed(seed: bigint, runIndex: number): Rng {
  return createRng(seed ^ ((BigInt(runIndex + 1) * 0xd1342543de82ef95n) & MASK64));
}

function sampleRun(arbitraries: Arbitrary<unknown>[], rng: Rng, biased: boolean) {
  return tupleNode(arbitraries.map((a) => a.sample(rng, biased)));
}

/**
 * Run a property `numRuns` times with fresh random inputs; on failure, shrink
 * to a minimal counterexample and throw with a replayable `{ seed, path }`.
 * Returns a promise for async properties.
 */
export function assert<T extends unknown[]>(
  prop: AsyncProperty<T>,
  options?: AssertOptions
): Promise<void>;
export function assert<T extends unknown[]>(prop: Property<T>, options?: AssertOptions): void;
export function assert(
  prop: Property<unknown[]> | AsyncProperty<unknown[]>,
  options: AssertOptions = {}
): void | Promise<void> {
  const numRuns = options.numRuns ?? GLOBAL.numRuns;
  const seedInput = options.seed ?? GLOBAL.seed;
  const seed = seedInput === undefined ? randomSeed() : normalizeSeed(seedInput);
  const first = options.path ?? 0;
  const last = options.path ?? numRuns - 1;

  if (prop.isAsync) {
    const check = async (values: unknown[]): Promise<Outcome> => {
      try {
        return { ok: (await prop.predicate(...values)) !== false };
      } catch (error) {
        return { ok: false, error };
      }
    };
    return (async () => {
      for (let run = first; run <= last; run++) {
        const node = sampleRun(prop.arbitraries, runSeed(seed, run), run % 4 === 0);
        const out = await check(node.value);
        if (out.ok) continue;
        let cur = node;
        let lastError = out.error;
        let shrinks = 0;
        let evals = 0;
        shrinking: while (evals < SHRINK_EVALS_MAX) {
          for (const cand of cur.shrink()) {
            if (++evals > SHRINK_EVALS_MAX) break shrinking;
            const res = await check(cand.value);
            if (!res.ok) {
              cur = cand;
              lastError = res.error;
              shrinks++;
              continue shrinking;
            }
          }
          break;
        }
        throw failure(cur.value, seed, run, run - first + 1, shrinks, lastError);
      }
    })();
  }

  const check = (values: unknown[]): Outcome => {
    let res: unknown;
    try {
      res = prop.predicate(...values);
    } catch (error) {
      return { ok: false, error };
    }
    if (res !== null && typeof res === 'object' && 'then' in (res as object))
      throw new Error('random.assert: predicate returned a promise; use asyncProperty');
    return { ok: res !== false };
  };
  for (let run = first; run <= last; run++) {
    const node = sampleRun(prop.arbitraries, runSeed(seed, run), run % 4 === 0);
    const out = check(node.value);
    if (out.ok) continue;
    let cur = node;
    let lastError = out.error;
    let shrinks = 0;
    let evals = 0;
    shrinking: while (evals < SHRINK_EVALS_MAX) {
      for (const cand of cur.shrink()) {
        if (++evals > SHRINK_EVALS_MAX) break shrinking;
        const res = check(cand.value);
        if (!res.ok) {
          cur = cand;
          lastError = res.error;
          shrinks++;
          continue shrinking;
        }
      }
      break;
    }
    throw failure(cur.value, seed, run, run - first + 1, shrinks, lastError);
  }
}
