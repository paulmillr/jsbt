import { describe, it, should } from '../src/test.ts';

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

should.runParallel();
