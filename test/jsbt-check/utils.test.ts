import { deepStrictEqual, throws } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { should } from '../../src/test.ts';
import { loadModuleApi, pkgTarget, readJson, readText, relName } from 'baler';
import {
  compact,
  collectIssues,
  loadTypeScriptApi,
  nodeText,
  readSource,
  resolveLocalImport,
  defaultFast,
  docCommentLines,
  emptyResult,
  execText,
  fastWorkerCount,
  fileUrl,
  firstText,
  importTypeText,
  loadTypeScript,
  literalText,
  makeIssue,
  makeTypeCheck,
  nodeLine,
  nodeStart,
  parseFast,
  pkgArgs,
  relFile,
  reportIssues,
  runDepNames,
  runImportFile,
  runTempImport,
  runWorker,
  runWorkerExec,
  skipRootImportTrap,
  sourceCtx,
  table,
  textLines,
  withRunDir,
  jsbtWorkerLimit,
} from '../../src/jsbt-check/utils.ts';

const capture = (fn: () => void) => {
  const prevLog = console.log;
  const prevErr = console.error;
  const lines: string[] = [];
  try {
    console.log = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));
    console.error = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));
    try {
      fn();
      return { error: '', out: lines.join('\n') };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), out: lines.join('\n') };
    }
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};

should('pkgArgs parses common package command args', () => {
  deepStrictEqual(pkgArgs(['package.json']), { help: false, pkgArg: 'package.json' });
  deepStrictEqual(pkgArgs(['--help']), { help: true, pkgArg: '' });
  deepStrictEqual(pkgArgs(['-h']), { help: true, pkgArg: '' });
  throws(() => pkgArgs([]), /expected <package\.json>/);
  throws(() => pkgArgs(['a', 'b']), /expected <package\.json>/);
});

should('pkgTarget resolves package paths under cwd', () => {
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  deepStrictEqual(pkgTarget('package.json', cwd), {
    cwd,
    pkgFile: resolve(cwd, 'package.json'),
  });
  throws(() => pkgTarget('../package.json', cwd), /refusing unsafe package path/);
});

should('parseFast accepts worker offsets and ratios', () => {
  deepStrictEqual(parseFast('true'), 1);
  deepStrictEqual(parseFast('3'), 3);
  deepStrictEqual(parseFast('-1'), -1);
  deepStrictEqual(parseFast('-2'), -2);
  deepStrictEqual(parseFast('0.5'), 0.5);
  deepStrictEqual(parseFast('0.25'), 0.25);
  deepStrictEqual(parseFast('half'), 0);
  deepStrictEqual(parseFast('quarter'), 0);
  deepStrictEqual(parseFast('0'), 0);
  deepStrictEqual(parseFast('1.5'), 0);
  deepStrictEqual(parseFast('-0.5'), 0);
  deepStrictEqual(parseFast('-257'), 0);
});

should('jsbtWorkerLimit resolves fast offsets and ratios from max cores', () => {
  const prevFast = process.env.JSBT_FAST;
  const expectedRatio = (ratio: number) =>
    Math.max(1, Math.min(Math.floor(cpus().length * ratio), 256));
  try {
    deepStrictEqual(defaultFast({}), 1);
    deepStrictEqual(defaultFast({ JSBT_FAST: '' }), 0);
    deepStrictEqual(fastWorkerCount(1, 12), 12);
    deepStrictEqual(fastWorkerCount(-1, 12), 11);
    deepStrictEqual(fastWorkerCount(0.5, 12), 6);
    delete process.env.JSBT_FAST;
    deepStrictEqual(jsbtWorkerLimit(2), Math.max(1, Math.min(cpus().length, 256)));
    process.env.JSBT_FAST = '';
    deepStrictEqual(jsbtWorkerLimit(2), 1);
    process.env.JSBT_FAST = '-1';
    deepStrictEqual(jsbtWorkerLimit(2), Math.max(1, Math.min(cpus().length - 1, 256)));
    process.env.JSBT_FAST = '-2';
    deepStrictEqual(jsbtWorkerLimit(2), Math.max(1, Math.min(cpus().length - 2, 256)));
    process.env.JSBT_FAST = '0.5';
    deepStrictEqual(jsbtWorkerLimit(2), expectedRatio(0.5));
    process.env.JSBT_FAST = '0.25';
    deepStrictEqual(jsbtWorkerLimit(2), expectedRatio(0.25));
  } finally {
    if (prevFast === undefined) delete process.env.JSBT_FAST;
    else process.env.JSBT_FAST = prevFast;
  }
});

