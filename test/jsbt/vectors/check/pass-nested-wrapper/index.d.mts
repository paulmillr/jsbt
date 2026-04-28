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
type FetchOpts = {
  timeout?: number;
};
type MergeOpts<Opts, Out> = [Opts] extends [undefined] ? Out : Opts & Out;
type AsyncFn<T extends any[], R> = ((...args: T) => R) & {
  async: (...args: T) => Promise<R>;
};
type Asyncify<F extends (...args: any[]) => any> = AsyncFn<Parameters<F>, ReturnType<F>>;
type HashInstance<Opts = undefined> = Asyncify<
  (msg: TArg<Uint8Array>, opts?: MergeOpts<Opts, OutputOpts>) => TRet<Uint8Array>
>;
type WebHash<Opts = undefined> = TRet<HashInstance<Opts>> & {
  isSupported: () => Promise<boolean>;
};
/**
 * Wrapped hash helper.
 * @param msg - message bytes.
 * @param opts - optional output options.
 * @returns Hash output bytes.
 */
type HashFn = (msg: TArg<Uint8Array>, opts?: OutputOpts) => TRet<Uint8Array>;
/** Wrapped object surface. */
export interface Surface {
  /** Hash function, documented by the referenced callable type. */
  hash: TRet<HashFn>;
  /**
   * Optional request logger callback.
   * @param url - request URL.
   * @param opts - optional fetch options. See {@link FetchOpts}.
   */
  log?: ((url: string, opts: FetchOpts) => void) | undefined;
}
/** Options with callback fields. */
export type Config = {
  /**
   * Optional request logger callback.
   * @param url - request URL.
   * @param opts - optional fetch options. See {@link FetchOpts}.
   */
  log: ((url: string, opts: FetchOpts) => void) | false;
};
/**
 * Web hash helper.
 * @param msg - message bytes.
 * @param opts - optional output options. See {@link OutputOpts}.
 * @returns Hash output bytes.
 * @example
 * Hash bytes when supported.
 * ```ts
 * import { sha } from '@jsbt-test/pass-nested-wrapper';
 * if (await sha.isSupported()) sha(new Uint8Array([1, 2, 3]));
 * ```
 */
export declare const sha: TRet<WebHash>;
export {};
