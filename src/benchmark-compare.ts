/*! jsbt - MIT License (c) 2020 Paul Miller, 2010-2016 Mathias Bynens, John-David Dalton, Robert Kieffer from JSLitmus.js */
/**
 * Benchmark JS projects with nanosecond resolution.
 *
 * `compare` submodule allows to compare runs across different dimensions.
 *
 * @module
 */
import type { BenchStats, Env } from './benchmark.ts';
import {
  ansi,
  benchmarkRun,
  buf,
  envFlag,
  formatDuration,
  formatOps,
  isCli,
  paintFormattedDuration as paintFormattedDurationWith,
  perSecondNumber,
  printCsvRow,
  roundRate,
  stripAnsi,
  wantColor,
} from './benchmark.ts';

const { green, gray, cyan, reset } = ansi;

type BenchObj = Record<string, any>;
type DimensionSource = Record<string, unknown> | readonly unknown[];
type Dimensions = Record<string, DimensionSource>;
type NormalizedDimensions = Record<string, Map<string, unknown>>;
type DynamicDimensions = Record<string, string[]>;
export type CompareArgsContext = {
  obj: BenchObj;
  args: any[];
};
type CompareAmount = number | Uint8Array | ((ctx: CompareArgsContext) => number | Uint8Array);
type CompareMode = 'normal' | 'time' | 'latency';
type RunResult = Pick<BenchStats, 'elapsed' | 'iterations' | 'perItemStr' | 'perSecStr' | 'stats'>;

export type CompareOpts = {
  /**
   * Names for the nesting levels of the libs tree, outermost first: with
   * `{ sha256: { noble: fn } }`, `levels: ['algorithm', 'library']`.
   * Defaults to `['name']` (a flat libs object).
   */
  levels?: string[];
  defaults?: BenchObj;
  /**
   * Input dimensions: `{ dim: { label: value } }`, or the array shorthand
   * `{ dim: [value, ...] }` where labels become `String(value)`. Each case's
   * values are passed to the benched function as arguments, in declaration order.
   */
  inputs?: Dimensions;
  /**
   * Size labels ('32B', '1KB', '10MB', ...): prepends a `size` dimension of
   * deterministic pseudo-random buffers (see `buf`). Unless overridden, `bytes`
   * defaults to the parsed size and `mode` to 'time' below 1KB.
   */
  sizes?: string[];
  /** Dimension precedence; selected dimensions not listed are appended after. */
  order?: string[];
  /**
   * The first declared value of the comparison (last) dimension is painted cyan
   * (the heading color) in text output, so "our" library stays findable in
   * speed-sorted rows; `false` disables.
   */
  focus?: false;
  filterObj?: (obj: BenchObj) => boolean;
  dryRun?: boolean;
  patchArgs?: (args: any[], obj: BenchObj) => any[];
  bytes?: CompareAmount;
  /**
   * 'time' prints aggregate mean duration per op; 'latency' prints p50, p95,
   * and p100. Display-only (CSV keeps its aggregate schema); may be a function
   * deciding per case.
   */
  mode?: CompareMode | ((ctx: CompareArgsContext) => CompareMode);
  /**
   * Dimension names across which results must be identical, e.g. `['library']`.
   * Before timing, every case runs once; results are deep-compared inside each group of
   * cases that differ only in these dimensions. Also verifies Uint8Array args are not mutated.
   * Runs even with dryRun, which allows validation without benchmarking.
   */
  crossValidate?: string[];
};

const MIB = 1024 ** 2;
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null;
function colorEnabled(env: Env = isCli ? process.env : {}): boolean {
  return isCli && wantColor(env, !!process.stderr?.isTTY || !!process.stdout?.isTTY);
}
const paint = (text: string, code: string): string =>
  colorEnabled() ? `${code}${text}${reset}` : text;
// compare's paint re-checks env per call, so pass it through instead of using bench's default
const paintFormattedDuration = (formatted: string, code: string): string =>
  paintFormattedDurationWith(formatted, code, paint);
const paintDuration = (duration: bigint, code: string): string =>
  paintFormattedDuration(formatDuration(duration), code);

