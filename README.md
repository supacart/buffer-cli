# Buffer CLI

Tiny unofficial CLI for drafting posts and publishing them to Buffer.

Package: `@supacart/buffer-cli`

Repo: `github.com/supacart/buffer-cli`

## Install

```bash
pnpm add -g @supacart/buffer-cli
```

Then run:

```bash
buffer-cli help
buffer-cli version
```

## What it does

- Saves local drafts in `.social/drafts/`
- Lists connected Buffer channels
- Schedules a post to a Buffer channel
- Publishes a post now

## Setup

1. Generate a Buffer API key in `https://publish.buffer.com/settings/api`
2. Export it:

```bash
export BUFFER_API_KEY=your_api_key_here
```

If you want `list-channels` through Buffer's GraphQL API, also set your organization ID:

```bash
export BUFFER_ORGANIZATION_ID=your_organization_id_here
```

Optional legacy token fallback for older profile listing:

```bash
export BUFFER_ACCESS_TOKEN=your_legacy_access_token
```

## Commands

```bash
buffer-cli help
buffer-cli list-channels --org your_organization_id
buffer-cli draft --text "We just shipped a new client portal." --channel-hint facebook
buffer-cli drafts
buffer-cli schedule --channel your_channel_id --text "Shipping updates this week." --at 2026-03-20T09:00:00Z
buffer-cli publish-now --channel your_channel_id --draft .social/drafts/2026-03-19_some-post.json
```

## Notes

- `draft` is local on purpose. Buffer draft behavior is less stable in the public docs than post creation.
- `list-channels` uses Buffer's GraphQL API when `BUFFER_ORGANIZATION_ID` is available, then falls back to Buffer's legacy profiles endpoint if `BUFFER_ACCESS_TOKEN` is available.
- `schedule` and `publish-now` use Buffer's GraphQL `createPost` mutation pattern.
- For local development in this repo, `pnpm social ...` still works.

## Release Plan

- Start at `0.1.0` while the CLI is still early and changing quickly.
- Use patch releases like `0.1.1` for bug fixes.
- Use minor releases like `0.2.0` for new features or breaking changes while still pre-1.0.
- Move to `1.0.0` when the command surface feels stable enough for others to depend on.

## Publish Setup

This repo includes:

- GitHub Actions CI in `.github/workflows/ci.yml`
- GitHub Actions npm publish workflow in `.github/workflows/publish.yml`

Recommended npm setup:

1. Create the package under the `@supacart` scope.
2. Configure npm trusted publishing for `supacart/buffer-cli` and the workflow file `.github/workflows/publish.yml`.
3. Publish by creating a GitHub release like `v0.1.0`.
