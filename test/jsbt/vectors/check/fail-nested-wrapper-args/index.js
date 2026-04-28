export const sha = (msg, opts) => Uint8Array.from(msg).slice(0, opts?.dkLen || msg.length);
sha.isSupported = async () => true;
