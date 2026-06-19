#!/usr/bin/env node
// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt bundle` helps produce single-file package output for JS projects.
 *
 * Usage:
 *   `npx --no @paulmillr/jsbt bundle`
 *
 * The command runs `npm install` and bundle in the target build directory,
 * then prints bundle checksums and compressed size.
 * @module
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join as pjoin, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  bundleTempDir,
  npmInstall,
  rmBundleTempDir,
  writeBundleInput,
  writePkg,
} from '../fs-modify.ts';
import { camelParts, kb, readJson, runSelf } from './utils.ts';

type Args = { cwd: string; directory: string; help: boolean; noPrefix: boolean; stats: boolean };
type BundleTarget = { root: string; temp: boolean };
type Names = {
  camel: string;
  name: string;
  noprefix: { camel: string; snake: string };
  snake: string;
};
type RunOpts = { stats?: boolean };
type ReportOpts = { stats?: boolean };
type BundleReport = {
  gzipBytes: number;
  loc: number;
  minBytes: number;
  minHash?: string;
  minName: string;
  minPath: string;
  outHash?: string;
  outName: string;
  outPath: string;
};
type TestApi = {
  autoInput: typeof autoInput;
  autoPackage: typeof autoPackage;
  bundleReportLines: typeof bundleReportLines;
  displayPath: typeof displayPath;
  ensureAutoFiles: typeof ensureAutoFiles;
  getNames: typeof getNames;
  parseArgs: typeof parseArgs;
  prepareAutoDir: typeof prepareAutoDir;
};

const exec_ = promisify(exec);
const ex = (cmd: string) => exec_(cmd);

const usage = `usage:
  jsbt bundle [--dir=<build-dir>] [--no-prefix] [--stats]

examples:
  jsbt bundle
  jsbt bundle --stats
  jsbt bundle --dir=test/build`;
const usageErr = (): never => {
  throw new Error(usage);
};

const sha256 = async (buf: Uint8Array<ArrayBuffer>) => {
  const resb = await crypto.subtle.digest('SHA-256', buf.buffer);
  return Buffer.from(resb).toString('hex');
};

const snakeToCamel = (snakeCased: string) => camelParts(snakeCased.split('-'));

