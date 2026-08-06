/**
 * Doubles a number.
 * @param value - Number to double.
 * @returns Twice the input.
 * @example
 * Double a number.
 * ```js
 * import { double } from '@jsbt-test/check-readme-deps';
 * import { dep } from '@jsbt-test/dep';
 * if (double(21) !== 42 || dep() !== 'dep') throw new Error('bad');
 * ```
 */
export declare const double: (value: number) => number;
