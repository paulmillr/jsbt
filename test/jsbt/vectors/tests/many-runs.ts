import { should } from '../../../../src/test.ts';

// 12 repeated parallel runs: enough to trip MaxListenersExceededWarning (threshold
// 11) if any per-run listener accumulates on a persistent emitter.
for (let i = 0; i < 12; i++) {
  should(`t${i}`, () => {});
  should(`u${i}`, () => {});
  await should.run();
}
console.log('ALL DONE');
