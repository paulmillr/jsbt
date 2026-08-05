/** Adds two numbers.
 * @param a - First addend.
 * @param b - Second addend.
 * @returns Sum of both addends.
 * @example
 * Add two numbers.
 * ```ts
 * import { add } from '@jsbt-test/check-mutate';
 * add(20, 22);
 * ```
 */
export declare const add: (a: number, b: number) => number;
/** Bytes constant. */
export declare const bytes: Uint8Array;
/** Frozen array constant. */
export declare const frozenArray: readonly number[];
/** Frozen object constant. */
export declare const frozenObject: Readonly<{ ok: true }>;
/** Frozen shallow object constant. */
export declare const frozenShallow: Readonly<{
  nestedArray: number[];
  nestedBytes: Uint8Array;
  nestedObject: { ok: true };
}>;
/** Mutable array constant. */
export declare const mutableArray: number[];
/** Mutable object constant. */
export declare const mutableObject: { ok: true };
/** Words constant. */
export declare const words: Uint32Array;