// Comparison against the group's fastest row; rows are sorted, so every diff is a
// slowdown — shown as a signed factor (-1.7x). A gray ≈ marks a tie: either the
// change sits inside noise (the combined rme of the two runs) or the factor is
// below 1.1x — too small to bother the reader with.
function diffText(value: number, best: number, higherIsBetter: boolean, noise: number): string {
  // equal values are a tie even at 0 — sub-resolution timers round p50 to 0 ns
  if (value === best) return `${gray}≈${reset}`;
  if (!(value > 0) || !(best > 0)) return `${gray}N/A${reset}`;
  const ratio = higherIsBetter ? best / value : value / best;
  if (ratio < 1.1 || (Math.abs(value - best) / best) * 100 <= noise) return `${gray}≈${reset}`;
  // one decimal below 10x; the decimal stops being informative from 10x on
  const factor = ratio >= 10 ? Math.round(ratio) : +ratio.toFixed(1);
  return `${gray}-${factor}x${reset}`;
}
const bytesValue = (amount: CompareAmount, ctx: CompareArgsContext): number => {
  const raw = typeof amount === 'function' ? amount(ctx) : amount;
  const value = raw instanceof Uint8Array ? raw.byteLength : raw;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('bench-compare bytes must be a positive safe integer');
  return value;
};
const modeFor = (mode: CompareOpts['mode'], ctx: CompareArgsContext): CompareMode => {
  const value = (typeof mode === 'function' ? mode(ctx) : mode) ?? 'normal';
  if (value !== 'normal' && value !== 'time' && value !== 'latency')
    throw new Error("bench-compare mode must be 'normal', 'time', or 'latency'");
  return value;
};

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
/**
 * Parses a size label ('64B', '1KB', '10MB') into its byte count — the same parser
 * the `sizes` option uses, so `buf(parseSize(label))` reproduces compare's internal
 * buffer for that label anywhere outside compare (precompute, preallocation, warmup).
 */
export function parseSize(label: unknown): number {
  const match = /^(\d+)(B|KB|MB|GB)$/i.exec(String(label));
  if (!match) throw new Error(`bench-compare sizes: cannot parse size label: ${label}`);
  return Number(match[1]) * SIZE_UNITS[match[2].toUpperCase()];
}

// Array dimension sources become label->value maps keyed by String(value). Maps
// (unlike records) keep declared order even for integer-like labels such as '8'.
function normalizeDimensions(dims: Dimensions): NormalizedDimensions {
  return Object.fromEntries(
    Object.entries(dims).map(([dim, source]) => [
      dim,
      new Map(
        Array.isArray(source)
          ? source.map((value) => [String(value), value] as const)
          : Object.entries(source)
      ),
    ])
  );
}

// FILTER grammar, always substring-matched against dimension values. With '=':
// ';'-separated `dim=value,value` terms — every term must match its dimension,
// comma values are alternatives ('library=awasm,noble;algorithm=sha3_256').
// Without '=': comma-separated terms that must each match some dimension.
type FilterTerm = { dim?: string; parts: string[] };
const parseFilter = (keywords: string | undefined): FilterTerm[] | undefined => {
  if (!keywords) return undefined;
  const scoped = keywords.includes('=');
  return keywords.split(scoped ? ';' : ',').map((term) => {
    const sep = term.indexOf('=');
    if (sep === -1) return { parts: scoped ? term.split(',') : [term] };
    return { dim: term.slice(0, sep), parts: term.slice(sep + 1).split(',') };
  });
};
function filterValues(selected: string[], fields: string[], keywords: string | undefined): boolean {
  const keys = parseFilter(keywords);
  return (
    !keys ||
    keys.every(({ dim, parts }) =>
      fields.some(
        (field, i) =>
          (dim === undefined || selected[i] === dim) && parts.some((part) => field.includes(part))
      )
    )
  );
}
function filterMatchesValue(dim: string, value: string, keywords: string | undefined): boolean {
  const keys = parseFilter(keywords);
  return !!keys?.some(
    ({ dim: scope, parts }) =>
      (scope === undefined || scope === dim) &&
      parts.some((part) => part !== '' && value.includes(part))
  );
}

