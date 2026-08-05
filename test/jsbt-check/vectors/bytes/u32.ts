import type { RetU32A } from './utils.ts';

type Poly = Uint32Array<any>;

function out32(): Uint32Array {
  return 1 as any;
}

function generic32(): Uint32Array<ArrayBuffer> {
  return 1 as any;
}

function genericAlias(): Poly {
  return 1 as any;
}

function input32(arg: RetU32A): RetU32A {
  return arg;
}

function source32(): Uint32Array {
  return 1 as any;
}

void [out32(), generic32(), genericAlias(), input32(source32())];
