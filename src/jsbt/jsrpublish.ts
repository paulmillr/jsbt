#!/usr/bin/env -S node --experimental-strip-types
/**
Destructive ops and `npm install` SHOULD use only `fs-modify.ts`.
Do not call raw fs delete/write helpers or raw `npm install` directly here.

`check:jsrpublish` probes the real local Deno publish path for Node-style packages:
`deno publish --unstable-bare-node-builtins --unstable-sloppy-imports`
`--unstable-byonm --dry-run --allow-dirty`.
It first runs without `--allow-slow-types`. If that fails, it reruns with `--allow-slow-types`
to separate slow-types-only problems from publish/type failures that still block publish.
Generic `jsbt check` should call this in compact mode; direct `jsbt jsrpublish` keeps full output.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cliArgs,
  emptyResult,
  pkgTarget,
  recordIssue,
  relFile,
  reportIssues,
  runSelf,
  textLines,
  type Issue as LogIssue,
  type Result,
  usageText,
} from './utils.ts';

type PublishProbe = {
  error?: string;
  skipped?: string;
  status: number;
  stderr: string;
  stdout: string;
};
type PublishLoc = { file: string; sym: string };
type PublishRun = (cwd: string, allowSlowTypes: boolean) => PublishProbe;

const usage = usageText('jsrpublish', 'jsbt/jsrpublish.ts');
const SNIP = 8;

const probeText = (probe: PublishProbe): string =>
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
    if (err.code === 'ENOENT') {
      return {
        skipped: 'missing deno on PATH; install deno to run publish dry-run',
        status: -1,
        stderr: '',
        stdout: '',
      };
    }
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
    return { file: relFile(cwd, raw, true), sym: `${hit[2]}:${hit[3]}` };
  }
  return;
};
const relevantLines = (text: string): string[] => {
  const lines = textLines(text, true);
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
  const lines = relevantLines(probeText(probe));
  if (full || lines.length <= SNIP) return lines;
  return [...lines.slice(0, SNIP), '...'];
};
const recordPublishIssue = (
  out: Result,
  issues: LogIssue[],
  level: 'ERROR' | 'WARNING',
  kind: string,
  text: string,
  probe: PublishProbe,
  cwd: string,
  full: boolean
): void => {
  const lines = relevantLines(probeText(probe));
  const loc = lines
    .map((line) => publishLoc(cwd, line))
    .find((item): item is PublishLoc => !!item) || {
    file: 'jsr.json',
    sym: 'publish',
  };
  const body = preview(probe, full)
    .map((line) => `  ${line}`)
    .join('\n');
  recordIssue(out, issues, level, loc.file, loc.sym, body ? `${text}\n${body}` : text, kind);
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
  const cli = cliArgs(argv, usage, opts.color);
  if (!cli) return;
  const { args, colorOn } = cli;
  const { cwd } = pkgTarget(args.pkgArg, opts.cwd);
  const full = opts.full ?? true;
  const run = opts.runPublish || runPublish;
  const strict = run(cwd, false);
  const issues: LogIssue[] = [];
  const out = emptyResult();
  if (strict.skipped) {
    recordIssue(
      out,
      issues,
      'info',
      'jsr.json',
      'publish',
      `deno publish dry-run skipped; ${strict.skipped}`,
      'jsrpublish-skip'
    );
  } else if (!strict.status && !strict.error) {
    out.passed = 1;
  } else {
    const slow = run(cwd, true);
    if (!slow.status && !slow.error) {
      const hint = full ? '' : '; see npm run check jsrpublish for full output';
      recordPublishIssue(
        out,
        issues,
        'WARNING',
        'jsrpublish-slow',
        [
          'deno publish fails without --allow-slow-types;',
          `rerun passes with --allow-slow-types${hint}`,
        ].join(' '),
        strict,
        cwd,
        full
      );
    } else {
      const hint = full ? '' : '; see npm run check jsrpublish for full output';
      recordPublishIssue(
        out,
        issues,
        'ERROR',
        'jsrpublish',
        `deno publish fails even with --allow-slow-types${hint}`,
        probeText(slow) ? slow : strict,
        cwd,
        full
      );
    }
  }
  reportIssues('jsrpublish', issues, out, colorOn, 'JSR publish check found issues', 'warn');
};

runSelf(import.meta.url, runCli);
