# @paulmillr/jsbt

> JS Build Tools

Zero-dependency helpers for secure JS apps, used by [noble cryptography](https://paulmillr.com/noble/).

1. [test](#test) 500-line simplicity with mocha-like syntax and parallelism
2. [benchmark](#benchmark) with nanosecond resolution
3. [CLI](#cli) to create single-file bundles; and check project for common mistakes
4. [workflows](#workflows) for GitHub CI actions for test / npm+jsr publish
5. [tsconfig](#tsconfig) with strict, doc-friendly, with type stripping

## Usage

> `npm install @paulmillr/jsbt`

> `jsr add jsr:@paulmillr/jsbt`

## 1. test

Small test runner with familiar `describe` / `it`  mocha-like syntax, explicit execution, and
optional parallelism. It is intended for tests that should run unchanged from standalone files,
aggregate test entrypoints, and browser bundles.

API:

- `it(title, fn)` register sync or async tests.
- `describe(title, fn)` groups tests and scopes `beforeEach` / `afterEach`.
- `it.only(title, fn)` runs one test; `should.skip(title, fn)` reports a skipped test.
- `it.serial(title, fn)` keeps a test on the main process when fast mode is enabled.
- `it.run()` runs the current file's registered tests.
- `it.runWhen(import.meta.url)` runs only when the file was launched directly, which keeps
  imported subtests from running twice in aggregate test files.

ENV variables:

- `JSBT_FAST=1` enables parallel execution with all available cores.
- `JSBT_FAST=3` uses three workers.
- `JSBT_FAST=-1` uses all cores minus one.
- `JSBT_FAST=0.5` uses half of available cores.
- `JSBT_QUIET=1` enables the dot reporter.

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
```

## 2. benchmark

Lightweight benchmark helpers with nanosecond timing, terminal-friendly output, throughput units,
and a matrix runner for comparing libraries, algorithms, platforms, input sizes, and other
dimensions.

### bench

Use `bench` for simple one-line measurements:

```js
import bench from '@paulmillr/jsbt/bench.js';

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
- `maxRunTimeSec`: per-benchmark runtime, from `0.1` to `60` seconds.
- `mode: 'runOnce'`: run one measurement and print only elapsed time.

Example output:

```
sqrt x 6,072 ops/sec @ 164μs/op
copy 1MiB x 1,420 mib/sec
blocks x 92,400 blocks/sec
```

### bench-compare

Use `bench-compare` for benchmark matrices. Static dimensions provide benchmark arguments; nested
library objects provide dynamic dimensions.

```js
import compare from '@paulmillr/jsbt/bench-compare.js';

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
- `iterations`: repeats one measured operation and reports per-iteration timing.
- `patchArgs`: rewrites generated benchmark arguments before calling a library function.
- `bytes`, `throughput`, `metrics`: add throughput or custom metric columns.
- `loadRun`, `skipThreshold`, `printUnchanged`: compare against a saved previous run.
- `format`: `table` or `csv`; table is the default when colors are enabled, CSV otherwise.

ENV variables:

- `JSBT_BENCHMARK_FILTER=sha256,1MiB` filters cases by dimension values.
- `JSBT_BENCHMARK_DIMENSIONS=algorithm,size,name` changes dimension order or visible dimensions.
- `JSBT_BENCHMARK_DRY_RUN=1` prints the selected matrix without measuring.
- `JSBT_CSV=1` forces CSV output.

## 3. CLI

jsbt CLI does single-file bundling and executes audit helpers.

### bundle

A few helpers on top of [esbuild](https://esbuild.github.io).

1. Gathers all package exports
2. Gathers all dependencies
3. Creates one file, bundling everything in it, declaring a global variable with package name
4. Prints file stats

```
$ jsbt bundle
11d1900e99f3aa945603bb5e7d82bdd9ec6ddf5d30e2fcab69b836840cff76d2 test/build/out/noble-hashes.js
0be3876ff0816c44d21a401e6572fdb76d06012c760a23a5cb771c6f612106f5 test/build/out/noble-hashes.min.js

3790 LOC noble-hashes.js
58.21 KB noble-hashes.min.js
21.10 KB +gzip
```

bundle command operates either in 1) `test/build` of the project 2) system-wide tmp directory.

There are following options:

```
$ jsbt bundle --dir=test/build
# (same as jsbt bundle, but uses specific dir instead of defaults)

$ jsbt bundle --stats
3790 LOC noble-hashes.js
58.21 KB noble-hashes.min.js
21.10 KB +gzip
```

### check

Runs opinionated code quality checks. Uses typescript parsing underneath.
Temporary build artifacts are created in a per-run OS temp directory and removed after the summary.

```
jsbt check [--project=<directory>]
jsbt check [--project=<directory>] bigint
jsbt check [--project=<directory>] bytes
jsbt check [--project=<directory>] comments
jsbt check [--project=<directory>] errors
jsbt check [--project=<directory>] importtime
jsbt check [--project=<directory>] jsr
jsbt check [--project=<directory>] jsrpublish
jsbt check [--project=<directory>] mutate
jsbt check [--project=<directory>] patterns
jsbt check [--project=<directory>] readme
jsbt check [--project=<directory>] treeshake
jsbt check [--project=<directory>] tsdoc
jsbt check [--project=<directory>] typeimport
jsbt check-install <package.json>
```

With `"check": "npx --no @paulmillr/jsbt check"` in `package.json`, selectors can be run
through npm:

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
npm run check treeshake
npm run check tsdoc
npm run check typeimport
```

Subcommand summary for `check <subcommand>`:

* `bigint`: find BigInt compatibility hazards in public runtime files.
* `bytes`: inspect byte/typed-array API surface and TypeScript-version compatibility.
* `comments`: enforce comments and release-facing source annotations.
* `errors`: verify documented thrown errors against runtime probes.
* `importtime`: measure public entry import time and flag slow imports.
* `jsr`: validate JSR package metadata, exports, imports, and publish graph.
* `jsrpublish`: run stricter JSR publish-readiness checks.
* `mutate`: detect mutation hazards in public runtime behavior.
* `patterns`: report source patterns that are risky for published packages.
* `readme`: type-check and run runnable README examples.
* `treeshake`: bundle public exports and report retained unused code.
* `tsdoc`: audit public declaration docs and examples.
* `typeimport`: verify imports that should be type-only.
* `check-install`: rewrite package check scripts to the current unified form.

## 4. Workflows

Secure GitHub CI configs for testing & publishing JS packages.

The files reside in `.github/workflows`:

* `test.yml`: reusable/manual test workflow for Node 22, 24, 26, Bun, and Deno. It runs
  `npm run build --if-present`, `npm test`, optional `test:tsc` on Node 26, optional `test:bun`,
  and optional `test:deno`. Inputs: `submodules` and `runs-on`.
* `test-matrix.yml`: reusable/manual Node matrix across Node 22, 24, 26 on `ubuntu-24.04-arm`,
  `macos-latest`, and `windows-latest`.
* `test-custom.yml`: reusable Node 26 workflow for one custom npm task, defaulting to `test:slow`.
* `release.yml`: release/reusable/manual publisher for NPM, and JSR when `jsr.json` exists. It
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
  "include": [
    "src"
  ],
  "exclude": [
    "node_modules"
  ]
}
```

## License

MIT License
