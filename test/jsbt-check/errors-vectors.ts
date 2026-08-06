// Fixture packages for the errors-audit tests, unpacked on demand via
// unpack.ts. Each entry is one fake package; package.json is derived from the
// entry name (`@jsbt-test/errors-<name>`, ESM, "." -> ./index.js unless listed
// in EXPORTS). File bodies stay verbatim, so TSDoc examples import by that name.
import { unpackVector } from './unpack.ts';

const EXPORTS: Record<string, Record<string, string>> = {
  'pass': {'.': './index.js', './source.js': './source.js'},
  'private-skip': {'.': './index.js', './_private.js': './_private.js'},
};

const VECTORS: Record<string, Record<string, string>> = {
  'accepted-probes': {
    'index.js': `export const one = (msg) => new Uint8Array();
export const two = (msg) => new Uint8Array();
`,
    'src/index.ts': `/**
 * Accepts one byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { one } from '@jsbt-test/errors-accepted-probes';
 * one(new Uint8Array([1]));
 * \`\`\`
 */
export function one(msg: Uint8Array): Uint8Array {
  return msg;
}

/**
 * Accepts another byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { two } from '@jsbt-test/errors-accepted-probes';
 * two(new Uint8Array([2]));
 * \`\`\`
 */
export function two(msg: Uint8Array): Uint8Array {
  return msg;
}
`,
  },
  'default-import': {
    'index.js': `export default function verify(value) {
  if (typeof value !== 'string') throw new Error(\`expected value, got \${typeof value}\`);
  return value;
}
`,
    'src/index.ts': `/**
 * Checks a value.
 * @param value - value to check.
 * @returns checked value.
 * @example
 * \`\`\`js
 * import verify from '@jsbt-test/errors-default-import';
 * verify('ok');
 * \`\`\`
 */
export function verify(value: string): string {
  return value;
}
`,
  },
  'fail': {
    'index.js': `export function isValidSecretKey(secretKey) {
  return secretKey instanceof Uint8Array;
}
export function badReturnedCoder(seed) {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg) {
      return msg;
    },
  };
}
export function vague(secretKey) {
  if (!(secretKey instanceof Uint8Array)) throw new TypeError('bad');
  return Uint8Array.from(secretKey);
}
export function mutates(secretKey) {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  secretKey[0] ^= 1;
  return Uint8Array.from(secretKey);
}
export function aliases(secretKey) {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  return secretKey;
}
`,
    'src/index.ts': `/**
 * Checks secret-key byte shape.
 * @param secretKey - Secret key bytes.
 * @returns Whether the bytes are a valid secret key.
 * @example
 * Check a valid secret key.
 *
 * \`\`\`ts
 * isValidSecretKey(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function isValidSecretKey(secretKey: Uint8Array): boolean {
  return secretKey instanceof Uint8Array;
}
/**
 * Creates a returned object that forgets to validate its method input.
 * @param seed - Seed bytes.
 * @returns Byte coder object.
 * @example
 * Create a bad returned coder.
 *
 * \`\`\`ts
 * badReturnedCoder(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function badReturnedCoder(seed: Uint8Array): { encode(msg: Uint8Array): Uint8Array } {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg: Uint8Array): Uint8Array {
      return msg;
    },
  };
}
/**
 * Copies secret-key bytes with a vague error message.
 * @param secretKey - Secret key bytes.
 * @returns Detached byte copy.
 * @example
 * Copy a valid secret key.
 *
 * \`\`\`ts
 * vague(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function vague(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array)) throw new TypeError('bad');
  return Uint8Array.from(secretKey);
}
/**
 * Accidentally mutates secret-key bytes.
 * @param secretKey - Secret key bytes.
 * @returns Detached byte copy.
 * @example
 * Mutate bug probe.
 *
 * \`\`\`ts
 * import { mutates } from '@jsbt-test/errors-fail';
 * const secretKey = Uint8Array.of(1, 2, 3);
 * mutates(secretKey);
 * \`\`\`
 */
export function mutates(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  secretKey[0] ^= 1;
  return Uint8Array.from(secretKey);
}
/**
 * Accidentally returns the caller buffer.
 * @param secretKey - Secret key bytes.
 * @returns Secret key bytes.
 * @example
 * Returned-buffer bug probe.
 *
 * \`\`\`ts
 * import { aliases } from '@jsbt-test/errors-fail';
 * const secretKey = Uint8Array.of(1, 2, 3);
 * aliases(secretKey);
 * \`\`\`
 */
export function aliases(secretKey: Uint8Array): Uint8Array {
  if (!(secretKey instanceof Uint8Array))
    throw new TypeError('"secretKey" expected Uint8Array, got type=' + typeof secretKey);
  return secretKey;
}
`,
  },
  'function-output': {
    'index.js': `const bytes = (name, value) => {
  if (!(value instanceof Uint8Array)) throw new Error(\`\${name} expected Uint8Array\`);
  return value;
};

class BaseState {
  update(message) {
    bytes('message', message);
    return this;
  }
  digestInto(dst) {
    bytes('dst', dst);
  }
  alpha(value) {
    return value;
  }
  beta(value) {
    return value;
  }
  gamma(value) {
    return value;
  }
  delta(value) {
    return value;
  }
  epsilon(value) {
    return value;
  }
  zeta(value) {
    return value;
  }
  eta(value) {
    return value;
  }
  theta(value) {
    return value;
  }
  iota(value) {
    return value;
  }
}

class State extends BaseState {}

export const wrapper = (message) => {
  bytes('message', message);
  return new Uint8Array([1]);
};
wrapper.state = () => new State();
`,
    'src/index.ts': `type State = {
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
 * \`\`\`ts
 * import { wrapper } from '@jsbt-test/errors-function-output';
 * wrapper(new Uint8Array([1, 2, 3]));
 * \`\`\`
 */
export const wrapper: Wrapper = makeWrapper();
`,
  },
  'generic-object': {
    'index.js': `export function merge(defaults, opts) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new TypeError('defaults expected object');
  }
  if (opts !== undefined && (!opts || typeof opts !== 'object' || Array.isArray(opts))) {
    throw new TypeError('opts expected object or undefined');
  }
  return Object.assign(defaults, opts);
}
`,
    'src/index.ts': `/**
 * Merges generic objects.
 * @param defaults - base object
 * @param opts - user overrides
 * @returns defaults mutated in place.
 * @example
 * \`\`\`js
 * import { merge } from '@jsbt-test/errors-generic-object';
 * merge({ dkLen: 32 }, { asyncTick: 10 });
 * \`\`\`
 */
export function merge<T1 extends object, T2 extends object>(defaults: T1, opts?: T2): T1 & T2 {
  return Object.assign(defaults, opts);
}
`,
  },
  'group-format': {
    'index.js': `const check = (value) => {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(\`expected Uint8Array, got type=\${typeof value}\`);
  }
  return new Uint8Array(value);
};

export const one = check;
export const two = check;
`,
    'src/index.ts': `/**
 * Checks one byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { one } from '@jsbt-test/errors-group-format';
 * one(new Uint8Array([1]));
 * \`\`\`
 */
export function one(msg: Uint8Array): Uint8Array {
  return msg;
}

/**
 * Checks another byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { two } from '@jsbt-test/errors-group-format';
 * two(new Uint8Array([2]));
 * \`\`\`
 */
export function two(msg: Uint8Array): Uint8Array {
  return msg;
}
`,
  },
  'label-param': {
    'index.js': `export function normalize(data, errorTitle = '') {
  if (!(data instanceof Uint8Array)) {
    const prefix = errorTitle && \`"\${errorTitle}" \`;
    throw new TypeError(\`\${prefix}expected Uint8Array, got type=\${typeof data}\`);
  }
  return new Uint8Array(data);
}
`,
    'src/index.ts': `/**
 * Normalizes bytes.
 * @param data - user bytes.
 * @param errorTitle - label included in thrown errors.
 * @returns copied bytes.
 * @example
 * \`\`\`js
 * import { normalize } from '@jsbt-test/errors-label-param';
 * normalize(new Uint8Array([1]));
 * \`\`\`
 */
export function normalize(data: Uint8Array, errorTitle = ''): Uint8Array {
  return data;
}
`,
  },
  'mixed-no-calls': {
    'index.js': `export function randomBytes(bytesLength) {
  if (typeof bytesLength !== 'number')
    throw new Error(\`"bytesLength" expected number, got \${typeof bytesLength}\`);
  return new Uint8Array(bytesLength);
}

const check = (value) => {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(\`expected Uint8Array, got type=\${typeof value}\`);
  }
  return new Uint8Array(value);
};

export const one = check;
export const two = check;
`,
    'src/index.ts': `/**
 * Returns random bytes.
 * @param bytesLength - byte count.
 * @returns random bytes.
 * @example
 * \`\`\`js
 * import { randomBytes } from '@jsbt-test/errors-mixed-no-calls';
 * randomBytes(16);
 * \`\`\`
 */
export function randomBytes(bytesLength: number): Uint8Array {
  return new Uint8Array(bytesLength);
}

/**
 * Uses random bytes in docs but has no probeable public call.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { one, randomBytes } from '@jsbt-test/errors-mixed-no-calls';
 * const msg = randomBytes(32);
 * const ref = one;
 * \`\`\`
 */
export function one(msg: Uint8Array): Uint8Array {
  return msg;
}

/**
 * Checks a byte array.
 * @param msg - message bytes.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { two } from '@jsbt-test/errors-mixed-no-calls';
 * two(new Uint8Array([2]));
 * \`\`\`
 */
export function two(msg: Uint8Array): Uint8Array {
  return msg;
}
`,
  },
  'no-calls': {
    'index.js': `export function check(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('value expected Uint8Array');
  return new Uint8Array(value);
}
`,
    'src/index.ts': `/**
 * Checks a value.
 * @param value - value to validate.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { check } from '@jsbt-test/errors-no-calls';
 * const value = new Uint8Array([1]);
 * \`\`\`
 */
export function check(value: Uint8Array): Uint8Array {
  return value;
}
`,
  },
  'object-methods': {
    'index.js': `const bytes = (name, value) => {
  if (!(value instanceof Uint8Array))
    throw new Error(\`"\${name}" expected Uint8Array, got type=\${typeof value}\`);
  return value;
};

export const suite = {
  lengths: { public: 32, secret: 32, seed: 32, signature: 64 },
  keygen(seed) {
    if (seed !== undefined) bytes('seed', seed);
    return { secretKey: new Uint8Array(32), publicKey: new Uint8Array(32) };
  },
  getPublicKey(secretKey) {
    bytes('secretKey', secretKey);
    return new Uint8Array(32);
  },
  sign(msg, secretKey) {
    bytes('msg', msg);
    bytes('secretKey', secretKey);
    return new Uint8Array(64);
  },
  verify(sig, msg, publicKey) {
    bytes('sig', sig);
    bytes('msg', msg);
    bytes('publicKey', publicKey);
    return true;
  },
  utils: {
    isValidSecretKey(secretKey) {
      bytes('secretKey', secretKey);
      return true;
    },
  },
};

export function makeReturnedSuite(seed) {
  if (seed !== undefined) bytes('seed', seed);
  return suite;
}

export function makeRegistry() {
  return { long: suite, short: { ...suite, utils: { ...suite.utils } } };
}

const hashed = {
  hash(messageBytes) {
    bytes('messageBytes', messageBytes);
    return { bytes: new Uint8Array(messageBytes) };
  },
  keygen(seed) {
    if (seed !== undefined) bytes('seed', seed);
    return { secretKey: new Uint8Array(32), publicKey: new PublicKey(new Uint8Array(32)) };
  },
  sign(message, secretKey, unusedArg) {
    if (unusedArg !== undefined) throw new Error('sign expects 2 arguments');
    if (!message || !(message.bytes instanceof Uint8Array))
      throw new Error('"message" expected hash');
    bytes('secretKey', secretKey);
    return { bytes: new Uint8Array(64) };
  },
  verify(signature, message, publicKey, unusedArg) {
    if (unusedArg !== undefined) throw new Error('verify expects 3 arguments');
    if (!signature || !(signature.bytes instanceof Uint8Array))
      throw new Error('"signature" expected signature');
    if (!message || !(message.bytes instanceof Uint8Array))
      throw new Error('"message" expected hash');
    if (!(publicKey instanceof PublicKey)) throw new Error('"publicKey" expected public key');
    return true;
  },
};

class PublicKey {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

export function makeHashedRegistry() {
  return { long: hashed, short: { ...hashed } };
}

export function makeBox(key) {
  bytes('key', key);
  let used = false;
  return {
    encrypt(plaintext, output) {
      if (used) throw new Error('cannot encrypt twice');
      used = true;
      bytes('plaintext', plaintext);
      if (output !== undefined) bytes('output', output);
      return output || new Uint8Array(plaintext.length);
    },
    decrypt(ciphertext, output) {
      bytes('ciphertext', ciphertext);
      if (output !== undefined) bytes('output', output);
      return output || new Uint8Array(ciphertext.length);
    },
  };
}

export function makeChain(key) {
  bytes('key', key);
  let destroyed = false;
  return {
    update(message) {
      if (destroyed) throw new Error('chain has been destroyed');
      bytes('message', message);
      return this;
    },
    digestInto(output) {
      if (destroyed) throw new Error('chain has been destroyed');
      destroyed = true;
      bytes('output', output);
      return output;
    },
  };
}
`,
    'src/index.ts': `export type CryptoKeys = {
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
   * @returns \`true\` when the signature is valid.
   */
  verify: (sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array) => boolean;
  /** Validation helpers for this signer. */
  utils: {
    /**
     * Check whether a secret key has the expected encoding.
     * @param secretKey - Secret key bytes.
     * @returns \`true\` when the key has the expected encoding.
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
   * @returns \`true\` when the signature is valid.
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
 * \`\`\`ts
 * import { suite } from '@jsbt-test/errors-object-methods';
 * const { secretKey, publicKey } = suite.keygen();
 * const msg = new Uint8Array([1, 2, 3]);
 * const sig = suite.sign(msg, secretKey);
 * suite.verify(sig, msg, publicKey);
 * suite.getPublicKey(secretKey);
 * suite.utils.isValidSecretKey(secretKey);
 * \`\`\`
 */
export const suite: Signer = makeSuite();

/**
 * Create a signer namespace from a seed.
 * @param seed - Optional seed bytes for deterministic setup.
 * @returns Signer namespace with key, signing, and verification helpers.
 * @example
 * Create a signer, sign one message, and verify the signature.
 *
 * \`\`\`ts
 * import { makeReturnedSuite } from '@jsbt-test/errors-object-methods';
 * const seed = new Uint8Array(32);
 * const signer = makeReturnedSuite(seed);
 * const { secretKey, publicKey } = signer.keygen();
 * const msg = new Uint8Array([1, 2, 3]);
 * const sig = signer.sign(msg, secretKey);
 * signer.verify(sig, msg, publicKey);
 * \`\`\`
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
 * \`\`\`ts
 * import { makeRegistry } from '@jsbt-test/errors-object-methods';
 * const registry = makeRegistry();
 * const { secretKey, publicKey } = registry.long.keygen();
 * const msg = new Uint8Array([1, 2, 3]);
 * const sig = registry.long.sign(msg, secretKey);
 * registry.long.verify(sig, msg, publicKey);
 * \`\`\`
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
 * \`\`\`ts
 * import { makeHashedRegistry } from '@jsbt-test/errors-object-methods';
 * const registry = makeHashedRegistry();
 * const { secretKey, publicKey } = registry.long.keygen();
 * const message = registry.long.hash(new Uint8Array([1, 2, 3]));
 * const signature = registry.long.sign(message, secretKey);
 * registry.long.verify(signature, message, publicKey);
 * \`\`\`
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
 * \`\`\`ts
 * import { makeBox } from '@jsbt-test/errors-object-methods';
 * const key = new Uint8Array(32);
 * const plaintext = new Uint8Array([1, 2, 3]);
 * const box = makeBox(key);
 * box.encrypt(plaintext);
 * \`\`\`
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
 * \`\`\`ts
 * import { makeChain } from '@jsbt-test/errors-object-methods';
 * const key = new Uint8Array(32);
 * const message = new Uint8Array([1, 2, 3]);
 * const output = new Uint8Array(3);
 * makeChain(key).update(message).digestInto(output);
 * \`\`\`
 */
export function makeChain(key: Uint8Array): Chain {
  throw new Error('runtime fixture is provided by index.js');
}
`,
  },
  'pass': {
    'index.js': `export const moduleOverview = 1;
export function cloneBytes(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
export function acceptCarrier(carrier) {
  if (!carrier || typeof carrier !== 'object')
    throw new TypeError('"carrier" expected object, got type=' + typeof carrier);
  return true;
}
export function returnedCoder(seed) {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg) {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from([...seed, ...msg]);
    },
  };
}
class ReturnedPoint {
  constructor(msg) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
export function returnedClassHolder(seed) {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return { Point: ReturnedPoint };
}
export function combineScoped(msg, sig) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  if (!(sig instanceof Uint8Array))
    throw new TypeError('"sig" expected Uint8Array, got type=' + typeof sig);
  return Uint8Array.from([...msg, ...sig]);
}
export function nestedPublicCall(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
export function commentedOwner(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
export class CheckedBox {
  constructor(msg) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
export function makeCoder() {
  return {
    encode(msg) {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from(msg);
    },
  };
}
export function makeDirectCoder() {
  return makeCoder();
}
export function optionalSeed(seed) {
  if (seed === undefined) return Uint8Array.of(1);
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return Uint8Array.from(seed);
}
const aliasBytesDoc = cloneBytes;
export { aliasBytesDoc as aliasBytes };
export const constantTable = /* @__PURE__ */ (() => ({
  value: 1,
  helper: (msg) => msg,
}))();
`,
    'src/index.ts': `/**
 * Module overview/import examples are not runtime validation probes.
 * @module
 * @example
 * Import examples should be ignored by check:errors.
 *
 * \`\`\`ts
 * import { cloneBytes } from '@jsbt-test/errors-pass';
 * \`\`\`
 */
export const moduleOverview = 1;
/**
 * Copies message bytes.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Clone one byte message.
 *
 * \`\`\`ts
 * const msg = Uint8Array.of(1, 2, 3);
 * cloneBytes(msg);
 * \`\`\`
 */
export function cloneBytes(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
/**
 * Accepts a caller-owned carrier object.
 * @param carrier - Caller-owned carrier object.
 * @returns Whether the carrier is structurally present.
 * @example
 * Accept a carrier object from user code.
 *
 * \`\`\`ts
 * const carrier = { bytes: Uint8Array.of(1, 2, 3), valid: true };
 * acceptCarrier(carrier);
 * \`\`\`
 */
export function acceptCarrier(carrier: { bytes: Uint8Array; valid: boolean }): boolean {
  if (!carrier || typeof carrier !== 'object')
    throw new TypeError('"carrier" expected object, got type=' + typeof carrier);
  return true;
}
/**
 * Creates a returned object with its own byte boundary.
 * @param seed - Seed bytes.
 * @returns Byte coder object.
 * @example
 * Create a coder; check:errors should probe returned methods too.
 *
 * \`\`\`ts
 * returnedCoder(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function returnedCoder(seed: Uint8Array): { encode(msg: Uint8Array): Uint8Array } {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return {
    encode(msg: Uint8Array): Uint8Array {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from([...seed, ...msg]);
    },
  };
}
class ReturnedPoint {
  msg: Uint8Array;
  constructor(msg: Uint8Array) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
/**
 * Creates an object with a class-valued member.
 * @param seed - Seed bytes.
 * @returns Public object that exposes a class constructor.
 * @example
 * Class members on returned objects are constructors, not methods to call directly.
 *
 * \`\`\`ts
 * returnedClassHolder(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function returnedClassHolder(seed: Uint8Array): { Point: typeof ReturnedPoint } {
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return { Point: ReturnedPoint };
}
/**
 * Combines message and signature bytes.
 * @param msg - Message bytes.
 * @param sig - Signature bytes.
 * @returns Detached byte copy.
 * @example
 * Use values created inside a setup block.
 *
 * \`\`\`ts
 * if (true) {
 *   const msg = Uint8Array.of(1, 2);
 *   const sig = Uint8Array.of(3, 4);
 *   combineScoped(msg, sig);
 * }
 * \`\`\`
 */
export function combineScoped(msg: Uint8Array, sig: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  if (!(sig instanceof Uint8Array))
    throw new TypeError('"sig" expected Uint8Array, got type=' + typeof sig);
  return Uint8Array.from([...msg, ...sig]);
}
/**
 * Accepts bytes created by another public helper.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Use a public helper inside another public call.
 *
 * \`\`\`ts
 * import { cloneBytes, nestedPublicCall } from '@jsbt-test/errors-pass';
 * nestedPublicCall(cloneBytes(Uint8Array.of(1, 2, 3)));
 * \`\`\`
 */
export function nestedPublicCall(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
/**
 * Copies message bytes after an internal note.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Use the documented function without an explicit import.
 *
 * \`\`\`ts
 * const msg = Uint8Array.of(1, 2, 3);
 * commentedOwner(msg);
 * \`\`\`
 */
// Real packages sometimes keep internal implementation notes between docs and export.
export function commentedOwner(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
/**
 * Stores message bytes in a wrapper object.
 * @param msg - Message bytes.
 * @example
 * Construct a checked wrapper.
 *
 * \`\`\`ts
 * new CheckedBox(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export class CheckedBox {
  msg: Uint8Array;
  constructor(msg: Uint8Array) {
    if (!(msg instanceof Uint8Array))
      throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
    this.msg = Uint8Array.from(msg);
  }
}
/**
 * Creates a byte coder object.
 * @returns Byte coder object.
 * @example
 * Probe a method on the returned object.
 *
 * \`\`\`ts
 * const coder = makeCoder();
 * coder.encode(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function makeCoder(): { encode(msg: Uint8Array): Uint8Array } {
  return {
    encode(msg: Uint8Array): Uint8Array {
      if (!(msg instanceof Uint8Array))
        throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
      return Uint8Array.from(msg);
    },
  };
}
/**
 * Creates another byte coder object.
 * @returns Byte coder object.
 * @example
 * Probe a method on a direct factory result.
 *
 * \`\`\`ts
 * makeDirectCoder().encode(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function makeDirectCoder(): { encode(msg: Uint8Array): Uint8Array } {
  return makeCoder();
}
/**
 * Copies optional seed bytes.
 * @param seed - Optional seed bytes.
 * @returns Detached seed copy.
 * @example
 * Generate a value without passing the optional seed.
 *
 * \`\`\`ts
 * optionalSeed();
 * \`\`\`
 */
export function optionalSeed(seed?: Uint8Array): Uint8Array {
  if (seed === undefined) return Uint8Array.of(1);
  if (!(seed instanceof Uint8Array))
    throw new TypeError('"seed" expected Uint8Array, got type=' + typeof seed);
  return Uint8Array.from(seed);
}
/**
 * Copies bytes through an exported alias.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Use the public alias name.
 *
 * \`\`\`ts
 * aliasBytes(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
const aliasBytesDoc: typeof cloneBytes = cloneBytes;
export { aliasBytesDoc as aliasBytes };
/**
 * Constant table with function-valued internals.
 * @example
 * Read from a constant table.
 *
 * \`\`\`ts
 * constantTable.value;
 * \`\`\`
 */
export const constantTable = /* @__PURE__ */ (() => ({
  value: 1,
  helper: (msg: Uint8Array) => msg,
}))();
`,
    'src/source.ts': `/**
 * Copies bytes from a source-only public entry.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Import from a public entry whose built JS is absent in the checkout.
 *
 * \`\`\`ts
 * import { sourceOnly } from '@jsbt-test/errors-pass/source.js';
 * sourceOnly(Uint8Array.of(1, 2, 3));
 * \`\`\`
 */
export function sourceOnly(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
`,
  },
  'private-skip': {
    '_private.js': `const bytes = (name, value) => {
  if (!(value instanceof Uint8Array)) throw new Error(\`\${name} expected Uint8Array\`);
  return value;
};

export function hiddenFile(data) {
  return new Uint8Array(bytes('hiddenFile data', data));
}
`,
    'index.js': `const bytes = (name, value) => {
  if (!(value instanceof Uint8Array)) throw new Error(\`\${name} expected Uint8Array\`);
  return value;
};

export function publicFn(_label, data) {
  return new Uint8Array(bytes('data', data));
}

export function _hidden(data) {
  return new Uint8Array(bytes('_hidden data', data));
}

export class _Secret {
  constructor(data) {
    bytes('_Secret data', data);
  }
  open(data) {
    return new Uint8Array(bytes('_Secret open data', data));
  }
}

export function makeSecret(data) {
  bytes('data', data);
  return new _Secret(data);
}

export const secretFactory = Object.assign((data) => new Uint8Array(bytes('data', data)), {
  create(data) {
    bytes('data', data);
    return new _Secret(data);
  },
});

export class Box {
  constructor(_seed) {
    bytes('_seed', _seed);
  }
  secret(data) {
    return new Uint8Array(bytes('secret data', data));
  }
  _skip(data) {
    return new Uint8Array(bytes('_skip data', data));
  }
  open(_tag, data) {
    return new Uint8Array(bytes('data', data));
  }
}
`,
    'src/_private.ts': `/**
 * Private-file helper.
 * @param data - Private-file bytes.
 * @returns Fresh bytes.
 * @example
 * Exercise an exported helper from an underscore-leading source file.
 *
 * \`\`\`ts
 * import { hiddenFile } from '@jsbt-test/errors-private-skip/_private.js';
 * hiddenFile(new Uint8Array([1]));
 * \`\`\`
 */
export function hiddenFile(data: Uint8Array): Uint8Array {
  throw new Error('runtime fixture is provided by _private.js');
}
`,
    'src/index.ts': `/**
 * Validates public payload bytes while carrying an internal label.
 * @param _label - Internal diagnostic label.
 * @param data - Payload bytes.
 * @returns Fresh payload bytes.
 * @example
 * Validate one public byte payload with an internal label.
 *
 * \`\`\`ts
 * import { publicFn } from '@jsbt-test/errors-private-skip';
 * publicFn('payload', new Uint8Array([1]));
 * \`\`\`
 */
export function publicFn(_label: string, data: Uint8Array): Uint8Array {
  throw new Error('runtime fixture is provided by index.js');
}

/**
 * Private exported helper.
 * @param data - Private helper bytes.
 * @returns Fresh bytes.
 * @example
 * Exercise an underscore-leading exported helper that should stay private.
 *
 * \`\`\`ts
 * import { _hidden } from '@jsbt-test/errors-private-skip';
 * _hidden(new Uint8Array([1]));
 * \`\`\`
 */
export function _hidden(data: Uint8Array): Uint8Array {
  throw new Error('runtime fixture is provided by index.js');
}

/**
 * Private exported class.
 * @param data - Private constructor bytes.
 * @example
 * Exercise an underscore-leading class that should stay private.
 *
 * \`\`\`ts
 * import { _Secret } from '@jsbt-test/errors-private-skip';
 * new _Secret(new Uint8Array([1])).open(new Uint8Array([2]));
 * \`\`\`
 */
export class _Secret {
  constructor(data: Uint8Array) {
    throw new Error('runtime fixture is provided by index.js');
  }
  open(data: Uint8Array): Uint8Array {
    throw new Error('runtime fixture is provided by index.js');
  }
}

/**
 * Public factory returning a private implementation class.
 * @param data - Seed bytes for the private implementation.
 * @returns Private implementation instance.
 * @example
 * Construct a private implementation through its public factory.
 *
 * \`\`\`ts
 * import { makeSecret } from '@jsbt-test/errors-private-skip';
 * makeSecret(new Uint8Array([1])).open(new Uint8Array([2]));
 * \`\`\`
 */
export function makeSecret(data: Uint8Array): _Secret {
  throw new Error('runtime fixture is provided by index.js');
}

export type SecretFactory = {
  (data: Uint8Array): Uint8Array;
  create(data: Uint8Array): _Secret;
};

/**
 * Public callable object returning a private implementation from \`.create()\`.
 * @param data - Payload bytes for the direct callable form.
 * @returns Fresh payload bytes.
 * @example
 * Use the direct callable form and the private implementation constructor.
 *
 * \`\`\`ts
 * import { secretFactory } from '@jsbt-test/errors-private-skip';
 * secretFactory(new Uint8Array([1]));
 * secretFactory.create(new Uint8Array([2])).open(new Uint8Array([3]));
 * \`\`\`
 */
export const secretFactory: SecretFactory = (() => {
  throw new Error('runtime fixture is provided by index.js');
}) as unknown as SecretFactory;

/**
 * Public box with internal constructor and method arguments.
 * @param _seed - Internal constructor seed bytes.
 * @example
 * Construct one public box and open one payload.
 *
 * \`\`\`ts
 * import { Box } from '@jsbt-test/errors-private-skip';
 * const box = new Box(new Uint8Array([1]));
 * box.open('tag', new Uint8Array([2]));
 * \`\`\`
 */
export class Box {
  constructor(_seed: Uint8Array) {
    throw new Error('runtime fixture is provided by index.js');
  }
  private secret(data: Uint8Array): Uint8Array {
    throw new Error('runtime fixture is provided by index.js');
  }
  _skip(data: Uint8Array): Uint8Array {
    throw new Error('runtime fixture is provided by index.js');
  }
  open(_tag: string, data: Uint8Array): Uint8Array {
    throw new Error('runtime fixture is provided by index.js');
  }
}
`,
  },
  'promise-chain': {
    'index.js': `export async function parsePrivateKey(privateKey) {
  if (typeof privateKey !== 'string')
    throw new TypeError('"privateKey" expected string, got type=' + typeof privateKey);
  return { keyId: '01' };
}

export function privateKeyText(seed) {
  if (typeof seed !== 'string')
    throw new TypeError('"seed" expected string, got type=' + typeof seed);
  return { privateKey: seed };
}

export function parsePackets(text) {
  if (typeof text !== 'string')
    throw new TypeError('"text" expected string, got type=' + typeof text);
  return [{ TAG: 'secretKey' }];
}
`,
    'index.ts': `/**
 * Parses one armored private key asynchronously.
 * @param privateKey - Armored private key text.
 * @returns Parsed key metadata.
 * @example
 * Read key metadata from the returned promise.
 * \`\`\`ts
 * import { privateKeyText, parsePrivateKey } from '@jsbt-test/errors-promise-chain';
 * const seed = 'secret';
 * parsePrivateKey(privateKeyText(seed).privateKey);
 * parsePrivateKey(privateKeyText(seed).privateKey).then(({ keyId }) => keyId);
 * \`\`\`
 */
export async function parsePrivateKey(privateKey: string): Promise<{ keyId: string }> {
  if (typeof privateKey !== 'string')
    throw new TypeError('"privateKey" expected string, got type=' + typeof privateKey);
  return { keyId: '01' };
}

export function privateKeyText(seed: string): { privateKey: string } {
  if (typeof seed !== 'string')
    throw new TypeError('"seed" expected string, got type=' + typeof seed);
  return { privateKey: seed };
}

/**
 * Parses one packet list.
 * @param text - Armored packet text.
 * @returns Parsed packet rows.
 * @example
 * Pick one packet from the parsed list.
 * \`\`\`ts
 * import { parsePackets } from '@jsbt-test/errors-promise-chain';
 * const text = 'secret';
 * parsePackets(text);
 * parsePackets(text).find((packet) => packet.TAG === 'secretKey');
 * \`\`\`
 */
export function parsePackets(text: string): { TAG: string }[] {
  if (typeof text !== 'string')
    throw new TypeError('"text" expected string, got type=' + typeof text);
  return [{ TAG: 'secretKey' }];
}
`,
  },
  'state-isolation': {
    'index.js': `let touched = false;

export function dirty(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  touched = true;
  return Uint8Array.from(msg);
}

export function fresh(msg) {
  if (touched) throw new Error('state leaked');
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
`,
    'src/index.ts': `let touched = false;

/**
 * Mutates package module state.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * Dirty the module state inside one public example.
 *
 * \`\`\`ts
 * dirty(Uint8Array.of(1));
 * \`\`\`
 */
export function dirty(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  touched = true;
  return Uint8Array.from(msg);
}

/**
 * Requires a fresh module instance.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * This probe should not observe another example's module state.
 *
 * \`\`\`ts
 * fresh(Uint8Array.of(2));
 * \`\`\`
 */
export function fresh(msg: Uint8Array): Uint8Array {
  if (touched) throw new Error('state leaked');
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
`,
  },
  'timeout-isolation': {
    'index.js': `export function spin(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  for (;;) {}
}

export function checked(msg) {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
`,
    'src/index.ts': `/**
 * Never returns after validating its input.
 * @param msg - Message bytes.
 * @returns Never returns.
 * @example
 * This example intentionally hangs after startup.
 *
 * \`\`\`ts
 * spin(Uint8Array.of(1));
 * \`\`\`
 */
export function spin(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  for (;;) {}
}

/**
 * Validates bytes normally.
 * @param msg - Message bytes.
 * @returns Detached byte copy.
 * @example
 * This example should still run after another example times out.
 *
 * \`\`\`ts
 * checked(Uint8Array.of(2));
 * \`\`\`
 */
export function checked(msg: Uint8Array): Uint8Array {
  if (!(msg instanceof Uint8Array))
    throw new TypeError('"msg" expected Uint8Array, got type=' + typeof msg);
  return Uint8Array.from(msg);
}
`,
  },
  'value-label': {
    'index.js': `export function check(value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(\`expected Uint8Array, got type=\${typeof value}\`);
  }
  return new Uint8Array(value);
}
`,
    'src/index.ts': `/**
 * Checks a generic validator value.
 * @param value - value to validate.
 * @returns checked bytes.
 * @example
 * \`\`\`js
 * import { check } from '@jsbt-test/errors-value-label';
 * check(new Uint8Array([1]));
 * \`\`\`
 */
export function check(value: Uint8Array): Uint8Array {
  return value;
}
`,
  },
  'wrapper-label': {
    'index.js': `const bytes = (value, label) => {
  if (!(value instanceof Uint8Array))
    throw new TypeError(\`"\${label}" expected Uint8Array, got type=\${typeof value}\`);
  return value;
};

const options = (opts) => {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts))
    throw new TypeError('"opts" expected object');
  if (opts.dkLen !== undefined) {
    if (typeof opts.dkLen !== 'number')
      throw new TypeError(\`"dkLen" expected number, got \${typeof opts.dkLen}\`);
    if (!Number.isInteger(opts.dkLen)) throw new TypeError('"dkLen" expected integer');
  }
  if (opts.personalization !== undefined) bytes(opts.personalization, 'personalization');
  if (opts.onProgress !== undefined && typeof opts.onProgress !== 'function')
    throw new TypeError(\`"onProgress" expected function, got \${typeof opts.onProgress}\`);
  return opts;
};

export const hash = (msg, opts = {}) => {
  return hash.create(opts).update(msg).digest();
};

hash.create = (opts = {}) => {
  options(opts);
  return {
    update(msg) {
      bytes(msg, 'msg');
      return this;
    },
    digest() {
      return new Uint8Array(opts.dkLen || 4);
    },
  };
};

export const mac = (key, message, personalization, dkLen = 4) => {
  bytes(key, 'key');
  bytes(message, 'message');
  bytes(personalization, 'personalization');
  if (typeof dkLen !== 'number')
    throw new TypeError(\`"dkLen" expected number, got \${typeof dkLen}\`);
  return hash(key, { dkLen, personalization: hash(message, { personalization }) });
};
`,
    'src/index.ts': `type Opts = {
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
 * \`\`\`js
 * import { hash } from '@jsbt-test/errors-wrapper-label';
 * const msg = new Uint8Array([1, 2, 3]);
 * hash(msg, {
 *   dkLen: 8,
 *   personalization: new Uint8Array([4]),
 *   onProgress(percentage) {
 *     percentage;
 *   },
 * });
 * \`\`\`
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
 * \`\`\`js
 * import { mac } from '@jsbt-test/errors-wrapper-label';
 * mac(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), 8);
 * \`\`\`
 */
export const mac: Mac = makeMac(hash);
`,
  },
  'zero-arg-no-warning': {
    'index.js': `export const removed = () => {
  throw new Error('removed');
};
`,
    'src/index.ts': `/**
 * Removed helper kept only to throw a migration hint.
 * @returns Never; always throws.
 * @example
 * Show the migration note without calling the removed helper.
 *
 * \`\`\`ts
 * const replacement = 'use the supported helper instead';
 * \`\`\`
 */
export const removed: () => never = () => {
  throw new Error('removed');
};
`,
  },
};

export function errorsVector(name: string): string {
  const files = VECTORS[name];
  if (!files) throw new Error(`unknown errors vector: ${name}`);
  const pkg = {
    name: `@jsbt-test/errors-${name}`,
    type: 'module',
    exports: EXPORTS[name] || { '.': './index.js' },
  };
  return unpackVector('errors', name, {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    ...files,
  });
}
