# check-readme-deps

## Usage

```js
import { double } from '@jsbt-test/check-readme-deps';
import { dep } from '@jsbt-test/dep';
import { rt } from '@jsbt-test/rt';
if (double(21) !== 42) throw new Error('double');
if (dep() !== 'dep') throw new Error('dep');
if (rt() !== 'rt') throw new Error('rt');
```