// filter comes only from the FILTER env var; env order/dryRun are defaults explicit opts override
function matrixOpts(opts: CompareOpts): CompareOpts & { filter?: string } {
  const env: Env = isCli ? process.env : {};
  return {
    filter: env.FILTER,
    order: env.JSBT_ORDER ? env.JSBT_ORDER.split(',') : undefined,
    dryRun: envFlag(env.JSBT_BENCHMARK_DRY_RUN),
    ...opts,
  };
}

function collectDynamicDimensions(
  libs: Record<string, unknown>,
  levels: string[]
): DynamicDimensions {
  const sets = Object.fromEntries(levels.map((dim) => [dim, new Set<string>()])) as Record<
    string,
    Set<string>
  >;
  const stack = Object.entries(libs).map(([key, value]) => ({ path: [key], value }));
  for (const cur of stack) {
    const dim = levels[cur.path.length - 1];
    if (dim) sets[dim].add(cur.path[cur.path.length - 1]);
    if (!isRecord(cur.value) || cur.path.length >= levels.length) continue;
    for (const [key, value] of Object.entries(cur.value)) {
      if (key === 'options') continue;
      stack.push({ path: [...cur.path, key], value });
    }
  }
  return Object.fromEntries(Object.entries(sets).map(([dim, values]) => [dim, [...values]]));
}

function selectDimensions(
  dimensions: NormalizedDimensions,
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

function valuesFor(
  dim: string,
  dimensions: NormalizedDimensions,
  dynamic: DynamicDimensions
): string[] {
  const source = dimensions[dim];
  if (source !== undefined) return [...source.keys()];
  const values = dynamic[dim];
  if (values !== undefined) return values;
  throw new Error(`Unknown dimension: ${dim}`);
}

// Hashes — 8 cases (FILTER='', JSBT_ORDER='')
//   size       32B, 10MB
//   algorithm  sha256, sha512
//   library    noble, node
function printMetadata(
  title: string,
  caseCount: number,
  dimensions: NormalizedDimensions,
  dynamic: DynamicDimensions,
  defaults: BenchObj,
  selected: string[],
  filter: string | undefined,
  order: string[] | undefined,
  dryRun: boolean | undefined
): void {
  const envVars = [`FILTER='${filter ?? ''}'`, `JSBT_ORDER='${order ? order.join(',') : ''}'`];
  if (dryRun) envVars.push('JSBT_BENCHMARK_DRY_RUN=1');
  const env = paint(`(${envVars.join(', ')})`, gray);
  const sfx = caseCount === 1 ? '' : 's';
  console.log(`${title} — ${paint(caseCount.toString(), green)} case${sfx} ${env}`);
  const explicit = new Set(order ?? []);
  const fixed = Object.entries(defaults)
    .filter(([dim]) => !selected.includes(dim))
    .map(([dim, value]) => `${dim}=${value}`);
  const dimWidth = Math.max(
    fixed.length ? 'fixed'.length : 0,
    ...selected.map((dim) => dim.length)
  );
  for (const dim of selected) {
    const name = paint(dim.padEnd(dimWidth), explicit.has(dim) ? cyan : gray);
    const values = valuesFor(dim, dimensions, dynamic).map((value) =>
      filterMatchesValue(dim, value, filter) ? paint(value, cyan) : value
    );
    console.log(`  ${name}  ${values.join(', ')}`);
  }
  if (fixed.length) console.log(`  ${paint('fixed'.padEnd(dimWidth), gray)}  ${fixed.join(', ')}`);
  console.log('');
}

function csvColumns(selected: string[], hasBytes: boolean): string[] {
  const cols = selected.map((name) => name.toLowerCase());
  if (hasBytes) cols.push('mib/sec');
  cols.push('nanoseconds', 'rme');
  return cols;
}

function caseData(
  dimensions: NormalizedDimensions,
  libs: Record<string, unknown>,
  levels: string[],
  obj: BenchObj
): { args: any[]; key: string; lib: unknown } {
  let options: unknown = {};
  let node: unknown = libs;
  for (const dim of levels) {
    if (!isRecord(node)) break;
    if (node.options !== undefined) options = node.options;
    node = node[String(obj[dim])];
  }
  const args = Object.keys(dimensions)
    .map((dim) => dimensions[dim].get(String(obj[dim])))
    .concat(options);
  const key = Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join('-');
  return { args, key, lib: node };
}

const DRY_RESULT: RunResult = {
  elapsed: 0n,
  iterations: 0,
  stats: { formatted: '', max: 0n, mean: 0n, min: 0n, p50: 0n, p95: 0n, rme: 0 },
  perSecStr: '',
  perItemStr: '0ns',
};

function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor)
      return false;
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEquals(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => deepEquals(a[key], b[key]));
  }
  return false;
}

