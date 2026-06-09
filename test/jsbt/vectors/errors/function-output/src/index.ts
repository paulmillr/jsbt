type State = {
  /**
   * Absorb one message chunk.
   * @param message - Message bytes.
   * @returns The same state for chaining.
   */
  update(message: Uint8Array): State;
  /**
   * Finalize into a caller-provided destination.
   * @param dst - Destination buffer.
   */
  digestInto(dst: Uint8Array): void;
};

type Wrapper = {
  /**
   * Hash one message directly.
   * @param message - Message bytes.
   * @returns Digest bytes.
   */
  (message: Uint8Array): Uint8Array;
  /**
   * Create an incremental state.
   * @returns Incremental hashing state.
   */
  state(): State;
};

declare const makeWrapper: () => Wrapper;

/**
 * Demo callable with a function-valued factory property.
 * @param message - Message bytes.
 * @returns Digest bytes.
 * @example
 * Hash one message with the direct callable.
 *
 * ```ts
 * import { wrapper } from '@jsbt-test/errors-function-output';
 * wrapper(new Uint8Array([1, 2, 3]));
 * ```
 */
export const wrapper: Wrapper = makeWrapper();
