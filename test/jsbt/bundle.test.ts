import { deepStrictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { should } from '../../src/test.ts';
import { __TEST as FS_TEST } from '../../src/fs-modify.ts';
import { __TEST, runCli } from '../../src/jsbt/bundle.ts';

const ROOT = resolve('test/jsbt/build/bundle');

const clean = (name = '') => rmSync(join(ROOT, name), { force: true, recursive: true });
const capture = <T>(fn: () => T): { out: string; value: T } => {
  const prevLog = console.log;
  let out = '';
  console.log = (...args) => {
    out += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  try {
    return { out, value: fn() };
  } finally {
    console.log = prevLog;
  }
};
const seed = (name: string, pkgName: string) => {
  const cwd = join(ROOT, name);
  clean(name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, 'package.json'),
    `${JSON.stringify({ name: pkgName, type: 'module' }, undefined, 2)}\n`
  );
  return cwd;
};
const inOsTmp = (file: string) => {
  const rel = relative(tmpdir(), file);
  return !!rel && !rel.startsWith('..') && rel.split(/[\\/]/)[0]?.startsWith('jsbt-bundle-');
};
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
const expectedFastWorkers = (fast: string): number => {
  const max = cpus().length;
  const raw = Number.parseFloat(fast);
  const count = raw === 1 ? max : raw < 0 ? max + raw : raw < 1 ? Math.floor(max * raw) : raw;
  return Math.max(1, Math.min(count, 256));
};
const captureBundleCommands = async (fast: string | undefined) => {
  const commands = ['npx esbuild out', 'npx esbuild min'];
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  let workers = 0;
  await withEnv('JSBT_FAST', fast, async () => {
    workers = __TEST.bundleFastWorkers();
    await __TEST.runBundleCommands(commands, async (cmd) => {
      order.push(`start ${cmd}`);
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      order.push(`end ${cmd}`);
    });
  });
  return { maxActive, order, workers };
};

should('bundle defaults to auto and parses explicit directory flags', () => {
  const cwd = resolve('.');
  deepStrictEqual(__TEST.parseArgs([], cwd), {
    cwd,
    directory: '',
    help: false,
    noPrefix: false,
    stats: false,
  });
  deepStrictEqual(__TEST.parseArgs(['--stats'], cwd), {
    cwd,
    directory: '',
    help: false,
    noPrefix: false,
    stats: true,
  });
  deepStrictEqual(__TEST.parseArgs(['--dir=test/jsbt', '--no-prefix'], cwd), {
    cwd,
    directory: resolve(cwd, 'test/jsbt'),
    help: false,
    noPrefix: true,
    stats: false,
  });
  throws(() => __TEST.parseArgs(['--auto'], cwd), /jsbt bundle/);
  throws(() => __TEST.parseArgs(['test/jsbt'], cwd), /jsbt bundle/);
  throws(() => __TEST.parseArgs(['--bad'], cwd), /jsbt bundle/);
  throws(() => __TEST.parseArgs(['--dir=missing-build-dir'], cwd), /jsbt bundle/);
});

should('bundle formats checksum paths relative to cwd when possible', () => {
  const cwd = resolve('.');
  const output = join(cwd, 'test', 'build', 'out', 'package.js');
  const outside = resolve(cwd, '..', 'package.js');
  deepStrictEqual(__TEST.displayPath(cwd, output), join('test', 'build', 'out', 'package.js'));
  deepStrictEqual(__TEST.displayPath(cwd, outside), outside);
});

should('bundle report starts with actual checksum lines', () => {
  const outHash = 'a'.repeat(64);
  const minHash = 'b'.repeat(64);
  const lines = __TEST.bundleReportLines({
    gzipBytes: 512,
    loc: 9,
    minBytes: 2048,
    minHash,
    minName: 'package.min.js',
    minPath: 'test/build/out/package.min.js',
    outHash,
    outName: 'package.js',
    outPath: 'test/build/out/package.js',
  });
  deepStrictEqual(lines[0], `${outHash} test/build/out/package.js`);
  deepStrictEqual(lines[1], `${minHash} test/build/out/package.min.js`);
  deepStrictEqual(lines[5].replace(/\x1b\[[0-9;]*m/g, ''), '0.50 KB +gzip');
  deepStrictEqual(
    lines.some((line) => line.includes('shasum')),
    false
  );
  const stats = __TEST.bundleReportLines(
    {
      gzipBytes: 512,
      loc: 9,
      minBytes: 2048,
      minName: 'package.min.js',
      minPath: 'test/build/out/package.min.js',
      outName: 'package.js',
      outPath: 'test/build/out/package.js',
    },
    { stats: true }
  );
  deepStrictEqual(
    stats.some((line) => line.includes(outHash) || line.includes(minHash)),
    false
  );
  deepStrictEqual(stats[0].replace(/\x1b\[[0-9;]*m/g, ''), '9 LOC package.js');
});

should('bundle uses JSBT_FAST worker semantics for esbuild commands', async () => {
  const disabled = await captureBundleCommands('');
  deepStrictEqual(disabled.workers, 0);
  deepStrictEqual(disabled.maxActive, 1);
  deepStrictEqual(disabled.order, [
    'start npx esbuild out',
    'end npx esbuild out',
    'start npx esbuild min',
    'end npx esbuild min',
  ]);

  const explicit = await captureBundleCommands('2');
  deepStrictEqual(explicit.workers, 2);
  deepStrictEqual(explicit.maxActive, 2);

  const negative = await captureBundleCommands('-1');
  deepStrictEqual(negative.workers, expectedFastWorkers('-1'));
  deepStrictEqual(negative.maxActive, negative.workers < 2 ? 1 : 2);

  const ratio = await captureBundleCommands('0.5');
  deepStrictEqual(ratio.workers, expectedFastWorkers('0.5'));
  deepStrictEqual(ratio.maxActive, ratio.workers < 2 ? 1 : 2);
});

should('bundle auto mode creates an os temp build fixture', () => {
  const cwd = seed('auto-tmp', '@jsbt-test/bundle-auto');
  const target = __TEST.prepareAutoDir(cwd);
  const root = target.root;
  try {
    deepStrictEqual(target.temp, true);
    deepStrictEqual(inOsTmp(root), true);
    deepStrictEqual(
      readFileSync(join(root, 'input.js'), 'utf8'),
      __TEST.autoInput('@jsbt-test/bundle-auto')
    );
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      private: boolean;
      type: string;
    };
    deepStrictEqual(pkg.private, true);
    deepStrictEqual(pkg.type, 'module');
    deepStrictEqual(pkg.dependencies['@jsbt-test/bundle-auto'].startsWith('file://'), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
    clean('auto-tmp');
  }
});

should('bundle auto mode suppresses setup logs in os tmpdir', () => {
  const cwd = seed('auto-quiet', '@jsbt-test/bundle-quiet');
  const res = capture(() => __TEST.prepareAutoDir(cwd));
  try {
    deepStrictEqual(res.out, '');
    deepStrictEqual(res.value.temp, true);
    deepStrictEqual(inOsTmp(res.value.root), true);
  } finally {
    rmSync(res.value.root, { force: true, recursive: true });
    clean('auto-quiet');
  }
});

should('bundle auto mode uses existing test/build and fills missing generated files', () => {
  const cwd = seed('auto-existing', '@jsbt-test/bundle-existing');
  const build = join(cwd, 'test', 'build');
  mkdirSync(build, { recursive: true });
  const target = capture(() => __TEST.prepareAutoDir(cwd)).value;
  try {
    deepStrictEqual(target, { root: build, temp: false });
    deepStrictEqual(existsSync(join(build, 'package.json')), true);
    deepStrictEqual(
      readFileSync(join(build, 'input.js'), 'utf8'),
      __TEST.autoInput('@jsbt-test/bundle-existing')
    );
  } finally {
    clean('auto-existing');
  }
});

should('bundle auto mode does not overwrite an existing test/build input', () => {
  const cwd = seed('auto-custom-input', '@jsbt-test/bundle-custom');
  const build = join(cwd, 'test', 'build');
  const input = join(build, 'input.js');
  mkdirSync(build, { recursive: true });
  writeFileSync(input, 'export const custom = true;\n');
  const target = capture(() => __TEST.prepareAutoDir(cwd)).value;
  try {
    deepStrictEqual(target, { root: build, temp: false });
    deepStrictEqual(readFileSync(input, 'utf8'), 'export const custom = true;\n');
  } finally {
    clean('auto-custom-input');
  }
});

should('fs-modify logs outside os tmpdir and suppresses inside it', () => {
  const prev = process.env.JSBT_LOG_LEVEL;
  process.env.JSBT_LOG_LEVEL = '0';
  try {
    deepStrictEqual(FS_TEST.shouldLogPath(join(ROOT, 'project', 'test', 'build')), true);
    deepStrictEqual(FS_TEST.shouldLogPath(join(tmpdir(), 'jsbt-bundle-test')), false);
  } finally {
    if (prev === undefined) delete process.env.JSBT_LOG_LEVEL;
    else process.env.JSBT_LOG_LEVEL = prev;
  }
});

should('fs-modify npm install prefers offline packages', () => {
  deepStrictEqual(FS_TEST.npmInstallArgs(), ['install', '--prefer-offline']);
});

should('bundle stats deletes generated os temp directory after run', async () => {
  const cwd = seed('stats-cleanup', '@jsbt-test/bundle-stats-cleanup');
  let root = '';
  try {
    await runCli(['--stats'], {
      cwd,
      runEsbuild: async (_cwd, buildRoot, _noPrefix, opts = {}) => {
        root = buildRoot;
        deepStrictEqual(opts.stats, true);
        deepStrictEqual(existsSync(root), true);
      },
    });
    deepStrictEqual(inOsTmp(root), true);
    deepStrictEqual(existsSync(root), false);
  } finally {
    if (root) rmSync(root, { force: true, recursive: true });
    clean('stats-cleanup');
  }
});

should.runWhen(import.meta.url);
