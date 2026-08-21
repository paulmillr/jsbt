import { should } from '../../../../src/test.ts';

// Deterministic registration, but workers stall before reaching run():
// the primary's init watchdog must abort the run instead of waiting forever.
should('a', () => {});
should('b', () => {});
if (typeof process.send === 'function') await new Promise(() => {});
await should.run().then(
  () => console.log('RESULT: resolved'),
  (error) => console.log(`RESULT: ${(error as Error).message}`)
);
