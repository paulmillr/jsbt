// Must be imported before src/test.ts, which reads JSBT_QUIET at module load.
// Reporter tests assert on full output; tests that need quiet mode set it
// explicitly on the child process env.
delete process.env.JSBT_QUIET;
