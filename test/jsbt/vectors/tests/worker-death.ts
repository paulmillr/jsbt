import { should } from '../../../../src/test.ts';

// One worker dies mid-run — by clean exit or SIGKILL depending on the env switch.
// The primary must abort loudly instead of dropping the task and never settling.
const mode = process.env.WORKER_DEATH_MODE;
should('a', () => {});
should('die', () => {
  if (mode === 'signal') process.kill(process.pid, 'SIGKILL');
  else process.exit(0);
});
should('b', () => {});
should('c', () => {});
await should.run().then(
  () => console.log('RESULT: resolved'),
  (error) => console.log(`RESULT: ${(error as Error).message}`)
);