should('prepareRunDir generates the temp run manifest', () => {
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  const tmp = mkdtempSync(join(tmpdir(), 'baler-check-utils-'));
  try {
    const dir = join(tmp, 'build');
    deepStrictEqual(withRunDir({ cwd, pkg: { name: '@jsbt-test/check-root' } }, dir), {
      cwd,
      pkg: { name: '@jsbt-test/check-root' },
      runDir: dir,
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    deepStrictEqual(manifest.dependencies['@jsbt-test/check-root'], `file:${cwd}`);
    deepStrictEqual(/^\^0\.\d+\.\d+$/.test(manifest.dependencies.esbuild), true);
    // No test/build template involved; writes outside jsbt temp dirs are refused.
    throws(
      () => withRunDir({ cwd, pkg: { name: 'x' } }, join(cwd, 'test', 'build')),
      /expected baler temp path/
    );
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});

should('prepareRunDir links allowlisted readme dependencies from the project', () => {
  const cwd = resolve('test/jsbt-check/vectors/check/pass-readme-deps');
  const tmp = mkdtempSync(join(tmpdir(), 'baler-check-utils-'));
  try {
    const dir = join(tmp, 'build');
    withRunDir({ cwd, pkg: { name: '@jsbt-test/check-readme-deps' } }, dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // Explicit allowlist entries and runtime deps land as file: links into the project.
    deepStrictEqual(
      manifest.dependencies['@jsbt-test/dep'],
      `file:${join(cwd, 'node_modules', '@jsbt-test/dep')}`
    );
    deepStrictEqual(
      manifest.dependencies['@jsbt-test/rt'],
      `file:${join(cwd, 'node_modules', '@jsbt-test/rt')}`
    );
    deepStrictEqual(existsSync(join(dir, 'node_modules', '@jsbt-test/dep', 'index.js')), true);
    deepStrictEqual(existsSync(join(dir, 'node_modules', '@jsbt-test/rt', 'index.js')), true);
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
});

should('runDepNames validates the .jsbtrc.json exampleDependencies allowlist', () => {
  type Fixture = {
    dependencies?: Record<string, unknown>;
    rc?: Record<string, unknown>;
  };
  const make = (fixture: Fixture, deps: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'baler-check-utils-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: fixture.dependencies, name: 'me' })
    );
    if (fixture.rc) writeFileSync(join(dir, '.jsbtrc.json'), JSON.stringify(fixture.rc));
    for (const [name, version] of Object.entries(deps)) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version })
      );
    }
    return dir;
  };
  const check = (fixture: Fixture, deps: Record<string, string>, expect: string[] | RegExp) => {
    const dir = make(fixture, deps);
    try {
      if (expect instanceof RegExp) throws(() => runDepNames(dir, 'me'), expect);
      else deepStrictEqual(runDepNames(dir, 'me'), expect);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  };
  const allow = (spec: unknown) => ({ rc: { exampleDependencies: { a: spec } } });
  // No rc file at all is fine; explicit pins come first, installed runtime deps
  // follow, and uninstalled runtime deps are skipped.
  check({ dependencies: { b: '^2' } }, { b: '2.1.0' }, ['b']);
  check({ ...allow('1.0.0'), dependencies: { b: '^2', c: '^3' } }, { a: '1.0.0', b: '2.1.0' }, [
    'a',
    'b',
  ]);
  check(allow('1.0.0'), { a: '1.1.0' }, /pins a@1\.0\.0 but 1\.1\.0 is installed/);
  check(allow('1.0.0'), {}, /a@1\.0\.0 is not installed/);
  check(allow('^1.0.0'), { a: '1.0.0' }, /pin an exact version/);
  check(
    { ...allow('1.0.0'), dependencies: { a: '1.0.0' } },
    { a: '1.0.0' },
    /already trusted via dependencies/
  );
  check({ rc: { exampleDependencies: { '../evil': '1.0.0' } } }, {}, /invalid/);
  check({ rc: { exampleDependencies: { esbuild: '0.28.1' } } }, {}, /provided automatically/);
  // Config typos never silently disable a check.
  check({ rc: { readmeDeps: {} } }, {}, /unknown \.jsbtrc\.json key: readmeDeps/);
});

should('sourceCtx resolves package and source files', () => {
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  deepStrictEqual(sourceCtx('package.json', cwd), {
    cwd,
    files: [resolve(cwd, 'index.ts')],
    pkgFile: resolve(cwd, 'package.json'),
  });
});

should('readText and readJson read typed text files', () => {
  const pkgFile = resolve('test/jsbt-check/vectors/check/pass-root/package.json');
  const srcFile = resolve('test/jsbt-check/vectors/check/pass-root/index.ts');
  deepStrictEqual(
    readText(pkgFile),
    `{
  "name": "@jsbt-test/check-root",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "module": "index.js",
  "types": "index.d.mts",
  "sideEffects": false
}
`
  );
  deepStrictEqual(readJson<{ name: string }>(pkgFile).name, '@jsbt-test/check-root');
  const src = readSource(ts, srcFile);
  deepStrictEqual(src.text, readText(srcFile));
  deepStrictEqual(src.source.fileName, srcFile);
});

should('literalText and importTypeText read TypeScript string-like specifiers', () => {
  const source = ts.createSourceFile(
    'fixture.ts',
    `import { a } from 'pkg';
type T = import("./types").Thing;
const dyn = import(\`./dyn\`);
`,
    ts.ScriptTarget.ESNext,
    true
  );
  const out: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) out.push(literalText(ts, node.moduleSpecifier));
    else if (ts.isImportTypeNode(node)) out.push(importTypeText(ts, node));
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length
    )
      out.push(literalText(ts, node.arguments[0]));
    ts.forEachChild(node, walk);
  };
  walk(source);
  deepStrictEqual(out, ['pkg', './types', './dyn']);
  deepStrictEqual(literalText(ts, undefined), '');
});

