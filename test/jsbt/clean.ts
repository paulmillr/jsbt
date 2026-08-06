import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');

const remove = (path: string) => rmSync(path, { force: true, recursive: true });

remove(join(ROOT, 'test/jsbt/build/.__jsbt-bin-test.mjs'));
remove(join(ROOT, 'test/jsbt/build/bytes-polarity'));
remove(join(ROOT, 'test/jsbt/build/patterns'));
remove(join(ROOT, 'test/jsbt/vectors/npm-check/node_modules'));
remove(join(ROOT, 'test/jsbt/vectors/npm-check/package-lock.json'));
