import { value } from '../index.ts';

if (value !== 1) throw new Error('bad root benchmark import');
if (!process.cwd().endsWith('benchmark')) throw new Error('root benchmark cwd');