// Odometer over dimension values; newGroup marks a wrap in any dimension above the last one,
// which is where diff-% baselines reset.
function* matrixCases(values: string[][]): Generator<{ curValues: string[]; newGroup: boolean }> {
  const indices = values.map(() => 0);
  if (indices.length === 0) {
    yield { curValues: [], newGroup: false };
    return;
  }
  let newGroup = false;
  main: while (true) {
    yield { curValues: indices.map((index, dim) => values[dim][index]), newGroup };
    newGroup = false;
    for (let pos = indices.length - 1; pos >= 0; pos--) {
      indices[pos]++;
      if (indices[pos] < values[pos].length) break;
      if (pos <= 0) break main;
      indices[pos] = 0;
      newGroup = true;
    }
  }
}

type CaseContext = {
  selected: string[];
  values: string[][];
  dimensions: NormalizedDimensions;
  libs: Record<string, unknown>;
  levels: string[];
  defaults: BenchObj;
  filter: string | undefined;
  filterObj: (obj: BenchObj) => boolean;
  patchArgs?: (args: any[], obj: BenchObj) => any[];
};
type BenchCase = {
  newGroup: boolean;
  curValues: string[];
  obj: BenchObj;
  key: string;
  lib: (...args: any[]) => any;
  args: any[];
};

// Walks the matrix, applies filters, resolves each case to its function + args.
function* benchCases(ctx: CaseContext): Generator<BenchCase> {
  let pendingNewGroup = false;
  for (const { curValues, newGroup } of matrixCases(ctx.values)) {
    pendingNewGroup ||= newGroup;
    if (!filterValues(ctx.selected, curValues, ctx.filter)) continue;
    const obj = {
      ...ctx.defaults,
      ...Object.fromEntries(curValues.map((value, i) => [ctx.selected[i], value])),
    };
    const data = caseData(ctx.dimensions, ctx.libs, ctx.levels, obj);
    if (data.lib === undefined || !ctx.filterObj(obj)) continue;
    if (typeof data.lib !== 'function')
      throw new Error(`Benchmark leaf is not a function: ${data.key}`);
    const args = ctx.patchArgs ? ctx.patchArgs(data.args, obj) : data.args;
    const lib = data.lib as (...fnArgs: any[]) => any;
    yield { newGroup: pendingNewGroup, curValues, obj, key: data.key, lib, args };
    pendingNewGroup = false;
  }
}

async function runCrossValidation(ctx: CaseContext, crossDims: string[]): Promise<void> {
  const groups = new Map<string, { key: string; result: unknown }>();
  for (const { obj, key, lib, args } of benchCases(ctx)) {
    const inputs = args.map((arg) => (arg instanceof Uint8Array ? arg.slice() : undefined));
    const result = await lib(...args);
    inputs.forEach((before, i) => {
      if (before !== undefined && !deepEquals(args[i], before))
        throw new Error(`bench-compare crossValidate: case mutates its Uint8Array input: ${key}`);
    });
    const groupKey = Object.entries(obj)
      .filter(([dim]) => !crossDims.includes(dim))
      .map(([dim, value]) => `${dim}=${value}`)
      .join('-');
    const prev = groups.get(groupKey);
    if (prev === undefined) groups.set(groupKey, { key, result });
    else if (!deepEquals(prev.result, result))
      throw new Error(`bench-compare crossValidate: results differ: ${prev.key} vs ${key}`);
  }
}

