# @paulmillr/jsbt

JS Build Tools: helpers for building, benchmarking & testing secure JS apps.

- 🤖 workflows: Secure GitHub CI actions for testing & token-less publishing of JS packages using OIDC.
- 🏋🏻 bench: Benchmark JS projects with nanosecond resolution.
- 📝 test: Multi-env testing framework with familiar syntax & parallel execution
- 🏗️ jsbt.js: Auto-produce single-file output for all package exports
- ⚙️ tsconfig: Strict typescript configs, friendly to type stripping
- 🪶 No dependencies

Used by [noble cryptography](https://paulmillr.com/noble/) and others.

## Usage

> `npm install @paulmillr/jsbt`

> `jsr add jsr:@paulmillr/jsbt`

- [🤖 CI workflows](#workflows)
- [🏋🏻 bench](#bench)
- [📝 test](#test)
- [🏗️ jsbt.js](#jsbtjs)
- [⚙️ tsconfig](#tsconfig)
- [repo-template](#repo-template)

## CI workflows

Secure GitHub CI configs for testing & publishing JS packages.

The files reside in `.github/workflows`:

* `test-js.yml`: runs tests on LTS node.js, bun, deno, linter, and calculates coverage
* `test-ts.yml`: the same, but runs typescript instead of js on supported node.js (v22+)
  On node.js v20, it executes `test:nodeold` to compile files instead.
* `release.yml` publishes package on NPM, JSR and creates single-file output if it exists
    * Uses brand new token-less GitHub OIDC connector to NPM, ensure to link package in npm settings first
    * The Trusted Publishing also provides provenance statements by default
    * It happens after GitHub release is created

You can copy them, or depend on them directly:

```yaml
name: Publish release
on:
  release:
    types: [created]
jobs:
  release-js:
    name: 'jsbt v0.4.5'
    uses: paulmillr/jsbt/.github/workflows/release.yml@570adcfe0ed96b477bb9b35400fb43fd9406fb47
    permissions:
      contents: read
      id-token: write
```

## bench

> Benchmark JS projects with nanosecond resolution

- Precise: 1ns resolution using `process.hrtime`
- Lightweight: ~200 lines of code
- Readable: utilizes colors and nice units, shows rel. margin of error only if it's high

```js
import bench from '@paulmillr/jsbt/bench.js';
(async () => {
  await bench('printing', () => Promise.resolve(0));
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

## test

Multi-env testing framework with familiar syntax & parallel execution.

- Familiar syntax: similar to Mocha / Jest / Vitest
- Multi-env: runs on node.js, deno, bun, cloudflare, browsers and others
- No "global" magic: `it.run()` in the end simplifies logic and browser runs
- Parallel: easily run in node.js and bun
- Great UI: beautiful tree reporter, optional "quiet" dot reporter

> `node a.test.js`

> `MSHOULD_FAST=1 MSHOULD_QUIET=1 node a.test.js`

```js
import { should } from 'micro-should';
import { equal } from 'node:assert';
// Any assertion library can be used e.g. Chai or Expect.js
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

should.runWhen(import.meta.url);
// or
// should.run();
// should.opts.STOP_AT_ERROR = false; // default=true
// should.opts.MSHOULD_QUIET = true; // same as env var
```

Usage:

- `should(title, case)` or `it(title, case)` syntax to register a test function
- `should.only`, `should.skip` allows to limit tests to one case / skip tests
- `beforeEach`, `afterEach` execute code before / after function in `describe` block
- `should.runWhen(import.meta.url)` must be executed in the end
    - The helper ensures tests are not ran when imported from other file
    - It compares import.meta.url to CLI argument
- `should.run()` or `it.run()` must always be executed in the end

ENV variables, specifiable via command line or through code:

- `MSHOULD_FAST=1` enables parallel execution in node.js and Bun. Values >1 will set worker count.
- `MSHOULD_QUIET=1` enables "quiet" dot reporter

## jsbt.js

`jsbt.js` calls [esbuild](https://esbuild.github.io) to produce single-file package output.

Usage (add this as `"build:release"` step in `package.json scripts` section):

> `npx --no @paulmillr/jsbt esbuild test/build`

The command would execute following subcommands and produce several files:

```sh
cd test/build
npm install
npx esbuild --bundle input.js --outfile=out/noble-hashes.js --global-name=nobleHashes
npx esbuild --bundle input.js --outfile=out/noble-hashes.min.js --global-name=nobleHashes --minify
# 11d1900e99f3aa945603bb5e7d82bdd9ec6ddf5d30e2fcab69b836840cff76d2 test/build/out/noble-hashes.js
# 0be3876ff0816c44d21a401e6572fdb76d06012c760a23a5cb771c6f612106f5 test/build/out/noble-hashes.min.js

3790 LOC noble-hashes.js
58.21 KB noble-hashes.min.js
21.10 KB +gzip
19.57 KB +zstd
```

## tsconfig

Strict typescript configs, friendly to type stripping.

* `tsconfig.test.json` is for typescript tests, with looser checks

Option descriptions:

* `isolatedDeclarations` ensures types are "fast" and friendly to JSR.io
* `verbatimModuleSyntax` - ensures files are friendly to "type erasure" / "type ignore"
node.js and others

## repo-template

Contains project skeleton, which can be used to create a new package.
Replace `EDIT_ME` with proper value.

## License

MIT License
