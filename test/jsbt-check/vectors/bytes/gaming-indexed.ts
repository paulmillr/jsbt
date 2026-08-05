import type { RetU8A } from './utils.ts';

type Bytes<T extends Uint8Array> = T;
type Packet<T extends Uint8Array> = { value: Bytes<T> };
type Box = { value: Packet<RetU8A>['value'] };

const take = (_arg: Box): void => {};

void take;
