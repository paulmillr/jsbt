import { should } from '../src/test.ts';

import './jsbt/bin.test.ts';
import './jsbt/bundle.test.ts';
import './jsbt/bytes.test.ts';
import './jsbt/camel-parts.test.ts';
import './jsbt/check.test.ts';
import './jsbt/dir-entries.test.ts';
import './jsbt/errors-format.test.ts';
import './jsbt/errors-import.test.ts';
import './jsbt/errors-label.test.ts';
import './jsbt/errors-object-methods.test.ts';
import './jsbt/errors-promise.test.ts';
import './jsbt/errors.test.ts';
import './jsbt/install.test.ts';
import './jsbt/jsr.test.ts';
import './jsbt/jsrpublish.test.ts';
import './jsbt/line-index.test.ts';
import './jsbt/mutate.test.ts';
import './jsbt/patterns.test.ts';
import './jsbt/public.test.ts';
import './jsbt/spec-constraints.test.ts';
import './jsbt/tests.test.ts';
import './jsbt/ts-source-rel.test.ts';
import './jsbt/utils.test.ts';

should.runWhen(import.meta.url);
