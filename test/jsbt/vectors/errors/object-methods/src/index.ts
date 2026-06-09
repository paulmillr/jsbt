export type CryptoKeys = {
  /** Public byte lengths for keys and optional seeds. */
  lengths: { public: number; secret: number; seed?: number; signature?: number };
  /**
   * Generate one secret/public keypair.
   * @param seed - Optional seed bytes for deterministic key generation.
   * @returns Fresh secret/public keypair.
   */
  keygen: (seed?: Uint8Array) => { secretKey: Uint8Array; publicKey: Uint8Array };
  /**
   * Derive one public key from a secret key.
   * @param secretKey - Secret key bytes.
   * @returns Public key bytes.
   */
  getPublicKey: (secretKey: Uint8Array) => Uint8Array;
};

export type Signer = CryptoKeys & {
  /**
   * Sign one message.
   * @param msg - Message bytes to sign.
   * @param secretKey - Secret key bytes.
   * @returns Signature bytes.
   */
  sign: (msg: Uint8Array, secretKey: Uint8Array) => Uint8Array;
  /**
   * Verify one signature.
   * @param sig - Signature bytes.
   * @param msg - Signed message bytes.
   * @param publicKey - Public key bytes.
   * @returns `true` when the signature is valid.
   */
  verify: (sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array) => boolean;
  /** Validation helpers for this signer. */
  utils: {
    /**
     * Check whether a secret key has the expected encoding.
     * @param secretKey - Secret key bytes.
     * @returns `true` when the key has the expected encoding.
     */
    isValidSecretKey: (secretKey: Uint8Array) => boolean;
  };
};

export type Registry = {
  /** Signer using long signatures. */
  long: Signer;
  /** Signer using short signatures. */
  short: Signer;
};

export type HashedMessage = { readonly bytes: Uint8Array };
export type HashedKey = { readonly bytes: Uint8Array };
export type HashedSignature = { readonly bytes: Uint8Array };

export type HashedSigner = {
  /**
   * Hash message bytes into the signer message domain.
   * @param messageBytes - Raw message bytes.
   * @returns Hashed message object.
   */
  hash: (messageBytes: Uint8Array) => HashedMessage;
  /**
   * Generate a keypair.
   * @param seed - Optional seed bytes for deterministic setup.
   * @returns Fresh secret/public keypair.
   */
  keygen: (seed?: Uint8Array) => { secretKey: Uint8Array; publicKey: HashedKey };
  /**
   * Sign one already-hashed message.
   * @param message - Hashed message object.
   * @param secretKey - Secret key bytes.
   * @returns Signature object.
   */
  sign: (message: HashedMessage, secretKey: Uint8Array) => HashedSignature;
  /**
   * Verify one signature against a hashed message and public key.
   * @param signature - Signature object.
   * @param message - Hashed message object.
   * @param publicKey - Public key object.
   * @returns `true` when the signature is valid.
   */
  verify: (signature: HashedSignature, message: HashedMessage, publicKey: HashedKey) => boolean;
};

export type HashedRegistry = {
  /** Signer using long signatures. */
  long: HashedSigner;
  /** Signer using short signatures. */
  short: HashedSigner;
};

export type OneShot = {
  /**
   * Encrypt one byte payload without a caller output buffer.
   * @param plaintext - Plaintext bytes to encrypt.
   * @returns Ciphertext bytes.
   */
  encrypt: (plaintext: Uint8Array) => Uint8Array;
};

export type WebBox = {
  /**
   * Encrypt with a WebCrypto-like argument list.
   * @param key - CryptoKey-compatible key material.
   * @param keyParams - Key import parameters.
   * @param cryptParams - Encryption parameters.
   * @param plaintext - Plaintext bytes to encrypt.
   * @returns Ciphertext bytes.
   */
  encrypt: (
    key: Uint8Array,
    keyParams: { name: string },
    cryptParams: { iv: Uint8Array },
    plaintext: Uint8Array
  ) => Uint8Array;
};

export type Box = {
  /**
   * Encrypt one byte payload.
   * @param plaintext - Plaintext bytes to encrypt.
   * @param output - Optional output buffer.
   * @returns Ciphertext bytes.
   */
  encrypt: (plaintext: Uint8Array, output?: Uint8Array) => Uint8Array;
  /**
   * Decrypt one byte payload.
   * @param ciphertext - Ciphertext bytes to decrypt.
   * @param output - Optional output buffer.
   * @returns Plaintext bytes.
   */
  decrypt: (ciphertext: Uint8Array, output?: Uint8Array) => Uint8Array;
};

