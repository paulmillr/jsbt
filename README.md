# @paulmillr/jsbt

JS Build Tools: helpers for building, benchmarking & testing secure JS apps.

- 🏋🏻 bench: Benchmark JS projects with nanosecond resolution.
- 🏗️ jsbt.js: Auto-produce single-file output for all package exports
- 📝 test: Multi-env testing framework with familiar syntax & parallel execution
- ⚙️ tsconfig: Strict typescript configs, friendly to type stripping
- 🤖 workflows: Secure GitHub CI configs for testing & publishing JS packages.
- 🪶 As minimal as possible, no dependencies

Used by [noble cryptography](https://paulmillr.com/noble/) and others.

## Usage

> `npm install @paulmillr/jsbt`

> `jsr add jsr:@paulmillr/jsbt`

## bench

Benchmark JS projects with nanosecond resolution.

- Precise: 1ns resolution using `process.hrtime`
- Lightweight: ~200 lines of code, no dependencies - to not interfere with benchmarked code
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
wc -l < out/noble-hashes.js
wc -c < out/noble-hashes.min.js
gzip -c8 < out/noble-hashes.min.js > out/noble-hashes.min.js.gz
wc -c < out/noble-hashes.min.js.gz
rm out/noble-hashes.min.js.gz
shasum -a 256 out/*
# build done: test/build/input.js => test/build/out
# 64edcb68e6fe5924f37e65c9c38eee2a631f9aad6cba697675970bb4ca34fa41  noble-hashes.js
# 798f32aa84880b3e4fd7db77a5e3dd680c1aa166cc431141e18f61b467e8db18  noble-hashes.min.js
```

## test

Multi-env testing framework with familiar syntax & parallel execution.

- Familiar syntax: similar to Mocha / Jest / Vitest
- Multi-env: runs on node.js, deno, bun, cloudflare, browsers and others
- No "global" magic: `it.run()` in the end simplifies logic and browser runs
- Parallel: easily run in node.js and bun
- Great UI: beautiful tree reporter, optional "quiet" dot reporter

```js
import { should } from 'micro-should';
should.opts.STOP_AT_ERROR = false; // default=true
should.opts.MSHOULD_QUIET = true; // same as env var
```

To run the example in parallel / quiet setting, save it as a.test.js:

    MSHOULD_FAST=1 MSHOULD_QUIET=1 node a.test.js

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

## tsconfig

Strict typescript configs, friendly to type stripping.

* `tsconfig.test.json` is for typescript tests, with looser checks

Option descriptions:

* `isolatedDeclarations` ensures types are "fast" and friendly to JSR.io
* `verbatimModuleSyntax` - ensures files are friendly to "type erasure" / "type ignore"
node.js and others

## workflows

Secure GitHub CI configs for testing & publishing JS packages.

The files reside in `.github/workflows`:

* `test-js.yml`: runs tests on LTS node.js, bun, deno, linter, and calculates coverage
* `test-ts.yml`: the same, but runs typescript instead of js on supported node.js (v22+)
  On node.js v20, it executes `test:nodeold` to compile files instead.
* `release.yml` publishes package on NPM, JSR and creates single-file output if it exists
    * `build-path: string` - path to build directory, which contains `out` dir, from which
      files would be uploaded to github releases
    * `slow-types: true / false (default)` - whether to allow [slow types](https://jsr.io/docs/about-slow-types) on JSR.io

## repo-template

Contains project skeleton, which can be used to create a new package.
Replace `EDIT_ME` with proper value.

## License

MIT License
