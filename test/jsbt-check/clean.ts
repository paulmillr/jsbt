import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve('.');
const VECTORS = join(ROOT, 'test/jsbt-check/vectors');

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
const BUILD = join(ROOT, 'test/jsbt-check/build');
for (const ent of existsSync(BUILD) ? readdirSync(BUILD) : [])
  if (ent.startsWith('.__')) remove(join(BUILD, ent));
remove(join(ROOT, 'test/jsbt-check/build/bytes-polarity'));
remove(join(ROOT, 'test/jsbt-check/build/check-install'));
remove(join(ROOT, 'test/jsbt-check/build/patterns'));
remove(join(ROOT, 'test/jsbt-check/vectors/npm-check/node_modules'));
remove(join(ROOT, 'test/jsbt-check/vectors/npm-check/package-lock.json'));
