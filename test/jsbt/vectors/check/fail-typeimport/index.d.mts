/**
 * Gets a shape.
 * @returns Exported shape.
 * @example
 * Read a shape value.
 * ```ts
 * import { getShape } from '@jsbt-test/check-typeimport';
 * getShape();
 * ```
 */
export declare const getShape: () => import("./types.ts").Shape;
/** Wrapped shapes. */
export interface Wrapped {
    /** Single shape. */
    item: import("./types.ts").Shape;
    /** Paired shapes. */
    pair: import("./types.ts").Pair;
}
/**
 * Gets a pair.
 * @returns Exported pair.
 * @example
 * Read a pair value.
 * ```ts
 * import { getPair } from '@jsbt-test/check-typeimport';
 * getPair();
 * ```
 */
export declare const getPair: () => import("./types.ts").Pair;
