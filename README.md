# @paulmillr/jsbt

> JS Build Tools

Zero-dependency helpers for secure JS apps, used by [noble cryptography](https://paulmillr.com/noble/).

1. [test](#test) 500-line simplicity with mocha-like syntax and parallelism
2. [benchmark](#benchmark) with nanosecond resolution
3. [CLI](#cli): single-file bundles and size stats, now in the separate [baler](./baler) package
4. [jsbt-check](#jsbt-check) to check project for common mistakes
5. [workflows](#workflows) for GitHub CI actions for test / npm+jsr publish
6. [tsconfig](#tsconfig) with strict, doc-friendly, with type stripping

## Usage

> `npm install @paulmillr/jsbt`

> `jsr add jsr:@paulmillr/jsbt`

## 1. test

Small test runner with familiar `describe` / `it`  mocha-like syntax, explicit execution, and
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
- `JSBT_QUIET=1` enables the dot reporter.
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

### bench

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
- `mode: 'runOnce'`: run one measurement and print only elapsed time.
- `section('math')` named export: print `# math` in text output and prefix CSV names as
  `math; <name>`. `section()` or `section('')` disables the prefix.
- `JSBT_CSV=1` forces CSV output. CSV prints `name,nanoseconds` by default, or
  `name,<unit>/sec` for `bytes` and `throughput`, and is also the default when color
  output is disabled.

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
- `iterations`: repeats one measured operation and reports per-iteration timing.
- `patchArgs`: rewrites generated benchmark arguments before calling a library function.
- `bytes`, `throughput`, `metrics`: add throughput or custom metric columns.
- `loadRun`, `skipThreshold`, `printUnchanged`: compare against a saved previous run.
- `format`: `table` or `csv`; table is the default when colors are enabled, CSV otherwise.

ENV variables:

- `JSBT_FILTER=sha256,1MiB` filters cases by dimension values.
- `JSBT_BENCHMARK_DIMENSIONS=algorithm,size,name` changes dimension order or visible dimensions.
- `JSBT_BENCHMARK_DRY_RUN=1` prints the selected matrix without measuring.
- `JSBT_CSV=1` forces CSV output.

## 3. CLI

Single-file bundles and size stats moved to the separate
[baler](./baler) package (`npm install baler`), which has exactly one
dependency: esbuild. One command, two outputs:

- `baler <selector>` packs the selection into a single-file IIFE bundle on stdout — nothing else
- `baler <selector> --size` prints min+gzip size stats of the same bundles instead
- `baler -i <selector>` navigates a package's modules and exports interactively, like a filesystem

`npx baler preact --size` works from any directory. See
[baler's README](./baler/README.md) for full docs. The `sizeLimits` budgets of
[`jsbt-check`](#jsbt-check) use baler's selector engine and size measurement
under the hood.

## 4. jsbt-check

Runs opinionated code quality checks. Uses typescript parsing underneath.
Temporary build artifacts are created in a per-run OS temp directory and removed after the summary.

```
jsbt-check
jsbt-check bigint
jsbt-check bytes
jsbt-check comments
jsbt-check errors
jsbt-check importtime
jsbt-check jsdoc
jsbt-check jsr
jsbt-check jsrpublish
jsbt-check mutate
jsbt-check patterns
jsbt-check readme
jsbt-check size
jsbt-check tsdoc
jsbt-check typeimport
```

With `"check": "jsbt-check"` in `package.json`, selectors can be run
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
npm run check size
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
* `size`: bundle public exports, measure bundle sizes, report retained unused code,
  enforce `sizeLimits` budgets from `.jsbtrc.json`.
* `tsdoc`: audit public declaration docs and examples.
* `typeimport`: verify imports that should be type-only.

### .jsbtrc.json config

Checks read optional configuration from a `.jsbtrc.json` file beside
`package.json`; unknown keys are rejected:

```json
{
  "sizeLimits": {
    "secp256k1.js/secp256k1": "4kb"
  },
  "exampleDependencies": {
    "@noble/hashes": "2.2.0"
  }
}
```

* `sizeLimits`: gzip size budgets enforced by `jsbt-check size`. Keys are `baler --size`
  selectors (`module`, `module/export`); values are bytes (`4096`) or a kb string
  (`"4kb"`, 1kb = 1024 bytes). A key with several space-separated selectors
  (`"index.js/sign index.js/verify"`) budgets their combined bundle — the cost when
  imported together, with shared code counted once. A bundle whose gzipped size
  exceeds its budget fails the check.
* `exampleDependencies`: third-party packages that examples — runnable README
  fences and TSDoc `@example` blocks — may import, pinned to exact versions. They
  are symlinked into the isolated run directory from the project's own installed
  `node_modules` — nothing is fetched at check time, and the check fails if the
  installed version differs from the pin. Packages listed in `dependencies` are
  implicitly trusted and must not be repeated here.

`--generate-jsbtrc` produces or updates the file, one section per selector (the
other section carries over untouched): `jsbt-check size --generate-jsbtrc` adds a
budget per public module at its current gzip size (existing entries are hand-set
budgets and are never overwritten); `jsbt-check readme --generate-jsbtrc` and
`jsbt-check tsdoc --generate-jsbtrc` both compile `exampleDependencies` from
third-party imports across all example sources — runnable README fences plus TSDoc
`@example` fences in public declarations — pinned to the installed versions. Review
the diff before committing — those two committed sections define what the checks
trust.

## 5. Workflows

Secure GitHub CI configs for testing & publishing JS packages.

The files reside in `.github/workflows`:

* `test.yml`: reusable/manual test workflow for Node 22, 24, 26, Bun, and Deno. It runs
  `npm run build --if-present` and `npm test`. `test:tsc`, `test:bun`, and `test:deno` are run
  when present; otherwise they fall back to defaults derived from the repo: `test:tsc` runs
  `cd test && npx tsc && node compiled/test/index.js` when `test/tsconfig.json` exists, and
  `test:bun`/`test:deno` run the `test` script's file (its `node <file>` invocation) directly
  under `bun`/`deno --allow-env --allow-read`. Inputs: `submodules` and `runs-on`.
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

## 6. tsconfig

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

## Troubleshooting

**Pager keys stop working after `baler … | bat`.** Node snapshots the
terminal state at startup and restores it on exit. When a pager takes a moment
to start (bat loads syntax assets before spawning `less`), the restore lands
*after* the pager switched the terminal to raw mode, knocking it back to
line-buffered input — keystrokes queue up instead of reaching the pager. This
affects any Node CLI piped into `bat`; plain `less` usually wins the race.
Fix a stuck pager with `Ctrl-Z` then `fg` (it re-initializes the terminal), or
avoid the race entirely by detaching baler from the terminal:

```sh
baler sha2.js/sha256 </dev/null 2>/dev/null | bat -l js
```

## License

MIT License
