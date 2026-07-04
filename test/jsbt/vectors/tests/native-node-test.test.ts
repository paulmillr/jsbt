import { deepStrictEqual } from 'node:assert';
import { afterEach, beforeEach, describe, should } from '../../../../src/test.ts';

let before = 0;
let after = 0;

describe('native node test bridge', () => {
  beforeEach(() => {
    before++;
  });
  afterEach(() => {
    after++;
  });

  should('runs first test through node:test', () => {
    deepStrictEqual(before, 1);
    deepStrictEqual(after, 0);
  });

  should.skip('keeps skipped tests skipped', () => {
    throw new Error('skipped test ran');
  });

  should('runs second test through node:test', () => {
    deepStrictEqual(before, 2);
    deepStrictEqual(after, 1);
  });
});

await should.run();
