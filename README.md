# @paulmillr/jsbt

Build tools for js projects. Includes tsconfigs, templates and CI workflows

## tsconfigs

There are two base strict tsconfig with a few interesting options:

- isolatedDeclarations - ensures output is friendly to JSR.io
- verbatimModuleSyntax - ensures files are friendly to "type erasure" / "type ignore"
  node.js and others.

## GitHub CI workflows

Contains two workflows:

`test-js.yml`:

1. Runs node.js tests on LTS versions
2. Runs Bun tests (if test:bun exists)
3. Runs Deno tests (TODO: do not run if no test:bun)
4. Runs linter (if lint exists)
5. Calculates code coverage from tests using c8

Options: `clone-submodules: true / false (default)` - whether to clone repo with submodules.

`release.yml`:

1. Publishes release on NPM
2. Publishes release on JSR if jsr.json exists

Options:

- `build-path: string` - path to build directory, which contains `out` dir, from which
  files would be uploaded to github releases
- `slow-types: true / false (default)` - whether to allow slow types on JSR.io. Check jsr docs

## Usage

Copy all files from `repo-template` when creating a new project.
Then, edit `EDIT_ME` parts in copied files.

Libraries can have different structure. Edit it to your needs:

- A library can be single-file (`index.ts`), or multiple-files (`src` directory)
- A library can be ESM-only (one tsconfig), or hybrid ESM+Common.js (two tsconfigs)

Make sure to adjust `package.json` steps: `lint`, `format`, `test`, `build` and `tsconfig`

## Structure

- `repo-template` - files that should be copied when a new repo is created
  - `.github` - github ci workflows:
    - run npm tests on every commit
    - publish npm package on every release, using GitHub CI and provenance
    - upload standalone build files to github release, from `build` directory
  - `.prettierrc.json`, `tsconfig.esm.json`: prettier and typescript configs
  - `LICENSE` - MIT license
  - `build` - directory that uses `esbuild` to create a standalone build file
    that can be used in browsers etc
- `tsconfig` - typescript config files that can be loaded through NPM
  - `@paulmillr/jsbt/tsconfig.esm.json` - ESM base config
  - `@paulmillr/jsbt/tsconfig.cjs.json` - common.js base config
- `jsbt.js` - binary, provides helpers for `build` directory,
  such as reading `package.json` and transforming its package name into snake-cased or
  camelCased name. When installed through NPM, it can be used as `npx jsbt`. For example, for package
  "@namespace/ab-cd", it would emit:
  - `npx jsbt outfile` - `namespace-ab-cd`
  - `npx jsbt global` - `namespaceAbCd`

## Updates

- When prettier, tsconfig, esbuild are updated, adjust
  `repo-template/package.json` and `repo-template/build/package.json`
- When node.js LTS is updated, adjust `repo-template/.github/workflows/*.yml`
- When GitHub CI checkout action is updated, adjust `repo-template/.github/workflows/*.yml`
  - contents with `actions/checkout@` will need to be set to new values
  - ensure it's commit ids and not tags, because tags are mutable (less secure)

## License

MIT License
