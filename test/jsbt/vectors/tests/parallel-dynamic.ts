import { setTimeout } from 'node:timers/promises';
import { it } from '../../../../src/test.ts';

const assignment = (name: string) => console.log(`assignment:${name}:${process.pid}`);

it('slow', async () => {
  await setTimeout(400);
  assignment('slow');
});
for (const name of ['fast-1', 'fast-2', 'fast-3']) {
  it(name, () => assignment(name));
}

it.runWhen(import.meta.url);