should('loadTypeScript loads TypeScript through package-local resolution', () => {
  const pkgFile = resolve('test/jsbt-check/vectors/check/pass-root/package.json');
  const loaded = loadTypeScript<typeof ts>(
    pkgFile,
    'TypeScript compiler API',
    (mod) => typeof mod.createProgram === 'function'
  );
  deepStrictEqual(typeof loaded.createProgram, 'function');
  const api = loadTypeScriptApi<typeof ts>(pkgFile, 'TypeScript compiler API', ['createProgram']);
  deepStrictEqual(typeof api.createProgram, 'function');
  const module = loadModuleApi<typeof ts>(pkgFile, 'typescript', 'TypeScript scanner API', [
    'createScanner',
  ]);
  deepStrictEqual(typeof module.createScanner, 'function');
  throws(
    () => loadTypeScriptApi<typeof ts>(pkgFile, 'TypeScript nope API', ['definitelyMissing']),
    /expected TypeScript nope API/
  );
});

should('collectIssues counts empty scans as passed and maps issue refs', () => {
  const empty = emptyResult();
  empty.passed++;
  deepStrictEqual(emptyResult(), { failures: 0, passed: 0, skipped: 0, warnings: 0 });
  deepStrictEqual(empty, { failures: 0, passed: 1, skipped: 0, warnings: 0 });
  const res = collectIssues(
    ['ok', 'bad'],
    (item) => (item === 'ok' ? [] : [{ file: `${item}.ts`, line: 3 }]),
    (item) => ({
      level: 'ERROR',
      ref: { file: item.file, issue: 'found issue', sym: `${item.line}/scan` },
    })
  );
  deepStrictEqual(res, {
    issues: [{ level: 'ERROR', ref: { file: 'bad.ts', issue: 'found issue', sym: '3/scan' } }],
    result: { failures: 1, passed: 1, skipped: 0, warnings: 0 },
  });
});

should('firstText and compact normalize diagnostic snippets', () => {
  deepStrictEqual(textLines('\n  first \n second\n'), ['first', 'second']);
  deepStrictEqual(textLines(' keep  \n\n next  ', true), [' keep', ' next']);
  deepStrictEqual(docCommentLines('/**\n * first \n *\n * second\n */'), [
    '',
    'first',
    '',
    'second',
    '',
  ]);
  deepStrictEqual(docCommentLines('/**\n * first \n */', false), ['', 'first', '']);
  deepStrictEqual(firstText('\n  first \n second\n'), 'first');
  deepStrictEqual(firstText(''), '');
  deepStrictEqual(execText({ ok: false, status: 1, stderr: '\n err\n', stdout: '' }), 'err');
  deepStrictEqual(compact([' a ', '', 'b']), 'a; b');
  deepStrictEqual(compact(['a', 'b', 'c', 'd']), 'a; b; c; +1 more');
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  const outside = resolve(cwd, '../outside.ts');
  deepStrictEqual(fileUrl(resolve(cwd, 'index.js')), pathToFileURL(resolve(cwd, 'index.js')).href);
  deepStrictEqual(relFile(cwd, resolve(cwd, 'src/index.ts')), 'src/index.ts');
  deepStrictEqual(relFile(cwd, cwd), cwd);
  deepStrictEqual(relFile(cwd, outside), '../outside.ts');
  deepStrictEqual(relFile(cwd, outside, true), outside);
  deepStrictEqual(relName(cwd, resolve(cwd, 'src/index.ts')), 'src/index.ts');
  deepStrictEqual(relName(cwd, cwd), 'pass-root');
  deepStrictEqual(nodeText({ text: 'name' }), 'name');
  deepStrictEqual(nodeText({}), '');
  const source = {
    getLineAndCharacterOfPosition: (pos: number) => ({
      character: pos % 10,
      line: Math.floor(pos / 10),
    }),
  };
  deepStrictEqual(nodeStart(source, { getStart: () => 23, pos: 7 }), 23);
  deepStrictEqual(nodeStart(source, { pos: 17 }), 17);
  deepStrictEqual(nodeLine(source, { pos: 17 }), 2);
});