export type Chain = {
  /**
   * Add message bytes to the current chain state.
   * @param message - Message bytes to absorb.
   * @returns The same chain instance.
   */
  update: (message: Uint8Array) => Chain;
  /**
   * Finalize the chain state into an output buffer.
   * @param output - Output buffer.
   * @returns The output buffer.
   */
  digestInto: (output: Uint8Array) => Uint8Array;
};

declare const makeSuite: () => Signer;

/**
 * Demo signer namespace.
 * @example
 * Generate a keypair, sign one message, verify it, and validate the secret key.
 *
 * ```ts
 * import { suite } from '@jsbt-test/errors-object-methods';
 * const { secretKey, publicKey } = suite.keygen();
 * const msg = new Uint8Array([1, 2, 3]);
 * const sig = suite.sign(msg, secretKey);
 * suite.verify(sig, msg, publicKey);
 * suite.getPublicKey(secretKey);
 * suite.utils.isValidSecretKey(secretKey);
 * ```
 */
export const suite: Signer = makeSuite();

/**
 * Create a signer namespace from a seed.
 * @param seed - Optional seed bytes for deterministic setup.
 * @returns Signer namespace with key, signing, and verification helpers.
 * @example
 * Create a signer, sign one message, and verify the signature.
 *
 * ```ts
 * import { makeReturnedSuite } from '@jsbt-test/errors-object-methods';
 * const seed = new Uint8Array(32);
 * const signer = makeReturnedSuite(seed);
 * const { secretKey, publicKey } = signer.keygen();
 * const msg = new Uint8Array([1, 2, 3]);
 * const sig = signer.sign(msg, secretKey);
 * signer.verify(sig, msg, publicKey);
 * ```
 */
export function makeReturnedSuite(seed?: Uint8Array): Signer {
  throw new Error('runtime fixture is provided by index.js');
}

/**
 * Create a registry with two compatible signer suites.
 * @returns Registry containing long and short signature suites.
 * @example
 * Build one registry, then sign and verify with the long-signature suite.
 *
 * ```ts
 * import { makeRegistry } from '@jsbt-test/errors-object-methods';
 * const registry = makeRegistry();
 * const { secretKey, publicKey } = registry.long.keygen();
 * const msg = new Uint8Array([1, 2, 3]);
 * const sig = registry.long.sign(msg, secretKey);
 * registry.long.verify(sig, msg, publicKey);
 * ```
 */
export function makeRegistry(): Registry {
  throw new Error('runtime fixture is provided by index.js');
}

/**
 * Create a registry with hashed-message signer suites.
 * @returns Registry containing long and short hashed-message suites.
 * @example
 * Build one registry, hash a raw message, then sign and verify with the long-signature suite.
 *
 * ```ts
 * import { makeHashedRegistry } from '@jsbt-test/errors-object-methods';
 * const registry = makeHashedRegistry();
 * const { secretKey, publicKey } = registry.long.keygen();
 * const message = registry.long.hash(new Uint8Array([1, 2, 3]));
 * const signature = registry.long.sign(message, secretKey);
 * registry.long.verify(signature, message, publicKey);
 * ```
 */
export function makeHashedRegistry(): HashedRegistry {
  throw new Error('runtime fixture is provided by index.js');
}

/**
 * Create a byte-box helper.
 * @param key - Encryption key bytes.
 * @returns Helper with encrypt/decrypt methods.
 * @example
 * Create a box and encrypt one payload into an explicit output buffer.
 *
 * ```ts
 * import { makeBox } from '@jsbt-test/errors-object-methods';
 * const key = new Uint8Array(32);
 * const plaintext = new Uint8Array([1, 2, 3]);
 * const box = makeBox(key);
 * box.encrypt(plaintext);
 * ```
 */
export function makeBox(key: Uint8Array): Box {
  throw new Error('runtime fixture is provided by index.js');
}

/**
 * Create a chainable byte helper.
 * @param key - Chain key bytes.
 * @returns Chain state with update and digest methods.
 * @example
 * Create a chain, absorb one message, and finalize into an explicit output buffer.
 *
 * ```ts
 * import { makeChain } from '@jsbt-test/errors-object-methods';
 * const key = new Uint8Array(32);
 * const message = new Uint8Array([1, 2, 3]);
 * const output = new Uint8Array(3);
 * makeChain(key).update(message).digestInto(output);
 * ```
 */
export function makeChain(key: Uint8Array): Chain {
  throw new Error('runtime fixture is provided by index.js');
}
