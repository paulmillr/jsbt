/*! micro-bmark - MIT License (c) 2020 Paul Miller, 2010-2016 Mathias Bynens, John-David Dalton, Robert Kieffer from JSLitmus.js */
/**
 * Benchmark JS projects with nanosecond resolution.
 *
 * `compare` submodule allows to compare runs across different dimensions.
 *
 * @module
 */
// @ts-nocheck
// TODO: remove ^
import { utils } from './bench.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const { benchmarkRaw } = utils;

const _c = String.fromCharCode(27);
const red = _c + '[31m';
const green = _c + '[32m';
const gray = _c + '[2;37m';
const blue = _c + '[34m';
const reset = _c + '[0m';

// Tables stuff
const NN = `${gray}│${reset}`;
const CH = `${gray}─${reset}`;
const LR = `${gray}┼${reset}`;
const RN = `${gray}├${reset}`;
const NL = `${gray}┤${reset}`;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stripAnsi = (str: string) => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
const joinBorders = (str: string) =>
  str
    .replaceAll(`${CH}${NN}${CH}`, `${CH}${LR}${CH}`)
    .replaceAll(`${CH}${NN}`, `${CH}${NL}`)
    .replaceAll(`${NN}${CH}`, `${RN}${CH}`);

const pad = (s, len, end = true) => {
  const diff = len - stripAnsi(s).length;
  if (diff <= 0) return s;
  const padding = ' '.repeat(diff);
  return end ? s + padding : padding + s;
};
function drawHeader(sizes, fields) {
  console.log(fields.map((name, i) => `${capitalize(name).padEnd(sizes[i])} `).join(NN));
}
function drawSeparator(sizes, changed) {
  // border for previous line: space if not changed, CH if changed
  const sep = sizes.map((_, i) => (changed[i] ? CH : ' ').repeat(sizes[i] + 1));
  console.log(joinBorders(sep.join(NN)));
}
function printRow(values, prev, sizes, selected) {
  // If previous (parent) dimension changed, consider next dimension changed too
  const changed = values.map((i) => true);
  const lastSelected = selected.length;
  for (let i = 0, p = false; i < lastSelected; i++) {
    const c = p || !prev || values[i] !== prev[i];
    changed[i] = c;
    if (c) p = true;
  }
  const sel = changed.slice(0, lastSelected);
  const toNotDraw =
    sel.length < 2 ? true : sel.slice(0, sel.length - 1).every((i) => !i) && !!sel[sel.length - 1];
  if (!toNotDraw) drawSeparator(sizes, changed);
  // actual line
  // NOTE: we padStart statistics for easier comparison
  const line = values.map((val, i) =>
    pad(!changed[i] ? ' ' : val, sizes[i] + 1, i < selected.length)
  );
  console.log(line.join(NN));
  return values;
}

const percent = (value, baseline, rev = false) => {
  if (baseline == 0n) return `${gray}N/A${reset}`;
  const changeScaled = ((value - baseline) * 100n) / baseline;
  const sign = changeScaled > 0n ? '+' : changeScaled < 0n ? '' : '';
  const integerPart = changeScaled / 1n;
  let decimalPart = (changeScaled % 1n).toString();
  if (decimalPart.startsWith('-')) decimalPart = decimalPart.slice(1);
  // Ensure two digits for decimal part
  decimalPart = decimalPart.padStart(0, '0');
  const formattedPercent = `${sign}${integerPart}%`;
  let color;
  if (changeScaled > 0n) color = rev ? green : red;
  else if (changeScaled < 0n) color = rev ? red : green;
  else color = gray;
  return `${color}${formattedPercent}${reset}`;
};

const percentNumber = (value, baseline, rev = true) =>
  percent(BigInt(Math.round(value * 1000)), BigInt(Math.round(baseline * 1000)), rev);

