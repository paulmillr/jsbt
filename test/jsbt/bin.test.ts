import { deepStrictEqual, rejects } from 'node:assert';
import { readFileSync } from 'node:fs';
import { should } from '../../src/test.ts';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { runCli } = await import('../../src/jsbt.ts');

const capture = async (fn: () => Promise<void>) => {
  const prev = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = prev;
  }
  return out;
};

should('package build marks both jsbt bins executable', () => {
  deepStrictEqual(/chmod \+x jsbt\.js jsbt-check\.bin\.js/.test(pkg.scripts.build), true);
  deepStrictEqual(pkg.bin, { jsbt: 'jsbt.js', 'jsbt-check': 'jsbt-check.bin.js' });
});

should('jsbt prints per-subcommand help', async () => {
  const size = await capture(() => runCli(['size', '--help']));
  deepStrictEqual(/jsbt size \[--list/.test(size), true, size);
  deepStrictEqual(/jsbt bundle \[|jsbt-check/.test(size), false, size);
  const bundle = await capture(() => runCli(['bundle', '--help']));
  deepStrictEqual(/jsbt bundle \[--minify/.test(bundle), true, bundle);
  const all = await capture(() => runCli(['--help']));
  deepStrictEqual(/jsbt bundle/.test(all) && /jsbt size \[/.test(all), true, all);
  deepStrictEqual(/jsbt-check|check-install/.test(all), false, all);
});

should('jsbt rejects undocumented top-level commands and points to jsbt-check', async () => {
  for (const command of ['build', 'esbuild', 'readme', 'check-readme'])
    await rejects(() => runCli([command]), new RegExp(`unknown jsbt command: ${command}`));
  await rejects(() => runCli(['check']), /moved to the jsbt-check binary/);
  await rejects(() => runCli(['check-install']), /unknown jsbt command: check-install/);
});

should.runWhen(import.meta.url);
