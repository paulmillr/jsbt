import { make, makeBox } from 'bytes-producer';

const takeThirdParty = (_arg: Uint8Array): void => {};
const takeThirdPartyBox = (_arg: { buf: Uint8Array }): void => {};

const out = make(new Uint8Array());
takeThirdParty(out);
crypto.subtle.digest('SHA-256', out);

const boxed = makeBox(new Uint8Array());
takeThirdPartyBox(boxed);
crypto.subtle.digest('SHA-256', boxed.buf);

export {};
