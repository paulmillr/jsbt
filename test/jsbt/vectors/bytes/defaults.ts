import type { RetU8A } from './utils.ts';

type BadRet<T extends Uint8Array = RetU8A> = T;
type BadRaw<T extends Uint8Array = Uint8Array> = T;
type Ok<T = string> = T;

void [0 as any as BadRet<RetU8A>, 0 as any as BadRaw<Uint8Array>, 0 as any as Ok];
