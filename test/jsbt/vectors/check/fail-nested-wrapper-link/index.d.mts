type TArg<T> = T;
type TRet<T> = T &
  (T extends (...args: infer A) => infer R
    ? ((...args: { [K in keyof A]: TArg<A[K]> }) => TRet<R>) & {
        [K in keyof T]: T[K];
      }
    : T);
type OutputOpts = {
  dkLen?: number;
};
type AsyncFn<T extends any[], R> = ((...args: T) => R) & {
  async: (...args: T) => Promise<R>;
};
type Asyncify<F extends (...args: any[]) => any> = AsyncFn<Parameters<F>, ReturnType<F>>;
type HashInstance = Asyncify<(msg: TArg<Uint8Array>, opts?: OutputOpts) => TRet<Uint8Array>>;
type WebHash = TRet<HashInstance> & {
  isSupported: () => Promise<boolean>;
};
/**
 * Web hash helper.
 * @param msg - message bytes.
 * @param opts - optional output options. See {@link TRet}.
 * @returns Hash output bytes.
 * @example
 * Hash bytes when supported.
 * ```ts
 * import { sha } from '@jsbt-test/fail-nested-wrapper-link';
 * if (await sha.isSupported()) sha(new Uint8Array([1, 2, 3]));
 * ```
 */
export declare const sha: TRet<WebHash>;
export {};
