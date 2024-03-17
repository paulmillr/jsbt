# @paulmillr/jsbt

Build tools for js projects. Includes tsconfigs, templates and CI workflows

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
- `tsconfigs` - typescript config files that can be loaded through NPM
    - `@paulmillr/jsbt/tsconfigs/esm.json` - ESM base config
    - `@paulmillr/jsbt/tsconfigs/cjs.json` - common.js base config
    - `@paulmillr/jsbt/tsconfigs/esm-less-strict.json` - ESM config that sets
      `noUncheckedIndexedAccess` to `false` instead of `true`
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
