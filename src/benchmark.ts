/*! jsbt - MIT License (c) 2020 Paul Miller, 2010-2016 Mathias Bynens, John-David Dalton, Robert Kieffer from JSLitmus.js */
/**
 * Benchmark JS projects with nanosecond resolution.
 *
 * - Precise: 1ns resolution using `process.hrtime`
 * - Lightweight: ~200 lines of code, no dependencies - to not interfere with benchmarked code
 * - Readable: utilizes colors and nice units, shows rel. margin of error only if it's high
 *
 * @module
 */
import { pseudoRandomBytes } from './random.ts';
export type BenchStats = {
  stats: {
    rme: number;
    min: bigint;
    max: bigint;
    mean: bigint;
    p50: bigint;
    p95: bigint;
    formatted: string;
  };
  /** Aggregate throughput and time per operation, derived from the mean of every
   * measured call. Percentiles are available separately in stats for latency output. */
  perSecStr: string;
  perSec: bigint;
  perItemStr: string;
  /** All measured callback time and call count, before percentile sample decimation. */
  elapsed: bigint;
  iterations: number;
  /** Sorted sample durations in ns; a view into a shared buffer, valid until the next run. */
  measurements: Float64Array;
};
export type CbFn = (iter?: number) => {};
const maxSamples = 2 ** 26;
const _c = String.fromCharCode(27);
/** ANSI escape codes, shared with benchmark-compare. */
export const ansi: {
  red: string;
  green: string;
  blue: string;
  cyan: string;
  gray: string;
  reset: string;
} = {
  red: _c + '[31m',
  green: _c + '[32m',
  blue: _c + '[34m',
  cyan: _c + '[36m',
  gray: _c + '[2;37m',
  reset: _c + '[0m',
};
const { red, green, blue, cyan, reset } = ansi;
export type Env = Record<string, string | undefined>;
export const isCli: boolean =
  // @ts-ignore
  typeof process !== 'undefined';
export function wantColor(env: Env = {}, tty = false): boolean {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
}
export const envFlag = (value: string | undefined): boolean => !!Number(value);
const colorOn =
  // @ts-ignore
  isCli && wantColor(process.env, !!process.stderr?.isTTY || !!process.stdout?.isTTY);
const csvOn =
  // @ts-ignore
  isCli && (envFlag(process.env?.JSBT_CSV) || !colorOn);
const benchFilter =
  // @ts-ignore
  isCli ? process.env?.FILTER || '' : '';
function paint(text: string, code: string): string {
  return colorOn ? `${code}${text}${reset}` : text;
}
export const stripAnsi = (str: string): string => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
const csvCell = (val: unknown): string => {
  const cell = stripAnsi(String(val ?? ''));
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};
export const printCsvRow = (values: unknown[]): void => printOutput(values.map(csvCell).join(','));
/** Deterministic benchmark buffer; content depends on size, so `buf(32)` differs from `buf(64)`. */
export function buf(size: number): Uint8Array {
  return pseudoRandomBytes(size, size);
}
const units = [
  { symbol: 'min', val: 60n * 10n ** 9n, threshold: 5n },
  { symbol: 's', val: 10n ** 9n, threshold: 1n },
  { symbol: 'ms', val: 10n ** 6n, threshold: 1n },
  { symbol: 'μs', val: 10n ** 3n, threshold: 10n },
  { symbol: 'ns', val: 1n, threshold: 0n },
];
export const SECOND: bigint = units[1].val;
let printedOutput = false;
function printOutput(...str: any) {
  printedOutput = true;
  // @ts-ignore
  console.log(...str);
}
export function logMem(): void {
  const mapping: Record<string, string> = {
    heapTotal: 'heap',
    heapUsed: 'used',
    arrayBuffers: 'arr',
  };
  // @ts-ignore
  const entries: [string, number][] = Object.entries(process.memoryUsage());
  const vals = entries
    .filter(([k, v]) => v > 100000 && k !== 'external')
    .map(([k, v]) => `${mapping[k] || k}=${(v / 1000000).toFixed(1)}mb`);
  printOutput('RAM:', vals.join(' '));
}
export type GcStats = {
  minor: number;
  incremental: number;
  major: number;
  weakcb: number;
  count: number;
  pauseMs: number;
};
/**
 * Observes garbage-collection pauses (node-only). `stats` updates live; `stop()` waits
 * for buffered entries to flush, disconnects, and returns the totals.
 * GC stats are process-global: benchmark one implementation per process.
 */
