const block = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(block, 0, 0, 2);

/** Fast root export.
 * @returns Fast value.
 * @example
 * Use the root export.
 * ```ts
 * import { fast } from '@jsbt-test/check-import';
 * console.log(fast);
 * ```
 */
export const fast = 1;
