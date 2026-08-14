# @paulmillr/jsbt

> JS Build Tools

Zero-dependency helpers for secure JS apps, used by [noble cryptography](https://paulmillr.com/noble/).

1. [test](#test) 500-line simplicity with mocha-like syntax and parallelism
2. [benchmark](#benchmark) with nanosecond resolution
3. [CLI](#cli) to check project for common mistakes
4. [workflows](#workflows) for GitHub CI actions for test / npm+jsr publish
5. [tsconfig](#tsconfig) with strict, doc-friendly, with type stripping

## Usage

> `npm install @paulmillr/jsbt`

> `jsr add jsr:@paulmillr/jsbt`

## 1. test

Small test runner with familiar `describe` / `it` mocha-like syntax, explicit execution, and
optional parallelism.

API:

- `it(title, fn)` register sync or async tests.
- `describe(title, fn)` groups tests and scopes `beforeEach` / `afterEach`.
- `it.only(title, fn)` runs one test; `should.skip(title, fn)` reports a skipped test.
- `it.serial(title, fn)` keeps a test on the main process when fast mode is enabled.
- `it.run()` runs the current file's registered tests.
- `it.runWhen(import.meta.url)` runs only when the file was launched directly, which keeps
  imported subtests from running twice in aggregate test files.

ENV variables:

- `JSBT_BAIL=0` disables stopping after the first failed test (`1` by default).
- `JSBT_FAST=1` enables parallel execution with all available cores.
- `JSBT_FAST=3` uses three workers.
- `JSBT_FAST=-1` uses all cores minus one.
- `JSBT_FAST=0.5` uses half of available cores.
- `JSBT_QUIET=1` enables the quiet (dot) reporter.
- `JSBT_FILTER=math/adds` runs tests whose full path contains the value.

```js
import { deepStrictEqual } from 'node:assert';
import { beforeEach, describe, it } from '@paulmillr/jsbt/test.js';

describe('math', () => {
  let value = 0;

  beforeEach(() => {
    value = 2;
  });

  it('adds', () => {
    deepStrictEqual(value + 2, 4);
  });

  it('works with async code', async () => {
    deepStrictEqual(await Promise.resolve(value * 3), 6);
  });

  it.skip('documents known gaps without running them', () => {
    deepStrictEqual(true, false);
  });
});

await should.runWhen(import.meta.url);
```

Run a project test entrypoint with node:

```
node test/index.ts
JSBT_FAST=1 node test/index.ts
JSBT_QUIET=1 node test/index.ts
JSBT_FILTER=math/adds node test/index.ts
```

When launched by `node --test`, `jsbt/test` registers suites, hooks, and test cases with
Node's native runner instead of printing its own report. Existing `it.run()` and
`it.runWhen(import.meta.url)` calls become harmless in that mode, so the same files can be run
directly or through Node's test runner.

## 2. benchmark

Lightweight benchmark helpers with nanosecond timing, terminal-friendly output, throughput units,
and a matrix runner for comparing libraries, algorithms, platforms, input sizes, and other
dimensions.

### benchmark

Use `bench` for simple one-line measurements:

```js
import bench from '@paulmillr/jsbt/benchmark.js';

const data = new Uint8Array(1024 * 1024);
const processBlock = () => data[0];

await bench('sqrt', () => Math.sqrt(2));
await bench('copy 1MiB', () => data.slice(), { bytes: data.byteLength });
await bench('blocks', () => processBlock(), { throughput: { amount: 16, unit: 'blocks' } });
```

Options:

- `bytes`: bytes processed by one benchmark iteration; output is `b/sec`, `kib/sec`, `mib/sec`,
  or `gib/sec`.
- `throughput`: custom units processed by one iteration, for example `{ amount: 16, unit: 'blocks' }`.
- `maxRunTimeSec`: per-benchmark runtime, from `0.1` to `60` seconds; defaults to `0.4`.
  Every measured run first performs an untimed warmup lasting one quarter of this duration.
- `mode: 'time'`: print aggregate mean duration per operation.
- `mode: 'latency'`: print p50, p95, and p100 (maximum) latency.
- `mode: 'once'`: run one measurement and print only elapsed time. `runOnce` remains an alias.
- `section('math')` named export: print `# math` in text output and prefix CSV names as
  `math; <name>`. `section()` or `section('')` disables the prefix.
- `JSBT_CSV=1` forces CSV output. CSV prints `name,nanoseconds` by default, or
  `name,<unit>/sec` for `bytes` and `throughput`, and is also the default when color
  output is disabled.

Example output:

```
sqrt x 6,072 ops/sec @ 164 μs/op
copy 1MiB x 1,420 mib/sec
blocks x 92,400 blocks/sec
```

### benchmark-compare

Use `benchmark-compare` for benchmark matrices. Static dimensions provide benchmark arguments; nested
library objects provide dynamic dimensions.

```js
import compare from '@paulmillr/jsbt/benchmark-compare.js';

const sizes = {
  '1KB': new Uint8Array(1024),
  '1MiB': new Uint8Array(1024 * 1024),
};

const libraries = {
  js: (buf) => buf.slice(),
  native: (buf) => Buffer.from(buf),
};

await compare('copy', { size: sizes }, libraries, {
  bytes: ({ args }) => args[0].byteLength,
});
```

Common options:

- `libraryDimensions`: names for nested library levels; defaults to `['name']`.
- `defaults`: fixed dimension values that should not vary in the table.
- `dimensions`: explicit dimension order and subset.
- `filter`: comma-separated match terms; `a|b,c` means `(a or b) and c`.
- `filterObj`: predicate for filtering generated benchmark cases.
- `mode`: `normal` for aggregate throughput, `time` for aggregate mean duration, or
  `latency` for p50/p95/p100 latency; may be selected per case with a function.
  Every non-dry case is warmed independently for one quarter of its measurement time.
- `iterations`: repeats one measured operation and reports per-iteration timing.
- `patchArgs`: rewrites generated benchmark arguments before calling a library function.
- `bytes`, `throughput`, `metrics`: add throughput or custom metric columns.
- `loadRun`, `skipThreshold`, `printUnchanged`: compare against a saved previous run.
- `format`: `table` or `csv`; table is the default when colors are enabled, CSV otherwise.

ENV variables:

- `FILTER` selects cases by substring-matching dimension values: `FILTER=sha256,1MB`
  requires every comma term to match some dimension; the scoped form
  `FILTER='algorithm=sha3_256;library=awasm,noble'` pins terms to a dimension,
  with commas as alternatives.
- `JSBT_BENCHMARK_DIMENSIONS=algorithm,size,name` changes dimension order or visible dimensions.
- `JSBT_BENCHMARK_DRY_RUN=1` prints the selected matrix without measuring.
- `JSBT_CSV=1` forces CSV output.

## 3. CLI

`jsbt-check` CLI executes audit helpers.

### check

Runs opinionated code quality checks. Uses typescript parsing underneath.
Temporary build artifacts are created in a per-run OS temp directory and removed after the summary.

Example-running checks (`readme`, `tsdoc`, `errors`) execute examples in an isolated temp run
directory. Its `node_modules` is assembled from symlinks — nothing is fetched at check time:

- the checked package itself, installed under its own name;
- the package's runtime `dependencies`, linked from the project's installed `node_modules`;
- extra example-only imports allowed by `exampleDependencies` in a committed `.jsbtrc.json`
  beside `package.json`, pinned to exact installed versions:

```json
{
  "exampleDependencies": {
    "micro-packed": "0.7.3"
  }
}
```

An example importing anything else fails at run time with `ERR_MODULE_NOT_FOUND`, naming the
package but not the list it is missing from. When any check reports one, `jsbt-check` prints
a reminder about `exampleDependencies` once, after the last check.

`esbuild` (importable by example code) is provided automatically and must not be listed: it
is resolved from the project's `node_modules`, from the copy next to jsbt itself, or from a
global install. If none is found, run `npm install -g esbuild`. The `size` selector measures
through [bismar](https://github.com/paulmillr/bismar), which brings its own pinned esbuild.

The checks always parse and type-check with jsbt's own pinned `typescript`, never with the
one the checked project installs. The checks drive the JS compiler API directly, and a
project is free to depend on a TypeScript that does not expose it — the v7 native port is a
Go rewrite with a different surface. Pinning one compiler also keeps verdicts identical
across repos, and lets `jsbt-check` run in a project with no `node_modules` of its own.

Checks run against the package in the current directory; in a monorepo, `cd` into the
package first.

```
jsbt-check
jsbt-check bigint
jsbt-check bytes
jsbt-check comments
jsbt-check errors
jsbt-check importtime
jsbt-check jsr
jsbt-check jsrpublish
jsbt-check mutate
jsbt-check patterns
jsbt-check readme
jsbt-check size
jsbt-check tsdoc
jsbt-check typeimport

jsbt-check --ignore=readme,tsdoc
jsbt-check --gen-config
```

`--ignore=<a,b>` skips the listed selectors; it accepts the same names as the selector
argument and errors if nothing would be left to run.

The one non-check mode is `--gen-config`, which writes size budgets instead of auditing
— see [size limits](#size-limits) below.

With `"check": "jsbt-check"` in `package.json` scripts, selectors can be run through npm:

```
npm run check bigint
npm run check bytes
npm run check comments
npm run check errors
npm run check importtime
npm run check jsr
npm run check jsrpublish
npm run check mutate
npm run check patterns
npm run check readme
npm run check size
npm run check tsdoc
npm run check typeimport
```

Selector summary for `jsbt-check <selector>`:

- `bigint`: find BigInt compatibility hazards in public runtime files.
- `bytes`: inspect byte/typed-array API surface and TypeScript-version compatibility.
- `comments`: enforce comments and release-facing source annotations.
- `errors`: verify documented thrown errors against runtime probes.
- `importtime`: measure public entry import time and flag slow imports.
- `jsr`: validate JSR package metadata, exports, imports, and publish graph.
- `jsrpublish`: run stricter JSR publish-readiness checks.
- `mutate`: detect mutation hazards in public runtime behavior.
- `patterns`: report source patterns that are risky for published packages.
- `readme`: type-check and run runnable README examples.
- `size`: audit release bundles for retained unused code and enforce `sizeLimits` budgets.
- `tsdoc`: audit public declaration docs and examples.
- `typeimport`: verify imports that should be type-only.

#### size limits

`jsbt-check size` measures release bundles with
[bismar](https://github.com/paulmillr/bismar) — the same engine behind `bismar --size` and
`bismar -bs` — then audits them for unused locals that survived bundling and enforces the
gzip budgets in `sizeLimits`:

```json
{
  "sizeLimits": {
    "index.js": "8kb",
    "index.js/add": 4096,
    "index.js/sign index.js/verify": "6kb"
  }
}
```

Keys are `bismar --size` selectors; values are bytes (`4096`) or a kb string (`"4kb"`,
1kb = 1024). A space-separated key budgets the combined bundle of all its selectors — their
cost when imported together, with shared code counted once. Only local modules and exports
can be budgeted.

The check itself prints no stats. To debug an over-budget entry, ask bismar directly:
`bismar -bs <selector...>` for the numbers, `bismar <selector> > out.js` for the measured
bundle bytes.

`jsbt-check --gen-config` writes or updates `.jsbtrc.json` with one budget per public
module at its current size; existing entries are hand-set and never touched, and the rest of
the file carries over unchanged. It is a mode of its own rather than a flag on `size`: it
runs no checks, takes no selector, and is the one `jsbt-check` invocation that writes to the
package directory.

## 4. Workflows

Secure GitHub CI configs for testing & publishing JS packages.

The files reside in `.github/workflows`:

- `test.yml`: reusable/manual test workflow for Node 22, 24, 26, Bun, and Deno. It runs
  `npm run build --if-present`, `npm test`, optional `test:tsc` on Node 26, optional `test:bun`,
  and optional `test:deno`. Inputs: `submodules` and `runs-on`.
- `test-matrix.yml`: reusable/manual Node matrix across Node 22, 24, 26 on `ubuntu-24.04-arm`,
  `macos-latest`, and `windows-latest`.
- `test-custom.yml`: reusable Node 26 workflow for one custom npm task, defaulting to `test:slow`.
- `release.yml`: release/reusable/manual publisher for NPM, and JSR when `jsr.json` exists. It
  uses OIDC Trusted Publishing, disables package-manager cache, runs `npm ci`, builds when present,
  verifies package/tag versions, dry-runs NPM publish, validates JSR version, and publishes through
  `npm stage publish --access public`.

You can copy them, or depend on them directly:

```yaml
name: jsbt 0.5.2
on:
  push:
  pull_request:
jobs:
  test:
    uses: paulmillr/jsbt/.github/workflows/test.yml@0.5.2
```

For releases, configure NPM Trusted Publishing for the package first:

```yaml
name: Publish release
on:
  release:
    types: [created]
jobs:
  publish:
    uses: paulmillr/jsbt/.github/workflows/release.yml@0.5.2
    permissions:
      contents: read
      id-token: write
```

## 5. tsconfig

Strict typescript v6+ configs, friendly to type stripping. Uses `isolatedDeclarations` and `verbatimModuleSyntax`
to ensure node.js is able to natively run typescript files without compilation.

There are two files: `tsconfig.json` and `tsconfig.test.json` (looser, for tests).

Inheritable in the following way:

```json
{
  "extends": "@paulmillr/jsbt/tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "."
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}
```

## License

MIT License
