# @paulmillr/jsbt

Typescript configs, build tools and templates for JS projects.

* `jsbt.js` calls [esbuild](https://esbuild.github.io) to produce single-file package output
* `.github/workflows` contains GitHub CI configs for testing & publishing JS packages:
    * `test-js.yml` runs tests on LTS node.js, bun, deno, linter, and calculates coverage
        * `submodules: true / false (default)` option determines whether to clone submodules
    * `test-ts.yml` is same, but runs typescript instead of js on supported node.js (v22+)
    * `release.yml` publishes package on NPM, JSR and creates single-file output if it exists
        * `build-path: string` - path to build directory, which contains `out` dir, from which
          files would be uploaded to github releases
        * `slow-types: true / false (default)` - whether to allow [slow types](https://jsr.io/docs/about-slow-types) on JSR.io
* `tsconfig.json` and `tsconfig.cjs.json` allow inheritance with a few useful options:
    * Overall they are quite strict
    * `isolatedDeclarations` ensures types are "fast" and friendly to JSR.io
    * `verbatimModuleSyntax` - ensures files are friendly to "type erasure" / "type ignore"
  node.js and others
    * `tsconfig.test.json` is for typescript tests, with looser checks
* `repo-template` contains project skeleton, which can be used to create a new package
    * Replace EDIT_ME with proper value

## License

MIT License