// complex queries: noble|stable,1KB|8KB -> matches if (noble OR stable) AND (1KB or 8KB).
// looks at each dimension, returns true if at least one matched
function filterValues(fields, keywords) {
  if (!keywords) return true;
  if (typeof keywords === 'string') keywords = keywords.split(',');
  if (!Array.isArray(fields)) fields = [];
  for (const k of keywords) {
    const parts = k.split('|');
    let found = false;
    for (const f of fields) {
      for (const p of parts) if (f.includes(p)) found = true;
    }
    if (!found) return false;
  }
  return true;
}

export type CompareOpts = {
  libDims?: string[];
  defaults?: Record<string, any>;
  dims?: string[];
  filter?: string | string[];
  filterObj?: (obj: Record<string, any>) => boolean;
  jsonOnly?: boolean;
  dryRun?: boolean;
  patchArgs?: (args: any[], obj: Record<string, any>) => any[];
  samples?: number | ((...args: any[], lib: any) => number);
  compact?: boolean; // Compact/vertical view (MBENCH_COMPACT=1) without tables
  metrics?: Record<
    string,
    {
      unit?: string; // e.g., 'MiB/s'
      rev?: boolean; // Bigger better? Default true
      width?: number; // Column width; same as name if omitted.
      diff?: boolean; // percentage diff if needed
      compute: (obj: Record<string, any>, stats: any, perSec: bigint, ...args: any[]) => number; // Returns value str, e.g., '1684.21'
    }
  >;
  prevFile?: string; // File path to save/load JSON (e.g., './bench-2025-11-14.json')
  printUnchanged?: boolean; // Print row even if unchanged and comparing to previous state
  skipThreshold?: number; // Skip if changed less than threshold percent (default: 5%)
};

const isCli = 'process' in globalThis;
function matrixOpts(opts: CompareOpts) {
  const env = isCli ? process.env : {};
  return {
    // Add default opts from env (can be overriden!)
    filter: env.MBENCH_FILTER ? env.MBENCH_FILTER : undefined, // filter by keywords
    // override order and list of dimensions. disables defaults!
    dims: env.MBENCH_DIMS ? env.MBENCH_DIMS.split(',') : undefined,
    jsonOnly: !!+env.MBENCH_JSON,
    dryRun: !!+env.MBENCH_DRY_RUN, // don't bench, just print table (for debug)
    compact: !!+env.MBENCH_COMPACT,
    loadRun: !!+env.MBENCH_DIFF ? opts.prevFile : undefined,
    saveRun: !!+env.MBENCH_UPDATE && opts.prevFile ? opts.prevFile : undefined,
    printUnchanged: !!+env.MBENCH_UNCHANGED,
    ...opts,
  };
}

