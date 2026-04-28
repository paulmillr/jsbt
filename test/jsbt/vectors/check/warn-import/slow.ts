const block = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(block, 0, 0, 20);

/** Slow public export.
 * @returns Slow value.
 * @example
 * Use the slow export.
 * ```ts
 * import { slow } from '@jsbt-test/check-import/slow.js';
 * slow;
 * ```
 */
export const slow = 42;
