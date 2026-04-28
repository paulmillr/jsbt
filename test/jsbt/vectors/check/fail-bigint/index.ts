/** Adds two numbers.
 * Docs: https://example.com/docs/reference/path/that-is-intentionally-long-enough-to-exceed-the-line-limit-for-comment-check
 * @param a - First addend.
 * @param b - Second addend.
 * @returns Sum of both addends.
 * @example
 * Add two numbers.
 * ```ts
 * import { add } from '@jsbt-test/check-bigint';
 * add(20, 22);
 * ```
 */
const _one = 1n;
const _minus = -1n;
const _field = 0x123456789abcdef123456789n;
export const add = (a: number, b: number): number => a + b + Number(_one + _minus + _field - _field);
