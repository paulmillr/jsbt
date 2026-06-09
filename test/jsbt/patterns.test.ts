import { deepStrictEqual, match } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { should } from '../../src/test.ts';
import { __TEST as TSDOC_TEST } from '../../src/jsbt/jsdoc.ts';
import { __TEST, runCli } from '../../src/jsbt/patterns.ts';

const TMP = resolve('test/jsbt/build/patterns');
const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  try {
    await fn();
    return { ok: true, stderr, stdout };
  } catch (err) {
    return { error: (err as Error).message, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const issueShape = (items: ReturnType<typeof __TEST.scanPatternText>) =>
  items.map((item) => ({
    issue: item.issue,
    kind: item.kind,
    level: item.level,
    line: item.line,
  }));

should('patterns scan reports invalid placeholders and keeps valid void returns', () => {
  const code = `
const value = 1;
void value;
value;
const run = () => void fn();
function done() {
  return void fn();
}
`;
  deepStrictEqual(issueShape(__TEST.scanPatternText(ts, 'fixture.ts', code)), [
    {
      issue: 'do not silence unused values with void expression statement',
      kind: 'unused',
      level: 'error',
      line: 3,
    },
    {
      issue: 'bare value expression statement does not use the value',
      kind: 'unused',
      level: 'error',
      line: 4,
    },
  ]);
});

should('tsdoc example pattern pass rejects bare values but keeps void calls', () => {
  deepStrictEqual(TSDOC_TEST.examplePatternErrors(ts as any, 'const value = 1;\nvalue;\n'), [
    'pattern 2:1: bare value expression statement does not use the value',
  ]);
  deepStrictEqual(TSDOC_TEST.examplePatternErrors(ts as any, 'const run = () => void fn();'), []);
});

should('patterns scan reports aliases, wrappers, helper names, and single-use helpers', () => {
  const code = `
import { abytes } from '@noble/hashes/utils.js';
const importedAlias = abytes;
const local = 1;
const renamed = local;
type Renamed = LocalType;
type Generic = Box<LocalType>;
const direct = (value: string) => trim(value);
function alsoDirect(value: string) {
  return trim(value);
}
function runOnce() {
  const usedOnce = (value: string) => value.trim();
  console.log(usedOnce('a'));
}
function hashOf(value: string) {
  return trim(value);
}
const useful = (value: string) => trim(lower(value));
`;
  deepStrictEqual(issueShape(__TEST.scanPatternText(ts, 'fixture.ts', code)), [
    {
      issue: 'pointless const alias; use local directly',
      kind: 'alias',
      level: 'error',
      line: 5,
    },
    {
      issue: 'pointless type alias; use LocalType directly',
      kind: 'alias',
      level: 'error',
      line: 6,
    },
    {
      issue: 'helper only forwards its arguments to trim',
      kind: 'wrapper',
      level: 'error',
      line: 8,
    },
    {
      issue: 'helper only forwards its arguments to trim',
      kind: 'wrapper',
      level: 'error',
      line: 9,
    },
    {
      issue: 'single-use helper; inline it or give it a real abstraction boundary',
      kind: 'helper',
      level: 'warning',
      line: 13,
    },
    {
      issue: 'helper name must not end with Of',
      kind: 'name',
      level: 'error',
      line: 16,
    },
    {
      issue: 'helper only forwards its arguments to trim',
      kind: 'wrapper',
      level: 'error',
      line: 16,
    },
  ]);
});

should('patterns scan reports multiline control flow and ignores negation', () => {
  const code = `
function check(value?: string, other = 'x') {
  if (!value) return;
  if (!other) return;
  if (
    other.length
  )
    console.log(other);
  for (
    let i = 0;
    i < 1;
    i++
  )
    console.log(i);
  while (
    other.length
  )
    console.log(other);
  if (other.length) {
    console.log(other);
  }
}
`;
  deepStrictEqual(issueShape(__TEST.scanPatternText(ts, 'fixture.ts', code)), [
    {
      issue: 'multiline if condition or body must use braces',
      kind: 'braces',
      level: 'error',
      line: 5,
    },
    {
      issue: 'multiline for condition or body must use braces',
      kind: 'braces',
      level: 'error',
      line: 9,
    },
    {
      issue: 'multiline while condition or body must use braces',
      kind: 'braces',
      level: 'error',
      line: 15,
    },
  ]);
});

should('patterns CLI scans source files and skips tests', async () => {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(join(TMP, 'test'), { recursive: true });
  writeFileSync(join(TMP, 'package.json'), '{"name":"patterns-fixture","type":"module"}\n');
  writeFileSync(join(TMP, 'index.ts'), 'export const ok = 1;\n');
  writeFileSync(join(TMP, 'test/bad.test.ts'), 'const value = 1;\nvoid value;\n');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd: TMP }));
  deepStrictEqual(res.ok, true);
  match(res.stdout, /\[pass\] summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
  deepStrictEqual(res.stderr, '');
});
