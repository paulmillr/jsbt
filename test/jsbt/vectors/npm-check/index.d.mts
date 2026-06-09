/** Adds two numbers.
 * @param a - First addend.
 * @param b - Second addend.
 * @returns Sum of both addends.
 * @example
 * Add two numbers.
 * ```ts
 * import { sum } from '@jsbt-test/npm-check';
 * sum(20, 22);
 * ```
 */
export declare function sum(a: number, b: number): number;

export declare function undocumented(value: number): number;

/** Copies byte input.
 * @param data - Input bytes.
 * @returns The same bytes.
 * @example
 * Copy bytes.
 * ```ts
 * import { bytes } from '@jsbt-test/npm-check';
 * bytes(Uint8Array.of(1, 2, 3));
 * ```
 */
export declare function bytes(data: Uint8Array): Uint8Array;

/** Example that cannot infer a valid public call.
 * @param data - Input bytes.
 * @returns The same bytes.
 * @example
 * Prepare bytes but do not call the documented function.
 * ```ts
 * const data = Uint8Array.of(1, 2, 3);
 * console.log(data.length);
 * ```
 */
export declare function unprobeable(data: Uint8Array): Uint8Array;

/** Mutable object that the mutate checker should reject. */
export declare const mutable: { count: number };

/** Raw bigint exported for bigint checker coverage. */
export declare const raw: bigint;

export type LocalShape = import('./types.ts').Shape;
