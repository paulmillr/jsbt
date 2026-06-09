import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { should } from '../../src/test.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

should('package build marks the jsbt bin executable', () => {
  deepStrictEqual(/chmod \+x jsbt\.bin\.js/.test(pkg.scripts.build), true);
});

should.runWhen(import.meta.url);
