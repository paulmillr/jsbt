import { should } from '../../../../src/test.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

should('fast 1', () => {});
should('fast 2', () => {});
should('slow 1', async () => {
  await delay(250);
  process.stdout.write('S');
});
should('slow 2', async () => {
  await delay(250);
  process.stdout.write('S');
});

await should.run();