should('skipRootImportTrap converts intentional root import errors into skipped rows', () => {
  const trapped = { error: 'Root module cannot be imported: import submodules instead.' };
  deepStrictEqual(skipRootImportTrap(trapped), true);
  deepStrictEqual(trapped, { error: undefined, skip: true });
  const failed = { error: 'Cannot find module ./missing.js' };
  deepStrictEqual(skipRootImportTrap(failed), false);
  deepStrictEqual(failed, { error: 'Cannot find module ./missing.js' });
  deepStrictEqual(skipRootImportTrap({}), false);
});

should('resolveLocalImport builds local import candidates while caller owns acceptance', () => {
  const src = resolve('test/jsbt-check/vectors/jsr/pass-src/src/index.ts');
  const util = resolve('test/jsbt-check/vectors/jsr/pass-src/src/util.ts');
  deepStrictEqual(resolveLocalImport(src, './util.js', { accept: (file) => file === util }), util);
  deepStrictEqual(
    resolveLocalImport(src, './util.js', { accept: (file) => file === util, jsToTs: false }),
    undefined
  );
  const index = resolve('test/jsbt-check/vectors/jsr/pass-src/src/nested/index.js');
  deepStrictEqual(
    resolveLocalImport(src, './nested', { accept: (file) => file === index, exts: ['.js'] }),
    index
  );
  deepStrictEqual(
    resolveLocalImport(src, './nested', {
      accept: (file) => file === index,
      exts: ['.js'],
      indexExts: [],
    }),
    undefined
  );
  const bytes = resolve('test/jsbt-check/vectors/bytes/import-query.ts');
  const files = new Set([resolve('test/jsbt-check/vectors/bytes/utils.ts')]);
  deepStrictEqual(
    resolveLocalImport(bytes, './utils.ts', { accept: (file) => files.has(file) }),
    resolve('test/jsbt-check/vectors/bytes/utils.ts')
  );
  deepStrictEqual(resolveLocalImport(src, 'micro-packed', { accept: () => true }), undefined);
});

should('makeIssue normalizes levels and optional issue kinds', () => {
  deepStrictEqual(makeIssue('warn', 'file.ts', '7/name', 'fix this', 'kind'), {
    level: 'WARN',
    ref: { file: 'file.ts', issue: 'fix this (kind)', sym: '7/name' },
  });
  deepStrictEqual(makeIssue('INFO', 'package.json', 'check', 'all clear'), {
    level: 'INFO',
    ref: { file: 'package.json', issue: 'all clear', sym: 'check' },
  });
});

should('table renders grouped rows with ansi-aware widths', () => {
  const lines: string[] = [];
  const print = table((line) => lines.push(line));
  const sizes = [6, 6, 6];
  const bar = '\u2500'.repeat(7);
  const sep = `${bar}\u253c${bar}\u253c${bar}`;
  print.drawHeader(sizes, ['module', 'export', 'result']);
  let prev: string[] | undefined;
  prev = print.printRow(['core', 'all', '\x1b[32mok\x1b[0m'], prev, sizes, ['module', 'export']);
  prev = print.printRow(['core', 'hash', '\x1b[33mslow\x1b[0m'], prev, sizes, ['module', 'export']);
  prev = print.printRow(['extra', 'all', '\x1b[31merror\x1b[0m'], prev, sizes, [
    'module',
    'export',
  ]);
  print.drawSeparator(
    sizes,
    sizes.map(() => true)
  );
  deepStrictEqual(lines, [
    'module \u2502export \u2502result ',
    sep,
    'core   \u2502all    \u2502     \x1b[32mok\x1b[0m',
    '       \u2502hash   \u2502   \x1b[33mslow\x1b[0m',
    sep,
    'extra  \u2502all    \u2502  \x1b[31merror\x1b[0m',
    sep,
  ]);
});

