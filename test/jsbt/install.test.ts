import * as assert from 'node:assert';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/install');
const TMP = resolve('test/jsbt/build/check-install');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');

const seed = (name: string) => {
  const dir = join(TMP, name);
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, name, 'package.json'), join(dir, 'package.json'));
  return dir;
};
const read = (cwd: string) => readFileSync(join(cwd, 'package.json'), 'utf8');
const scripts = (cwd: string) => JSON.parse(read(cwd)).scripts;

should('check-install rewrites legacy check scripts', async () => {
  const cwd = seed('legacy');
  await runJsbt(['check-install', 'package.json'], { cwd });
  assert.deepStrictEqual(scripts(cwd), {
    build: 'tsc',
    'build:release': 'npx --no @paulmillr/jsbt esbuild test/build',
    check: 'npx --no @paulmillr/jsbt check package.json',
    'check:install': 'npx --no @paulmillr/jsbt check-install package.json',
    'check:readme': 'npx --no @paulmillr/jsbt readme package.json',
    'check:treeshake': 'npx --no @paulmillr/jsbt treeshake package.json test/build/out-treeshake',
    'check:jsdoc': 'npx --no @paulmillr/jsbt tsdoc package.json',
    'check:comments': 'npx --no @paulmillr/jsbt comments package.json',
    'check:errors': 'npx --no @paulmillr/jsbt errors package.json',
    'check:bigint': 'npx --no @paulmillr/jsbt bigint package.json',
    'check:bytes': 'npx --no @paulmillr/jsbt bytes package.json',
    'check:mutate': 'npx --no @paulmillr/jsbt mutate package.json',
    'check:tests': 'npx --no @paulmillr/jsbt tests package.json',
    'check:importtime': 'npx --no @paulmillr/jsbt importtime package.json',
    'check:typeimport': 'npx --no @paulmillr/jsbt typeimport package.json',
    'check:jsr': 'npx --no @paulmillr/jsbt jsr package.json',
    'check:jsrpublish': 'npx --no @paulmillr/jsbt jsrpublish package.json',
    bench: 'node test/benchmark.ts',
    format: "prettier --write 'index.ts' 'test/*.{js,ts}'",
    test: 'node --experimental-strip-types test/index.ts',
  });
  assert.equal(read(cwd).endsWith('\n'), true);
  rmSync(cwd, { force: true, recursive: true });
});

should('check-install preserves a legacy build prelude before unified check', async () => {
  const cwd = seed('legacy-build');
  await runJsbt(['check-install', 'package.json'], { cwd });
  assert.deepStrictEqual(scripts(cwd), {
    build: 'tsc',
    'build:release': 'npx --no @paulmillr/jsbt esbuild test/build',
    check: 'npm run build && npx --no @paulmillr/jsbt check package.json',
    'check:install': 'npx --no @paulmillr/jsbt check-install package.json',
    'check:readme': 'npx --no @paulmillr/jsbt readme package.json',
    'check:treeshake': 'npx --no @paulmillr/jsbt treeshake package.json test/build/out-treeshake',
    'check:jsdoc': 'npx --no @paulmillr/jsbt tsdoc package.json',
    'check:comments': 'npx --no @paulmillr/jsbt comments package.json',
    'check:errors': 'npx --no @paulmillr/jsbt errors package.json',
    'check:bigint': 'npx --no @paulmillr/jsbt bigint package.json',
    'check:bytes': 'npx --no @paulmillr/jsbt bytes package.json',
    'check:mutate': 'npx --no @paulmillr/jsbt mutate package.json',
    'check:tests': 'npx --no @paulmillr/jsbt tests package.json',
    'check:importtime': 'npx --no @paulmillr/jsbt importtime package.json',
    'check:typeimport': 'npx --no @paulmillr/jsbt typeimport package.json',
    'check:jsr': 'npx --no @paulmillr/jsbt jsr package.json',
    'check:jsrpublish': 'npx --no @paulmillr/jsbt jsrpublish package.json',
    bench: 'node test/benchmark.ts',
    format: "prettier --write 'index.ts' 'test/*.{js,ts}'",
    test: 'node --experimental-strip-types test/index.ts',
  });
  rmSync(cwd, { force: true, recursive: true });
});

should('check-install is idempotent', async () => {
  const cwd = seed('legacy');
  await runJsbt(['check-install', 'package.json'], { cwd });
  const once = read(cwd);
  await runJsbt(['check-install', 'package.json'], { cwd });
  assert.deepStrictEqual(read(cwd), once);
  rmSync(cwd, { force: true, recursive: true });
});

should('check-install keeps a preserved build prelude on rerun', async () => {
  const cwd = seed('legacy-build');
  await runJsbt(['check-install', 'package.json'], { cwd });
  const once = read(cwd);
  await runJsbt(['check-install', 'package.json'], { cwd });
  assert.deepStrictEqual(read(cwd), once);
  rmSync(cwd, { force: true, recursive: true });
});

should.runWhen(import.meta.url);
