// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt` dispatches the shared build and audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt esbuild test/build`
 *   `jsbt readme package.json`
 *   `jsbt treeshake package.json test/build/out-treeshake`
 *   `jsbt tsdoc package.json`
 * @module
 */
import * as TSDoc from '@microsoft/tsdoc';
import { runCli as runBuild } from './jsbt-esbuild.ts';
import { runCli as runTSDoc } from './jsbt-jsdoc.ts';
import { runCli as runReadme } from './jsbt-readme.ts';
import { runCli as runTreeShaking } from './jsbt-treeshake.ts';

type Cmd =
  | 'build'
  | 'check-jsdoc'
  | 'check-readme'
  | 'check-tree-shaking'
  | 'esbuild'
  | 'readme'
  | 'treeshake'
  | 'tsdoc';

const usage = `usage:
  jsbt esbuild <build-dir> [--auto] [--no-prefix]
  jsbt readme <package.json>
  jsbt treeshake <package.json> <out-dir>
  jsbt tsdoc <package.json>

aliases:
  jsbt build <build-dir> ...
  jsbt check-readme <package.json>
  jsbt check-tree-shaking <package.json> <out-dir>
  jsbt check-jsdoc <package.json>

examples:
  npx --no @paulmillr/jsbt esbuild test/build
  npx --no @paulmillr/jsbt readme package.json
  npx --no @paulmillr/jsbt treeshake package.json test/build/out-treeshake
  npx --no @paulmillr/jsbt tsdoc package.json`;

const cmd = (name: string): Cmd | undefined => {
  switch (name) {
    case 'build':
    case 'check-jsdoc':
    case 'check-readme':
    case 'check-tree-shaking':
    case 'esbuild':
    case 'readme':
    case 'treeshake':
    case 'tsdoc':
      return name;
  }
  return undefined;
};

export const runCli = async (argv: string[]): Promise<void> => {
  const [head, ...rest] = argv;
  if (!head || head === '--help' || head === '-h') return console.log(usage);
  const sub = cmd(head);
  if (!sub) throw new Error(`unknown jsbt command: ${head}\n\n${usage}`);
  switch (sub) {
    case 'build':
    case 'esbuild':
      return runBuild(rest);
    case 'check-readme':
    case 'readme':
      return runReadme(rest);
    case 'check-tree-shaking':
    case 'treeshake':
      return runTreeShaking(rest);
    case 'check-jsdoc':
    case 'tsdoc':
      return runTSDoc(rest, { loadTSDoc: () => TSDoc as any });
  }
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
};

void main();