async function compare(title: string, dimensions: any, libs: any, opts: CompareOpts): void {
  const {
    libDims = ['name'],
    defaults = {},
    dims,
    filter,
    filterObj = () => true,
    jsonOnly,
    dryRun,
    saveRun,
    loadRun,
    compact = false,
    patchArgs, // patch arguments (very hacky way for decryption)
    samples: defSamples = 10, // default sample value
    skipThreshold = 5, // skip if loadRun and less than 5% difference
    printUnchanged,
    metrics = {},
  } = matrixOpts(opts);
  for (const ld of libDims) {
    if (dimensions[ld] !== undefined)
      throw new Error('Dimensions is static and dynamic at same time: ' + ld);
  }
  for (const [name, config] of Object.entries(metrics)) {
    if (typeof config.compute !== 'function') {
      throw new Error(`Metric '${name}' missing compute function`);
    }
    config.rev = config.rev !== undefined ? config.rev : true;
    config.unit = config.unit !== undefined ? config.unit : '';
  }
  let prevData;
  if (loadRun && isCli) {
    const priorJson = readFileSync(loadRun, 'utf8');
    prevData = JSON.parse(priorJson, (k, v) => (v && v.__BigInt__ ? BigInt(v.__BigInt__) : v)).data;
  }

  if (!jsonOnly) console.log(title); // Title
  // Collect dynamic dimensions
  let dynDimensions = {};
  for (const dim of libDims) dynDimensions[dim] = new Set();
  const stack = Object.entries(libs).map(([key, value]) => ({
    value,
    path: [key],
  }));
  while (stack.length > 0) {
    // - const { value, path } = stack.pop();
    const { value, path } = stack.shift();
    const dimIndex = path.length - 1;
    dynDimensions[libDims[dimIndex]].add(path[path.length - 1]);
    // Add children to stack if it's an object and we haven't hit libDims depth
    if (typeof value === 'object' && value !== null && path.length < libDims.length) {
      for (const [key, child] of Object.entries(value)) {
        if (['options', 'samples'].includes(key)) continue;
        stack.push({ value: child, path: [...path, key] });
      }
    }
  }
  dynDimensions = Object.fromEntries(
    Object.entries(dynDimensions).map(([dim, values]) => [dim, Array.from(values)])
  );
  // Select dimensions
  let selected = dims; // Either overriden by option
  if (selected === undefined) {
    // Or just list dimensions.concat(dynDimensions) without defaults
    selected = [...Object.keys(dimensions), ...Object.keys(dynDimensions)].filter(
      (i) => defaults[i] === undefined
    );
  }
  // always add dimensions without defaults (otherwise we don't know value!)
  const allDims = Object.keys(dynDimensions).concat(Object.keys(dimensions));
  const allDimsReq = allDims.filter((i) => defaults[i] === undefined);
  for (const d of allDimsReq) if (!selected.includes(d)) selected.push(d);
  // Multi-dimensional iterator
  const values = selected.map((i) =>
    dimensions[i] !== undefined ? Object.keys(dimensions[i]) : dynDimensions[i]
  );
  if (!jsonOnly) {
    console.log(
      `Available dimensions: ${allDims
        .map((i) => {
          const flags = [
            dynDimensions[i] !== undefined ? 'dyn' : undefined,
            defaults[i] !== undefined ? 'default' : undefined,
          ].filter((i) => !!i);
          return `${i}${flags.length ? `(${flags.join(', ')})` : ''}`;
        })
        .join(', ')}`
    );
    console.log(
      'Values:',
      allDims
        .map(
          (i) =>
            `${i}(${(dimensions[i] !== undefined
              ? Object.keys(dimensions[i])
              : dynDimensions[i]
            ).join(', ')})`
        )
        .join(', ')
    );
    console.log('Selected:', selected.join(', '));
    console.log('Diff mode:', loadRun ? `previous file${saveRun ? ' (update)' : ''}` : 'first row');
  }
  // selected dimensions column size
  const sizes = selected.map((i, j) =>
    [i, ...values[j]].reduce((acc, i) => Math.max(acc, i.length), 0)
  );
  // Static columns with statistics
  const extraDims = {};
  // Dynamic stuff
  for (const [name, config] of Object.entries(metrics)) {
    const { width, unit, diff } = config;
    const w = width !== undefined ? width : name.length; // Default to name.length
    extraDims[`${name}${unit ? ` ${unit}` : ''}`] = w;
    if (diff) extraDims[`${name} %`] = 8; // '-100.01%'.length
  }
  Object.assign(extraDims, {
    'Ops/sec': 10,
    'Per op': 10,
    'Diff %': 8,
    Variability: 22,
  });
  for (const k in extraDims) extraDims[k] = Math.max(extraDims[k], k.length);

  sizes.push(...Object.values(extraDims));
  if (!jsonOnly && !compact) drawHeader(sizes, selected.concat(Object.keys(extraDims)));
  if (compact) console.log();
  const indices = selected.map((i) => 0); // current value indices
  let prevValues;
  let baselineOps;
  let baselinePerOps;
  let baselineMetrics;
  const res = {};
  main: while (true) {
    const curValues = indices.map((i, j) => values[j][i]);
    if (filterValues(curValues, filter)) {
      const obj = {
        ...defaults,
        ...Object.fromEntries(curValues.map((v, i) => [selected[i], v])),
      };
      // get samples/options
      const lib = libDims.reduce((acc, i) => (acc === undefined ? undefined : acc[obj[i]]), libs);
      // Ugly without continue, but I have no idea howto handle carry then.
      if (lib !== undefined && filterObj(obj)) {
        let options = {};
        let samples = defSamples;
        for (let i = 0, o = libs; i < libDims.length && o; i++) {
          if (o.options !== undefined) options = o.options;
          if (o.samples !== undefined) samples = o.samples;
          o = o[obj[libDims[i]]];
        }
        let args = Object.keys(dimensions)
          .map((i) => dimensions[i][obj[i]])
          .concat(options);
        if (patchArgs) args = patchArgs(args, obj);
        const currSamples = typeof samples === 'function' ? samples(...args, lib) : samples;
        const { stats, perSecStr, perSec, perItemStr } = dryRun
          ? {
              stats: { mean: 0n },
              perSec: 0n,
              perSecStr: '',
              perItemStr: '0ns',
            }
          : await benchmarkRaw(() => lib(...args), currSamples);
        if (baselineOps === undefined && baselinePerOps === undefined) {
          baselineOps = perSec;
          baselinePerOps = stats.mean;
        }
        const metricValues = Object.entries(metrics).map(([k, v]) =>
          v.compute(obj, stats, perSec, ...args)
        );
        if (baselineMetrics === undefined) baselineMetrics = metricValues;
        const rowKey = Object.entries(obj)
          .map(([k, v]) => `${k}=${v}`)
          .join('-');
        const rawData = { ...obj, stats, perSec, metricValues };
        const prevRow = prevData && prevData[rowKey];
        res[rowKey] = rawData;
        const prevMean = prevData ? (prevRow ? prevRow.stats.mean : stats.mean) : baselinePerOps;
        const prevMetrics = metricValues.map((val, i) =>
          prevData ? (prevRow ? prevRow.metricValues[i] : val) : baselineMetrics[i]
        );
        const changePercent = Math.max(
          ...[[stats.mean, prevMean], ...metricValues.map((val, i) => [val, prevMetrics[i]])].map(
            ([curr, prior]) => (prior != 0 ? Math.abs(Number((curr - prior) / prior)) * 100 : 0)
          )
        );
        const needPrint = !prevData || printUnchanged || changePercent > skipThreshold;
        if (!jsonOnly && needPrint) {
          const metricDisplays = metricValues
            .map((val, i) => {
              const { unit, rev = true } = metrics[Object.keys(metrics)[i]];
              return [`${blue}${val}${reset}`, percentNumber(val, prevMetrics[i], rev)];
            })
            .flat();
          const allFields = curValues.concat([
            ...metricDisplays,
            `${green}${perSecStr}${reset}`,
            `${blue}${perItemStr}${reset}/op`,
            // `${percent(perSec, baselineOps, true)}`,
            `${percent(stats.mean, prevMean)}`,
            `${stats.rme >= 1 ? stats.formatted : ''}`,
          ]);
          if (compact) {
            const allHeaders = selected.concat(Object.keys(extraDims));
            allFields.forEach((val, i) => {
              const header = allHeaders[i];
              console.log(`${header.padEnd(15, ' ')}: ${val}`); // Fixed-width label for alignment
            });
            console.log(''); // Blank line between rows/groups
            prevValues = allFields;
          } else {
            prevValues = printRow(allFields, prevValues, sizes, selected);
          }
        }
      }
    }
    // Carry propogation
    for (let pos = indices.length - 1; pos >= 0; pos--) {
      indices[pos]++;
      if (indices[pos] < values[pos].length) break; // No carry needed
      if (pos <= 0) break main;
      indices[pos] = 0; // Reset this position and carry to next
      baselineOps = undefined;
      baselinePerOps = undefined;
      baselineMetrics = undefined;
    }
  }
  // Close table (looks cleaner this way)
  if (!compact && !jsonOnly) {
    drawSeparator(
      sizes,
      sizes.map((i) => true)
    );
  }
  // NOTE: these done in compact format, so in case of multiple things we can just split by lines to parse
  const json = JSON.stringify({ name: title, data: res }, (k, v) => {
    if (typeof v === 'bigint') return { __BigInt__: v.toString(10) };
    return v;
  });
  if (jsonOnly) console.log(json);
  if (saveRun && isCli) writeFileSync(saveRun, json, 'utf8');
}

export default compare;
export { compare };
