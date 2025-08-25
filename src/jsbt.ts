#!/usr/bin/env node
/**
 * jsbt(1) helps to produce single-file package output for JS projects.
 *
 * Usage:
 *   npx --no @paulmillr/jsbt esbuild test/build
 * The command would execute following subcommands and produce several files:
```

npx --no @paulmillr/jsbt --auto => gets package.json main field, uses auto-input.js
npx --no @paulmillr/jsbt --bundle test/build-input.js

> cd test/build
> inputs/noble-hashes.js => outputs/noble-hashes.js
> inputs/noble-hashes-sha256.js => outputs/noble-hashes-sha256.js
> cd build
> npm install
> npx esbuild --bundle input.js --outfile=out/noble-hashes.js --global-name=nobleHashes
> npx esbuild --bundle input.js --outfile=out/noble-hashes.min.js --global-name=nobleHashes --minify
# shasum -a 256, checksums
64edcb68e6fe5924f37e65c9c38eee2a631f9aad6cba697675970bb4ca34fa41 test/build/out/noble-hashes.js
798f32aa84880b3e4fd7db77a5e3dd680c1aa166cc431141e18f61b467e8db18 test/build/out/noble-hashes.min.js

3790 LOC noble-hashes.js
58.19 KB noble-hashes.min.js
21.23 KB +gzip
19.56 KB +zstd
```
 * @module
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join as pjoin } from 'node:path';
import { promisify } from 'node:util';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';

const exec_ = promisify(exec);
const ex = (cmd: string) => {
  console.log(`> ${cmd}`);
  return exec_(cmd);
};

async function sha256(buf: Uint8Array<ArrayBuffer>) {
  const resb = await crypto.subtle.digest('SHA-256', buf.buffer);
  return Buffer.from(resb).toString('hex');
}

function snakeToCamel(snakeCased: string) {
  return snakeCased
    .split('-')
    .map((words, index) => {
      return index === 0 ? words : words[0].toUpperCase() + words.slice(1);
    })
    .join('');
}

// @namespace/ab-cd => namespace-ab-cd and namespaceAbCd
function getNames(cwd: string) {
  // packageJsonName = '@space/test-runner'; // consider this value
  const curr = pjoin(cwd, 'package.json');
  let packageJsonName;
  try {
    packageJsonName = JSON.parse(readFileSync(curr, 'utf8')).name;
  } catch (error) {
    throw new Error('package.json read error: ' + error);
  }

  const hasNs = packageJsonName.startsWith('@'); // true
  const snake = packageJsonName.replace(/^@/, '').replace(/\//, '-'); // space-test-runner
  const camel = snakeToCamel(snake); // spaceTestRunner
  const spl = snake.split('-'); // ["space", "test", "runner"]
  const parts = hasNs ? spl.slice(1) : spl; // ["test", "runner"]
  const snakeNp = parts.join('-'); // test-runner
  const camelNp = snakeToCamel(snakeNp); // testRunner
  const noprefix = { snake: snakeNp, camel: camelNp };
  return { snake, camel, noprefix };
}

const _c = String.fromCharCode(27); // x1b, control code for terminal colors
const c = {
  // colors
  red: _c + '[31m',
  green: _c + '[32m',
  reset: _c + '[0m',
};
const kb = (bytes: number) => (bytes / 1024).toFixed(2);

async function esbuild(root: string, noPrefix: boolean, _isAuto: boolean) {
  const names = getNames(process.cwd());
  const inp = `input.js`;
  const inpFull = pjoin(root, inp);
  if (!existsSync(inpFull)) throw new Error('jsbt expected input.js in dir: ' + root);

  // console.log(names);
  // out = noble-hashes.js;
  // min = noble-hashes.min.js;
  // glb = nobleHashes

  const fname = noPrefix ? names.noprefix.snake : names.snake;
  const outDir = 'out';
  const outb = `${fname}.js`;
  const minb = `${fname}.min.js`;
  const outp = pjoin(outDir, outb);
  const minp = pjoin(outDir, minb);
  const glbName = noPrefix ? names.noprefix.camel : names.camel;

  process.chdir(root);
  console.log(`> cd ${root}`);
  await ex(`npm install`);
  await ex(`npx esbuild --bundle ${inp} --outfile=${outp} --global-name=${glbName}`);
  await ex(`npx esbuild --bundle ${inp} --outfile=${minp} --global-name=${glbName} --minify`);
  const outf = readFileSync(outp);
  const minf = readFileSync(minp);
  const cmpfgzip = gzipSync(minf, { level: 9 });
  const cmpfzstd = zstdCompressSync(minf, { params: { [constants.ZSTD_c_compressionLevel]: 22 } });

  console.log('# shasum -a 256, checksums');
  console.log(await sha256(outf), pjoin(root, outp));
  console.log(await sha256(minf), pjoin(root, minp));

  const loc = outf.toString('utf8').split('\n').length - 1;
  console.log();
  console.log(`${c.green}${loc}${c.reset} LOC ${basename(outp)}`);
  console.log(`${c.green}${kb(minf.length)}${c.reset} KB ${basename(minp)}`);
  console.log(`${c.green}${kb(cmpfgzip.length)}${c.reset} KB +gzip`);
  console.log(`${c.green}${kb(cmpfzstd.length)}${c.reset} KB +zstd`);
  return true;
}

// jsbt esbuild test/build --no-prefix
function parseCli(argv: string[]) {
  const selected = argv[2];
  const directory = argv[3];
  const isAuto = argv.includes('--auto');
  const noPrefix = argv.includes('--no-prefix');
  if (selected !== 'esbuild' || !existsSync(directory))
    throw new Error(`usage: jsbt esbuild <build-dir> [--auto / --no-prefix]`);
  return esbuild(directory, noPrefix, isAuto);
}

parseCli(process.argv);
