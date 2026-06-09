/**
 * Parses one armored private key asynchronously.
 * @param privateKey - Armored private key text.
 * @returns Parsed key metadata.
 * @example
 * Read key metadata from the returned promise.
 * ```ts
 * import { privateKeyText, parsePrivateKey } from '@jsbt-test/errors-promise-chain';
 * const seed = 'secret';
 * parsePrivateKey(privateKeyText(seed).privateKey);
 * parsePrivateKey(privateKeyText(seed).privateKey).then(({ keyId }) => keyId);
 * ```
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
 * ```ts
 * import { parsePackets } from '@jsbt-test/errors-promise-chain';
 * const text = 'secret';
 * parsePackets(text);
 * parsePackets(text).find((packet) => packet.TAG === 'secretKey');
 * ```
 */
export function parsePackets(text: string): { TAG: string }[] {
  if (typeof text !== 'string')
    throw new TypeError('"text" expected string, got type=' + typeof text);
  return [{ TAG: 'secretKey' }];
}
