/**
 * Merges generic objects.
 * @param defaults - base object
 * @param opts - user overrides
 * @returns defaults mutated in place.
 * @example
 * ```js
 * import { merge } from '@jsbt-test/errors-generic-object';
 * merge({ dkLen: 32 }, { asyncTick: 10 });
 * ```
 */
export function merge<T1 extends object, T2 extends object>(defaults: T1, opts?: T2): T1 & T2 {
  return Object.assign(defaults, opts);
}
