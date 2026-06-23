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
export type BenchStats = {
  stats: {
    rme: number;
    min: bigint;
    max: bigint;
    mean: bigint;
    median: bigint;
    formatted: string;
  };
  perSecStr: string;
  perSec: bigint;
  perItemStr: string;
  measurements: bigint[];
};
export type CbFn = (iter?: number) => {};
const maxSamples = 2 ** 26;
const _c = String.fromCharCode(27);
const red = _c + '[31m';
const green = _c + '[32m';
const blue = _c + '[34m';
const reset = _c + '[0m';
type Env = Record<string, string | undefined>;
function wantColor(env: Env = {}, tty = false): boolean {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
}
const colorOn =
  // @ts-ignore
  typeof process !== 'undefined' &&
  wantColor(process.env, !!process.stderr?.isTTY || !!process.stdout?.isTTY);
const benchFilter =
  // @ts-ignore
  typeof process !== 'undefined' ? process.env?.JSBT_FILTER || '' : '';
function paint(text: string, code: string): string {
  return colorOn ? `${code}${text}${reset}` : text;
}
const units = [
  { symbol: 'min', val: 60n * 10n ** 9n, threshold: 5n },
  { symbol: 's', val: 10n ** 9n, threshold: 10n },
  { symbol: 'ms', val: 10n ** 6n, threshold: 1n },
  { symbol: 'μs', val: 10n ** 3n, threshold: 1n },
  { symbol: 'ns', val: 0n, threshold: 1n },
];
const SECOND = units[1].val;
function printOutput(...str: any) {
  // @ts-ignore
  console.log(...str);
}
function logMem(): void {
  const mapping: any = {
    heapTotal: 'heap',
    heapUsed: 'used',
    external: 'ext',
    arrayBuffers: 'arr',
  };
  // @ts-ignore
  const vals = Object.entries(process.memoryUsage())
    .filter((entry: any) => {
      const [k, v] = entry;
      return v > 100000 && k !== 'external';
    })
    .map((entry: any) => {
      const [k, v] = entry;
      return `${mapping[k] || k}=${`${(v / 1000000).toFixed(1)}mb`}`;
    });
  printOutput('RAM:', vals.join(' '));
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
const formatter = Intl.NumberFormat('en-US');
function formatOps(value: bigint | number): string {
  if (typeof value === 'bigint') return colorOn ? formatter.format(value) : value.toString();
  const maximumFractionDigits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return Intl.NumberFormat('en-US', {
    maximumFractionDigits,
    useGrouping: colorOn,
  }).format(value);
}
const displayRmeThreshold = 5;
const byteRateUnits = [
  { unit: 'gib', bytes: 1024 ** 3 },
  { unit: 'mib', bytes: 1024 ** 2 },
  { unit: 'kib', bytes: 1024 },
  { unit: 'b', bytes: 1 },
];
// duration formatter
function formatDuration(duration: any): string {
  for (let i = 0; i < units.length; i++) {
    const { symbol, threshold, val } = units[i];
    if (duration >= val * threshold) {
      const div = val === 0n ? 1n : val;
      return (duration / div).toString() + symbol;
    }
  }
  throw new Error('Invalid duration ' + duration);
}
function calcSum<T extends number | bigint>(list: T[], isBig = true): T {
  // @ts-ignore
  return list.reduce((a, b) => a + b, (isBig ? 0n : 0) as T);
}
function isFirstBig<T extends number | bigint>(list: T[]): boolean {
  return list.length > 0 && typeof list[0] === 'bigint';
}
function calcMean<T extends number | bigint>(list: T[]): T {
  const len = list.length;
  const isBig = isFirstBig(list);
  const tlen = isBig ? BigInt(len) : len;
  // @ts-ignore
  return calcSum(list, isBig) / tlen;
}
function calcDeviation(list: bigint[]): number {
  if (list.length < 2) return 0;
  const mean = Number(calcSum(list)) / list.length;
  const variance =
    list.reduce((sum, val) => sum + (Number(val) - mean) ** 2, 0) / (list.length - 1);
  return Math.sqrt(variance);
}
// Mutates array by sorting it
function calcStats(list: bigint[]): {
  rme: number;
  min: bigint;
  max: bigint;
  mean: bigint;
  median: bigint;
  formatted: string;
} {
  list.sort((a, b) => Number(a - b));
  const samples = list.length;
  const mean: bigint = calcMean(list);
  const median = list[Math.floor(samples / 2)];
  const min = list[0];
  const max = list[samples - 1];
  // Compute the standard error of the mean
  // a.k.a. the standard deviation of the sampling distribution of the sample mean
  const sem = calcDeviation(list) / Math.sqrt(samples);
  const df = samples - 1; // degrees of freedom
  // @ts-ignore
  const critical: number = tTable[Math.round(df) || 1] || tTable.infinity; // critical value
  const moe = sem * critical; // margin of error
  const rme = (moe / Number(mean)) * 100 || 0; // relative margin of error
  const formatted = paint(
    `± ${rme.toFixed(2)}% (${formatDuration(min)}..${formatDuration(max)})`,
    red
  );
  return { rme, min, max, mean, median, formatted };
}
// @ts-ignore
const getTime: () => bigint = process.hrtime.bigint;
let defaultMaxRunTime = SECOND;
async function benchmarkRaw(
  callback: CbFn,
  maxRunTime: bigint = defaultMaxRunTime
): Promise<BenchStats> {
  if (typeof callback !== 'function') throw new Error('callback must be a function');
  // measurements contain sample timings
  // `new Array(30_000_000)` pre-allocation is in some cases more efficient for
  // garbage collection than growing array size continuously.
  const measurements = [];
  let total = 0n;
  for (let i = 0; i < maxSamples; i++) {
    const start = getTime();
    const val = callback(i);
    if (val instanceof Promise) await val;
    const stop = getTime();
    const diff = stop - start;
    measurements.push(diff);
    total += diff;
    if (total >= maxRunTime) break;
  }
  const stats = calcStats(measurements);
  const { mean } = stats;
  const perSec = SECOND / mean;
  const perSecStr = formatOps(perSec);
  const perItemStr = formatDuration(mean);
  return { stats, perSecStr, perSec, perItemStr, measurements };
}

export type BenchOpts = {
  /** Bytes processed by one benchmark iteration; printed as kib/mib/gib per second. */
  bytes?: number;
  /** Custom units processed by one benchmark iteration. */
  throughput?: BenchThroughput;
  maxRunTimeSec?: number;
  mode?: 'normal' | 'runOnce';
};
export type BenchThroughput = {
  amount: number;
  unit: string;
};
type BenchRate =
  | { type: 'bytes'; bytes: number; showPerItem: false }
  | { type: 'unit'; amount: number; unit: string; showPerItem: boolean };

function parseMaxRunTime(val: number | undefined) {
  if (val === undefined) return;
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0.1 || val > 60)
    throw new Error('must be between 0.1 and 60 sec');
  return (BigInt(Math.round(val * 1000)) * SECOND) / 1000n;
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
  const { bytes, throughput } = opts;
  if (bytes !== undefined) {
    if (throughput !== undefined) throw new Error('bench bytes cannot be used with throughput');
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error('bench bytes must be a positive safe integer');
    return { type: 'bytes', bytes, showPerItem: false };
  }
  if (throughput !== undefined) {
    if (!throughput || typeof throughput !== 'object')
      throw new Error('bench throughput must be an object');
    const amount = parsePositiveNumber('throughput amount', throughput.amount);
    if (typeof throughput.unit !== 'string' || !throughput.unit)
      throw new Error('bench throughput unit must be a non-empty string');
    return { type: 'unit', amount, unit: throughput.unit, showPerItem: false };
  }
  return undefined;
}

