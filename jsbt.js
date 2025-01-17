#!/usr/bin/env node
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, join as pjoin } from "node:path";
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

async function esbuild(directory, noPrefix) {
  // inp = input.js;
  // out = noble-hashes.js;
  // min = noble-hashes.min.js;
  // gzp = noble-hashes.min.js.gz;
  // glb = nobleHashes

  const names = getNames(process.cwd());
  const inp = `input.js`;
  const inpFull = join(directory, inp);

  if (!existsSync(inpFull))
    throw new Error("jsbt expected input.js in dir: " + directory);

  // console.log(names);
  const sel = noPrefix ? names.noprefix.snake : names.snake;
  const outDir = "out";
  const out = join(outDir, `${sel}.js`);
  const min = join(outDir, `${sel}.min.js`);
  const zip = join(outDir, `${sel}.min.js.gz`);
  const glb = noPrefix ? names.noprefix.camel : names.camel;

  process.chdir(directory);
  console.log(`> cd ${directory}`);
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
  console.log("# build completed:");
  console.log(`${inpFull} => ${join(directory, outDir)}`);
  console.log(`${wc_out} lines ${out}`);
  console.log(`${kb(wc_min)} kb ${min}`);
  if (wc_zip) console.log(`${kb(wc_zip)} kb ${zip}`);
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
