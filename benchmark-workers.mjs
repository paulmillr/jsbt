#!/usr/bin/env node
/*! jsbt - MIT License (c) 2019 Paul Miller (paulmillr.com) */
// Benchmarks a jsbt test suite across worker counts and runtimes, for comparing
// machines. Zero dependencies; run with node from any directory:
//
//   node benchmark-workers.mjs --repo ~/Developer/noble/curves
//   node benchmark-workers.mjs --repo . --workers 4,8,12 --runtimes node,deno --passes 3
//   node benchmark-workers.mjs --repo . --csv >> results.csv   # collect across machines
//
// Options:
//   --repo <dir>       repository to benchmark (default: cwd)
//   --entry <file>     test entry, relative to repo (default: test/index.ts)
//   --workers <list>   comma-separated counts (default: 1,2,4,... up to core count)
//   --runtimes <list>  node,deno,bun — missing runtimes are skipped (default: node,deno)
//   --passes <n>       runs per config; best (min) wall time is reported (default: 2)
//   --timeout <sec>    per-run timeout (default: 600)
//   --csv              machine-tagged CSV rows instead of a table
import { spawnSync } from 'node:child_process';
import { availableParallelism, cpus, hostname, platform, arch } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const repo = opt('repo', process.cwd());
const entry = opt('entry', 'test/index.ts');
const cores = availableParallelism();
const defaultWorkers = () => {
  const list = [];
  for (let w = 1; w < cores; w *= 2) list.push(w);
  list.push(cores);
  return list;
};
const workers = opt('workers', '')
  ? opt('workers', '').split(',').map(Number)
  : defaultWorkers();
const runtimes = opt('runtimes', 'node,deno').split(',');
const passes = Number(opt('passes', '2'));
const timeoutMs = Number(opt('timeout', '600')) * 1000;
const csv = flag('csv');

if (workers.some((w) => !Number.isInteger(w) || w < 1)) {
  console.error(`invalid --workers: ${opt('workers', '')}`);
  process.exit(1);
}

const RUNTIME_ARGS = {
  node: (file) => ['node', [file]],
  deno: (file) => ['deno', ['run', '-A', file]],
  bun: (file) => ['bun', [file]],
};

const runtimeVersion = (runtime) => {
  const res = spawnSync(runtime, ['--version'], { encoding: 'utf8' });
  if (res.error) return undefined;
  return (res.stdout || '').trim().split('\n')[0];
};

const runOnce = (runtime, workerCount) => {
  const [cmd, cmdArgs] = RUNTIME_ARGS[runtime](join(repo, entry));
  const env = { ...process.env, JSBT_QUIET: '1', JSBT_WORKERS: String(workerCount) };
  delete env.JSBT_BAIL;
  delete env.JSBT_FILTER;
  delete env.JSBT_DEBUG;
  const start = process.hrtime.bigint();
  const res = spawnSync(cmd, cmdArgs, { cwd: repo, encoding: 'utf8', env, timeout: timeoutMs });
  const wallSec = Number(process.hrtime.bigint() - start) / 1e9;
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  const passed = /(\d+) tests passed/.exec(text);
  if (res.status !== 0 || !passed) {
    const reason =
      res.error?.code === 'ETIMEDOUT'
        ? 'timeout'
        : (text.trim().split('\n').at(-1) || res.error?.message || `exit ${res.status}`).slice(0, 60);
    return { ok: false, wallSec, reason };
  }
  return { ok: true, wallSec, tests: Number(passed[1]) };
};

const machine = `${hostname()} ${platform()}/${arch()} ${cores}c (${cpus()[0]?.model?.trim() || '?'})`;
if (!csv) {
  console.log(`repo: ${repo} (entry: ${entry})`);
  console.log(`machine: ${machine}`);
} else {
  console.log('machine,runtime,version,workers,tests,best_sec,runs_sec');
}

for (const runtime of runtimes) {
  if (!RUNTIME_ARGS[runtime]) {
    console.error(`unknown runtime: ${runtime}`);
    continue;
  }
  const version = runtimeVersion(runtime);
  if (version === undefined) {
    if (!csv) console.log(`\n${runtime}: not installed, skipping`);
    continue;
  }
  if (!csv) console.log(`\n${runtime} (${version})`);
  for (const w of workers) {
    const runs = [];
    let failure;
    for (let p = 0; p < passes; p++) {
      const run = runOnce(runtime, w);
      if (!run.ok) {
        failure = run.reason;
        break;
      }
      runs.push(run);
    }
    const label = `workers=${String(w).padEnd(3)}`;
    if (failure !== undefined) {
      console.log(csv ? `# ${runtime} workers=${w} FAILED: ${failure}` : `  ${label} FAILED: ${failure}`);
      continue;
    }
    const times = runs.map((r) => r.wallSec);
    const best = Math.min(...times);
    const all = times.map((t) => t.toFixed(1)).join(' ');
    if (csv) {
      console.log(`"${machine}",${runtime},"${version}",${w},${runs[0].tests},${best.toFixed(1)},"${all}"`);
    } else {
      console.log(`  ${label} best=${best.toFixed(1).padStart(6)}s  (runs: ${all})  ${runs[0].tests} tests`);
    }
  }
}
