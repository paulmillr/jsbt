import { should } from '../../../../src/test.ts';

// Paths are identical in both processes, but worker metadata differs. The replay
// manifest must reject this instead of silently counting the skipped test as passed.
const worker = typeof process.send === 'function';
if (worker) should.skip('stable path', () => {});
else should('stable path', () => {});
await should.run().then(
  () => console.log('RESULT: resolved'),
  (error) => console.log(`RESULT: ${(error as Error).message}`)
);
