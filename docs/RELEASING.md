# Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets) and `.github/workflows/release.yml`.

1. Every user-facing PR adds a changeset (`pnpm changeset`).
2. On each push to `main`, the Release workflow opens or updates the **"chore(release): version packages"** PR.
3. Merging that PR (owner only) runs the workflow again, which publishes the bumped packages to npm and creates the git tags.

## npm authentication: trusted publishing

The workflow publishes with **npm trusted publishing (OIDC)**. There is no npm token in the repo: GitHub Actions proves its identity to npm (`id-token: write`), and npm adds provenance automatically. Requirements: Node >= 22.14 and npm >= 11.5.1, both handled in the workflow.

Each published package must have a trusted publisher configured on npmjs.com (package → Settings → Trusted publisher → GitHub Actions):

| Field | Value |
|---|---|
| Organization or user | `mfiumara` |
| Repository | `spice-ts` |
| Workflow filename | `release.yml` |
| Environment | (empty) |

Packages: `@spice-ts/core`, `@spice-ts/mcp`, `@spice-ts/ui`, `@spice-ts/circuit-json`.

A **new** package can't get a trusted publisher before it exists on npm. Publish its first version once by hand (`npm login`, then `pnpm changeset publish` on a clean checkout of the release commit, then push the tags), then configure the trusted publisher.

Long-lived publish tokens no longer work: since npm's 2026 change, even 2FA-bypass tokens can only stage a publish (`E_STAGE_REQUIRED`).

## After a release

- Check every package on npm: `npm view @spice-ts/<pkg> version`.
- Create the GitHub Release from `docs/releases/<version>.md`.
- Run `benchmarks/release/then-vs-now.ts` against the previous npm version for the release notes.
- After the release containing `@spice-ts/core/protocol`, Mattia runs `npm deprecate @spice-ts/protocol "moved to @spice-ts/core/protocol"` with npm 2FA. Leave the already published `@spice-ts/protocol@0.3.0` available; do not unpublish it.
