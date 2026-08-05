// Tests for the `jsbt` binary and shared package modules (test, bench, utils).
// `jsbt-check` tests live in test/check.ts (npm run test:check).
import { should } from '../src/test.ts';

// Deterministic machine-mode output regardless of TTY; FORCE_COLOR sub-tests override.
process.env.NO_COLOR = '1';

import './bench/bench.test.ts';
import './bench/bench-compare.test.ts';
import './jsbt/bin.test.ts';
import './jsbt/bundle.test.ts';
import './jsbt/camel-parts.test.ts';
import './jsbt/public.test.ts';
import './jsbt/size.test.ts';

should.runWhen(import.meta.url);
