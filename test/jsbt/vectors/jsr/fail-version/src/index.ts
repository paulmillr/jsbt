import packed from 'micro-packed';
import { sha256 } from '@noble/hashes/sha2.js';

export const value = [packed, sha256];
