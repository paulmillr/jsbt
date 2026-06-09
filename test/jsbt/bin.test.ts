import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { should } from '../../src/test.ts';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

should('package build marks the jsbt bin executable', () => {
  assert.match(pkg.scripts.build, /chmod \+x jsbt\.bin\.js/);
});

should.runWhen(import.meta.url);
