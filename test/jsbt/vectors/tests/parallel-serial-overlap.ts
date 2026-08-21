import cluster from 'node:cluster';
import { setTimeout } from 'node:timers/promises';
import { it } from '../../../../src/test.ts';

const marker = (lane: string, event: string) =>
  console.log(`lane:${lane}:${event}:${Date.now()}:${cluster.isPrimary}:${process.pid}`);

it('parallel lane', async () => {
  marker('parallel', 'start');
  await setTimeout(500);
  marker('parallel', 'end');
});
it.serial('serial lane', async () => {
  marker('serial', 'start');
  await setTimeout(500);
  marker('serial', 'end');
});

it.runWhen(import.meta.url);
