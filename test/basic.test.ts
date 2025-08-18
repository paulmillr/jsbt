import * as assert from 'node:assert';
import { describe, it, should } from '../src/test.ts';

const section = (name) => console.log(`${'='.repeat(16)} ${name} ${'='.repeat(16)}`);

function restoreOpts() {
  should.PRINT_TREE = true;
  should.PRINT_MULTILINE = true;
  should.STOP_AT_ERROR = true;
}

function basicData() {
  describe('micro-interrupt-controller tests', () => {
    describe('catch errors', () => {
      it('promise errors', () => {});
      it('sync errors', () => {});
    });
    describe('produce result', () => {
      describe('A + ? = A', () => {
        it('A + 0 = A', () => {
          console.log('DEBUG A = NaN');
        });
        it('A * 1 = A ', () => {});
      });
      it('Do some signature tests', () => {});
    });
  });
}

function skipData() {
  describe('A2', () => {
    describe('B', () => {
      it('C', () => {});
      it.skip('D', () => {});
    });
    describe('E', () => {
      describe('F', () => {
        it.skip('H', () => {});
        it('E', () => {});
      });
      it('I', () => {});
    });
    it('J', () => {});
  });
}

function onlyData() {
  describe('A2', () => {
    describe('B', () => {
      it('C', () => {});
      it('D', () => {});
    });
    describe('E', () => {
      describe('F', () => {
        it.only('H', () => {});
        it('E', () => {});
      });
      it('I', () => {});
    });
    it('J', () => {});
  });
}

function errorData() {
  describe('A2', () => {
    describe('B', () => {
      it('C', () => {
        throw new Error('error 1');
      });
      it.skip('D', () => {});
    });
    describe('E', () => {
      describe('F', () => {
        it.skip('H', () => {});
        it('E', () => {
          throw new Error('error 2');
        });
      });
      it('I', () => {});
    });
    it('J', () => {});
  });
}

(async () => {
  section('Basic');
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
    const data = await fs.readFile('README.md', 'utf-8');
    assert.ok(data.includes('Micro testing framework'));
  });

  // Execute this at the end of a file.
  await should.run();

  // Nested tests
  section('Nested');
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

  basicData();

  describe('A2', () => {
    describe('B', () => {
      it('C', () => {});
      it('D', () => {});
    });
    describe('E', () => {
      describe('F', () => {
        it('H', () => {});
        it('E', () => {});
      });
      it('I', () => {});
    });
    it('J', () => {});
  });

  await should.run();

  section('Nested with should.PRINT_TREE = false;');
  should.PRINT_TREE = false;
  basicData();

  await should.run();
  should.PRINT_MULTILINE = false;
  section('Nested with should.PRINT_TREE = false && should.PRINT_MULTILINE = false');
  basicData();
  await should.run();
  restoreOpts();

  section('Only (tree)');
  onlyData();
  await should.run();

  section('Only (flat)');
  should.PRINT_TREE = false;
  onlyData();
  await should.run();
  restoreOpts();

  section('Skip (tree)');
  skipData();
  await should.run();

  section('Skip (flat)');
  should.PRINT_TREE = false;
  skipData();
  await should.run();
  restoreOpts();

  section('Errors (tree)');
  should.STOP_AT_ERROR = false;
  errorData();
  await should.run();
  restoreOpts();

  section('Errors (flat)');
  should.STOP_AT_ERROR = false;
  should.PRINT_TREE = false;
  errorData();
  await should.run();
  restoreOpts();

  section('parallel'); // Separator so we can see where parallel test starts
})();
