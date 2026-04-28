import * as assert from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/jsr');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');
const { runCli: runJsr } = await import('../../src/jsbt/jsr.ts');

const fixture = (name: string) => join(ROOT, name);
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
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const run = (cwd: string) => capture(() => runJsr(['package.json'], { color: false, cwd }));

should('jsr passes on root-entry fixture', async () => {
  const cwd = fixture('pass-root');
  const res = await run(cwd);
  assert.equal(res.ok, true, all(res));
  assert.match(plain(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should(
  'jsr passes on src-entry fixture and ignores npm-only deps outside the exported source graph',
  async () => {
    const cwd = fixture('pass-src');
    const res = await run(cwd);
    assert.equal(res.ok, true, all(res));
    assert.match(plain(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
  }
);

should('jsr accepts type-only public source deps from devDependencies', async () => {
  const cwd = fixture('pass-typeonly-dev');
  const res = await run(cwd);
  assert.equal(res.ok, true, all(res));
  assert.match(plain(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('jsr forces import mappings for optional peer runtime deps', async () => {
  const cwd = fixture('fail-optional-peer-import');
  const res = await run(cwd);
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) fix jsr import mapping \(jsr-import\)\n  jsr\.json:imports @awasm\/compiler -> jsr:@awasm\/compiler@0\.1\.1/
  );
  assert.doesNotMatch(
    plain(res),
    /\[ERROR\] \(jsr\) package\.json:dependencies add package dependency for exported source import @awasm\/compiler \(jsr-dep\)/
  );
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 1 failure, 0 skipped/);
});

should('jsr reports gitignored module graph paths with publish.exclude unignore hint', async () => {
  const cwd = fixture('fail-gitignored-graph');
  const res = await run(cwd);
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) 2x unignore gitignored module graph path; add publish\.exclude entry !src\/generated \(jsr-gitignore\)\n  src\/generated\/index\.ts:gitignore\n  src\/generated\/util\.js:gitignore/
  );
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 2 failures, 0 skipped/);
});

should('jsr accepts gitignored module graph paths when publish.exclude already unignores them', async () => {
  const cwd = fixture('pass-gitignored-unignored');
  const res = await run(cwd);
  assert.equal(res.ok, true, all(res));
  assert.match(plain(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('jsr reports export, import, publish, version, and name mismatches', async () => {
  const cwd = fixture('fail-src');
  const res = await run(cwd);
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) jsr\.json:version version mismatch; expected 1\.2\.3 from package\.json \(jsr-version\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) jsr\.json:name name mismatch; expected @paulmillr\/micro-jsr-fail from package\.json \(jsr-name\)/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) missing jsr export mapping \(jsr-export\)\n  jsr\.json:exports \.\/util\.js -> \.\/src\/util\.ts/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) remove unexpected jsr export mapping \(jsr-export-extra\)\n  jsr\.json:exports \.\/extra\.js -> \.\/src\/extra\.ts/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) 2x fix jsr import mapping \(jsr-import\)\n  jsr\.json:imports @noble\/hashes -> jsr:@noble\/hashes\n  jsr\.json:imports micro-packed -> jsr:@paulmillr\/micro-packed/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) remove unexpected jsr import mapping \(jsr-import-extra\)\n  jsr\.json:imports unused -> jsr:@paulmillr\/unused/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) 2x add required publish entry \(jsr-publish-required\)\n  jsr\.json:publish LICENSE\n  jsr\.json:publish README\.md/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) 2x add publish coverage for exported source graph \(jsr-publish\)\n  jsr\.json:publish src\/shared\.ts\n  jsr\.json:publish src\/util\.ts/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) remove non-source publish entry \(jsr-publish-source\)\n  jsr\.json:publish util\.js/
  );
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 12 failures, 0 skipped/);
  assert.match(plain(res), /JSR check found issues/);
});

should('jsr reports stale import versions from package.json deps while allowing jsr package remaps', async () => {
  const cwd = fixture('fail-version');
  const res = await run(cwd);
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(jsr\) 2x fix jsr import mapping \(jsr-import\)\n  jsr\.json:imports @noble\/hashes -> jsr:@noble\/hashes@\^2\.2\.0\n  jsr\.json:imports micro-packed -> jsr:@paulmillr\/micro-packed@\^0\.8\.0/
  );
  assert.doesNotMatch(plain(res), /summary: 1 passed/);
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 2 failures, 0 skipped/);
});

should('check-jsr alias runs jsr checker', async () => {
  const cwd = fixture('pass-root');
  const res = await capture(() => runJsbt(['check-jsr', 'package.json'], { color: false, cwd }));
  assert.equal(res.ok, true, all(res));
  assert.match(plain(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should.runWhen(import.meta.url);
