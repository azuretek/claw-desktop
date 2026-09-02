'use strict';

// Release configuration, driven by release-it.
//
//   npm run release              # patch: 1.0.0 -> 1.0.1
//   npm run release -- minor
//   npm run release -- major
//   npm run release -- --dry-run
//
// release-it replaced a hand-written script that did the same four steps. The
// steps were never the hard part -- the preflight is, and a maintained tool has
// years of other people's mistakes encoded in its checks.
//
// Why not semantic-release or release-please: both decide the version by parsing
// Conventional Commits, and this repo does not write them (1 of 27 subjects
// matches). Adopting either means rewriting a deliberate commit style to satisfy
// a parser, and until then every release would be classified "no release".
// release-it asks for the bump instead, which is the honest interface for a
// repo whose commit messages are prose.
//
// A CommonJS config rather than .release-it.json so the reasoning above can live
// with the settings; package.json declares no `type`, so `.cjs` is explicit.

const REPO = 'https://github.com/azuretek/claw-desktop';

module.exports = {
  git: {
    // Releases are cut from main so the tag lands on the line everyone builds.
    requireBranch: 'main',
    // Untracked files count as dirty here, and should: they are inside `src/**`
    // for packaging purposes, so they can change what ships while leaving the
    // commit looking clean.
    requireCleanWorkingDir: true,
    // CI builds the remote, not this checkout. Releasing from a branch that has
    // no upstream produces a tag nothing will build.
    requireUpstream: true,
    commitMessage: 'Release v${version}',
    tagName: 'v${version}',
    tagAnnotation: 'Claw Desktop v${version}',
    push: true,
  },

  github: {
    // The GitHub Release is created by CI, not from here.
    //
    // It has to be: electron-builder generates `latest.yml` / `latest-mac.yml`
    // during the build, and those files are what an updater reads. A release
    // created here would exist before those files do, and two publishers
    // writing one release is how assets go missing from it.
    release: false,
  },

  npm: {
    // Not a package. This still bumps package.json and package-lock.json --
    // that is the npm plugin's bump step, not publication.
    publish: false,
  },

  hooks: {
    // Nothing is written until these pass. A release that stops before the
    // first write is recoverable; one that stops after tagging leaves a tag
    // only on this machine, which is the state that later produces "why did CI
    // build the wrong commit".
    'before:init': ['npm test'],
    'after:release': [
      `echo "\n  released \${name} v\${version}"`,
      `echo "  CI is building it:  ${REPO}/actions"`,
      `echo "  installers land at: ${REPO}/releases/tag/v\${version}\n"`,
    ],
  },
};
