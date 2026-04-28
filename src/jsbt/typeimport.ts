#!/usr/bin/env -S node --experimental-strip-types
/**
Checks public declaration files for local `import("./x").Type` references.
Goal:
  - keep published type surfaces readable without inline local import-type chains
Rules:
  - scan public `.d.ts` / `.d.mts` files only
  - report local relative `import("./x").Type` references
  - fix them with a local `import type { Foo } from './x.ts'; export type { Foo };`
  - direct `export type { Foo } from './x.ts'` does not create a local binding for signatures
  - runtime `await import(...)` and package/builtin import types are out of scope
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModules, readPkg } from './public.ts';
import {
  bundled,
  groupIssues,
  guardChild,
  issueKind,
  status,
  summary,
  type Issue as LogIssue,
  type Result,
  wantColor,
} from './utils.ts';

type Args = { help: boolean; pkgArg: string };
type Issue = { file: string; line: number; name: string; spec: string };
type TsLike = typeof import('typescript');

const usage = `usage:
  jsbt typeimport <package.json>

examples:
  jsbt typeimport package.json
  node /path/to/check-typeimport.ts package.json`;

const err = (msg: string): never => {
  throw new Error(msg);
};
const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true, pkgArg: '' };
  if (argv.length !== 1) err('expected <package.json>');
  return { help: false, pkgArg: argv[0] };
};
const loadTS = (pkgFile: string): TsLike => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req('typescript') as TsLike | { default?: TsLike };
    } catch {
      return err(`missing typescript near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const ts = ('default' in raw && raw.default ? raw.default : raw) as TsLike;
  if (typeof ts.createSourceFile !== 'function') err(`expected TypeScript parser API near ${pkgFile}`);
  return ts;
};
const startOf = (source: import('typescript').SourceFile, node: import('typescript').Node): number =>
  typeof node.getStart === 'function' ? node.getStart(source) : node.pos;
const specOf = (ts: TsLike, node: import('typescript').ImportTypeNode): string => {
  if (!ts.isLiteralTypeNode(node.argument)) return '';
  const lit = node.argument.literal;
  return ts.isStringLiteral(lit) ? lit.text : '';
};
const nameOf = (source: import('typescript').SourceFile, node: import('typescript').ImportTypeNode): string =>
  node.qualifier ? node.qualifier.getText(source) : 'import';
const issueOf = (name: string, spec: string) =>
  `add import type { ${name} } from '${spec}'; export type { ${name} }; to avoid import(...) in public types`;
const scan = (ts: TsLike, cwd: string, file: string): Issue[] => {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const out: Issue[] = [];
  const seen = new Set<string>();
  const walk = (node: import('typescript').Node): void => {
    if (ts.isImportTypeNode(node) && !node.isTypeOf) {
      const spec = specOf(ts, node);
      if (spec.startsWith('.')) {
        const line = source.getLineAndCharacterOfPosition(startOf(source, node)).line + 1;
        const name = nameOf(source, node);
        const key = `${name}\0${spec}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ file: relative(cwd, file) || basename(file), line, name, spec });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
};

export const runCli = async (
  argv: string[],
  opts: { color?: boolean; cwd?: string } = {}
): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  const cwd = resolve(opts.cwd || process.cwd());
  const pkgFile = resolve(cwd, args.pkgArg);
  guardChild(cwd, pkgFile, 'package');
  const colorOn = opts.color ?? wantColor();
  const ts = loadTS(pkgFile);
  const pkg = readPkg(pkgFile);
  const out: Result = { failures: 0, passed: 0, skipped: 0, warnings: 0 };
  const logs: LogIssue[] = [];
  for (const mod of listModules({ cwd, pkg, pkgFile })) {
    const issues = scan(ts, cwd, mod.dtsFile);
    if (!issues.length) {
      out.passed++;
      continue;
    }
    for (const item of issues)
      logs.push({
        level: 'ERROR',
        ref: {
          file: item.file,
          issue: issueKind(issueOf(item.name, item.spec), 'typeimport'),
          sym: `${item.line}/typeimport`,
        },
      });
    out.failures += issues.length;
  }
  for (const line of groupIssues('typeimport', logs, colorOn)) console.error(line);
  if (out.failures) {
    console.error(`${status('error', colorOn)} summary: ${summary(out)}`);
    err('Type import check found issues');
  }
  console.log(`${status('pass', colorOn)} summary: ${summary(out)}`);
};

const main = async (): Promise<void> => {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
};

const entry: string | undefined = process.argv[1];
const self: string = fileURLToPath(import.meta.url);
if (!bundled() && entry && realpathSync(resolve(entry)) === realpathSync(self)) void main();
