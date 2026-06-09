import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve('.');
const VECTORS = join(ROOT, 'test/jsbt/vectors');

const remove = (path: string) => rmSync(path, { force: true, recursive: true });
const cleanBuild = (dir: string) => {
  remove(join(dir, 'node_modules'));
  remove(join(dir, 'out-treeshake'));
  remove(join(dir, 'package-lock.json'));
  for (const ent of existsSync(dir) ? readdirSync(dir) : [])
    if (ent.startsWith('.__')) remove(join(dir, ent));
};
const walk = (dir: string) => {
  if (!existsSync(dir)) return;
  if (basename(dir) === 'build' && basename(dirname(dir)) === 'test') {
    cleanBuild(dir);
    return;
  }
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === 'node_modules') continue;
    walk(join(dir, ent.name));
  }
};

walk(VECTORS);
remove(join(ROOT, 'test/jsbt/build/.__jsbt-bin-test.mjs'));
remove(join(ROOT, 'test/jsbt/build/bytes-polarity'));
remove(join(ROOT, 'test/jsbt/build/check-install'));
remove(join(ROOT, 'test/jsbt/build/patterns'));
remove(join(ROOT, 'test/jsbt/vectors/npm-check/node_modules'));
remove(join(ROOT, 'test/jsbt/vectors/npm-check/package-lock.json'));
