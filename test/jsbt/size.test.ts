// Tests for the slim `jsbt` binary's `size` command. `jsbt-check` has its own
// suite in check.test.ts; `jsbt bundle` in bundle.test.ts.
import { deepStrictEqual } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { should as test } from '../../src/test.ts';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const BASE = resolve('.');
const ROOT = join(BASE, 'test/jsbt-check/vectors/check');
process.env.npm_config_audit = 'false';
process.env.npm_config_fund = 'false';
process.env.npm_config_loglevel = 'silent';
process.env.npm_config_progress = 'false';
process.env.npm_config_update_notifier = 'false';
const { runCli: runJsbt } = await import('../../src/jsbt.ts');
const { npmInstall } = await import('../../src/fs-modify.ts');
const should = Object.assign(test.serial, { runWhen: test.runWhen });

const fixture = (name: string) => join(ROOT, name);
const cleanup = (cwd: string) => {
  const build = join(cwd, 'test/build');
  rmSync(join(build, 'node_modules'), { force: true, recursive: true });
  rmSync(join(build, 'package-lock.json'), { force: true });
  if (!existsSync(build)) return;
  for (const ent of readdirSync(build))
    if (ent.startsWith('.__')) rmSync(join(build, ent), { force: true, recursive: true });
};
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
    return { error: undefined, ok: true, stderr, stdout };
  } catch (error) {
    stderr += `${(error as Error).message}\n`;
    return { error: error as Error, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const run = async (cwd: string, fn: () => Promise<void>) => {
  cleanup(cwd);
  const res = await capture(fn);
  cleanup(cwd);
  return res;
};
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const withEnv = async <T>(key: string, value: string | undefined, fn: () => Promise<T>) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

should('size command prints stats even with JSBT_QUIET and skips the audit', async () => {
  const cwd = fixture('pass-root');
  const res = await withEnv('JSBT_QUIET', '1', () =>
    run(cwd, () => runJsbt(['size'], { color: false, cwd }))
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^module,export,loc,minified_bytes,gzipped_bytes$/m.test(out), true, out);
  deepStrictEqual(/@jsbt-test\/check-root,,/.test(out), true, out);
  deepStrictEqual(/,_internal,/.test(out), false, out);
  deepStrictEqual(/bundle_path|_tree_shaking_|%/.test(res.stdout), false, out);
  deepStrictEqual(/\[(?:ERROR|WARN)\]/.test(out), false, out);
  deepStrictEqual(/checks? (?:started|finished)/.test(out), false, out);
  deepStrictEqual(/Tip:/.test(out), false, out);
});

should('size command selector rows are in-memory only', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd, () => runJsbt(['size', 'index'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^module,export,loc,minified_bytes,gzipped_bytes$/m.test(out), true, out);
  deepStrictEqual(/index,,\d+,/.test(out), true, out);
  deepStrictEqual(/bundle_path|\/tmp\//.test(out), false, out);
  // Nothing is kept: the flag is gone along with the files.
  const legacy = await run(cwd, () => runJsbt(['size', '--keep'], { color: false, cwd }));
  deepStrictEqual(legacy.ok, false);
  deepStrictEqual(/unknown size option: --keep/.test(plain(legacy)), true, plain(legacy));
});

should('size command works without a test/build template', async () => {
  const cwd = fixture('pass-no-build');
  try {
    const res = await run(cwd, () => runJsbt(['size'], { color: false, cwd }));
    const out = plain(res);
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/^module,export,loc,minified_bytes,gzipped_bytes$/m.test(out), true, out);
    deepStrictEqual(/@jsbt-test\/no-build,,/.test(out), true, out);
    // Default output is unsorted: natural order puts the package row first.
    deepStrictEqual(out.indexOf('@jsbt-test/no-build,,') < out.indexOf('index,add,'), true, out);
    // --sort groups module bundles first, then exports, each ascending by the key.
    const sortedRes = await run(cwd, () => runJsbt(['size', '--sort'], { color: false, cwd }));
    const sout = plain(sortedRes);
    deepStrictEqual(sortedRes.ok, true, all(sortedRes));
    deepStrictEqual(sout.indexOf('index,,') < sout.indexOf('index,add,'), true, sout);
    deepStrictEqual(sout.indexOf('@jsbt-test/no-build,,') < sout.indexOf('index,add,'), true, sout);
    deepStrictEqual(sout.indexOf('index,add,') < sout.indexOf('index,blob,'), true, sout);
    const badSort = await run(cwd, () => runJsbt(['size', '--sort=gzip'], { color: false, cwd }));
    deepStrictEqual(badSort.ok, false);
    deepStrictEqual(/unknown size option: --sort=gzip/.test(plain(badSort)), true, plain(badSort));
    deepStrictEqual(/,_internal,/.test(out), false, out);
    // `_underscore`-prefixed subpath exports are internal too and get no module rows.
    deepStrictEqual(/_priv/.test(out), false, out);
    // Machine mode carries raw bytes only; the data-heavy marker is table-only.
    deepStrictEqual(/data-heavy/.test(out), false, out);
    const tableRes = await withEnv('FORCE_COLOR', '1', () =>
      run(cwd, () => runJsbt(['size'], { cwd }))
    );
    const tableOut = plain(tableRes);
    deepStrictEqual(tableRes.ok, true, all(tableRes));
    // The incompressible base64 blob makes its rows big and poorly compressible.
    deepStrictEqual(/blob.*data-heavy/.test(tableOut), true, tableOut);
    deepStrictEqual(/add.*data-heavy/.test(tableOut), false, tableOut);
  } finally {
    rmSync(join(cwd, 'node_modules'), { force: true, recursive: true });
    rmSync(join(cwd, 'package-lock.json'), { force: true });
  }
});

should('size command falls back to globally installed esbuild', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'jsbt-size-no-esbuild-'));
  const prefix = mkdtempSync(join(tmpdir(), 'jsbt-size-global-'));
  try {
    // Fake npm global prefix: `npm root -g` resolves lib/node_modules (posix) or
    // node_modules (windows) under it; cover both layouts.
    for (const root of [join(prefix, 'lib', 'node_modules'), join(prefix, 'node_modules')]) {
      mkdirSync(root, { recursive: true });
      symlinkSync(join(BASE, 'node_modules/esbuild'), join(root, 'esbuild'), 'junction');
    }
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify(
        {
          main: './index.js',
          module: './index.js',
          name: '@jsbt-test/no-esbuild',
          private: true,
          sideEffects: false,
          type: 'module',
          version: '1.0.0',
        },
        undefined,
        2
      )}\n`
    );
    writeFileSync(join(cwd, 'index.js'), 'export const add = (a, b) => a + b;\n');
    // TypeScript must resolve near the project; only esbuild provisioning is exercised.
    mkdirSync(join(cwd, 'node_modules'));
    symlinkSync(
      join(BASE, 'node_modules/typescript'),
      join(cwd, 'node_modules/typescript'),
      'junction'
    );
    const res = await withEnv('npm_config_prefix', prefix, () =>
      capture(() => runJsbt(['size'], { color: false, cwd }))
    );
    const out = plain(res);
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/@jsbt-test\/no-esbuild,,/.test(out), true, out);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
    rmSync(prefix, { force: true, recursive: true });
  }
});

should('size command filters specific module/export paths', async () => {
  const cwd = fixture('pass-no-build');
  const res = await capture(() => runJsbt(['size', 'index/add'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^module,export,loc,minified_bytes,gzipped_bytes$/m.test(out), true, out);
  deepStrictEqual(/index,add,\d+,/.test(out), true, out);
  deepStrictEqual(/index,,|,blob,/.test(out), false, out);

  // Selectors accept extensions, ./ prefixes, package-name prefixes, and bare modules.
  for (const spec of [
    'index.js/add',
    'index.ts/add',
    './index.js/add',
    '@jsbt-test/no-build/index.js/add',
  ]) {
    const alias = await capture(() => runJsbt(['size', spec], { color: false, cwd }));
    const aout = plain(alias);
    deepStrictEqual(alias.ok, true, `${spec}\n${all(alias)}`);
    deepStrictEqual(/index,add,/.test(aout), true, `${spec}\n${aout}`);
  }
  const bare = await capture(() => runJsbt(['size', 'index'], { color: false, cwd }));
  const bout = plain(bare);
  deepStrictEqual(bare.ok, true, all(bare));
  deepStrictEqual(/index,,\d/.test(bout), true, bout);

  const multi = await capture(() =>
    runJsbt(['size', 'index/add', 'index/blob'], { color: false, cwd })
  );
  const mout = plain(multi);
  deepStrictEqual(multi.ok, true, all(multi));
  deepStrictEqual(/selection,,\d+,/.test(mout), true, mout);
  deepStrictEqual(/index,add,/.test(mout), true, mout);
  deepStrictEqual(/index,blob,/.test(mout), true, mout);

  // Wrong export names surface from esbuild during bundling (enumeration is skipped).
  const bad = await capture(() => runJsbt(['size', 'index/nope'], { color: false, cwd }));
  deepStrictEqual(bad.ok, false);
  deepStrictEqual(
    /index has no export: nope; use one of:\nindex\/add\nindex\/blob/.test(plain(bad)),
    true,
    plain(bad)
  );
  // No dangling table/CSV header when the selector fails.
  deepStrictEqual(/module,export/.test(plain(bad)), false, plain(bad));
  // Dash-typos in export names get caught before esbuild sees invalid syntax.
  const dashed = await capture(() => runJsbt(['size', 'index/some-name'], { color: false, cwd }));
  deepStrictEqual(dashed.ok, false);
  deepStrictEqual(
    /invalid export name: some-name .*did you mean index\/some_name\?/.test(plain(dashed)),
    true,
    plain(dashed)
  );
  const badMod = await capture(() => runJsbt(['size', 'nope'], { color: false, cwd }));
  deepStrictEqual(badMod.ok, false);
  deepStrictEqual(
    /unknown module: nope; use one of:\nindex/.test(plain(badMod)),
    true,
    plain(badMod)
  );
});

should('size command gives friendly hints for selector slips', async () => {
  const cwd = fixture('pass-no-build');
  // A mistyped module extension is neither an export name nor an unknown module.
  const typo = await capture(() => runJsbt(['size', 'index.t2/add'], { color: false, cwd }));
  deepStrictEqual(typo.ok, false);
  deepStrictEqual(
    /unknown module: index\.t2; did you mean index\/add\?/.test(plain(typo)),
    true,
    plain(typo)
  );
  // Same for npm refs, in copy-pasteable selector form (tsdoc is cached by other tests).
  const refTypo = await capture(() =>
    runJsbt(['size', 'npm:@microsoft/tsdoc@0.16.0/index.t2'], { color: false, cwd })
  );
  deepStrictEqual(refTypo.ok, false);
  deepStrictEqual(
    /unknown module: index\.t2; did you mean npm:@microsoft\/tsdoc@0\.16\.0\?/.test(
      plain(refTypo)
    ),
    true,
    plain(refTypo)
  );
  // An explicit extension names a module; a bogus one lists modules instead of being
  // retried as a root export (`invalid export name: 123456.js` would be nonsense).
  const extMod = await capture(() =>
    runJsbt(['size', 'npm:@microsoft/tsdoc@0.16.0/123456.js'], { color: false, cwd })
  );
  deepStrictEqual(extMod.ok, false);
  deepStrictEqual(
    /unknown module: 123456; use one of:\nnpm:@microsoft\/tsdoc@0\.16\.0$/m.test(plain(extMod)),
    true,
    plain(extMod)
  );
  // The same bogus filter on --list errors too instead of printing nothing.
  const extList = await capture(() =>
    runJsbt(['size', '--list', 'npm:@microsoft/tsdoc@0.16.0/123456.js'], { color: false, cwd })
  );
  deepStrictEqual(extList.ok, false);
  deepStrictEqual(
    /unknown module: 123456; use one of:\nnpm:@microsoft\/tsdoc@0\.16\.0$/m.test(plain(extList)),
    true,
    plain(extList)
  );
  const localList = await capture(() =>
    runJsbt(['size', '--list', 'nopemod'], { color: false, cwd })
  );
  deepStrictEqual(localList.ok, false);
  deepStrictEqual(
    /unknown module: nopemod; use one of:\nindex/.test(plain(localList)),
    true,
    plain(localList)
  );
  // Slash slips are harmless: trailing slash means the module, doubles collapse.
  const trailing = await capture(() => runJsbt(['size', 'index/'], { color: false, cwd }));
  deepStrictEqual(trailing.ok, true, all(trailing));
  deepStrictEqual(/index,,\d/.test(plain(trailing)), true, plain(trailing));
  const doubled = await capture(() => runJsbt(['size', 'index//add'], { color: false, cwd }));
  deepStrictEqual(doubled.ok, true, all(doubled));
  deepStrictEqual(/index,add,\d/.test(plain(doubled)), true, plain(doubled));
});

// Scratch package in a temp dir with real deps symlinked in, mirroring the entry-point
// shapes of top npm packages (ms, express, chalk, yargs, preact) without the network.
const withScratchPkg = async (
  files: Record<string, string>,
  fn: (cwd: string) => Promise<void>
) => {
  const cwd = mkdtempSync(join(tmpdir(), 'jsbt-size-scratch-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), text);
    }
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    for (const dep of ['typescript', 'esbuild'])
      symlinkSync(join(BASE, 'node_modules', dep), join(cwd, 'node_modules', dep), 'junction');
    await fn(cwd);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
};
const scratchJson = (extra: Record<string, unknown>) =>
  `${JSON.stringify({ name: '@jsbt-test/scratch', private: true, version: '1.0.0', ...extra })}\n`;

should('size command handles legacy and modern package entry shapes', async () => {
  const cjs = "'use strict';\nexports.add = (a, b) => a + b;\n";
  const esm = 'export const add = (a, b) => a + b;\n';
  // Extensionless legacy main (ms).
  await withScratchPkg(
    { 'index.js': cjs, 'package.json': scratchJson({ main: './index' }) },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/@jsbt-test\/scratch,,\d+,/.test(plain(res)), true, plain(res));
    }
  );
  // No entry fields at all: node's legacy ./index.js default (express).
  await withScratchPkg({ 'index.js': cjs, 'package.json': scratchJson({}) }, async (cwd) => {
    const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/@jsbt-test\/scratch,,\d+,/.test(plain(res)), true, plain(res));
  });
  // Root conditions object (chalk) — and the module must not be named "default".
  await withScratchPkg(
    {
      'main.js': esm,
      'package.json': scratchJson({ exports: { default: './main.js' }, type: 'module' }),
    },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,add,\d+,/.test(plain(res)), true, plain(res));
      deepStrictEqual(/default,/.test(plain(res)), false, plain(res));
    }
  );
  // String exports sugar.
  await withScratchPkg(
    { 'main.js': esm, 'package.json': scratchJson({ exports: './main.js', type: 'module' }) },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,add,\d+,/.test(plain(res)), true, plain(res));
    }
  );
  // .mjs entry (yargs).
  await withScratchPkg(
    { 'index.mjs': esm, 'package.json': scratchJson({ main: './index.mjs' }) },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,add,\d+,/.test(plain(res)), true, plain(res));
    }
  );
  // Alias keys (`./a` + `./a.js`, classnames/dotenv) list once; a root `./index.js` key
  // stays `index` instead of degenerating into a module named `.`; exports pointing at
  // files absent from the tarball (ramda's ./dist) are skipped, not fatal.
  await withScratchPkg(
    {
      'a.js': esm,
      'index.js': esm,
      'package.json': scratchJson({
        exports: {
          '.': './index.js',
          './a': './a.js',
          './a.js': './a.js',
          './gone': './dist/gone.js',
          './index.js': './index.js',
        },
        type: 'module',
      }),
    },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size', '--list'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      const lines = plain(res).trim().split('\n');
      deepStrictEqual(lines, ['index/add', 'a/add'], plain(res));
    }
  );
  // Entries that resolve to no JS at all must error, not measure an empty shim.
  await withScratchPkg(
    { 'package.json': scratchJson({ main: './style.css' }), 'style.css': 'body {}\n' },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, false);
      deepStrictEqual(
        /no importable JS modules found in @jsbt-test\/scratch/.test(plain(res)),
        true,
        plain(res)
      );
    }
  );
  // Deps exporting a name only under the `node` condition (execa's unicorn-magic,
  // concurrently's rxjs default-import) trigger one retry with node conditions.
  await withScratchPkg(
    {
      'index.js': "export { thing } from 'cond-dep';\n",
      'node_modules/cond-dep/default.js': 'export const other = 1;\n',
      'node_modules/cond-dep/node.js': 'export const thing = 1;\n',
      'node_modules/cond-dep/package.json': `${JSON.stringify({
        // Condition order matters: node before default, like real packages.
        exports: { '.': { node: './node.js', default: './default.js' } },
        name: 'cond-dep',
        type: 'module',
        version: '1.0.0',
      })}\n`,
      'package.json': scratchJson({ main: './index.js', type: 'module' }),
    },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,thing,\d+,/.test(plain(res)), true, plain(res));
      deepStrictEqual(/note: retrying with node conditions/.test(plain(res)), true, plain(res));
    }
  );
  // Undeclared optional imports become external with a note (preact's compat/server).
  await withScratchPkg(
    {
      'index.js': "import missing from 'jsbt-test-not-installed';\nexport const use = () => missing;\n",
      'package.json': scratchJson({ main: './index.js', type: 'module' }),
    },
    async (cwd) => {
      const res = await capture(() => runJsbt(['size'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,use,\d+,/.test(plain(res)), true, plain(res));
      deepStrictEqual(
        /note: treating unresolvable import jsbt-test-not-installed as external/.test(plain(res)),
        true,
        plain(res)
      );
    }
  );
});

should('size command rejects exports of CJS modules that have no exports', async () => {
  // esbuild cannot statically validate named imports against CommonJS, so a bogus name
  // would otherwise "build" into a permanently-undefined property read (npm:noble-hashes
  // is the real-world shape: its entry just throws). The build warning becomes an error.
  const cwd = fixture('pass-cjs');
  const res = await capture(() => runJsbt(['size', 'index/whatever'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /index has no export: whatever; use --list to see modules and exports/.test(plain(res)),
    true,
    plain(res)
  );
  deepStrictEqual(/will always be undefined|No matching export/.test(plain(res)), false, plain(res));
});

should('size command paints export names in listings and errors', async () => {
  const cwd = fixture('pass-no-build');
  // Unknown-export listings paint `/export` blue, matching size-line labels.
  const bad = await withEnv('FORCE_COLOR', '1', () =>
    capture(() => runJsbt(['size', 'index/nope'], { cwd }))
  );
  deepStrictEqual(bad.ok, false);
  deepStrictEqual(all(bad).includes('\x1b[33mindex\x1b[0m/\x1b[34madd\x1b[0m'), true, all(bad));
  deepStrictEqual(all(bad).includes('\x1b[31mnope\x1b[0m'), true, all(bad));
  // --list uses the same painting; machine mode stays plain.
  const list = await withEnv('FORCE_COLOR', '1', () =>
    capture(() => runJsbt(['size', '--list'], { cwd }))
  );
  deepStrictEqual(list.ok, true, all(list));
  deepStrictEqual(all(list).includes('\x1b[33mindex\x1b[0m/\x1b[34madd\x1b[0m'), true, all(list));
  // npm refs add a violet package segment: npm:{pkg}/{module}/{export}.
  const ref = await withEnv('FORCE_COLOR', '1', () =>
    capture(() => runJsbt(['size', '--list', 'npm:@microsoft/tsdoc@0.16.0'], { cwd }))
  );
  deepStrictEqual(ref.ok, true, all(ref));
  deepStrictEqual(
    all(ref).includes(
      'npm:\x1b[35m@microsoft/tsdoc@0.16.0\x1b[0m/\x1b[34mTSDocParser\x1b[0m'
    ),
    true,
    all(ref)
  );
});

should('size command --list prints selectable export paths without bundling', async () => {
  const cwd = fixture('pass-no-build');
  const res = await capture(() => runJsbt(['size', '--list'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^index\/add$/m.test(out), true, out);
  deepStrictEqual(/^index\/blob$/m.test(out), true, out);
  deepStrictEqual(/all|Tip:|module,export/.test(out), false, out);
  const filtered = await capture(() => runJsbt(['size', '--list', 'index'], { color: false, cwd }));
  deepStrictEqual(/^index\/add$/m.test(plain(filtered)), true, plain(filtered));
  // npm refs list in copy-pasteable selector form.
  const ref = await capture(() =>
    runJsbt(['size', '--list', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  const rout = plain(ref);
  deepStrictEqual(ref.ok, true, all(ref));
  deepStrictEqual(/^npm:@microsoft\/tsdoc@0\.16\.0\/TSDocParser$/m.test(rout), true, rout);
  deepStrictEqual(/^index\/add$/m.test(rout), false, rout);
});

should('size command --list caches pinned ref enumeration in jsbt.db.json', async () => {
  const cwd = fixture('pass-no-build');
  const db = join(tmpdir(), 'jsbt-refs', 'microsoft-tsdoc-0-16-0', 'jsbt.db.json');
  rmSync(db, { force: true });
  const argv = ['size', '--list', 'npm:@microsoft/tsdoc@0.16.0'];
  const first = await capture(() => runJsbt(argv, { color: false, cwd }));
  deepStrictEqual(first.ok, true, all(first));
  deepStrictEqual(existsSync(db), true);
  // A corrupt db is recomputed and rewritten, never trusted.
  writeFileSync(db, 'not json');
  const second = await capture(() => runJsbt(argv, { color: false, cwd }));
  deepStrictEqual(second.ok, true, all(second));
  deepStrictEqual(plain(second), plain(first));
  const parsed = JSON.parse(readFileSync(db, 'utf8'));
  deepStrictEqual(parsed.v, 1);
  deepStrictEqual(parsed.modules[0].exports.includes('TSDocParser'), true);
  // The db-served listing matches the freshly computed one.
  const third = await capture(() => runJsbt(argv, { color: false, cwd }));
  deepStrictEqual(plain(third), plain(first));
});

should('size command measures external npm refs alongside local exports', async () => {
  const cwd = fixture('pass-no-build');
  // @microsoft/tsdoc@0.16.0 is a repo devDependency, so the npm cache serves it offline.
  const res = await capture(() =>
    runJsbt(['size', 'index/add', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/index,add,\d+,/.test(out), true, out);
  deepStrictEqual(/^npm:@microsoft\/tsdoc@0\.16\.0,,\d+,/m.test(out), true, out);
  // The combined selection row includes both, despite different resolution roots.
  deepStrictEqual(/selection,,\d+,/.test(out), true, out);

  const bad = await capture(() => runJsbt(['size', 'npm:git+ssh://evil/x'], { color: false, cwd }));
  deepStrictEqual(bad.ok, false);
  deepStrictEqual(/invalid npm ref/.test(plain(bad)), true, plain(bad));

  // Scoped foreign packages may omit the npm: prefix — a `@scope/name` selector can
  // only mean a package. The local package's own name stays a local-selector spelling.
  const sugar = await capture(() =>
    runJsbt(['size', '@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  deepStrictEqual(sugar.ok, true, all(sugar));
  deepStrictEqual(/^npm:@microsoft\/tsdoc@0\.16\.0,,\d+,/m.test(plain(sugar)), true, plain(sugar));

  // Unknown ref exports get the same friendly listing as local ones, in selector form —
  // never a raw esbuild "No matching export" error with temp-dir paths.
  const miss = await capture(() =>
    runJsbt(['size', 'npm:@microsoft/tsdoc@0.16.0/index/NopeParser'], { color: false, cwd })
  );
  const missOut = plain(miss);
  deepStrictEqual(miss.ok, false);
  deepStrictEqual(
    /npm:@microsoft\/tsdoc@0\.16\.0 has no export: NopeParser; use one of:/.test(missOut),
    true,
    missOut
  );
  deepStrictEqual(
    /^npm:@microsoft\/tsdoc@0\.16\.0\/TSDocParser$/m.test(missOut),
    true,
    missOut
  );
  deepStrictEqual(/No matching export|jsbt-size-/.test(missOut), false, missOut);
});

should('size command measures a single file via --input', async () => {
  const cwd = fixture('pass-no-build');
  const res = await capture(() => runJsbt(['size', '--input=./index.js'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^module,export,loc,minified_bytes,gzipped_bytes$/m.test(out), true, out);
  // The file is the module: per-export rows plus ALL, but no package-level row.
  deepStrictEqual(/index,,\d/.test(out), true, out);
  deepStrictEqual(/index,add,/.test(out), true, out);
  deepStrictEqual(/index,blob,/.test(out), true, out);
  deepStrictEqual(/@jsbt-test/.test(out), false, out);
});

should('npm install failures surface stderr with a stable prefix', async () => {
  // Run-dir deps assemble via symlinks; npm runs only on cold cache, so exercise the
  // failure surface directly at the fs-modify boundary.
  const tmp = mkdtempSync(join(tmpdir(), 'jsbt-size-npmfail-'));
  const cache = mkdtempSync(join(tmpdir(), 'jsbt-size-cache-'));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(
        { dependencies: { '@jsbt-test/definitely-missing': '9.9.9' }, private: true },
        undefined,
        2
      )}\n`
    );
    await withEnv('npm_config_cache', cache, () =>
      withEnv('npm_config_registry', 'http://127.0.0.1:9', () =>
        withEnv('npm_config_fetch_retries', '0', () =>
          withEnv('npm_config_fetch_retry_maxtimeout', '100', async () => {
            let message = '';
            try {
              npmInstall(tmp);
            } catch (error) {
              message = (error as Error).message;
            }
            deepStrictEqual(
              /^npm install failed/.test(message),
              true,
              message
            );
          })
        )
      )
    );
  } finally {
    rmSync(tmp, { force: true, recursive: true });
    rmSync(cache, { force: true, recursive: true });
  }
});

should.runWhen(import.meta.url);