function perSecond(mean: bigint, amount: number): bigint | number {
  if (Number.isSafeInteger(amount)) return (SECOND * BigInt(amount)) / mean;
  return (Number(SECOND) * amount) / Number(mean);
}

function formatBenchRate(mean: bigint, rate: BenchRate): { perSecStr: string; unit: string } {
  if (rate.type === 'unit')
    return { perSecStr: formatOps(perSecond(mean, rate.amount)), unit: rate.unit };
  const bytesPerSec = (Number(SECOND) * rate.bytes) / Number(mean);
  const { bytes, unit } =
    byteRateUnits.find((item) => bytesPerSec >= item.bytes) ?? byteRateUnits.at(-1)!;
  return { perSecStr: formatOps(bytesPerSec / bytes), unit };
}

function setMaxRunTime(val: number): void {
  defaultMaxRunTime = parseMaxRunTime(val) ?? SECOND;
}

export async function bench(
  label: string,
  fn: CbFn,
  opts: BenchOpts = {}
): Promise<BenchStats | undefined> {
  if (typeof label !== 'string') throw new Error('benchmark label must be a string');
  if (benchFilter && !label.includes(benchFilter)) return;
  if (!opts || typeof opts !== 'object')
    throw new Error('benchmark opts must be an object, got: ' + typeof opts);
  let { maxRunTimeSec, mode } = opts;
  const rate = parseBenchRate(opts);
  let { stats, perSecStr, perItemStr, measurements } = await benchmarkRaw(
    fn,
    mode === 'runOnce' ? 0n : parseMaxRunTime(maxRunTimeSec)
  );
  let OUTPUT = `${label} `;
  if (mode === 'runOnce') {
    OUTPUT += paint(perItemStr, blue);
  } else {
    if (rate) {
      const formattedRate = formatBenchRate(stats.mean, rate);
      perSecStr = formattedRate.perSecStr;
      OUTPUT += `x ${paint(perSecStr, green)} ${formattedRate.unit}/sec`;
      if (rate.showPerItem) {
        OUTPUT += ` @ ${paint(perItemStr, blue)}/op`;
        if (stats.rme >= displayRmeThreshold) OUTPUT += ` ${stats.formatted}`;
      }
    } else {
      OUTPUT += `x ${paint(perSecStr, green)} ops/sec`;
      OUTPUT += ` @ ${paint(perItemStr, blue)}/op`;
      if (stats.rme >= displayRmeThreshold) OUTPUT += ` ${stats.formatted}`;
    }
  }
  printOutput(OUTPUT);
  measurements.length = 0; // Destroy the list, simplify the life for garbage collector
  return;
}

export default bench;
export const utils: {
  getTime: typeof getTime;
  logMem: typeof logMem;
  setMaxRunTime: typeof setMaxRunTime;
  formatDuration: typeof formatDuration;
  calcStats: typeof calcStats;
  benchmarkRaw: typeof benchmarkRaw;
} = {
  getTime,
  logMem,
  setMaxRunTime,
  formatDuration,
  calcStats,
  benchmarkRaw,
};
