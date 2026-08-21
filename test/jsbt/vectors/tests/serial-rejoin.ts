import { should } from '../../../../src/test.ts';

// A quick serial lane plus a long parallel queue: with 2 workers, the worker that
// ran the serial lane must rejoin the pool and claim parallel tasks afterwards.
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (name: string) => process.stdout.write(`\nmark:${name}:${process.pid}\n`);
should.serial('serial quick', () => mark('serial'));
for (let i = 0; i < 6; i++) {
  should(`p${i}`, async () => {
    mark(`p${i}`);
    await delay(150);
  });
}
await should.run();
