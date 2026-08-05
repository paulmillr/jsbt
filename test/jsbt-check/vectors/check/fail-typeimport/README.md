# check-typeimport

## Usage

```ts
import { getShape } from '@jsbt-test/check-typeimport';
const shape = getShape();
if (shape.value !== 42) throw new Error(`expected 42, got ${shape.value}`);
```
