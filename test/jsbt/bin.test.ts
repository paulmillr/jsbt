import { deepStrictEqual, rejects } from 'node:assert';
import { readFileSync } from 'node:fs';
import { should } from '../../src/test.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { runCli } = await import('../../src/jsbt/index.ts');

should('package build marks the jsbt bin executable', () => {
  deepStrictEqual(/chmod \+x jsbt\.bin\.js/.test(pkg.scripts.build), true);
});

should('jsbt rejects undocumented top-level commands', async () => {
  for (const command of ['build', 'esbuild', 'readme', 'check-readme'])
    await rejects(() => runCli([command]), new RegExp(`unknown jsbt command: ${command}`));
  await rejects(() => runCli(['check', 'check-readme']), /unknown check selector: check-readme/);
});

should.runWhen(import.meta.url);
