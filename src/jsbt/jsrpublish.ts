#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`;
do not call `rmSync`, `rmdirSync`, `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.

`check:jsrpublish` probes the real local Deno publish path for Node-style packages:
`deno publish --unstable-bare-node-builtins --unstable-sloppy-imports --unstable-byonm --dry-run --allow-dirty`.
It first runs without `--allow-slow-types`. If that fails, it reruns with `--allow-slow-types`
to separate slow-types-only problems from publish/type failures that still block publish.
Generic `jsbt check` should call this in compact mode; direct `jsbt jsrpublish` keeps full output.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundled,
  guardChild,
  issueKind,
  printIssues,
  status,
  summary,
  wantColor,
  type Issue as LogIssue,
  type Result,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type PublishProbe = {
  error?: string;
  skipped?: string;
  status: number;
  stderr: string;
  stdout: string;
};
type PublishLoc = { file: string; sym: string };
type PublishRun = (cwd: string, allowSlowTypes: boolean) => PublishProbe;

const usage = `usage:
  jsbt jsrpublish <package.json>

examples:
  jsbt jsrpublish package.json
  node /path/to/jsbt/jsrpublish.ts package.json`;
const SNIP = 8;

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const textOf = (probe: PublishProbe): string =>
  [probe.stdout, probe.stderr, probe.error].filter(Boolean).join('\n');
const runPublish = (cwd: string, allowSlowTypes: boolean): PublishProbe => {
  const args = [
    'publish',
    '--unstable-bare-node-builtins',
    '--unstable-sloppy-imports',
    '--unstable-byonm',
    '--dry-run',
    '--allow-dirty',
  ];
  if (allowSlowTypes) args.push('--allow-slow-types');
  const res = spawnSync('deno', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    const err = res.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT')
      return {
        skipped: 'missing deno on PATH; install deno to run publish dry-run',
        status: -1,
        stderr: '',
        stdout: '',
      };
    return {
      error: err.message,
      status: res.status || 1,
      stderr: res.stderr || '',
      stdout: res.stdout || '',
    };
  }
  return { status: res.status || 0, stderr: res.stderr || '', stdout: res.stdout || '' };
};
const publishLoc = (cwd: string, line: string): PublishLoc | undefined => {
  for (const hit of [
    line.match(/^\s+at (file:\/\/\S+):(\d+):(\d+)$/),
    line.match(/^\s+at (\S+):(\d+):(\d+)$/),
    line.match(/^\s+--> (file:\/\/\S+):(\d+):(\d+)$/),
    line.match(/^\s+--> (\S+):(\d+):(\d+)$/),
  ]) {
    if (!hit) continue;
    const raw = hit[1].startsWith('file://') ? fileURLToPath(hit[1]) : hit[1];
    const rel = relative(cwd, raw);
    const file = (!rel || rel.startsWith('..') ? raw : rel).split('\\').join('/');
    return { file, sym: `${hit[2]}:${hit[3]}` };
  }
  return;
};
const relevantLines = (text: string): string[] => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (!lines.length) return [];
  const start = lines.findIndex((line) =>
    /^(?:TS\d+ \[(?:ERROR|WARNING)\]:|(?:error|warning)\[[^\]]+\]:|error: )/.test(line)
  );
  if (start !== -1) return lines.slice(start);
  return lines.filter(
    (line) =>
      !line.startsWith('Check ') &&
      !line.startsWith('Checking for slow types') &&
      !line.startsWith('Simulating publish') &&
      !line.startsWith('Found ')
  );
};
const preview = (probe: PublishProbe, full: boolean): string[] => {
  const lines = relevantLines(textOf(probe));
  if (full || lines.length <= SNIP) return lines;
  return [...lines.slice(0, SNIP), '...'];
};
const issueOf = (
  level: 'ERROR' | 'WARNING',
  kind: string,
  text: string,
  probe: PublishProbe,
  cwd: string,
  full: boolean
): LogIssue => {
  const lines = relevantLines(textOf(probe));
  const loc =
    lines.map((line) => publishLoc(cwd, line)).find((item): item is PublishLoc => !!item) || {
      file: 'jsr.json',
      sym: 'publish',
    };
  const body = preview(probe, full)
    .map((line) => `  ${line}`)
    .join('\n');
  return {
    level,
    ref: {
      file: loc.file,
      issue: issueKind(body ? `${text}\n${body}` : text, kind),
      sym: loc.sym,
    },
  };
};

export const runCli = async (
  argv: string[],
  opts: {
    color?: boolean;
    cwd?: string;
    full?: boolean;
    runPublish?: PublishRun;
  } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const cwd = resolve(opts.cwd || process.cwd());
  const pkgFile = resolve(cwd, args.pkgArg);
  guardChild(cwd, pkgFile, 'package');
  const colorOn = opts.color ?? wantColor();
  const full = opts.full ?? true;
  const run = opts.runPublish || runPublish;
  const strict = run(cwd, false);
  const issues: LogIssue[] = [];
  let out: Result = { failures: 0, passed: 1, skipped: 0, warnings: 0 };
  if (strict.skipped) {
    issues.push({
      level: 'INFO',
      ref: {
        file: 'jsr.json',
        issue: issueKind(`deno publish dry-run skipped; ${strict.skipped}`, 'jsrpublish-skip'),
        sym: 'publish',
      },
    });
    out = { failures: 0, passed: 0, skipped: 1, warnings: 0 };
  } else if (!strict.status && !strict.error) {
    out = { failures: 0, passed: 1, skipped: 0, warnings: 0 };
  } else {
    const slow = run(cwd, true);
    if (!slow.status && !slow.error) {
      const hint = full ? '' : '; see npm run check jsrpublish for full output';
      issues.push(
        issueOf(
          'WARNING',
          'jsrpublish-slow',
          `deno publish fails without --allow-slow-types; rerun passes with --allow-slow-types${hint}`,
          strict,
          cwd,
          full
        )
      );
      out = { failures: 0, passed: 0, skipped: 0, warnings: 1 };
    } else {
      const hint = full ? '' : '; see npm run check jsrpublish for full output';
      issues.push(
        issueOf(
          'ERROR',
          'jsrpublish',
          `deno publish fails even with --allow-slow-types${hint}`,
          textOf(slow) ? slow : strict,
          cwd,
          full
        )
      );
      out = { failures: 1, passed: 0, skipped: 0, warnings: 0 };
    }
  }
  printIssues('jsrpublish', issues, colorOn);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    throw new Error('JSR publish check found issues');
  }
  if (out.warnings) return console.error(`${status('warn', colorOn)} summary: ${summary(out)}`);
  if (out.skipped) return console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
  console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