export async function observeGc(): Promise<{ stats: GcStats; stop: () => Promise<GcStats> }> {
  // @ts-ignore
  const { PerformanceObserver, constants } = await import('node:perf_hooks');
  const kinds: Record<number, 'minor' | 'major' | 'incremental' | 'weakcb'> = {
    [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
    [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
    [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
  };
  const stats: GcStats = { minor: 0, incremental: 0, major: 0, weakcb: 0, count: 0, pauseMs: 0 };
  const observer = new PerformanceObserver((list: any) => {
    for (const entry of list.getEntries()) {
      const kind = kinds[entry.detail?.kind];
      if (kind) stats[kind]++;
      stats.count++;
      stats.pauseMs += entry.duration;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  return {
    stats,
    stop: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // let buffered entries flush
      observer.disconnect();
      return stats;
    },
  };
}
// T-Distribution two-tailed critical values for 95% confidence.
// http://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm
// prettier-ignore
const tTable = {
  '1': 12.706, '2': 4.303, '3': 3.182, '4': 2.776, '5': 2.571, '6': 2.447,
  '7': 2.365, '8': 2.306, '9': 2.262, '10': 2.228, '11': 2.201, '12': 2.179,
  '13': 2.16, '14': 2.145, '15': 2.131, '16': 2.12, '17': 2.11, '18': 2.101,
  '19': 2.093, '20': 2.086, '21': 2.08, '22': 2.074, '23': 2.069, '24': 2.064,
  '25': 2.06, '26': 2.056, '27': 2.052, '28': 2.048, '29': 2.045, '30': 2.042,
  'infinity': 1.96
};
const opsFormat = (opts: Intl.NumberFormatOptions) =>
  Intl.NumberFormat('en-US', { ...opts, useGrouping: colorOn });
const opsSignificant = opsFormat({ maximumSignificantDigits: 4 });
const opsFraction = [0, 1, 2].map((maximumFractionDigits) => opsFormat({ maximumFractionDigits }));
/** Human-readable throughput with at most four significant digits. */
export function formatOps(value: bigint | number): string {
  if (value >= 1000) return opsSignificant.format(value);
  return opsFraction[value < 10 ? 2 : value < 100 ? 1 : 0].format(value);
}
const displayRmeThreshold = 5;
const byteRateUnits = [
  { unit: 'gib', bytes: 1024 ** 3 },
  { unit: 'mib', bytes: 1024 ** 2 },
  { unit: 'kib', bytes: 1024 },
  { unit: 'b', bytes: 1 },
];
// Duration formatter with at most three significant digits. Rounds instead of
// truncating and carries across unit boundaries (999,500 ns is 1 ms, not 1,000 μs).
function durationValue(duration: any, unit: (typeof units)[number]) {
  const whole = duration / unit.val;
  const decimals = whole < 10n ? 2 : whole < 100n ? 1 : 0;
  const scale = 10n ** BigInt(decimals);
  const rounded = (duration * scale + unit.val / 2n) / unit.val;
  const integer = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return { rounded, scale, text: `${integer}${fraction ? `.${fraction}` : ''} ${unit.symbol}` };
}
export function formatDuration(duration: any): string {
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const { threshold, val } = unit;
    if (duration >= val * threshold) {
      const formatted = durationValue(duration, unit);
      // Rounding can carry into the next unit.
      const prev = units[i - 1];
      if (prev && prev.threshold === 1n && formatted.rounded * val >= prev.val * formatted.scale)
        return durationValue(duration, prev).text;
      return formatted.text;
    }
  }
  throw new Error('Invalid duration ' + duration);
}
/** Colors the numeric part of a `formatDuration` string, leaving the unit unpainted. */
export function paintFormattedDuration(
  formatted: string,
  code: string,
  painter: (text: string, code: string) => string = paint
): string {
  const separator = formatted.lastIndexOf(' ');
  return painter(formatted.slice(0, separator), code) + formatted.slice(separator);
}
function unpaintDurationUnit(formatted: string, code: string): string {
  if (!colorOn) return formatted;
  const separator = formatted.lastIndexOf(' ');
  return formatted.slice(0, separator) + reset + formatted.slice(separator) + code;
}
function criticalValue(df: number): number {
  // @ts-ignore
  return tTable[Math.round(df) || 1] || tTable.infinity;
}
// Stats over integer-ns durations. Every sample is one call's duration (far below 2^53),
// so doubles are exact. Mutates list by sorting it.
export function calcStats(list: Float64Array): BenchStats['stats'] {
  list.sort();
  const samples = list.length;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += list[i];
  const meanNum = sum / samples;
  // nearest-rank percentiles; p50 is the upper-median for even sample counts
  const pick = (q: number) => BigInt(list[Math.min(samples - 1, Math.floor(samples * q))]);
  const p50 = pick(0.5);
  const p95 = pick(0.95);
  const min = BigInt(list[0]);
  const max = BigInt(list[samples - 1]);
  const mean = BigInt(Math.round(meanNum));
  let varSum = 0;
  for (let i = 0; i < samples; i++) varSum += (list[i] - meanNum) ** 2;
  const deviation = samples < 2 ? 0 : Math.sqrt(varSum / (samples - 1));
  const sem = deviation / Math.sqrt(samples);
  const moe = sem * criticalValue(samples - 1);
  const rme = (moe / meanNum) * 100 || 0;
  const formatted = paint(
    `± ${rme.toFixed(2)}% (${unpaintDurationUnit(
      formatDuration(min),
      red
    )}..${unpaintDurationUnit(formatDuration(max), red)})`,
    red
  );
  return { rme, min, max, mean, p50, p95, formatted };
}
// @ts-ignore
export const getTime: () => bigint = process.hrtime.bigint;
const DEFAULT_MAX_RUN_TIME = (4n * SECOND) / 10n;
let defaultMaxRunTime = DEFAULT_MAX_RUN_TIME;
// Samples live in one module-global Float64Array, allocated on first use and reused by
// every run: per-sample BigInt boxing and array regrowth would otherwise cause GC pauses
// inside the measured window. Access is a streaming write (8 bytes/sample), so buffer
// size adds no cache pressure on the benchmarked code. Once full, decimation halves
// retention and doubles the recording stride, keeping a uniform subsample of the full
// run window instead of cutting the run short.
const SAMPLES_MAX = 2 ** 22;
let sampleBuf = new Float64Array(0);
let benchmarkActive = false;
/**
 * True while `benchmarkRaw` measures the callback; untimed warmup calls observe `false`.
 * Lets a benched function distinguish measured calls from warmup deterministically.
 */
export function isBenchmarkMeasuring(): boolean {
  return benchmarkActive;
}
export async function benchmarkRaw(
  callback: CbFn,
  maxRunTime: bigint = defaultMaxRunTime
): Promise<BenchStats> {
  if (typeof callback !== 'function') throw new Error('callback must be a function');
  // the shared sample buffer makes concurrent runs corrupt, not just meaningless
  if (benchmarkActive) throw new Error('benchmarkRaw is not reentrant: await the previous run');
  benchmarkActive = true;
  try {
    if (sampleBuf.length === 0) sampleBuf = new Float64Array(SAMPLES_MAX);
    const samples = sampleBuf;
    let count = 0; // recorded samples
    let stride = 1; // record every stride-th measurement once decimation kicks in
    let iterations = 0;
    let total = 0n;
    for (let i = 0; i < maxSamples; i++) {
      const start = getTime();
      const val = callback(i);
      if (val instanceof Promise) await val;
      const stop = getTime();
      const diff = stop - start;
      total += diff;
      iterations++;
      if ((i & (stride - 1)) === 0) {
        if (count === SAMPLES_MAX) {
          count >>= 1;
          for (let j = 0; j < count; j++) samples[j] = samples[2 * j];
          stride *= 2;
        }
        samples[count++] = Number(diff);
      }
      if (total >= maxRunTime) break;
    }
    const measurements = samples.subarray(0, count);
    const stats = calcStats(measurements);
    // Unlike retained percentile samples, aggregate mean includes every call even
    // after bounded sample retention starts decimating.
    const sampleCount = BigInt(iterations);
    const mean = (total + sampleCount / 2n) / sampleCount;
    stats.mean = mean;
    const perSec = total === 0n ? 0n : (SECOND * sampleCount) / total;
    const perSecStr = formatOps(perSec);
    const perItemStr = formatDuration(mean);
    return {
      stats,
      perSecStr,
      perSec,
      perItemStr,
      elapsed: total,
      iterations,
      measurements,
    };
  } finally {
    benchmarkActive = false;
  }
}

/** Runs the standard untimed warmup, then measures. Warmup is one quarter of measurement time. */
export async function benchmarkRun(
  callback: CbFn,
  maxRunTime: bigint = defaultMaxRunTime
): Promise<BenchStats> {
  if (maxRunTime > 0n) await warmupRaw(callback, maxRunTime / 4n);
  return benchmarkRaw(callback, maxRunTime);
}

export type BenchOpts = {
  /**
   * Bytes processed by one benchmark iteration; printed as kib/mib/gib per second.
   * A Uint8Array (usually the benchmarked input itself) stands for its byteLength.
   */
  bytes?: number | Uint8Array;
  /** Custom units processed by one benchmark iteration. */
  throughput?: BenchThroughput;
  /** Per-benchmark runtime in seconds. Defaults to 0.4. */
  maxRunTimeSec?: number;
  /** 'once' times one call; 'time' prints aggregate mean duration; 'latency' prints p50/p95/p100. */
  mode?: BenchMode;
};
const BENCH_MODES = ['normal', 'once', 'time', 'latency', 'runOnce'] as const;
/** 'runOnce' is a deprecated alias of 'once'. */
export type BenchMode = (typeof BENCH_MODES)[number];
export type BenchThroughput = {
  amount: number;
  unit: string;
};
type BenchRate = { type: 'bytes'; bytes: number } | { type: 'unit'; amount: number; unit: string };

function parseMaxRunTime(val: number | undefined) {
  if (val === undefined) return;
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0.1 || val > 60)
    throw new Error('must be between 0.1 and 60 sec');
  return (BigInt(Math.round(val * 1000)) * SECOND) / 1000n;
}

/**
 * Runs fn repeatedly for the given wall-clock time, untimed. Call once before benchmarks
 * with a representative hot path, so the JIT compiles it before the first measurement:
 * `await warmup(() => sha256(data))`. Warm several entities with several calls.
 */
export async function warmup(fn: CbFn, maxRunTimeSec: number = 2): Promise<void> {
  if (typeof fn !== 'function') throw new Error('callback must be a function');
  await warmupRaw(fn, parseMaxRunTime(maxRunTimeSec)!);
}

async function warmupRaw(fn: CbFn, maxRunTime: bigint): Promise<void> {
  const deadline = getTime() + maxRunTime;
  for (let i = 0; getTime() < deadline; i++) {
    const val = fn(i);
    if (val instanceof Promise) await val;
  }
}

function parsePositiveNumber(name: string, val: unknown): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0)
    throw new Error(`bench ${name} must be a positive finite number`);
  return val;
}

function parseBenchRate(opts: BenchOpts): BenchRate | undefined {
  const legacy = opts as BenchOpts & { unit?: unknown; multiplier?: unknown };
  if (legacy.unit !== undefined || legacy.multiplier !== undefined)
    throw new Error('bench unit/multiplier options were removed; use bytes or throughput');
  const { throughput } = opts;
  const bytes = opts.bytes instanceof Uint8Array ? opts.bytes.byteLength : opts.bytes;
  if (bytes !== undefined) {
    if (throughput !== undefined) throw new Error('bench bytes cannot be used with throughput');
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error('bench bytes must be a positive safe integer');
    return { type: 'bytes', bytes };
  }
  if (throughput !== undefined) {
    if (!throughput || typeof throughput !== 'object')
      throw new Error('bench throughput must be an object');
    const amount = parsePositiveNumber('throughput amount', throughput.amount);
    if (typeof throughput.unit !== 'string' || !throughput.unit)
      throw new Error('bench throughput unit must be a non-empty string');
    return { type: 'unit', amount, unit: throughput.unit };
  }
  return undefined;
}

/** Float units-per-second over the full run; shared with benchmark-compare. */
export function perSecondNumber(
  result: Pick<BenchStats, 'elapsed' | 'iterations'>,
  amount: number
): number {
  if (result.elapsed === 0n) return 0;
  return (Number(SECOND) * result.iterations * amount) / Number(result.elapsed);
}

function perSecond(result: BenchStats, amount: number): bigint | number {
  if (!Number.isSafeInteger(amount)) return perSecondNumber(result, amount);
  if (result.elapsed === 0n) return 0n;
  return (SECOND * BigInt(result.iterations) * BigInt(amount)) / result.elapsed;
}

export function roundRate(value: number): number {
  return value >= 100 ? Math.round(value) : value >= 10 ? +value.toFixed(1) : +value.toFixed(2);
}

function formatCsvNumber(value: bigint | number): string {
  return typeof value === 'bigint' ? value.toString() : String(roundRate(value));
}

function benchRateValue(
  result: BenchStats,
  rate: BenchRate
): { value: bigint | number; unit: string } {
  if (rate.type === 'unit') return { value: perSecond(result, rate.amount), unit: rate.unit };
  const bytesPerSec = Number(perSecond(result, rate.bytes));
  const { bytes, unit } =
    byteRateUnits.find((item) => bytesPerSec >= item.bytes) ?? byteRateUnits.at(-1)!;
  return { value: bytesPerSec / bytes, unit };
}

let lastCsvHeader = '';
let benchSection = '';
let benchSubsection = '';
let sectionOpts: BenchOpts = {};
let subsectionOpts: BenchOpts = {};

function sectionLabel(label: string): string {
  return [benchSection, benchSubsection, label].filter(Boolean).join('; ');
}

// bytes and throughput are alternatives: an override choosing one replaces the
// other inherited from the base, instead of erroring on the combination.
function mergeOpts(base: BenchOpts, override: BenchOpts): BenchOpts {
  const merged: BenchOpts = { ...base, ...override };
  if (override.bytes !== undefined && override.throughput === undefined) delete merged.throughput;
  if (override.throughput !== undefined && override.bytes === undefined) delete merged.bytes;
  return merged;
}

function parseSectionArgs(title: string, opts: BenchOpts): BenchOpts {
  if (typeof title !== 'string') throw new Error('section title must be a string');
  if (!opts || typeof opts !== 'object') throw new Error('section opts must be an object');
  return opts;
}

function printBenchCsv(label: string, result: BenchStats, rate?: BenchRate) {
  const { stats } = result;
  const metric = rate ? benchRateValue(result, rate) : undefined;
  const header = ['name', metric ? `${metric.unit}/sec` : 'nanoseconds', 'rme'];
  const headerKey = header.join('\0');
  if (headerKey !== lastCsvHeader) {
    printCsvRow(header);
    lastCsvHeader = headerKey;
  }
  printCsvRow([
    sectionLabel(label),
    metric ? formatCsvNumber(metric.value) : stats.mean.toString(),
    stats.rme.toFixed(2),
  ]);
}

/**
 * Groups subsequent bench() calls: prints `# title` (after a blank line, unless it
 * is the first output), prefixes CSV name cells, and applies opts as defaults for
 * every bench() until the next section. `section()` clears the group.
 */
export function section(title: string = '', opts: BenchOpts = {}): void {
  sectionOpts = parseSectionArgs(title, opts);
  subsectionOpts = {};
  benchSection = title;
  benchSubsection = '';
  if (title && !csvOn) {
    if (printedOutput) printOutput('');
    printOutput(paint(`# ${title}`, cyan));
  }
}

/** Nested group inside the current section: prints `## title`, stacks CSV prefixes and opts. */
export function subsection(title: string = '', opts: BenchOpts = {}): void {
  subsectionOpts = parseSectionArgs(title, opts);
  benchSubsection = title;
  if (title && !csvOn) printOutput(paint(`## ${title}`, cyan));
}

export function setMaxRunTime(val: number): void {
  defaultMaxRunTime = parseMaxRunTime(val) ?? DEFAULT_MAX_RUN_TIME;
}

export async function bench(
  label: string,
  fn: CbFn,
  opts?: BenchOpts
): Promise<BenchStats | undefined>;
export async function bench(
  label: string,
  mode: BenchMode,
  fn: CbFn,
  opts?: BenchOpts
): Promise<BenchStats | undefined>;
export async function bench(
  label: string,
  fnOrMode: CbFn | BenchMode,
  fnOrOpts?: CbFn | BenchOpts,
  modeOpts?: BenchOpts
): Promise<BenchStats | undefined> {
  let fn: CbFn;
  let opts: BenchOpts;
  if (typeof fnOrMode === 'string') {
    fn = fnOrOpts as CbFn;
    opts = { ...modeOpts, mode: fnOrMode };
  } else {
    fn = fnOrMode;
    opts = (fnOrOpts as BenchOpts) ?? {};
  }
  if (typeof label !== 'string') throw new Error('benchmark label must be a string');
  if (benchFilter && !label.includes(benchFilter)) return;
  if (!opts || typeof opts !== 'object')
    throw new Error('benchmark opts must be an object, got: ' + typeof opts);
  const merged = mergeOpts(mergeOpts(sectionOpts, subsectionOpts), opts);
  const { maxRunTimeSec } = merged;
  if (merged.mode !== undefined && !BENCH_MODES.includes(merged.mode))
    throw new Error(`benchmark mode must be one of: ${BENCH_MODES.join(', ')}`);
  const mode = merged.mode === 'runOnce' ? 'once' : merged.mode;
  const rate = parseBenchRate(merged);
  const result = await benchmarkRun(fn, mode === 'once' ? 0n : parseMaxRunTime(maxRunTimeSec));
  const { stats, perSecStr, perItemStr } = result;
  if (csvOn) {
    printBenchCsv(label, result, mode === 'once' || mode === 'time' ? undefined : rate);
    return;
  }
  let OUTPUT = `${label} `;
  if (mode === 'once') {
    OUTPUT += paintFormattedDuration(perItemStr, blue);
  } else if (mode === 'time') {
    OUTPUT += paintFormattedDuration(formatDuration(stats.mean), green);
    if (stats.rme >= displayRmeThreshold) OUTPUT += ` ${stats.formatted}`;
  } else if (mode === 'latency') {
    OUTPUT += [
      `p50 ${paintFormattedDuration(formatDuration(stats.p50), blue)}`,
      `p95 ${paintFormattedDuration(formatDuration(stats.p95), blue)}`,
      `p100 ${paintFormattedDuration(formatDuration(stats.max), blue)}`,
    ].join(' · ');
  } else if (rate) {
    const { value, unit } = benchRateValue(result, rate);
    OUTPUT += `x ${paint(formatOps(value), green)} ${unit}/sec`;
  } else {
    OUTPUT += `x ${paint(perSecStr, green)} ops/sec`;
    OUTPUT += ` @ ${paintFormattedDuration(perItemStr, blue)}/op`;
    if (stats.rme >= displayRmeThreshold) OUTPUT += ` ${stats.formatted}`;
  }
  printOutput(OUTPUT);
  return;
}

export default bench;
