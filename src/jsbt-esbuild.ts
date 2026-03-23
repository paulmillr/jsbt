#!/usr/bin/env node
// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt esbuild` helps produce single-file package output for JS projects.
 *
 * Usage:
 *   `npx --no @paulmillr/jsbt esbuild test/build`
 *
 * The command runs `npm install` and esbuild in the target build directory,
 * then prints bundle checksums and compressed sizes.
 * @module
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join as pjoin, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';
import { npmInstall } from './fs-modify.ts';

declare const __JSBT_BUNDLE__: boolean | undefined;

type Args = { cwd: string; directory: string; help: boolean; isAuto: boolean; noPrefix: boolean };

const exec_ = promisify(exec);
const ex = (cmd: string) => {
  console.log(`> ${cmd}`);
  return exec_(cmd);
};

const usage = `usage:
  jsbt esbuild <build-dir> [--auto] [--no-prefix]
  jsbt build <build-dir> [--auto] [--no-prefix]

examples:
  jsbt esbuild test/build
  npx --no @paulmillr/jsbt esbuild test/build`;

const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;

const sha256 = async (buf: Uint8Array<ArrayBuffer>) => {
  const resb = await crypto.subtle.digest('SHA-256', buf.buffer);
  return Buffer.from(resb).toString('hex');
};

const snakeToCamel = (snakeCased: string) =>
  snakeCased
    .split('-')
    .map((words, index) => (index === 0 ? words : words[0].toUpperCase() + words.slice(1)))
    .join('');

// @namespace/ab-cd => namespace-ab-cd and namespaceAbCd
const getNames = (cwd: string) => {
  const curr = pjoin(cwd, 'package.json');
  let packageJsonName;
  try {
    packageJsonName = JSON.parse(readFileSync(curr, 'utf8')).name;
  } catch (error) {
    throw new Error('package.json read error: ' + error);
  }
  const hasNs = packageJsonName.startsWith('@');
  const snake = packageJsonName.replace(/^@/, '').replace(/\//, '-');
  const camel = snakeToCamel(snake);
  const spl = snake.split('-');
  const parts = hasNs ? spl.slice(1) : spl;
  const snakeNp = parts.join('-');
  const camelNp = snakeToCamel(snakeNp);
  const noprefix = { snake: snakeNp, camel: camelNp };
  return { camel, noprefix, snake };
};

const _c = String.fromCharCode(27);
const c = { green: _c + '[32m', reset: _c + '[0m' };
const kb = (bytes: number) => (bytes / 1024).toFixed(2);

const runEsbuild = async (cwd: string, root: string, noPrefix: boolean, _isAuto: boolean) => {
  const names = getNames(cwd);
  const inp = `input.js`;
  const inpFull = pjoin(root, inp);
  if (!existsSync(inpFull)) throw new Error('jsbt expected input.js in dir: ' + root);
  const fname = noPrefix ? names.noprefix.snake : names.snake;
  const outDir = 'out';
  const outb = `${fname}.js`;
  const minb = `${fname}.min.js`;
  const outp = pjoin(outDir, outb);
  const minp = pjoin(outDir, minb);
  const glbName = noPrefix ? names.noprefix.camel : names.camel;

  process.chdir(root);
  npmInstall(root);
  await ex(`npx esbuild --bundle ${inp} --outfile=${outp} --global-name=${glbName}`);
  await ex(`npx esbuild --bundle ${inp} --outfile=${minp} --global-name=${glbName} --minify`);
  const outf = readFileSync(outp);
  const minf = readFileSync(minp);
  const cmpfgzip = gzipSync(minf, { level: 9 });
  const cmpfzstd = zstdCompressSync(minf, { params: { [constants.ZSTD_c_compressionLevel]: 22 } });

  console.log('# shasum -a 256, checksums');
  console.log(`${await sha256(outf)} ${pjoin(root, outp)}`);
  console.log(`${await sha256(minf)} ${pjoin(root, minp)}`);
  const loc = outf.toString('utf8').split('\n').length - 1;
  console.log('');
  console.log(`${c.green}${loc}${c.reset} LOC ${basename(outp)}`);
  console.log(`${c.green}${kb(minf.length)}${c.reset} KB ${basename(minp)}`);
  console.log(`${c.green}${kb(cmpfgzip.length)}${c.reset} KB +gzip`);
  console.log(`${c.green}${kb(cmpfzstd.length)}${c.reset} KB +zstd`);
};

const parseArgs = (argv: string[], cwd: string = process.cwd()): Args => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { cwd: resolve(cwd), directory: '', help: true, isAuto: false, noPrefix: false };
  const base = resolve(cwd);
  const directoryArg = argv[0];
  const directory = resolve(base, directoryArg || '');
  const isAuto = argv.includes('--auto');
  const noPrefix = argv.includes('--no-prefix');
  if (!directory || !existsSync(directory))
    throw new Error(`usage: jsbt esbuild <build-dir> [--auto] [--no-prefix]`);
  return { cwd: base, directory, help: false, isAuto, noPrefix };
};

export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  await runEsbuild(args.cwd, args.directory, args.noPrefix, args.isAuto);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
};

const entry = process.argv[1];
const self = fileURLToPath(import.meta.url);
if (!bundled() && entry && entry === self) void main();
