# @paulmillr/jsbt

> JS Build Tools

Zero-dependency helpers for secure JS apps, used by [noble cryptography](https://paulmillr.com/noble/).

1. [test](#test) 500-line simplicity with mocha-like syntax and parallelism
2. [benchmark](#benchmark) with nanosecond resolution
3. [CLI](#cli) to create single-file bundles; and check project for common mistakes
4. [tsconfig](#tsconfig) with strict, doc-friendly, with type stripping
5. [workflows](#workflows) for GitHub CI actions for test / npm+jsr publish

## Usage

> `npm install @paulmillr/jsbt`

> `jsr add jsr:@paulmillr/jsbt`

## 1. test

500-line test framework with syntax similar to Mocha / Jest / Vitest. Advantages:

- Colorful tree reporter
- +quiet mode: dot reporter
- +fast mode: use all cores or x cores
- No "global" magic: `it.run()` in the end simplifies logic and browser runs
- RunWhen helper: runs from cli; doesn't run when imported (as subtest)

API:

- `it(title, case)` or `should(title, case)` syntax to register a test function
- `it.only`, `it.skip` allows to limit tests to one case / skip tests
- `beforeEach`, `afterEach` execute code before / after function in `describe` block
- In the end, `it.run()` or `it.runWhen(import.meta.url)` must be executed:
    - runWhen helper ensures tests are not ran when imported from other file. It compares import.meta.url to CLI argument

ENV variables:

- `JSBT_FAST=1` enables parallel execution in node.js and Bun
    - `JSBT_FAST=3` values >1 will set worker count
- `JSBT_FAST=1` enables "quiet" dot reporter

```js
import { should } from 'micro-should';
import { equal } from 'node:assert';
should('add', () => {
  equal(2 + 2, 4);
});
should('work in async env', async () => {
  equal(await Promise.resolve(123), 123);
});
describe('nested', () => {
  describe('nested 2', () => {
    should('multiply', () => {
      equal(2 * 2, 4);
    });
    should.skip('disable test by using skip', () => {
      equal(true, false); // skip
    });
    // should.only('execute only one test', () => {
    //   equal(true, true);
    // });
  });
});

should.runWhen(import.meta.url); // or should.run();
```

## 2. benchmark

200-line benchmarking framework. Advantages:

- Precise: 1ns resolution using `process.hrtime`
- Colorful and with nice units
- Easy switch from ops/sec to mb/sec

```js
import bench from '@paulmillr/jsbt/bench.js';
(async () => {
  await bench('printing', async () => 0);
  await bench('base', () => Promise.resolve(1));
  await bench('sqrt', 10000, () => Math.sqrt(2));
})();
```

Example output:

```
getPublicKey x 6,072 ops/sec @ 164μs/op ± 8.22% [143μs..17ms]
sign x 4,980 ops/sec @ 200μs/op
verify x 969 ops/sec @ 1ms/op
recoverPublicKey x 890 ops/sec @ 1ms/op
getSharedSecret x 585 ops/sec @ 1ms/op
```

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

$ jsbt bundle --stats-only
3790 LOC noble-hashes.js
58.21 KB noble-hashes.min.js
21.10 KB +gzip
```

### check

Runs opinionated code quality checks. Uses typescript parsing underneath.

```
jsbt check <package.json>
jsbt check <package.json> bigint
jsbt check <package.json> bytes
jsbt check <package.json> comments
jsbt check <package.json> errors
jsbt check <package.json> importtime
jsbt check <package.json> jsr
jsbt check <package.json> jsrpublish
jsbt check <package.json> mutate
jsbt check <package.json> patterns
jsbt check <package.json> readme
jsbt check <package.json> tests
jsbt check <package.json> treeshake [out-dir]
jsbt check <package.json> tsdoc
jsbt check <package.json> typeimport
jsbt check-install <package.json>
```

Subcommand summary for `check <package.json> <subcommand>`:

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
* `tests`: run package tests and benchmark entry points.
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
