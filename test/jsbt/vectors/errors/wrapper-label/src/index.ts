type Opts = {
  dkLen?: number;
  onProgress?: (progress: number) => void;
  personalization?: Uint8Array;
};
type State = {
  digest(): Uint8Array;
  update(msg: Uint8Array): State;
};
type CHash = {
  (msg: Uint8Array, opts?: Opts): Uint8Array;
  create(opts?: Opts): State;
};
declare const createHash: () => CHash;

/**
 * Hashes one message.
 * @param msg - message bytes.
 * @param opts - output options.
 * @returns digest bytes.
 * @example
 * ```js
 * import { hash } from '@jsbt-test/errors-wrapper-label';
 * const msg = new Uint8Array([1, 2, 3]);
 * hash(msg, {
 *   dkLen: 8,
 *   personalization: new Uint8Array([4]),
 *   onProgress(percentage) {
 *     percentage;
 *   },
 * });
 * ```
 */
export const hash: CHash = createHash();

export type Mac = (
  key: Uint8Array,
  message: Uint8Array,
  personalization: Uint8Array,
  dkLen?: number
) => Uint8Array;

const makeMac =
  (hash: CHash): Mac =>
  (key: Uint8Array, message: Uint8Array, personalization: Uint8Array, dkLen?: number) =>
    hash(key, { dkLen, personalization: hash(message, { personalization }) });

/**
 * Authenticates one message via the hash wrapper.
 * @param key - key bytes.
 * @param message - message bytes.
 * @param personalization - personalization bytes.
 * @param dkLen - output length.
 * @returns tag bytes.
 * @example
 * ```js
 * import { mac } from '@jsbt-test/errors-wrapper-label';
 * mac(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), 8);
 * ```
 */
export const mac: Mac = makeMac(hash);
