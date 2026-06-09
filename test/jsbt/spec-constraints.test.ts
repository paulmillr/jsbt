import { deepStrictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

// These constraints SHOULD NOT BE VIOLATED OR CHANGED AT ANY POINT.

const ROOT = resolve('.');
const NPM_FIXTURE = join(ROOT, 'test/jsbt/vectors/npm-check');
const npmEnv = {
  ...process.env,
  JSBT_LOG_LEVEL: '0',
  NO_COLOR: '1',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_loglevel: 'silent',
  npm_config_progress: 'false',
  npm_config_update_notifier: 'false',
};

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const sorted = (items: string[]) => items.slice().sort((a, b) => a.localeCompare(b));
const checkSelectors = [
  'bigint',
  'bytes',
  'comments',
  'errors',
  'importtime',
  'jsdoc',
  'jsr',
  'jsrpublish',
  'mutate',
  'patterns',
  'readme',
  'tests',
  'treeshake',
  'tsdoc',
  'typeimport',
] as const;
const jsbtTests = () =>
  sorted(readdirSync(join(ROOT, 'test/jsbt')).filter((file) => file.endsWith('.test.ts')));
const testTsFiles = (dir = 'test/jsbt'): string[] => {
  const out: string[] = [];
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory() && ent.name !== 'build' && ent.name !== 'node_modules')
      out.push(...testTsFiles(rel));
    else if (ent.name.endsWith('.ts')) out.push(rel);
  }
  return sorted(out);
};
const jsbtImport = /import\s+\{([^;]+?)\}\s+from\s+'(\.\.\/\.\.\/src\/jsbt\/[^']+)'/g;
const cleanupNpmFixture = () => {
  const build = join(NPM_FIXTURE, 'test/build');
  rmSync(join(build, 'node_modules'), { force: true, recursive: true });
  rmSync(join(build, 'out-treeshake'), { force: true, recursive: true });
  rmSync(join(build, 'package-lock.json'), { force: true });
  if (!existsSync(build)) return;
  for (const ent of readdirSync(build))
    if (ent.startsWith('.__')) rmSync(join(build, ent), { force: true, recursive: true });
};
const installNpmFixture = () => {
  const bin = join(NPM_FIXTURE, 'node_modules/.bin/jsbt');
  if (existsSync(bin)) return;
  rmSync(join(NPM_FIXTURE, 'node_modules'), { force: true, recursive: true });
  rmSync(join(NPM_FIXTURE, 'package-lock.json'), { force: true });
  const res = spawnSync('npm', ['install', '--ignore-scripts', '--no-package-lock'], {
    cwd: NPM_FIXTURE,
    encoding: 'utf8',
    env: npmEnv,
    timeout: 120_000,
  });
  deepStrictEqual(res.status, 0, `${res.stdout || ''}${res.stderr || ''}`);
};
const plain = (text: string): string => text.replace(/\x1b\[\d+(;\d+)*m/g, '');
const runNpmCheck = (args: string[] = []) => {
  installNpmFixture();
  cleanupNpmFixture();
  const res = spawnSync('npm', ['run', 'check', ...args], {
    cwd: NPM_FIXTURE,
    encoding: 'utf8',
    env: npmEnv,
    timeout: 120_000,
  });
  cleanupNpmFixture();
  const error = res.error ? `\n${res.error.message}` : '';
  const text = plain(`${res.stdout || ''}${res.stderr || ''}${error}`);
  return { status: res.status, text };
};
const has = (text: string, pattern: RegExp, label = String(pattern)) =>
  deepStrictEqual(pattern.test(text), true, `${label}\n${text}`);
const lacks = (text: string, pattern: RegExp, label = String(pattern)) =>
  deepStrictEqual(pattern.test(text), false, `${label}\n${text}`);
const fails = (res: ReturnType<typeof runNpmCheck>) =>
  deepStrictEqual(res.status !== 0, true, res.text);
const passes = (res: ReturnType<typeof runNpmCheck>) => deepStrictEqual(res.status, 0, res.text);

const exportedNames = (text: string): Set<string> => {
  const names = new Set<string>();
  for (const item of text.matchAll(/export\s+(?:const|function|class|type|interface)\s+(\w+)/g))
    names.add(item[1]);
  for (const item of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of item[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
};

should('test/index.ts imports every jsbt test file', () => {
  const imports = sorted(
    Array.from(read('test/index.ts').matchAll(/import '\.\/jsbt\/([^']+\.test\.ts)'/g)).map(
      (item) => item[1]
    )
  );
  deepStrictEqual(imports, jsbtTests());
});

should('every standalone jsbt test file opts into runWhen', () => {
  const missing = jsbtTests().filter(
    (file) => !read(`test/jsbt/${file}`).includes('should.runWhen(import.meta.url)')
  );
  deepStrictEqual(missing, []);
});

should('jsbt tests import names that source modules actually export', () => {
  const missing: string[] = [];
  for (const file of jsbtTests()) {
    const text = read(`test/jsbt/${file}`);
    const imports = text.matchAll(jsbtImport);
    for (const item of imports) {
      const spec = item[2].replace('../../', '');
      const exports = exportedNames(read(spec));
      const names = item[1]
        .split(',')
        .map((name) =>
          name
            .trim()
            .split(/\s+as\s+/)[0]
            .replace(/^type\s+/, '')
            .trim()
        )
        .filter(Boolean);
      for (const name of names) {
        if (!exports.has(name)) missing.push(`${file}: ${name} from ${spec}`);
      }
    }
  }
  deepStrictEqual(sorted(missing), []);
});

should('jsbt checker tests only import allowed node:assert helpers', () => {
  const allowed = new Set(['deepStrictEqual', 'throws', 'rejects']);
  const bad: string[] = [];
  for (const file of testTsFiles()) {
    const text = read(file);
    if (/import\s+\*\s+as\s+\w+\s+from\s+['"]node:assert['"]/.test(text))
      bad.push(`${file}: namespace assert import`);
    for (const item of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]node:assert['"]/g)) {
      for (const raw of item[1].split(',')) {
        const part = raw.trim();
        const name = part.split(/\s+as\s+/)[0]?.trim();
        if (!name || !allowed.has(name) || /\s+as\s+/.test(part)) bad.push(`${file}: ${part}`);
      }
    }
  }
  deepStrictEqual(bad, []);
});

should('jsbt files with fs-modify constraints do not import raw destructive fs helpers', () => {
  const files = readdirSync(join(ROOT, 'src/jsbt')).filter((file) => file.endsWith('.ts'));
  const bad: string[] = [];
  const forbidden = /\b(?:rmSync|rmdirSync|unlinkSync|writeFileSync)\b/;
  for (const file of files) {
    const text = read(`src/jsbt/${file}`);
    if (!text.includes('Do not call raw fs')) continue;
    for (const [idx, line] of text.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      if (forbidden.test(line)) bad.push(`${file}:${idx + 1}: ${trimmed}`);
    }
  }
  deepStrictEqual(bad, []);
});

should('documented top-level jsbt commands are wired in dispatcher', () => {
  const src = read('src/jsbt/index.ts');
  const documented = new Set(Array.from(src.matchAll(/^\s+jsbt\s+(\S+)/gm)).map((item) => item[1]));
  const cmdRun = src.match(/const cmdRun = \{([\s\S]*?)\n\} satisfies/)?.[1] || '';
  const wired = new Set(
    Array.from(cmdRun.matchAll(/^\s+(?:'([^']+)'|([A-Za-z]\w*)):/gm)).map(
      (item) => item[1] || item[2]
    )
  );
  const missing = sorted(Array.from(documented).filter((cmd) => !wired.has(cmd)));
  deepStrictEqual(missing, []);
});

should('README and CLI usage document every check selector', () => {
  const readme = read('README.md');
  const usage = read('src/jsbt/index.ts');
  const missing: string[] = [];
  for (const selector of checkSelectors) {
    const suffix = selector === 'treeshake' ? ' [out-dir]' : '';
    const jsbt = `jsbt check <package.json> ${selector}${suffix}`;
    const npm = `npm run check ${selector}`;
    if (!usage.includes(jsbt)) missing.push(`src/jsbt/index.ts: ${jsbt}`);
    if (!readme.includes(jsbt)) missing.push(`README.md: ${jsbt}`);
    if (!readme.includes(npm)) missing.push(`README.md: ${npm}`);
  }
  deepStrictEqual(missing, []);
});

should('constraint: npm run check errors prints standalone errors audit rows', () => {
  const res = runNpmCheck(['errors']);
  fails(res);
  has(res.text, /wrong a=true\n- index\.ts:sum: NO ERROR!/);
  has(res.text, /could not derive valid runtime probes from TSDoc example/);
  has(res.text, /jsbt check done in \d+s: errors\(\d+, \d+s\)/);
});

should('constraint: npm run check treeshake prints the standalone table', () => {
  const res = runNpmCheck(['treeshake']);
  passes(res);
  has(res.text, /module\s+│export\s+│min bundle\s+│LOC\s+│min KB/);
  has(res.text, /@jsbt-test\/npm-check\s+│/);
  has(res.text, /jsbt check done in \d+s: treeshake\(0, \d+s\)/);
});

should('constraint: npm run check patterns prints pattern findings', () => {
  const res = runNpmCheck(['patterns']);
  fails(res);
  has(res.text, /\[ERROR\] \(patterns\) index\.ts:2:1\/unused/);
  has(res.text, /do not silence unused values with void expression statement/);
  has(res.text, /jsbt check done in \d+s: patterns\(1, \d+s\)/);
});

should('constraint: npm run check tsdoc returns only the tsdoc subset', () => {
  const res = runNpmCheck(['tsdoc']);
  fails(res);
  has(res.text, /\[ERROR\] \(tsdoc\) /);
  has(res.text, /missing JSDoc/);
  lacks(res.text, /\(readme\)/);
  lacks(res.text, /\(patterns\)/);
  has(res.text, /jsbt check done in \d+s: tsdoc\(\d+, \d+s\)/);
});

should('constraint: npm run check readme returns only the readme subset', () => {
  const res = runNpmCheck(['readme']);
  fails(res);
  has(res.text, /\[ERROR\] \(readme\) README\.md:\d+\/usage/);
  lacks(res.text, /\(tsdoc\)/);
  lacks(res.text, /\(patterns\)/);
  has(res.text, /jsbt check done in \d+s: readme\(1, \d+s\)/);
});

should('constraint: plain npm run check suppresses standalone audit tables and patterns', () => {
  const res = runNpmCheck();
  fails(res);
  has(res.text, /\[ERROR\] \(readme\) /);
  has(res.text, /\[ERROR\] \(tsdoc\) /);
  has(res.text, /\[WARNING\] \(errors\) /);
  has(res.text, /could not derive valid runtime probes from TSDoc example/);
  lacks(res.text, /module\s+│export\s+│min bundle/);
  lacks(res.text, /^wrong \S+=/m);
  lacks(res.text, /NO ERROR!/);
  lacks(res.text, /\(patterns\)/);
  has(res.text, /jsbt check done in \d+s:/);
});

should('constraint: npm run check locks output contracts for every other selector', () => {
  const contracts = {
    bigint: {
      fail: true,
      has: [
        /\[ERROR\] \(bigint\) replace raw bigint literal with helper const/,
        /index\.ts:5:20\/bigint 123n -> \/\* @__PURE__ \*\/ BigInt\(123\)/,
      ],
    },
    bytes: {
      fail: true,
      has: [
        /\[ERROR\] \(bytes\) index\.ts:1\/helper add canonical bytes helper types/,
        /wrap input type with TArg<\.\.\.>/,
        /wrap output type with TRet<\.\.\.>/,
      ],
    },
    comments: {
      fail: true,
      has: [/\[ERROR\] \(comments\) index\.ts:4\/comment comment line exceeds 100 chars/],
    },
    importtime: {
      pass: true,
      has: [/\[WARNING\] \(importtime\) index\.js:import \d+\.\d+ms \(x\d+\.\d+ from baseline\)/],
    },
    jsdoc: {
      fail: true,
      head: 'tsdoc',
      has: [/\[ERROR\] \(tsdoc\) /, /missing JSDoc/],
      lacks: [/\(readme\)/, /\(patterns\)/],
    },
    jsr: {
      fail: true,
      has: [
        /\[ERROR\] \(jsr\) fix jsr export mapping/,
        /jsr\.json:name name mismatch/,
        /add required publish entry/,
      ],
    },
    jsrpublish: {
      has: [/\[(?:ERROR|WARNING|INFO)\] \(jsrpublish\) /],
    },
    mutate: {
      fail: true,
      has: [/\[ERROR\] \(mutate\) index\.js:mutable mutable object export/],
    },
    tests: {
      fail: true,
      has: [/\[ERROR\] \(tests\) test\/fail\.test\.ts:exec exited 1 AssertionError/],
    },
    typeimport: {
      fail: true,
      has: [/\[ERROR\] \(typeimport\) index\.d\.mts:\d+\/typeimport add import type/],
    },
  } as const;
  for (const [selector, contract] of Object.entries(contracts)) {
    const res = runNpmCheck([selector]);
    if ('fail' in contract) fails(res);
    if ('pass' in contract) passes(res);
    lacks(res.text, /unknown jsbt command/, selector);
    const head = 'head' in contract ? contract.head : selector;
    has(res.text, new RegExp(`jsbt check done in \\d+s: ${head}\\(`), selector);
    for (const pattern of contract.has) has(res.text, pattern, selector);
    if ('lacks' in contract)
      for (const pattern of contract.lacks) lacks(res.text, pattern, selector);
  }
});

should.runWhen(import.meta.url);
