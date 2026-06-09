const bytes = (name, value) => {
  if (!(value instanceof Uint8Array))
    throw new Error(`"${name}" expected Uint8Array, got type=${typeof value}`);
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
