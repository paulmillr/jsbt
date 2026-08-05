import { value } from '../../index.ts';

if (value !== 1) throw new Error('bad test benchmark import');
if (!process.cwd().endsWith('test/benchmark')) throw new Error('test benchmark cwd');
