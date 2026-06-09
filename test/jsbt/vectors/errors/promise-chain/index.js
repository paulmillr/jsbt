export async function parsePrivateKey(privateKey) {
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
