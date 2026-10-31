# Publishing & Installation

The repository ships **sources only**. `dist/` is git-ignored build output, so a Git checkout holds nothing the Harness can load. The installable artifact is the tarball attached to a GitHub Release, packed by `.github/workflows/release.yml` from a fresh build of the tag.

## Installation

`dsh plugin --profile web add <package>` is a thin pnpm forwarder: it runs `pnpm add <package>` inside the web profile directory and promotes the package to a profile layer only because its `package.json` declares `dsh.bundle.patch`.

The recommended channel is the release asset, which is already built:

```bash
dsh plugin --profile web add \
  https://github.com/Mooling0602/dsh-hint-shell/releases/download/<version>/dsh-hint-shell-<version>.tgz
```

A downloaded asset installs through its local path (`./dsh-hint-shell-<version>.tgz`) the same way.

A Git address also works, because `package.json` declares a `prepare` script that builds `dist/` on install:

```bash
dsh plugin --profile web add github:Mooling0602/dsh-hint-shell
```

That channel needs Node `^22.19.0 || >=24.0.0` and a build step. pnpm blocks build scripts by default: allow the exact key pnpm prints in the profile's `pnpm-workspace.yaml` (`allowBuilds`), or pass `--allow-build` for a one-off install.

> pnpm's git shorthand is `github:<owner>/<repo>`; a bare `github.com/<owner>/<repo>` is treated as a local directory. `git+https://github.com/Mooling0602/dsh-hint-shell.git` works too.

After installing, restart the dsh web process and refresh the page.

## Update

A tarball URL is pinned in the profile manifest, so switching releases means `remove` then `add`:

```bash
dsh plugin --profile web remove dsh-hint-shell
dsh plugin --profile web add \
  https://github.com/Mooling0602/dsh-hint-shell/releases/download/<version>/dsh-hint-shell-<version>.tgz
```

A Git install updates by re-resolving the spec (`dsh plugin --profile web update dsh-hint-shell`), or by a clean remove + add when the lockfile pins the old commit.

`dsh plugin` forwards to pnpm inside the profile directory, so never edit `~/.dsh/profiles/web/node_modules/dsh-hint-shell` by hand: the next pnpm operation rewrites it.

## Uninstall

```bash
dsh plugin --profile web remove dsh-hint-shell
```

## Releases

Releases are cut by `.github/workflows/release.yml` from **bare version tags** (`0.1.0`, no `v` prefix). The only manual input is the maintainer-written `CHANGELOG.md` entry: the workflow composes the Release body from the global `## Header` content, the version's `## <version>` section and the global `## Endfix` content (titles excluded), and generates the `**Full Changelog**` compare link from the previous release tag.

Every release attaches `dsh-hint-shell-<version>.tgz`, the built and installable package.

### Cutting a release

The tag name is the exact `package.json` version without a `v` prefix. The prefix belongs to the release commit subject (`release: v0.1.0`) and the Release title (`v0.1.0`). A `v`-prefixed tag does not trigger the workflow.

1. Add the version's section to `CHANGELOG.md` and commit it. The heading is the exact bare version; category groups are `###` headings.

2. Bump the version, commit as `release: v<version>`, and tag the bare version:

   ```bash
   npm version 0.1.0 --no-git-tag-version
   git commit -am "release: v0.1.0"

   # annotated bare tag; the message carries the release commit hash
   git tag -a 0.1.0 -m "commit $(git rev-parse --short HEAD)"

   git push origin main 0.1.0
   ```

The workflow validates that the tag is bare, matches `package.json`, is valid semver, sits on a commit reachable from `main`, and that the commit subject is exactly `release: v<version>`. It then runs the same gate as CI (`typecheck`, `test`, `build`), asserts the build modified no tracked file, composes the notes, packs the tarball, verifies the tarball contains `dist/index.js` and `dist/client.js`, and creates the Release titled `v<version>`.

A semver prerelease (`-alpha.N`, `-beta.N`, `-rc.N`) is flagged as a pre-release; a final `X.Y.Z` is marked latest.

Preview the composed notes locally before tagging:

```bash
GITHUB_REPOSITORY=Mooling0602/dsh-hint-shell node .github/scripts/release-notes.mjs 0.1.0 /tmp/note.md
```

Re-running a failed release is safe: an existing Release gets its title and notes refreshed, and its tarball replaced unless the release is immutable. When GitHub's immutable releases are enabled, assets are locked; the workflow keeps the published tarball and refreshes only the title and notes, so a broken release is repaired by bumping the version.

### Manual run

*Actions → Release → Run workflow* releases an existing tag, which is how a release that failed midway is retried. Set `dry_run: true` to run every check and build the tarball without creating a Release.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run build     # writes dist/, git-ignored
npm pack --dry-run
```

`npm run build` writes only into the git-ignored `dist/`, so a rebuild leaves `git status` clean. CI and the release workflow both assert that; a dirty tree means generated output leaked back into the tree.
