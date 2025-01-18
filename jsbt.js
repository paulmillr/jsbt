#!/usr/bin/env node
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join as pjoin } from "node:path";
import { promisify } from "node:util";

const exec_ = promisify(exec);
const ex = (cmd) => {
  console.log(`> ${cmd}`);
  return exec_(cmd);
};

function snakeToCamel(snakeCased) {
  return snakeCased
    .split("-")
    .map((words, index) => {
      return index === 0 ? words : words[0].toUpperCase() + words.slice(1);
    })
    .join("");
}

// @namespace/ab-cd => namespace-ab-cd and namespaceAbCd
function getNames(cwd) {
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

async function esbuild(root, noPrefix) {
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

  const stdout = async (str) => Number.parseInt((await ex(str)).stdout.trim());
  const wc_out = await stdout(`wc -l < ${out}`);
  const wc_min = await stdout(`wc -c < ${min}`);

  let wc_zip = "";
  try {
    await ex(`gzip -c8 < ${min} > ${zip}`);
    wc_zip = await stdout(`wc -c < ${zip}`);
  } catch (error) {
    console.log("gzip failed: " + error);
  }
  const kb = (bytes) => (bytes / 1024).toFixed(2);
  console.log();
  console.log(`# build done: ${inpFull} => ${pjoin(root, outDir)}`);
  console.log("");
  console.log(`${c.green}${wc_out}${c.reset} lines ${basename(out)}`);
  console.log(`${c.green}${kb(wc_min)}${c.reset} kb ${basename(min)}`);
  if (wc_zip)
    console.log(`${c.green}${kb(wc_zip)}${c.reset} kb ${basename(zip)}`);
  return true;
}

// jsbt esbuild test/build/input.js --no-prefix
function parseCli(argv) {
  const selected = argv[2];
  const directory = argv[3];
  const noPrefix = argv.includes("--no-prefix");
  if (selected !== "esbuild" || !existsSync(directory))
    throw new Error(`usage: jsbt esbuild <build-dir> [--no-prefix]`);
  return esbuild(directory, noPrefix);
}

parseCli(process.argv);
