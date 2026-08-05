import type { RetU8A } from './utils.ts';

class Worker {
  cached(_arg: RetU8A): Uint8Array {
    return 1 as any;
  }
}

void Worker;
