#!/usr/bin/env node
/**
 * jsbt(1) helps to produce single-file package output for JS projects.
 *
 * Usage:
 *   npx --no @paulmillr/jsbt esbuild test/build
 * The command would execute following subcommands and produce several files:
```
> cd test/build
> npm install
> npx esbuild --bundle input.js --outfile=out/noble-hashes.js --global-name=nobleHashes
> npx esbuild --bundle input.js --outfile=out/noble-hashes.min.js --global-name=nobleHashes --minify
> wc -l < out/noble-hashes.js
> wc -c < out/noble-hashes.min.js
> gzip -c8 < out/noble-hashes.min.js > out/noble-hashes.min.js.gz
> wc -c < out/noble-hashes.min.js.gz
> rm out/noble-hashes.min.js.gz
> shasum -a 256 out/*
# build done: test/build/input.js => test/build/out

64edcb68e6fe5924f37e65c9c38eee2a631f9aad6cba697675970bb4ca34fa41  noble-hashes.js
798f32aa84880b3e4fd7db77a5e3dd680c1aa166cc431141e18f61b467e8db18  noble-hashes.min.js
```
 * @module
 */
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join as pjoin } from "node:path";
import { promisify } from "node:util";

const exec_ = promisify(exec);
const ex = (cmd: string) => {
  console.log(`> ${cmd}`);
  return exec_(cmd);
};

function snakeToCamel(snakeCased: string) {
  return snakeCased
    .split("-")
    .map((words, index) => {
      return index === 0 ? words : words[0].toUpperCase() + words.slice(1);
    })
    .join("");
}

// @namespace/ab-cd => namespace-ab-cd and namespaceAbCd
function getNames(cwd: string) {
  // packageJsonName = '@space/test-runner'; // consider this value
  const curr = pjoin(cwd, "package.json");
  let packageJsonName;
  try {
    packageJsonName = JSON.parse(readFileSync(curr, "utf8")).name;
  } catch (error) {
    throw new Error("package.json read error: " + error);
  }

  const hasNs = packageJsonName.startsWith("@"); // true
  const snake = packageJsonName.replace(/^@/, "").replace(/\//, "-"); // space-test-runner
  const camel = snakeToCamel(snake); // spaceTestRunner
  const spl = snake.split("-"); // ["space", "test", "runner"]
  const parts = hasNs ? spl.slice(1) : spl; // ["test", "runner"]
  const snakeNp = parts.join("-"); // test-runner
  const camelNp = snakeToCamel(snakeNp); // testRunner
  const noprefix = { snake: snakeNp, camel: camelNp };
  return { snake, camel, noprefix };
}

const _c = String.fromCharCode(27); // x1b, control code for terminal colors
const c = {
  // colors
  red: _c + "[31m",
  green: _c + "[32m",
  reset: _c + "[0m",
};

async function esbuild(root: string, noPrefix: boolean) {
  // inp = input.js;
  // out = noble-hashes.js;
  // min = noble-hashes.min.js;
  // gzp = noble-hashes.min.js.gz;
  // glb = nobleHashes

  const names = getNames(process.cwd());
  const inp = `input.js`;
  const inpFull = pjoin(root, inp);

  if (!existsSync(inpFull))
    throw new Error("jsbt expected input.js in dir: " + root);

  // console.log(names);
  const sel = noPrefix ? names.noprefix.snake : names.snake;
  const outDir = "out";
  const out = pjoin(outDir, `${sel}.js`);
  const min = pjoin(outDir, `${sel}.min.js`);
  const zip = pjoin(outDir, `${sel}.min.js.gz`);
  const glb = noPrefix ? names.noprefix.camel : names.camel;

  process.chdir(root);
  console.log(`> cd ${root}`);
  await ex(`npm install`);
  await ex(`npx esbuild --bundle ${inp} --outfile=${out} --global-name=${glb}`);
  await ex(
    `npx esbuild --bundle ${inp} --outfile=${min} --global-name=${glb} --minify`
  );

  const stdout = async (cmd: string) => (await ex(cmd)).stdout.trim();
  const parseNum = async (cmd: string) => Number.parseInt(await stdout(cmd));
  const wc_out = await parseNum(`wc -l < ${out}`);
  const wc_min = await parseNum(`wc -c < ${min}`);

  let wc_zip = 0;
  try {
    await ex(`gzip -c8 < ${min} > ${zip}`);
    wc_zip = await parseNum(`wc -c < ${zip}`);
    await ex(`rm ${zip}`);
  } catch (error) {
    console.log("gzip failed: " + error);
  }
  let sha;
  try {
    sha = await stdout(`shasum -a 256 ${pjoin(outDir, "*")}`);
  } catch (error) {}
  const kb = (bytes: number) => (bytes / 1024).toFixed(2);
  console.log(`# build done: ${inpFull} => ${pjoin(root, outDir)}`);
  console.log();
  if (sha) {
    console.log(sha.replace(new RegExp(outDir + "/", "g"), ""));
    console.log();
  }
  console.log(`${c.green}${wc_out}${c.reset} lines ${basename(out)}`);
  console.log(`${c.green}${kb(wc_min)}${c.reset} kb ${basename(min)}`);
  if (wc_zip)
    console.log(`${c.green}${kb(wc_zip)}${c.reset} kb ${basename(zip)}`);
  return true;
}

// jsbt esbuild test/build --no-prefix
function parseCli(argv: string[]) {
  const selected = argv[2];
  const directory = argv[3];
  const noPrefix = argv.includes("--no-prefix");
  if (selected !== "esbuild" || !existsSync(directory))
    throw new Error(`usage: jsbt esbuild <build-dir> [--no-prefix]`);
  return esbuild(directory, noPrefix);
}

parseCli(process.argv);
