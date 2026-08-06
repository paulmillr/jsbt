import { deepStrictEqual, rejects } from 'node:assert';
import { readFileSync } from 'node:fs';
import { should } from '../../src/test.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { runCli } = await import('../../src/jsbt/index.ts');

should('package build marks the jsbt-check bin executable', () => {
  deepStrictEqual(/chmod \+x jsbt-check\.bin\.js/.test(pkg.scripts.build), true);
  deepStrictEqual(pkg.bin, { 'jsbt-check': 'jsbt-check.bin.js' });
});

should('jsbt-check rejects undocumented selectors', async () => {
  for (const selector of ['build', 'esbuild', 'check', 'check-readme'])
    await rejects(() => runCli([selector]), new RegExp(`unknown check selector: ${selector}`));
});

should.runWhen(import.meta.url);
