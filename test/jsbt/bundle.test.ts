import { deepStrictEqual, rejects, throws } from 'node:assert';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';
import { __TEST as FS_TEST } from '../../src/fs-modify.ts';
import { __TEST, runBundleCli as runCli } from '../../src/jsbt.ts';

const FIXTURE = resolve('test/jsbt-check/vectors/check/pass-no-build');

const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  const prevWrite = process.stdout.write;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return { ok: true, stderr, stdout };
  } catch (error) {
    stderr += `${(error as Error).message}\n`;
    return { ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    process.stdout.write = prevWrite;
  }
};

should('bundle parses flags and rejects removed ones', () => {
  const args = __TEST.parseArgs(['--minify', '--checksum', 'index/add']);
  deepStrictEqual(args, {
    checksum: true,
    help: false,
    input: undefined,
    list: false,
    minify: true,
    paths: ['index/add'],
  });
  throws(() => __TEST.parseArgs(['--project=pkg']), /unknown bundle option: --project=/);
  throws(() => __TEST.parseArgs(['--stats']), /unknown bundle option: --stats/);
  throws(() => __TEST.parseArgs(['--dir=test/build']), /unknown bundle option: --dir=/);
  throws(() => __TEST.parseArgs(['--no-prefix']), /unknown bundle option: --no-prefix/);
});

should('bundle writes the unminified bundle to stdout and nothing else', async () => {
  const res = await capture(() => runCli(['index/add'], { cwd: FIXTURE }));
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(res.stderr, '');
  deepStrictEqual(
    /var jsbtTestNoBuildIndexAdd = /.test(res.stdout),
    true,
    res.stdout.slice(0, 200)
  );
  // Pure content: no stats, hashes, paths, or headers.
  deepStrictEqual(/LOC|gzip|sha256|module,export|jsbt-bundle-/.test(res.stdout), false);
});

should('bundle --minify and --checksum emit variants of the same artifact', async () => {
  const min = await capture(() => runCli(['--minify', 'index/add'], { cwd: FIXTURE }));
  deepStrictEqual(min.ok, true, min.stderr);
  deepStrictEqual(
    /var jsbtTestNoBuildIndexAdd=\(/.test(min.stdout),
    true,
    min.stdout.slice(0, 120)
  );
  const sum = await capture(() => runCli(['--checksum', 'index/add'], { cwd: FIXTURE }));
  deepStrictEqual(sum.ok, true, sum.stderr);
  deepStrictEqual(/^[0-9a-f]{64}\n$/.test(sum.stdout), true, sum.stdout);
  const minSum = await capture(() =>
    runCli(['--checksum', '--minify', 'index/add'], { cwd: FIXTURE })
  );
  deepStrictEqual(/^[0-9a-f]{64}\n$/.test(minSum.stdout), true, minSum.stdout);
  deepStrictEqual(sum.stdout !== minSum.stdout, true);
});

should('bundle defaults to the whole package and supports --list', async () => {
  const res = await capture(() => runCli([], { cwd: FIXTURE }));
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(/var jsbtTestNoBuild = /.test(res.stdout), true, res.stdout.slice(0, 200));
  const list = await capture(() => runCli(['--list'], { cwd: FIXTURE }));
  deepStrictEqual(list.ok, true, list.stderr);
  deepStrictEqual(/^index\/add$/m.test(list.stdout), true, list.stdout);
  deepStrictEqual(/var /.test(list.stdout), false, list.stdout);
  await rejects(() => runCli(['index/nope'], { cwd: FIXTURE }), /has no export/);
});

should('fs-modify recognizes only jsbt-owned temp dirs', () => {
  deepStrictEqual(FS_TEST.inJsbtTmp(join(tmpdir(), 'jsbt-bundle-test')), true);
  deepStrictEqual(FS_TEST.inJsbtTmp(join(tmpdir(), 'other-dir')), false);
  deepStrictEqual(FS_TEST.inJsbtTmp(join(FIXTURE, 'test', 'build')), false);
  deepStrictEqual(FS_TEST.inJsbtTmp('relative/jsbt-x'), false);
});

should('fs-modify npm install prefers offline packages', () => {
  deepStrictEqual(FS_TEST.npmInstallArgs(), [
    'install',
    '--prefer-offline',
    '--ignore-scripts',
    '--no-package-lock',
  ]);
});

should.runWhen(import.meta.url);
