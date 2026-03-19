# Releasing `@supacart/buffer-cli`

This package is published from GitHub Actions using npm trusted publishing.

## 1. Prepare npm

Make sure the `@supacart` scope exists on npm and your npm user can publish under it.

Package name:

```text
@supacart/buffer-cli
```

If the scope does not exist yet, create the npm organization first and add yourself with publish/admin permissions.

## 2. Configure npm trusted publishing

In npm package settings, add a trusted publisher for this package with:

- GitHub organization or user: `supacart`
- Repository: `buffer-cli`
- Workflow filename: `publish.yml`

Important:

- Enter only `publish.yml`, not `.github/workflows/publish.yml`
- The repo must be public for automatic provenance
- The workflow filename is case-sensitive

## 3. First publish

For the first release, use version `0.1.0`.

Why:

- `0.1.0` means early and still changing
- `0.1.1` means bug fix
- `0.2.0` means new feature or breaking change while still pre-1.0
- `1.0.0` means stable contract

## 4. Cut a release

Update the package version when needed:

```bash
cd /Users/thethmuu/buffer-cli
npm version patch
```

Or for a new feature:

```bash
cd /Users/thethmuu/buffer-cli
npm version minor
```

Then push the tag:

```bash
git push origin main --tags
```

Create a GitHub release for the matching tag, for example `v0.1.0`.

The publish workflow runs on `release.published`, so the simplest flow is:

1. push commits to `main`
2. create a GitHub release `v0.1.0`
3. GitHub Actions publishes to npm

## 5. Verify

After publish:

- check the Actions run succeeded
- confirm the package page exists on npm
- test install:

```bash
pnpm add -g @supacart/buffer-cli
buffer-cli version
```

## Notes

- Scoped packages are private by default, so public publishing needs `access: public`
- This repo already sets that via `publishConfig.access`
- Trusted publishing automatically generates provenance for public packages from public repos
