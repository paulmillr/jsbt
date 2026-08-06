// Writes generated fixture packages under test/jsbt-check/build so they
// resolve typescript and config by directory walk-up exactly like the old
// checked-in vector dirs. The `.__` prefix keeps them gitignored; each process
// gets its own root (tests run in parallel worker processes) and removes it on
// exit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BUILD = join(import.meta.dirname, 'build');
const made = new Map<string, string>();
let root = '';

export function unpackVector(kind: string, name: string, files: Record<string, string>): string {
  const key = `${kind}/${name}`;
  const done = made.get(key);
  if (done) return done;
  if (!root) {
    mkdirSync(BUILD, { recursive: true });
    root = mkdtempSync(join(BUILD, '.__vectors-'));
  }
  const dir = join(root, kind, name);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  made.set(key, dir);
  return dir;
}

process.on('exit', () => {
  if (root) rmSync(root, { force: true, recursive: true });
});
