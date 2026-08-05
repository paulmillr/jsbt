/** Input wrapper helper. */
export type TArg<T> = T;
/** Output wrapper helper. */
export type TRet<T> = T;
/** Signature options. */
export interface SignOptions {
  /** Domain separation context. */
  context?: Uint8Array;
}
/** Verification options. */
export interface VerifyOptions {
  /** Whether ZIP-215 verification is enabled. */
  zip215?: boolean;
}

/** Wrapped callable surface. */
export interface Surface {
  /**
   * Signs a message.
   * @param options - Optional signature options. See {@link TArg}.
   * @returns Signature bytes.
   */
  sign(options: TArg<SignOptions>): Uint8Array;
  /**
   * Verifies a signature.
   * @param options - Optional verification options. See {@link TRet}.
   * @returns Whether signature is valid.
   */
  verify(options: TRet<VerifyOptions>): boolean;
}