async function compare(
  title: string,
  libs: Record<string, unknown>,
  opts: CompareOpts = {}
): Promise<void> {
  const {
    levels = ['name'],
    defaults = {},
    inputs = {},
    sizes,
    order,
    focus,
    filter,
    filterObj = () => true,
    dryRun,
    patchArgs,
    bytes: bytesOpt,
    mode: modeOpt,
    crossValidate,
  } = matrixOpts(opts);
  let bytes = bytesOpt;
  let mode = modeOpt;
  let dimensions = normalizeDimensions(inputs);
  if (sizes !== undefined) {
    if (dimensions.size !== undefined)
      throw new Error("bench-compare sizes reserves the 'size' dimension");
    const sizeBytes = new Map(sizes.map((label) => [String(label), parseSize(label)]));
    const sized = new Map([...sizeBytes].map(([label, size]) => [label, buf(size)]));
    dimensions = { size: sized, ...dimensions };
    const caseBytes = ({ obj }: CompareArgsContext) =>
      sizeBytes.get(String(obj.size)) ?? parseSize(obj.size);
    bytes ??= caseBytes;
    mode ??= (ctx: CompareArgsContext) => (caseBytes(ctx) < 1024 ? 'time' : 'normal');
  }
  for (const dim of levels) {
    if (dimensions[dim] !== undefined)
      throw new Error('Dimensions is static and dynamic at same time: ' + dim);
  }
  const env: Env = isCli ? process.env : {};
  const csv = envFlag(env.JSBT_CSV) || !colorEnabled(env);
  const dynamic = collectDynamicDimensions(libs, levels);
  const selected = selectDimensions(dimensions, dynamic, defaults, order);
  const values = selected.map((dim) => valuesFor(dim, dimensions, dynamic));
  const caseCtx: CaseContext = {
    selected,
    values,
    dimensions,
    libs,
    levels,
    defaults,
    filter,
    filterObj,
    patchArgs,
  };
  if (crossValidate !== undefined) {
    for (const dim of crossValidate) valuesFor(dim, dimensions, dynamic); // throws on unknown name
    await runCrossValidation(caseCtx, crossValidate);
  }
  if (csv) {
    printCsvRow(csvColumns(selected, bytes !== undefined));
  } else {
    // count with patchArgs disabled: it may depend on per-run precompute and must
    // not run an extra time per case just for the header
    let caseCount = 0;
    for (const _ of benchCases({ ...caseCtx, patchArgs: undefined })) caseCount++;
    printMetadata(title, caseCount, dimensions, dynamic, defaults, selected, filter, order, dryRun);
  }

  // Last selected dimension varies inside a group; the dimensions above it become
  // `# dim=value` group headers. Rows buffer per group and print sorted fastest to
  // slowest, each compared against the fastest. On a live terminal the group block
  // renders in place as results arrive (JSBT_LIVE=0 disables).
  const grouped = !csv && selected.length >= 2;
  const lastValues = values[selected.length - 1] ?? [];
  const labelWidth = Math.max(0, ...lastValues.map((v) => v.length));
  const focusLabel = focus === false ? undefined : lastValues[0];
  const paintLabel = (label: string): string =>
    label === focusLabel ? `${cyan}${label}${reset}` : label;
  const live =
    !csv && (env.JSBT_LIVE !== undefined ? envFlag(env.JSBT_LIVE) : !!process.stdout?.isTTY);
  type GroupRow = {
    label: string;
    mean: bigint;
    p50: bigint;
    p95: bigint;
    p100: bigint;
    rme: number;
    rate?: number;
    mode: CompareMode;
    perSecStr: string;
    perItemStr: string;
  };
  const primaryValue = (row: GroupRow): bigint => (row.mode === 'latency' ? row.p50 : row.mean);
  const compareRows = (a: GroupRow, b: GroupRow): number =>
    a.rate !== undefined && b.rate !== undefined
      ? b.rate - a.rate
      : Number(primaryValue(a) - primaryValue(b));
  const rowLine = (row: GroupRow, fastest: GroupRow): string => {
    // manual padding: ANSI codes around a focused label would break padEnd
    const pad = ' '.repeat(labelWidth - row.label.length);
    const lead = paintLabel(row.label) + pad;
    // primary metric in green, derived time dimmed, segments split by interpuncts;
    // mib/sec already implies the time, so no time segment there
    const segs =
      row.mode === 'time'
        ? [paintDuration(row.mean, green)]
        : row.mode === 'latency'
          ? [
              `p50 ${paintDuration(row.p50, green)}`,
              `p95 ${paintDuration(row.p95, gray)}`,
              `p100 ${paintDuration(row.p100, gray)}`,
            ]
          : row.rate !== undefined
            ? [`${green}${formatOps(row.rate)}${reset} mib/sec`]
            : [
                `${green}${row.perSecStr}${reset} ops/sec`,
                `${paintFormattedDuration(row.perItemStr, gray)}/op`,
              ];
    if (row !== fastest) {
      const noise =
        row.mode === 'latency' || fastest.mode === 'latency' ? 0 : Math.hypot(row.rme, fastest.rme);
      segs.push(
        row.rate !== undefined && fastest.rate !== undefined
          ? diffText(row.rate, fastest.rate, true, noise)
          : diffText(Number(primaryValue(row)), Number(primaryValue(fastest)), false, noise)
      );
    }
    return `${lead}  ${segs.join(` ${gray}·${reset} `)}`;
  };
  const rows: GroupRow[] = [];
  let livePending = false;
  const eraseBlock = (): string => (livePending ? '\x1b[1A\r\x1b[0J' : '');
  // a wrapped line would break the cursor-up math of the next rewrite, so live
  // (non-final) lines are truncated to the terminal width
  const fitLine = (line: string): string => {
    const cols = process.stdout?.columns;
    if (!cols) return line;
    const plain = stripAnsi(line);
    return plain.length <= cols ? line : plain.slice(0, cols - 1) + '…';
  };
  // one self-replacing status line while the group runs; results stay hidden
  // until finishGroup prints the sorted block over it
  const liveRender = (pending: string): void => {
    if (!live) return;
    process.stdout.write(eraseBlock() + fitLine(`${gray}… ${pending}${reset}`) + '\n');
    livePending = true;
  };
  const finishGroup = (): void => {
    if (rows.length === 0) return;
    const sorted = rows.sort(compareRows);
    const lines = sorted.map((row) => rowLine(row, sorted[0]));
    if (live) process.stdout.write(eraseBlock() + lines.join('\n') + '\n');
    else for (const line of lines) console.log(line);
    rows.length = 0;
    livePending = false;
  };

  let firstCase = true;
  for (const { newGroup, curValues, obj, lib, args } of benchCases(caseCtx)) {
    if (grouped && (firstCase || newGroup)) {
      finishGroup();
      if (!firstCase) console.log('');
      const header = curValues
        .slice(0, -1)
        .map((value, i) => `${selected[i]}=${value}`)
        .join(', ');
      console.log(paint(`# ${header}`, cyan));
    }
    firstCase = false;
    const label = curValues.at(-1) ?? title;
    const ctx = { obj, args };
    if (!csv && !dryRun) liveRender(label);
    const result = dryRun ? DRY_RESULT : await benchmarkRun(() => lib(...args));
    const { stats, perSecStr, perItemStr } = result;
    const rate =
      bytes !== undefined
        ? roundRate(perSecondNumber(result, bytesValue(bytes, ctx) / MIB))
        : undefined;
    if (csv) {
      const row = [...curValues];
      if (rate !== undefined) row.push(String(rate));
      row.push(stats.mean.toString(), stats.rme.toFixed(2));
      printCsvRow(row);
    } else if (dryRun) {
      console.log(paintLabel(label));
    } else {
      const caseMode = modeFor(mode, ctx);
      rows.push({
        label,
        mean: stats.mean,
        p50: stats.p50,
        p95: stats.p95,
        p100: stats.max,
        rme: stats.rme,
        rate: caseMode === 'normal' ? rate : undefined,
        mode: caseMode,
        perSecStr,
        perItemStr,
      });
    }
  }
  finishGroup();
}

export default compare;
export { compare };
