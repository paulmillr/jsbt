import { should } from '../../../../src/test.ts';

// Registration depends on the process role — exactly the divergence the primary's
// fingerprint check must reject instead of silently running the wrong tests.
const role = typeof process.send === 'function' ? 'worker' : 'primary';
should(`role ${role}`, () => {});
should('stable', () => {});
await should.run().then(
  () => console.log('RESULT: resolved'),
  (error) => console.log(`RESULT: ${(error as Error).message}`)
);
