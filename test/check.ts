// Tests for the `jsbt-check` binary and its audit modules.
import { should } from '../src/test.ts';

// Deterministic machine-mode output regardless of TTY; FORCE_COLOR sub-tests override.
process.env.NO_COLOR = '1';

import './jsbt-check/bytes.test.ts';
import './jsbt-check/dir-entries.test.ts';
import './jsbt-check/line-index.test.ts';
import './jsbt-check/ts-source-rel.test.ts';
import './jsbt-check/utils.test.ts';
import './jsbt-check/check.test.ts';
import './jsbt-check/check-bin.test.ts';
import './jsbt-check/errors-format.test.ts';
import './jsbt-check/errors-import.test.ts';
import './jsbt-check/errors-label.test.ts';
import './jsbt-check/errors-object-methods.test.ts';
import './jsbt-check/errors-promise.test.ts';
import './jsbt-check/errors.test.ts';
import './jsbt-check/jsr.test.ts';
import './jsbt-check/jsrpublish.test.ts';
import './jsbt-check/mutate.test.ts';
import './jsbt-check/patterns.test.ts';
import './jsbt-check/spec-constraints.test.ts';
import './jsbt-check/tests.test.ts';

should.runWhen(import.meta.url);