// @namespace/ab-cd => namespace-ab-cd and namespaceAbCd
const getNames = (cwd: string): Names => {
  const curr = pjoin(cwd, 'package.json');
  let packageJsonName;
  try {
    packageJsonName = readJson<{ name?: string }>(curr).name;
  } catch (error) {
    throw new Error('package.json read error: ' + error);
  }
  if (typeof packageJsonName !== 'string' || !packageJsonName)
    throw new Error('package.json expected name in: ' + curr);
  const hasNs = packageJsonName.startsWith('@');
  const snake = packageJsonName.replace(/^@/, '').replace(/\//, '-');
  const camel = snakeToCamel(snake);
  const spl = snake.split('-');
  const parts = hasNs ? spl.slice(1) : spl;
  const snakeNp = parts.join('-');
  const camelNp = snakeToCamel(snakeNp);
  const noprefix = { snake: snakeNp, camel: camelNp };
  return { camel, name: packageJsonName, noprefix, snake };
};

const _c = String.fromCharCode(27);
const c = { green: _c + '[32m', reset: _c + '[0m' };
const displayPath = (cwd: string, file: string): string => {
  const full = resolve(file);
  const rel = relative(resolve(cwd), full);
  return rel && !/^\.\.(?:[/\\]|$)/.test(rel) && !isAbsolute(rel) ? rel : full;
};

const autoInput = (name: string): string => `export * from '${name}';\n`;
const autoPackage = (cwd: string, name: string): string =>
  `${JSON.stringify(
    {
      private: true,
      type: 'module',
      dependencies: { [name]: pathToFileURL(cwd).href },
    },
    undefined,
    2
  )}\n`;
const ensureAutoFiles = (root: string, cwd: string, name: string): void => {
  const pkg = pjoin(root, 'package.json');
  if (!existsSync(pkg)) writePkg(pkg, autoPackage(cwd, name));
  const input = pjoin(root, 'input.js');
  if (!existsSync(input)) writeBundleInput(input, autoInput(name));
};
const prepareAutoDir = (cwd: string): BundleTarget => {
  const names = getNames(cwd);
  const build = pjoin(cwd, 'test', 'build');
  const temp = !existsSync(build);
  const root = temp ? bundleTempDir() : build;
  ensureAutoFiles(root, cwd, names.name);
  return { root, temp };
};

const requireReportValue = (value: string | undefined, label: string): string => {
  if (!value) throw new Error(`bundle report missing ${label}`);
  return value;
};
const bundleReportLines = (report: BundleReport, opts: ReportOpts = {}): string[] => [
  ...(opts.stats
    ? []
    : [
        `${requireReportValue(report.outHash, 'out hash')} ${report.outPath}`,
        `${requireReportValue(report.minHash, 'min hash')} ${report.minPath}`,
        '',
      ]),
  `${c.green}${report.loc}${c.reset} LOC ${report.outName}`,
  `${c.green}${kb(report.minBytes)}${c.reset} KB ${report.minName}`,
  `${c.green}${kb(report.gzipBytes)}${c.reset} KB +gzip`,
];

const runEsbuild = async (
  cwd: string,
  root: string,
  noPrefix: boolean,
  opts: RunOpts = {}
): Promise<void> => {
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

  const prev = process.cwd();
  process.chdir(root);
  try {
    npmInstall(root);
    await ex(`npx esbuild --bundle ${inp} --outfile=${outp} --global-name=${glbName}`);
    await ex(`npx esbuild --bundle ${inp} --outfile=${minp} --global-name=${glbName} --minify`);
    const outf = readFileSync(outp);
    const minf = readFileSync(minp);
    const cmpfgzip = gzipSync(minf, { level: 9 });
    const report: BundleReport = {
      gzipBytes: cmpfgzip.length,
      loc: outf.toString('utf8').split('\n').length - 1,
      minBytes: minf.length,
      minName: basename(minp),
      minPath: displayPath(cwd, pjoin(root, minp)),
      outName: basename(outp),
      outPath: displayPath(cwd, pjoin(root, outp)),
    };
    if (!opts.stats) {
      report.minHash = await sha256(minf);
      report.outHash = await sha256(outf);
    }
    for (const line of bundleReportLines(report, { stats: opts.stats })) console.log(line);
  } finally {
    process.chdir(prev);
  }
};

const parseArgs = (argv: string[], cwd: string = process.cwd()): Args => {
  if (argv.includes('--help') || argv.includes('-h'))
    return { cwd: resolve(cwd), directory: '', help: true, noPrefix: false, stats: false };
  const base = resolve(cwd);
  let directoryArg = '';
  let noPrefix = false;
  let stats = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      const next = argv[++i];
      if (!next || next.startsWith('-') || directoryArg) usageErr();
      directoryArg = next;
    } else if (arg.startsWith('--dir=')) {
      const next = arg.slice('--dir='.length);
      if (!next || directoryArg) usageErr();
      directoryArg = next;
    } else if (arg === '--no-prefix') noPrefix = true;
    else if (arg === '--stats') stats = true;
    else usageErr();
  }
  const directory = directoryArg ? resolve(base, directoryArg) : '';
  if (directory && !existsSync(directory)) usageErr();
  return { cwd: base, directory, help: false, noPrefix, stats };
};

export const runCli = async (
  argv: string[],
  opts: { cwd?: string; runEsbuild?: typeof runEsbuild } = {}
): Promise<void> => {
  const args = parseArgs(argv, opts.cwd);
  if (args.help) return console.log(usage);
  const target = args.directory ? { root: args.directory, temp: false } : prepareAutoDir(args.cwd);
  try {
    await (opts.runEsbuild || runEsbuild)(args.cwd, target.root, args.noPrefix, {
      stats: args.stats,
    });
  } finally {
    if (args.stats && target.temp) rmBundleTempDir(target.root);
  }
};

export const __TEST: TestApi = {
  autoInput: autoInput,
  autoPackage: autoPackage,
  bundleReportLines: bundleReportLines,
  displayPath: displayPath,
  ensureAutoFiles: ensureAutoFiles,
  getNames: getNames,
  parseArgs: parseArgs,
  prepareAutoDir: prepareAutoDir,
};

runSelf(import.meta.url, runCli);
