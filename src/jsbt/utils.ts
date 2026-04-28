import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

declare const __JSBT_BUNDLE__: boolean | undefined;

export type Result = { failures: number; passed: number; skipped: number; warnings: number };
export type Level = 'ERROR' | 'INFO' | 'WARNING';
export type Ref = { file: string; issue: string; sym: string };
export type Issue = { level: Level; ref: Ref };
type Action = { detail?: string; key: string; text: string };
type GroupRef = { detail?: string; ref: Ref };

export const color = {
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
} as const;
const TS = new Set(['.cts', '.mts', '.ts', '.tsx']);

export const stripAnsi = (line: string): string => line.replace(/\x1b\[\d+(;\d+)*m/g, '');
export const bundled = (): boolean => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;
export const paint = (text: string, code: string, on: boolean = true): string =>
  on ? `${code}${text}${color.reset}` : text;
export const wantColor = (
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = !!process.stderr.isTTY || !!process.stdout.isTTY
): boolean => {
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return true;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  // Explicit force flags must win so one-shot debug runs can override a global NO_COLOR shell.
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.CLICOLOR === '0') return false;
  return tty;
};
export const status = (name: 'error' | 'pass' | 'warn', on: boolean): string => {
  const code = name === 'error' ? color.red : name === 'warn' ? color.yellow : color.green;
  return `[${paint(name, code, on)}]`;
};
export const tag = (name: Level, on: boolean): string => {
  const code = name === 'ERROR' ? color.red : name === 'WARNING' ? color.yellow : color.green;
  return `[${paint(name, code, on)}]`;
};
export const formatIssue = (level: Level, head: string, ref: Ref, on: boolean): string =>
  `${tag(level, on)} (${head}) ${ref.file}:${ref.sym} ${ref.issue}`;
export const issueKind = (text: string, kind: string): string => {
  const [first, ...rest] = text.split('\n');
  return [`${first} (${kind})`, ...rest].join('\n');
};
const locOf = (ref: Ref): string => `${ref.file}:${ref.sym}`;
const actionOf = (head: string, ref: Ref): Action => {
  if (head === 'bigint') {
    const [text, detail] = ref.issue.split('\n');
    if (detail) return { detail, key: text, text };
  }
  if (head === 'bytes') {
    const wrap = ref.issue.match(
      /^wrap (input|output) type with (TArg|TRet)<(.+)> \((bytes-(?:input|return))\)$/
    );
    if (wrap) {
      const [, mode, name, type, kind] = wrap;
      const text = `wrap ${mode} type with ${name}<...> (${kind})`;
      return { detail: `${name}<${type}>`, key: text, text };
    }
    const promise = ref.issue.match(
      /^wrap output type with Promise<TRet<(.+)>> \((bytes-return)\)$/
    );
    if (promise) {
      const [, type, kind] = promise;
      const text = `wrap output type with Promise<TRet<...>> (${kind})`;
      return { detail: `Promise<TRet<${type}>>`, key: text, text };
    }
    const badPromise = ref.issue.match(
      /^use Promise<TRet<(.+)>> instead of TRet<Promise<(.+)>> \((bytes-return)\)$/
    );
    if (badPromise) {
      const [, good, bad, kind] = badPromise;
      if (good === bad) {
        const text = `use Promise<TRet<...>> instead of TRet<Promise<...>> (${kind})`;
        return { detail: `Promise<TRet<${good}>>`, key: text, text };
      }
    }
  }
  if (head === 'treeshake') {
    const unused = ref.issue.match(/^unused \((.+?)\)(?: \((treeshake)\))?$/);
    if (unused) {
      const text = `unused${unused[2] ? ` (${unused[2]})` : ''}`;
      return { detail: `(${unused[1]})`, key: text, text };
    }
  }
  if (head === 'jsr') {
    const exportFix = ref.issue.match(
      /^(missing|fix) jsr export mapping; use (.+) -> (.+) \((jsr-export)\)$/
    );
    if (exportFix) {
      const [, mode, key, file, kind] = exportFix;
      const text = `${mode} jsr export mapping (${kind})`;
      return { detail: `${key} -> ${file}`, key: text, text };
    }
    const exportDrop = ref.issue.match(
      /^remove unexpected jsr export mapping; drop (.+) -> (.+) \((jsr-export-extra)\)$/
    );
    if (exportDrop) {
      const [, key, file, kind] = exportDrop;
      const text = `remove unexpected jsr export mapping (${kind})`;
      return { detail: `${key} -> ${file}`, key: text, text };
    }
    const importFix = ref.issue.match(
      /^fix jsr import mapping; use (.+) -> (.+) \((jsr-import)\)$/
    );
    if (importFix) {
      const [, key, file, kind] = importFix;
      const text = `fix jsr import mapping (${kind})`;
      return { detail: `${key} -> ${file}`, key: text, text };
    }
    const importDrop = ref.issue.match(
      /^remove unexpected jsr import mapping; drop (.+) -> (.+) \((jsr-import-extra)\)$/
    );
    if (importDrop) {
      const [, key, file, kind] = importDrop;
      const text = `remove unexpected jsr import mapping (${kind})`;
      return { detail: `${key} -> ${file}`, key: text, text };
    }
    const publishAdd = ref.issue.match(
      /^add (required publish entry|publish coverage for exported source graph); use (.+) \((jsr-publish(?:-required)?)\)$/
    );
    if (publishAdd) {
      const [, what, file, kind] = publishAdd;
      const text = `add ${what} (${kind})`;
      return { detail: file, key: text, text };
    }
    const publishDrop = ref.issue.match(
      /^remove non-source publish entry; drop (.+) \((jsr-publish-source)\)$/
    );
    if (publishDrop) {
      const [, file, kind] = publishDrop;
      const text = `remove non-source publish entry (${kind})`;
      return { detail: file, key: text, text };
    }
  }
  return { key: ref.issue, text: ref.issue };
};
const formatIssueGroup = (
  level: Level,
  head: string,
  issue: string,
  refs: GroupRef[],
  on: boolean
): string[] =>
  refs.length === 1 && !refs[0].detail
    ? [formatIssue(level, head, refs[0].ref, on)]
    : [
        `${tag(level, on)} (${head}) ${refs.length === 1 ? issue : `${refs.length}x ${issue}`}`,
        ...refs.map((item) => `  ${locOf(item.ref)}${item.detail ? ` ${item.detail}` : ''}`),
      ];
