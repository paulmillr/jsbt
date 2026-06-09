/**
 * Removed helper kept only to throw a migration hint.
 * @returns Never; always throws.
 * @example
 * Show the migration note without calling the removed helper.
 *
 * ```ts
 * const replacement = 'use the supported helper instead';
 * ```
 */
export const removed: () => never = () => {
  throw new Error('removed');
};
