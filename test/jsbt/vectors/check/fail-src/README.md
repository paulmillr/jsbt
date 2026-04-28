# check-src

## Usage

```ts
import { add } from '@jsbt-test/check-src';
const sum = add(20, 22);
if (sum !== 42) throw new Error(`expected 42, got ${sum}`);
```

```ts
import { add } from '@jsbt-test/check-src/alpha.js';
add('bad', 2);
```
