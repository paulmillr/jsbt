import bench, { utils } from '../src/bench.ts';
(async () => {
  utils.setMaxRunTime(1);
  await bench('printing', () => Promise.resolve(0));
  await bench('base', () => Promise.resolve(1));
  await bench('sqrt', () => Math.sqrt(2));
  await bench('init', () => Math.sqrt(3));
})();
