# Releases

`@dioko/analytics` is a public npm package. Browser, React, and server exports share one version.

## One-time npm setup

The initial version has already been published. Once `.github/workflows/publish.yml` is on `main`, open the package's npm Settings → Trusted Publisher and choose GitHub Actions:

- Organization: `dioko-ai`
- Repository: `dioko-analytics-clients`
- Workflow filename: `publish.yml` (filename only)
- Environment: leave blank
- Allowed actions: enable direct publishing with `npm publish`

No `NPM_TOKEN` secret is required. The workflow uses a GitHub-hosted runner, Node 24, and OIDC (`id-token: write`). npm requires CLI 11.5.1 or newer. Complete the first automated publish within two days of configuring trust, otherwise recreate the expired configuration. After verifying automation, select “Require two-factor authentication and disallow tokens” in npm Publishing access.

See https://docs.npmjs.com/trusted-publishers/ for npm's current requirements. Public packages published from public repositories also receive automatic provenance.

GitHub Actions must be allowed to write repository contents to create tags and releases. Restrict writes to `main` and release tags to maintainers; release tags must permit this workflow's GitHub token to create them. Published tags must never be moved.

## Publish a version

1. Create a branch and make the changes.
2. Run `npm version patch --no-git-tag-version` (or `minor`, `major`, or `prerelease --preid=beta`). This updates both package files. Do not manually edit generated `src/version.ts`.
3. Run `npm ci`, `npm run check`, and `npm pack --dry-run`. For changes to transport or tracking, exercise a browser source against the deployed collector; mocked transport tests cannot verify production delivery or CORS.
4. Open a PR containing the code and version bump, then merge it into `main`.
5. Watch the Publish workflow. It checks the version against the state before the push, validates the lockfile, runs all checks, packs the library, and tests the installed exports with React 18. It publishes the tested tarball, then creates `v<version>` and a GitHub Release at the workflow's exact commit. The tarball is also saved as a workflow artifact.

Pushes without version changes skip publishing. A multi-commit push compares its final version with the version before that push. Versions must increase using semantic version precedence; build metadata is intentionally unsupported. Stable versions use npm's `latest` channel; prereleases use `next`. Keep stable releases ahead of the current `latest` version; publish prereleases on `next` until ready for promotion with a new stable version.

Keep the version unchanged when initially merging this automation: `0.1.0` is already published. The next intended release should bump it, for example to `0.1.1`.

## Failure and recovery

- Before npm publication: fix the issue, then rerun the failed workflow. If the fix changes the commit, use Actions → Publish → Run workflow on `main` to publish its current version explicitly.
- After npm publication: rerun the original workflow. It compares the rebuilt tarball's SHA-512 integrity to the registry and only skips publishing if the contents match, then retries tag/release creation. Existing tags must point to the same commit. Registry and GitHub errors fail the run rather than being treated as missing versions/releases.
- If bytes differ for an existing version, stop and inspect the original run's saved tarball. Do not overwrite or move a release; publish a new version if changes are needed.
- Manual runs are restricted to `main`, validate the package and lockfile, and use the same build and publishing checks. They intentionally allow publishing an unchanged version to recover a failed automatic release.
- Active releases are never cancelled by newer pushes. GitHub concurrency retains only one pending run, so wait for a release to complete before merging another version bump. If a pending release is replaced, use a new version on `main` or rerun its original workflow; intermediate versions in a multi-commit push are not published.

Do not force-push `main` to trigger a release. New-branch and forced-push events are rejected. Version corrections after publication require another version bump; npm versions are immutable.