should('reportIssues can make warning-only results fatal with checker-specific tags', () => {
  const issues = [makeIssue('warn', 'README.md', '1/usage', 'js->ts', 'fence-mismatch')];
  const res = { failures: 0, passed: 0, skipped: 0, warnings: 1 };
  deepStrictEqual(
    capture(() => reportIssues('readme', issues, res, false, 'README check found issues', 'error')),
    {
      error: 'README check found issues',
      out: [
        '[WARN] readme: README.md:1/usage js->ts (fence-mismatch)',
        '[error] summary: 0 passed, 1 warning, 0 failures, 0 skipped',
      ].join('\n'),
    }
  );
  deepStrictEqual(
    capture(() => reportIssues('tsdoc', issues, res, false, 'JSDoc check found issues', 'fail')),
    {
      error: 'JSDoc check found issues',
      out: [
        '[WARN] tsdoc: README.md:1/usage js->ts (fence-mismatch)',
        '[warn] summary: 0 passed, 1 warning, 0 failures, 0 skipped',
      ].join('\n'),
    }
  );
});

should('makeTypeCheck checks generated snippets', () => {
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  const check = makeTypeCheck(ts, cwd, '.__utils-check.ts');
  deepStrictEqual(check('const value: number = 1;\n'), []);
  deepStrictEqual(check("const value: number = 'x';\n"), [
    "Type 'string' is not assignable to type 'number'.",
  ]);
});

should('runWorker returns messages and mapped worker failures', async () => {
  const ok = await runWorker<{ ok?: boolean; error?: string }>(
    `import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({ ok: workerData.ok });`,
    { data: { ok: true }, error: (error) => ({ error }) }
  );
  deepStrictEqual(ok, { ok: true });
  const error = await runWorker<{ error: string }>(`throw new Error('boom');`, {
    data: {},
    error: (message) => ({ error: message }),
  });
  deepStrictEqual(error, { error: 'boom' });
});

should('runWorker terminates timed out workers', async () => {
  const res = await runWorker<{ timeout: boolean }>(`setInterval(() => {}, 1000);`, {
    data: {},
    error: (error) => {
      throw new Error(error);
    },
    timeout: { ms: 10, result: () => ({ timeout: true }) },
  });
  deepStrictEqual(res, { timeout: true });
});

should('runImportFile imports a fixture file in a worker', async () => {
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  const res = await runImportFile(resolve(cwd, 'index.js'), { cwd });
  deepStrictEqual(res, { ok: true, status: 0, stderr: '', stdout: '' });
});

should('runTempImport writes, imports, and removes generated files', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'baler-check-tempimport-'));
  const prev = process.env.JSBT_LOG_LEVEL;
  process.env.JSBT_LOG_LEVEL = '0';
  const res = await runTempImport(cwd, {
    code: "console.log('temp-ok');",
    ext: 'js',
    prefix: '.__readme-check-',
  }).finally(() => {
    if (prev === undefined) delete process.env.JSBT_LOG_LEVEL;
    else process.env.JSBT_LOG_LEVEL = prev;
  });
  deepStrictEqual(res, { ok: true, status: 0, stderr: '', stdout: 'temp-ok\n' });
  rmSync(cwd, { force: true, recursive: true });
});

should('runWorkerExec captures output and restores cwd', async () => {
  const prev = process.cwd();
  const cwd = resolve('test/jsbt-check/vectors/check/pass-root');
  const res = await runWorkerExec(
    `import { parentPort, workerData } from 'node:worker_threads';
console.log(process.cwd() === workerData.cwd ? 'cwd-ok' : process.cwd());
console.error('stderr-ok');
parentPort.postMessage({ ok: true });`,
    { cwd, data: { cwd } }
  );
  deepStrictEqual(res, {
    ok: true,
    status: 0,
    stderr: 'stderr-ok\n',
    stdout: 'cwd-ok\n',
  });
  deepStrictEqual(process.cwd(), prev);
});

// Vectors are committed, machine-independent fixtures. Generated artifacts embed
// absolute paths (run manifests, error-check probes), so any absolute path found
// here is a leaked artifact, not fixture material.
should('vectors contain no machine-specific absolute paths', () => {
  const vectors = resolve('test/jsbt-check/vectors');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules') walk(path);
      } else if (/(?:file:\/*)?\/(?:home|Users|root)\//.test(readFileSync(path, 'utf8')))
        offenders.push(relName(vectors, path));
    }
  };
  walk(vectors);
  deepStrictEqual(offenders, []);
});

should.runWhen(import.meta.url);
