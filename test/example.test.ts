import * as assert from 'node:assert';
import { afterEach, beforeEach, describe, should } from '../src/test.ts';

describe('init', () => {
  let counterA_b = 0;
  let counterA_a = 0;
  let counterB_b = 0;
  let counterB_a = 0;
  let counterC_b = 0;
  let counterC_a = 0;
  describe('A', () => {
    beforeEach(() => {
      counterA_b++;
    });
    afterEach(() => {
      counterA_a++;
    });
    describe('B', () => {
      beforeEach(() => {
        counterB_b++;
      });
      afterEach(() => {
        counterB_a++;
      });
      describe('C', () => {
        beforeEach(() => {
          counterC_b++;
        });
        afterEach(() => {
          counterC_a++;
        });

        should('test', () => {
          assert.equal(counterA_b, 1);
          assert.equal(counterA_b, 1);
          assert.equal(counterA_b, 1);

          assert.equal(counterA_a, 0);
          assert.equal(counterB_a, 0);
          assert.equal(counterC_a, 0);
        });

        should('test 2', () => {
          assert.equal(counterA_b, 2);
          assert.equal(counterA_b, 2);
          assert.equal(counterA_b, 2);

          assert.equal(counterA_a, 1);
          assert.equal(counterB_a, 1);
          assert.equal(counterC_a, 1);
        });
      });
    });
  });

  should('test 3', () => {
    assert.equal(counterA_b, 2);
    assert.equal(counterA_b, 2);
    assert.equal(counterA_b, 2);

    assert.equal(counterA_a, 2);
    assert.equal(counterB_a, 2);
    assert.equal(counterC_a, 2);
  });
});

should('add two numbers together', () => {
  assert.equal(2 + 2, 4);
});

should('catch errors', () => {
  assert.throws(() => {
    throw new Error('invalid');
  });
  // throw new Error("invalid");
});

should('produce correct promise result', async () => {
  const fs = await import('node:fs/promises');
  const data = await fs.readFile('../README.md', 'utf-8');
  assert.ok(data.includes('Micro testing framework'));
});

describe('during any time of day', () => {
  describe('without hesitation', () => {
    should('multiply two numbers together', () => {
      assert.equal(2 * 2, 4);
    });

    should('multiply three numbers together', () => {
      assert.equal(3 * 3 * 3, 27);
    });
  });
});

should.opts.FAST = 0;
should.run();
