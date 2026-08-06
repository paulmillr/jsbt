// Tests for the shared package modules (test, bench). The `baler` binary
// (bundle + size) has its own suite in baler/test; `jsbt-check` tests live in
// test/check.ts (npm run test:check).
import { should } from '../src/test.ts';

// Deterministic machine-mode output regardless of TTY; FORCE_COLOR sub-tests override.
process.env.NO_COLOR = '1';

import './benchmark/benchmark.test.ts';
import './benchmark/benchmark-compare.test.ts';

should.runWhen(import.meta.url);