export const groupIssues = (head: string, issues: Issue[], on: boolean): string[] => {
  const grouped = new Map<string, { issue: string; level: Level; refs: GroupRef[] }>();
  for (const item of issues) {
    const action = actionOf(head, item.ref);
    const key = `${item.level}\0${action.key}`;
    const prev = grouped.get(key);
    const ref = { detail: action.detail, ref: item.ref };
    if (prev) prev.refs.push(ref);
    else grouped.set(key, { issue: action.text, level: item.level, refs: [ref] });
  }
  return [...grouped.values()].flatMap((item) =>
    formatIssueGroup(item.level, head, item.issue, item.refs, on)
  );
};
export const printIssues = (head: string, issues: Issue[], on: boolean): void => {
  for (const line of groupIssues(head, issues, on)) console.error(line);
};
export const summary = (res: Result): string =>
  `${res.passed} passed, ${res.warnings} warning${res.warnings === 1 ? '' : 's'}, ${res.failures} failure${res.failures === 1 ? '' : 's'}, ${res.skipped} skipped`;
export const guardChild = (cwd: string, file: string, label: string): void => {
  const rel = relative(cwd, file);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
export const wantTSFile = (file: string): boolean => {
  if (!TS.has(file.slice(file.lastIndexOf('.')))) return false;
  if (/\.d\.[cm]?ts$/.test(file)) return false;
  return true;
};
const listTSFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((ent) => {
      const file = join(dir, ent.name);
      if (ent.isDirectory()) return listTSFiles(file);
      return wantTSFile(file) ? [file] : [];
    });
export const pickTSFiles = (cwd: string): string[] => {
  const root = readdirSync(cwd, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((ent) => {
      const file = join(cwd, ent.name);
      if (!ent.isFile()) return [];
      return wantTSFile(file) ? [file] : [];
    });
  const src = join(cwd, 'src');
  const files = existsSync(src) ? [...root, ...listTSFiles(src)] : root;
  if (!files.length)
    throw new Error(`expected root *.ts files or src/*.ts files next to ${basename(cwd)}`);
  return files;
};
