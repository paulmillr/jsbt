/**
 * Validates public payload bytes while carrying an internal label.
 * @param _label - Internal diagnostic label.
 * @param data - Payload bytes.
 * @returns Fresh payload bytes.
 * @example
 * Validate one public byte payload with an internal label.
 *
 * ```ts
 * import { publicFn } from '@jsbt-test/errors-private-skip';
 * publicFn('payload', new Uint8Array([1]));
 * ```
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
 * ```ts
 * import { _hidden } from '@jsbt-test/errors-private-skip';
 * _hidden(new Uint8Array([1]));
 * ```
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
 * ```ts
 * import { _Secret } from '@jsbt-test/errors-private-skip';
 * new _Secret(new Uint8Array([1])).open(new Uint8Array([2]));
 * ```
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
 * ```ts
 * import { makeSecret } from '@jsbt-test/errors-private-skip';
 * makeSecret(new Uint8Array([1])).open(new Uint8Array([2]));
 * ```
 */
export function makeSecret(data: Uint8Array): _Secret {
  throw new Error('runtime fixture is provided by index.js');
}

export type SecretFactory = {
  (data: Uint8Array): Uint8Array;
  create(data: Uint8Array): _Secret;
};

/**
 * Public callable object returning a private implementation from `.create()`.
 * @param data - Payload bytes for the direct callable form.
 * @returns Fresh payload bytes.
 * @example
 * Use the direct callable form and the private implementation constructor.
 *
 * ```ts
 * import { secretFactory } from '@jsbt-test/errors-private-skip';
 * secretFactory(new Uint8Array([1]));
 * secretFactory.create(new Uint8Array([2])).open(new Uint8Array([3]));
 * ```
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
 * ```ts
 * import { Box } from '@jsbt-test/errors-private-skip';
 * const box = new Box(new Uint8Array([1]));
 * box.open('tag', new Uint8Array([2]));
 * ```
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
