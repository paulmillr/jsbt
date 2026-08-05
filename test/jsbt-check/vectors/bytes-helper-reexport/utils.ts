import { type TArg, type TRet } from './helpers.ts';
export { type TArg, type TRet } from './helpers.ts';

export function raw(): Uint8Array {
  return 1 as any;
}

export function wrapped(arg: TArg<Uint8Array>): TRet<Uint8Array> {
  return arg as TRet<Uint8Array>;
}
