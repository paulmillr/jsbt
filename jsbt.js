#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path'

function snakeToCamel(snakeCased) {
  return snakeCased.split('-').map((words, index) => {
    return index === 0 ? words : words[0].toUpperCase() + words.slice(1);
  }).join('')
}

// @namespace/ab-cd => namespace-ab-cd and namespaceAbCd
function getNames(packageJsonName) {
  const snakeCased = packageJsonName.replace(/^@/, '').replace(/\//, '-');
  const outfile = snakeCased + '.js';
  const global = snakeToCamel(snakeCased);

  const spl = snakeCased.split('-');
  const parts = spl.length <= 1 ? spl : snakeCased.split('-').slice(1);
  const npOutfile = parts.join('-');
  const noGlobal = snakeToCamel(npOutfile);

  return { outfile, global, 'noprefix-outfile': npOutfile + '.js', 'noprefix-global': noGlobal }
}

function parseCli(argv, names) {
  const selected = argv[2];
  const validKeys = Object.keys(names);
  if (!validKeys.includes(selected)) throw new Error(`usage: jsbt [${validKeys.join(' / ')}]`);
  return names[selected];
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPkgJsons(cwd) {
  const curr = pjoin(cwd, 'package.json')
  const prnt = pjoin(cwd, '..', 'package.json');
  let pkg;
  try {
    pkg = parseJson(curr).name;
    if (pkg === 'build') pkg = parseJson(prnt).name
  } catch (error) {
    throw new Error('package.json read error: ' + error)
  }
  return pkg;
}

console.log(
  parseCli(process.argv, getNames(
    readPkgJsons(process.cwd())
  ))
);
