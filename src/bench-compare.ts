/*! jsbt - MIT License (c) 2020 Paul Miller, 2010-2016 Mathias Bynens, John-David Dalton, Robert Kieffer from JSLitmus.js */
/**
 * Benchmark JS projects with nanosecond resolution.
 *
 * `compare` submodule allows to compare runs across different dimensions.
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import type { BenchStats } from './bench.ts';
import { utils } from './bench.ts';
const { benchmarkRaw, formatDuration } = utils;

const _c = String.fromCharCode(27);
const red = _c + '[31m',
  green = _c + '[32m',
  gray = _c + '[2;37m',
  blue = _c + '[34m',
  reset = _c + '[0m';
const NN = `${gray}│${reset}`,
  CH = `${gray}─${reset}`,
  LR = `${gray}┼${reset}`,
  RN = `${gray}├${reset}`,
  NL = `${gray}┤${reset}`;

type BenchObj = Record<string, any>;
type Column = { name: string; width: number };
type DimensionSource = Record<string, unknown> | readonly unknown[];
type Dimensions = Record<string, DimensionSource>;
type DynamicDimensions = Record<string, string[]>;
export type CompareArgsContext = {
  obj: BenchObj;
  args: any[];
};
export type CompareMetricContext = CompareArgsContext & {
  stats: BenchStats['stats'];
  perSec: bigint;
  iterations: number;
};
type CompareAmount = number | ((ctx: CompareArgsContext) => number);
type CompareIterations = number | ((ctx: CompareArgsContext) => number);
export type CompareThroughput = {
  amount: CompareAmount;
  unit: string;
  name?: string;
  width?: number;
  diff?: boolean;
  higherIsBetter?: boolean;
};
export type CompareMetric = {
  name: string;
  unit?: string;
  width?: number;
  diff?: boolean;
  higherIsBetter?: boolean;
  compute: (ctx: CompareMetricContext) => number;
};
type MetricDef = Pick<CompareMetric, 'compute' | 'diff' | 'width'> & {
  label: string;
  name: string;
  higherIsBetter: boolean;
};
type PreviousRow = { metricValues?: number[]; stats?: { mean?: bigint } };
type PreviousData = Record<string, PreviousRow>;
type RunResult = Pick<BenchStats, 'perItemStr' | 'perSec' | 'perSecStr' | 'stats'>;

export type CompareOpts = {
  libraryDimensions?: string[];
  defaults?: BenchObj;
  dimensions?: string[];
  filter?: string | string[];
  filterObj?: (obj: BenchObj) => boolean;
  dryRun?: boolean;
  loadRun?: string;
  patchArgs?: (args: any[], obj: BenchObj) => any[];
  printUnchanged?: boolean;
  iterations?: CompareIterations;
  skipThreshold?: number;
  format?: 'csv' | 'table';
  bytes?: CompareAmount;
  throughput?: CompareThroughput | CompareThroughput[];
  metrics?: CompareMetric[];
};

const isCli = typeof process !== 'undefined';
const SECOND = 10n ** 9n;
const MIB = 1024 ** 2;
const stripAnsi = (str: string): string => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null;
const envFlag = (value: string | undefined): boolean => !!Number(value);
type Env = Record<string, string | undefined>;
function wantColor(env: Env = {}, tty = false): boolean {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
}
function colorEnabled(env: Env = isCli ? process.env : {}): boolean {
  return isCli && wantColor(env, !!process.stderr?.isTTY || !!process.stdout?.isTTY);
}
const paint = (text: string, code: string): string =>
  colorEnabled() ? `${code}${text}${reset}` : text;
const headerName = (name: string): string => normalizeLabel(name).toLowerCase();

const joinBorders = (str: string): string =>
  str
    .replaceAll(`${CH}${NN}${CH}`, `${CH}${LR}${CH}`)
    .replaceAll(`${CH}${NN}`, `${CH}${NL}`)
    .replaceAll(`${NN}${CH}`, `${RN}${CH}`);
const pad = (s: string, len: number, end = true): string => {
  const diff = len - stripAnsi(s).length;
  if (diff <= 0) return s;
  const padding = ' '.repeat(diff);
  return end ? s + padding : padding + s;
};
const csvCell = (val: unknown): string => {
  const cell = stripAnsi(String(val ?? ''));
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};
const printCsvRow = (values: unknown[]): void => console.log(values.map(csvCell).join(','));

const normalizeLabel = (label: string): string =>
  label.replace(/\bMiB\/(?:sec|s)\b/g, 'mib/sec').replace(/\bmib\/s\b/g, 'mib/sec');
const metricLabel = (name: string, unit = ''): string =>
  normalizeLabel(`${name}${unit ? ` ${unit}` : ''}`);
const percent = (value: bigint, baseline: bigint, rev = false): string => {
  if (baseline === 0n) return `${gray}N/A${reset}`;
  const change = ((value - baseline) * 100n) / baseline;
  const sign = change > 0n ? '+' : change < 0n ? '' : '';
  const formatted = `${sign}${change}%`;
  const code = change > 0n ? (rev ? green : red) : change < 0n ? (rev ? red : green) : gray;
  return `${code}${formatted}${reset}`;
};
const percentNumber = (value: number, baseline: number, rev = true): string =>
  percent(BigInt(Math.round(value * 1000)), BigInt(Math.round(baseline * 1000)), rev);
const changePercent = (value: number | bigint, baseline: number | bigint): number => {
  const prev = Number(baseline);
  return prev === 0 ? 0 : Math.abs(((Number(value) - prev) / prev) * 100);
};
const roundRate = (value: number): number =>
  value >= 100 ? Math.round(value) : value >= 10 ? +value.toFixed(1) : +value.toFixed(2);
const parsePositiveFinite = (name: string, value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`bench-compare ${name} must be a positive finite number`);
  return value;
};
const parseIterations = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('bench-compare iterations must be a positive safe integer');
  return value;
};
const amountValue = (name: string, amount: CompareAmount, ctx: CompareArgsContext): number =>
  parsePositiveFinite(name, typeof amount === 'function' ? amount(ctx) : amount);
const bytesValue = (amount: CompareAmount, ctx: CompareArgsContext): number => {
  const value = typeof amount === 'function' ? amount(ctx) : amount;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('bench-compare bytes must be a positive safe integer');
  return value;
};
const perSecond = (mean: bigint, amount: number): number =>
  mean === 0n ? 0 : (Number(SECOND) * amount) / Number(mean);

function drawHeader(columns: Column[]): void {
  console.log(columns.map((col) => `${col.name.padEnd(col.width)} `).join(NN));
}
function drawSeparator(columns: Column[], changed: boolean[]): void {
  const sep = columns.map((col, i) => (changed[i] ? CH : ' ').repeat(col.width + 1));
  console.log(joinBorders(sep.join(NN)));
}
function printTableRow(
  values: string[],
  prev: string[] | undefined,
  columns: Column[],
  selectedCount: number
): string[] {
  const changed = values.map(() => true);
  for (let i = 0, parentChanged = false; i < selectedCount; i++) {
    const cur: boolean = parentChanged || !prev || values[i] !== prev[i];
    changed[i] = cur;
    parentChanged ||= cur;
  }
  const selected = changed.slice(0, selectedCount);
  const skipSeparator =
    selected.length < 2 ||
    (selected.slice(0, selected.length - 1).every((item) => !item) &&
      !!selected[selected.length - 1]);
  if (!skipSeparator) drawSeparator(columns, changed);
  const row = values.map((val, i) =>
    pad(!changed[i] ? ' ' : val, columns[i].width + 1, i < selectedCount)
  );
  console.log(row.join(NN));
  return values;
}

function filterValues(fields: string[], keywords: string | string[] | undefined): boolean {
  const keys = typeof keywords === 'string' ? keywords.split(',') : keywords;
  return (
    !keys ||
    keys.every((key) => {
      const parts = key.split('|');
      return fields.some((field) => parts.some((part) => field.includes(part)));
    })
  );
}
function filterMatchesValue(value: string, keywords: string | string[] | undefined): boolean {
  const keys = typeof keywords === 'string' ? keywords.split(',') : keywords;
  return !!keys?.some((key) => key.split('|').some((part) => part !== '' && value.includes(part)));
}

function matrixOpts(opts: CompareOpts): CompareOpts {
  const env = isCli ? process.env : {};
  const csv = envFlag(env.JSBT_CSV) || !colorEnabled(env);
  return {
    filter: env.JSBT_BENCHMARK_FILTER,
    dimensions: env.JSBT_BENCHMARK_DIMENSIONS
      ? env.JSBT_BENCHMARK_DIMENSIONS.split(',')
      : undefined,
    dryRun: envFlag(env.JSBT_BENCHMARK_DRY_RUN),
    ...opts,
    format: csv ? 'csv' : opts.format,
  };
}

function collectDynamicDimensions(
  libs: Record<string, unknown>,
  libraryDimensions: string[]
): DynamicDimensions {
  const sets = Object.fromEntries(
    libraryDimensions.map((dim) => [dim, new Set<string>()])
  ) as Record<string, Set<string>>;
  const stack = Object.entries(libs).map(([key, value]) => ({ path: [key], value }));
  for (const cur of stack) {
    const dim = libraryDimensions[cur.path.length - 1];
    if (dim) sets[dim].add(cur.path[cur.path.length - 1]);
    if (!isRecord(cur.value) || cur.path.length >= libraryDimensions.length) continue;
    for (const [key, value] of Object.entries(cur.value)) {
      if (key === 'options') continue;
      stack.push({ path: [...cur.path, key], value });
    }
  }
  return Object.fromEntries(Object.entries(sets).map(([dim, values]) => [dim, [...values]]));
}

function selectDimensions(
  dimensions: Dimensions,
  dynamic: DynamicDimensions,
  defaults: BenchObj,
  selectedDimensions: string[] | undefined
): string[] {
  const selected =
    selectedDimensions === undefined
      ? [...Object.keys(dimensions), ...Object.keys(dynamic)].filter(
          (dim) => defaults[dim] === undefined
        )
      : [...selectedDimensions];
  for (const dim of [...Object.keys(dynamic), ...Object.keys(dimensions)]) {
    if (defaults[dim] === undefined && !selected.includes(dim)) selected.push(dim);
  }
  return selected;
}

function valuesFor(dim: string, dimensions: Dimensions, dynamic: DynamicDimensions): string[] {
  const source = dimensions[dim];
  if (source !== undefined) return Object.keys(source);
  const values = dynamic[dim];
  if (values !== undefined) return values;
  throw new Error(`Unknown dimension: ${dim}`);
}

function printMetadata(
  dimensions: Dimensions,
  dynamic: DynamicDimensions,
  defaults: BenchObj,
  selected: string[],
  loadRun: string | undefined,
  filter: string | string[] | undefined,
  explicitDims: string[] | undefined
): void {
  const allDims = [...new Set([...selected, ...Object.keys(dimensions), ...Object.keys(dynamic)])];
  const explicit = new Set(explicitDims ?? []);
  const optionRows = [
    ['JSBT_BENCHMARK_FILTER', !!(Array.isArray(filter) ? filter.length : filter)],
    ['JSBT_BENCHMARK_DIMENSIONS', explicit.size > 0],
  ] as const;
  const fixed = Object.entries(defaults)
    .filter(([dim]) => !selected.includes(dim))
    .map(([dim, value]) => `${dim}=${value}`);
  const planRows = [
    [
      'varies',
      selected.length
        ? selected.map((dim) => (explicit.has(dim) ? paint(dim, blue) : dim)).join(' x ')
        : 'single case',
    ],
    ['fixed', fixed.length ? fixed.join(', ') : 'none'],
    ['compare', loadRun ? `against ${loadRun}` : 'against first row in each group'],
    ['env', optionRows.map(([name, active]) => (active ? paint(name, blue) : name)).join(', ')],
  ];
  const planWidth = Math.max(...planRows.map(([label]) => label.length));
  console.log(paint('benchmark plan', gray));
  for (const [label, value] of planRows)
    console.log(`  ${paint(label.padEnd(planWidth), gray)}  ${value}`);
  console.log(paint('dimensions', gray));
  const dimWidth = Math.max(0, ...allDims.map((dim) => dim.length));
  for (const dim of allDims) {
    const name = explicit.has(dim)
      ? paint(dim.padEnd(dimWidth), blue)
      : paint(dim.padEnd(dimWidth), gray);
    const values = valuesFor(dim, dimensions, dynamic).map((value) =>
      filterMatchesValue(value, filter) ? paint(value, blue) : value
    );
    const details = [
      values.join(', '),
      dynamic[dim] !== undefined ? '(from benchmark cases)' : '',
      fixed.some((item) => item.startsWith(`${dim}=`)) ? `(fixed: ${defaults[dim]})` : '',
    ].filter(Boolean);
    console.log(`  ${name}  ${details.join(' ')}`);
  }
  console.log('');
}

function metricDefs(opts: Pick<CompareOpts, 'bytes' | 'metrics' | 'throughput'>): MetricDef[] {
  const defs: MetricDef[] = [];
  const bytes = opts.bytes;
  if (bytes !== undefined) {
    defs.push({
      name: 'mib/sec',
      label: 'mib/sec',
      width: 7,
      diff: true,
      higherIsBetter: true,
      compute: (ctx) => roundRate(perSecond(ctx.stats.mean, bytesValue(bytes, ctx) / MIB)),
    });
  }
  const throughputs =
    opts.throughput === undefined
      ? []
      : Array.isArray(opts.throughput)
        ? opts.throughput
        : [opts.throughput];
  for (const throughput of throughputs) {
    if (!throughput || typeof throughput !== 'object')
      throw new Error('bench-compare throughput must be an object');
    if (typeof throughput.unit !== 'string' || !throughput.unit)
      throw new Error('bench-compare throughput unit must be a non-empty string');
    const name = throughput.name ?? `${throughput.unit}/sec`;
    defs.push({
      name,
      label: metricLabel(name),
      width: throughput.width,
      diff: throughput.diff ?? true,
      higherIsBetter: throughput.higherIsBetter ?? true,
      compute: (ctx) =>
        roundRate(
          perSecond(ctx.stats.mean, amountValue('throughput amount', throughput.amount, ctx))
        ),
    });
  }
  const metrics = opts.metrics ?? [];
  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object')
      throw new Error('bench-compare metric must be an object');
    if (typeof metric.name !== 'string' || !metric.name)
      throw new Error('bench-compare metric name must be a non-empty string');
    if (typeof metric.compute !== 'function')
      throw new Error(`Metric '${metric.name}' missing compute function`);
    defs.push({
      compute: metric.compute,
      diff: metric.diff,
      label: metricLabel(metric.name, metric.unit),
      name: metric.name,
      higherIsBetter: metric.higherIsBetter ?? true,
      width: metric.width,
    });
  }
  return defs;
}

function columnsFor(
  selected: string[],
  values: string[][],
  metrics: MetricDef[],
  csv: boolean
): Column[] {
  const cols = selected.map((name, i) => ({
    name: headerName(name),
    width: Math.max(headerName(name).length, ...values[i].map((value) => value.length)),
  }));
  for (const metric of metrics) {
    const label = headerName(metric.label);
    cols.push({ name: label, width: Math.max(metric.width ?? metric.name.length, label.length) });
    if (metric.diff && !csv)
      cols.push({ name: `${label} %`, width: Math.max(8, label.length + 2) });
  }
  cols.push(
    ...(csv
      ? [{ name: 'nanoseconds', width: 'nanoseconds'.length }]
      : [
          { name: 'ops/sec', width: 10 },
          { name: 'time', width: 10 },
          { name: 'diff %', width: 8 },
        ])
  );
  return cols;
}

function loadPrevious(file: string | undefined): PreviousData | undefined {
  if (!file || !isCli) return undefined;
  const revive = (_key: string, value: unknown): unknown =>
    isRecord(value) && typeof value.__BigInt__ === 'string' ? BigInt(value.__BigInt__) : value;
  const data = JSON.parse(readFileSync(file, 'utf8'), revive) as { data?: PreviousData };
  return data.data;
}

function caseData(
  dimensions: Dimensions,
  libs: Record<string, unknown>,
  libraryDimensions: string[],
  obj: BenchObj
): { args: any[]; key: string; lib: unknown } {
  let options: unknown = {};
  let node: unknown = libs;
  for (const dim of libraryDimensions) {
    if (!isRecord(node)) break;
    if (node.options !== undefined) options = node.options;
    node = node[String(obj[dim])];
  }
  const args = Object.keys(dimensions)
    .map((dim) => (dimensions[dim] as Record<string, unknown>)[String(obj[dim])])
    .concat(options);
  const key = Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join('-');
  return { args, key, lib: node };
}

function divDuration(value: bigint, iterations: number): bigint {
  if (value === 0n || iterations === 1) return value;
  const div = BigInt(iterations);
  return (value + div - 1n) / div;
}

function normalizeRun(result: RunResult, iterations: number): RunResult {
  if (iterations === 1) return result;
  const stats = {
    ...result.stats,
    min: divDuration(result.stats.min, iterations),
    max: divDuration(result.stats.max, iterations),
    mean: divDuration(result.stats.mean, iterations),
    median: divDuration(result.stats.median, iterations),
  };
  stats.formatted = `± ${stats.rme.toFixed(2)}% (${formatDuration(stats.min)}..${formatDuration(stats.max)})`;
  const perSec = stats.mean === 0n ? 0n : SECOND / stats.mean;
  return { stats, perSec, perSecStr: perSec.toString(), perItemStr: formatDuration(stats.mean) };
}

function iterationsFor(iterations: CompareIterations | undefined, ctx: CompareArgsContext): number {
  const source = iterations ?? 1;
  return parseIterations(typeof source === 'function' ? source(ctx) : source);
}

function runIterations(fn: (...args: any[]) => any, args: any[], iterations: number): any {
  let pending: Promise<unknown> | undefined;
  for (let i = 0; i < iterations; i++) {
    if (pending) {
      pending = pending.then(() => fn(...args));
    } else {
      const res = fn(...args);
      if (res instanceof Promise) pending = res;
    }
  }
  return pending;
}

const DRY_RESULT: RunResult = {
  stats: { formatted: '', max: 0n, mean: 0n, median: 0n, min: 0n, rme: 0 },
  perSec: 0n,
  perSecStr: '',
  perItemStr: '0ns',
};

async function compare(
  title: string,
  dimensions: Dimensions,
  libs: Record<string, unknown>,
  opts: CompareOpts
): Promise<void> {
  const {
    libraryDimensions = ['name'],
    defaults = {},
    dimensions: selectedDimensions,
    filter,
    filterObj = () => true,
    dryRun,
    loadRun,
    format = 'table',
    patchArgs,
    iterations,
    skipThreshold = 5,
    printUnchanged,
    bytes,
    throughput,
    metrics,
  } = matrixOpts(opts);
  for (const dim of libraryDimensions) {
    if (dimensions[dim] !== undefined)
      throw new Error('Dimensions is static and dynamic at same time: ' + dim);
  }
  if (format !== 'csv' && format !== 'table')
    throw new Error(`Unknown bench-compare format: ${format}`);
  const csv = format === 'csv';
  const table = format === 'table';
  const dynamic = collectDynamicDimensions(libs, libraryDimensions);
  const selected = selectDimensions(dimensions, dynamic, defaults, selectedDimensions);
  const values = selected.map((dim) => valuesFor(dim, dimensions, dynamic));
  const metricList = metricDefs({ bytes, throughput, metrics });
  const columns = columnsFor(selected, values, metricList, csv);
  const prevData = loadPrevious(loadRun);
  if (!csv) {
    console.log(title);
    printMetadata(dimensions, dynamic, defaults, selected, loadRun, filter, selectedDimensions);
  }
  if (table) drawHeader(columns);
  if (csv) printCsvRow(columns.map((col) => col.name));

  const indices = selected.map(() => 0);
  let prevValues: string[] | undefined;
  let baselineMean: bigint | undefined;
  let baselineMetrics: number[] | undefined;
  main: while (true) {
    const curValues = indices.map((index, dim) => values[dim][index]);
    if (filterValues(curValues, filter)) {
      const obj = {
        ...defaults,
        ...Object.fromEntries(curValues.map((value, i) => [selected[i], value])),
      };
      const data = caseData(dimensions, libs, libraryDimensions, obj);
      const lib = data.lib;
      if (lib !== undefined && filterObj(obj)) {
        if (typeof lib !== 'function')
          throw new Error(`Benchmark leaf is not a function: ${data.key}`);
        let args = data.args;
        if (patchArgs) args = patchArgs(args, obj);
        const ctx = { obj, args };
        const iterationCount = iterationsFor(iterations, ctx);
        const { stats, perSec, perSecStr, perItemStr } = dryRun
          ? DRY_RESULT
          : normalizeRun(
              await benchmarkRaw(() =>
                runIterations(lib as (...args: any[]) => any, args, iterationCount)
              ),
              iterationCount
            );
        baselineMean ??= stats.mean;
        const metricCtx = { ...ctx, stats, perSec, iterations: iterationCount };
        const metricValues = metricList.map((metric) => metric.compute(metricCtx));
        baselineMetrics ??= metricValues;
        const prevRow = prevData?.[data.key];
        const prevMean = prevData ? (prevRow?.stats?.mean ?? stats.mean) : baselineMean;
        const prevMetrics = metricValues.map((value, i) =>
          prevData ? (prevRow?.metricValues?.[i] ?? value) : (baselineMetrics?.[i] ?? value)
        );
        const maxChange = Math.max(
          changePercent(stats.mean, prevMean),
          ...metricValues.map((value, i) => changePercent(value, prevMetrics[i]))
        );
        if (!prevData || printUnchanged || maxChange > skipThreshold) {
          const metricFields = metricList.flatMap((metric, i) => {
            const display = table ? `${blue}${metricValues[i]}${reset}` : String(metricValues[i]);
            return metric.diff && !csv
              ? [display, percentNumber(metricValues[i], prevMetrics[i], metric.higherIsBetter)]
              : [display];
          });
          const statFields = csv
            ? [stats.mean.toString()]
            : [
                table ? `${green}${perSecStr}${reset}` : perSec.toString(),
                table ? `${blue}${perItemStr}${reset}` : perItemStr,
                percent(stats.mean, prevMean),
              ];
          const row = curValues.concat(metricFields, statFields);
          if (table) {
            prevValues = printTableRow(row, prevValues, columns, selected.length);
          } else {
            printCsvRow(row);
          }
        }
      }
    }
    for (let pos = indices.length - 1; pos >= 0; pos--) {
      indices[pos]++;
      if (indices[pos] < values[pos].length) break;
      if (pos <= 0) break main;
      indices[pos] = 0;
      baselineMean = undefined;
      baselineMetrics = undefined;
    }
  }
  if (table)
    drawSeparator(
      columns,
      columns.map(() => true)
    );
}

export default compare;
export { compare };
