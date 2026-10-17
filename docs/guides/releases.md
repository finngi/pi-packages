# Develop and release

Work from a checkout with Node 24 and the root lockfile. Source development, a public npm
release and activation in a running Pi are separate actions.

## Test locally

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
npm run test:packages
npm run test:alpha
```

Run the affected package's tests while iterating. Before merging, also run `npm run check:docs`,
`npm run check:boundary` and `npm run test:e2e`, as CI does. The last command already includes
`test:packages`, so CI runs that installed-consumer suite once. Installed-package tests use fresh
projects with stock Pi 1.3.0 and scripted providers; they do not call your real models.

To try the source in a new session without saving package settings, from the checkout:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --no-extensions \
  -e "$PWD/packages/pi-background" -e "$PWD/packages/pi-delegation"
```

This uses Pi's native temporary package loading and your existing login. It does not replace your
normal Pi executable. The new session still uses your ordinary personal/project settings for
other resources. Existing sessions are unaffected. Add other package directories explicitly as
needed; restart only this test session when changing extension code.

## Test the public download before releasing

```sh
npm run test:alpha
```

This builds seven `@finngi` tarballs and installs each alone beside stock Pi. Files go into
`.artifacts/public-packages/`, separate from unscoped development tarballs in `.artifacts/packages/`.
The public output directory is replaced on each pack, so it contains only the current batch.
`npm run pack:alpha` builds the same format without running installed-consumer tests.

For a manual trial, install a tarball into an empty temporary directory, then pass that installed
package directory to Pi with `-e`, as above. Use the pinned CLI's absolute path if launching outside
this checkout. Do not run `pi install` on a development artifact unless you intend to save it in
normal package settings.

## Versions

The **root `package.json` version** is the public version of all seven downloads. The current
`0.1.0-alpha.1` is an unpublished candidate; the first public release was `0.1.0-alpha.0`.
We use one version for the small alpha set because each download includes its workspace helpers.
This does not make users install all seven.

Before preparing a subsequent alpha candidate:

```sh
npm run version:alpha
```

This uses [npm version](https://docs.npmjs.com/cli/v11/commands/npm-version/) to advance the
alpha number in the root manifest and lockfile. It makes no commit, tag or publication. For a new
base version, set it explicitly, for example:

```sh
npm version 0.2.0-alpha.0 --no-git-tag-version --workspaces=false --ignore-scripts
```

Do not bump on every development commit. Record user-visible changes in [the changelog](../../CHANGELOG.md).
Private workspace versions remain internal dependency identities; they are bundled, not published
separately. Change those versions and their dependency references together only if needed.
The packer rejects non-alpha public versions. Stable releases need a deliberate change to this
policy rather than accidentally using npm's default `latest` tag.

## CI and deliberate publication

CI runs on Linux and macOS for PRs and `main`; it can also be started manually with GitHub's
**Run workflow** button. It uses the same commands above, including both the internal-package
checks and the seven actual scoped-download checks. Only after that platform's checks pass does
it upload `alpha-PLATFORM-COMMIT` with seven tarballs and `SHA256SUMS`, retained for 14 days.
An artifact from one platform is not proof that the other platform passed.

Neither CI nor a merge publishes to npm. CI has read-only repository access and needs no npm
publishing credential. To publish a reviewed release:

1. Confirm both platform jobs passed for the exact merged commit. Review its version and changelog.
2. Download that commit's **Linux** artifact from the successful CI run. Verify `SHA256SUMS`
   with `shasum -a 256 -c SHA256SUMS` in the extracted directory. Do not rebuild it after review.
3. With publication explicitly approved, use your npm login to publish each of the seven tested
   files: `npm publish FILE.tgz --access public --tag alpha`. Handle npm's 2FA prompt normally.
   Use exact filenames, not a glob over an old artifact directory.
4. Confirm the registry version and `alpha` tag for each package. If only some publishes succeed,
   check which already exist and finish the missing ones; npm versions cannot be overwritten.
5. Record the published version and source commit in the changelog/release notes. Tag that source
   commit `vVERSION` only after all seven are verified. Start the next candidate when needed.

Do not publish merely to update catalog ranking. npm publication and Pi catalog discovery are
[separate checks](distribution.md#verify-catalog-discovery-separately).
