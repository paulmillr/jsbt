import { value } from '../index.ts';

if (value !== 1) throw new Error('bad test import');
if (!process.cwd().endsWith('pass')) throw new Error('test cwd should be package root');
