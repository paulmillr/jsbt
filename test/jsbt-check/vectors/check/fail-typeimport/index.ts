import type { Pair, Shape } from './types.ts';

export type { Pair, Shape };

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
export const getShape = (): Shape => ({ value: 42 });

/** Wrapped shapes. */
export interface Wrapped {
  /** Single shape. */
  item: Shape;
  /** Paired shapes. */
  pair: Pair;
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
export const getPair = (): Pair => ({ left: { value: 1 }, right: { value: 2 } });
