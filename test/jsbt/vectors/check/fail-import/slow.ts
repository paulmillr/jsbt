const block = new Int32Array(new SharedArrayBuffer(4));
// Stay above the 20x error cutoff even when generic check runs workers in parallel.
Atomics.wait(block, 0, 0, 120);

/** Slow public export.
 * @returns Slow value.
 * @example
 * Use the slow export.
 * ```ts
 * import { slow } from '@jsbt-test/check-import-fail/slow.js';
 * slow;
 * ```
 */
export const slow = 42;
