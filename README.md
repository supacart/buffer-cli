# Buffer CLI

Terminal-first CLI for drafting posts and publishing them to Buffer.

Package: `@supacart/buffer-cli`

Repo: `github.com/supacart/buffer-cli`

Use it when you want a simple way to:

- draft posts locally
- list your connected Buffer channels
- schedule a post from the terminal
- publish a post immediately

## Install

```bash
pnpm add -g @supacart/buffer-cli
```

Then run:

```bash
buffer help
buffer version
buffer setup
```

## Quick Start

```bash
buffer setup

buffer list-channels
buffer draft --text "We help teams ship software without the usual chaos." --channel-hint facebook
buffer drafts
buffer schedule --channel facebook --draft .social/drafts/your_draft_file.json --at 2026-03-20T09:00:00Z
```

## What it does

- Saves local drafts in `.social/drafts/`
- Lists connected Buffer channels
- Schedules a post to a Buffer channel
- Publishes a post now

## Setup

The easiest way is:

```bash
buffer setup
```

`buffer setup` will:

- detect whether you use `zsh` or `bash`
- ask for your Buffer API key
- ask for your Buffer organization ID
- save them into the right shell profile

If you prefer to set values manually, you can still export them yourself:

```bash
export BUFFER_API_KEY=your_api_key_here
export BUFFER_ORGANIZATION_ID=your_organization_id_here
```

Optional legacy token fallback for older profile listing:

```bash
export BUFFER_ACCESS_TOKEN=your_legacy_access_token
```

## Facebook Example

List your channels and copy the Facebook channel ID:

```bash
buffer list-channels
```

Create a draft:

```bash
buffer draft --text "We help teams ship software without the usual chaos." --channel-hint facebook
```

Schedule the draft:

```bash
buffer schedule \
  --channel facebook \
  --draft .social/drafts/your_draft_file.json \
  --at 2026-03-20T09:00:00Z
```

Facebook posts default to `post`. If you want a different Facebook type, pass:

```bash
buffer publish-now --channel your_facebook_channel_id --text "Behind the scenes" --type story
buffer publish-now --channel your_facebook_channel_id --text "New product demo" --type reel
```

Or publish immediately:

```bash
buffer publish-now \
  --channel facebook \
  --text "We help teams ship software without the usual chaos."
```

## Command Reference

```bash
buffer help
buffer version
buffer setup
buffer list-channels --org your_organization_id
buffer draft --text "We just shipped a new client portal." --channel-hint facebook
buffer drafts
buffer schedule --channel facebook --text "Shipping updates this week." --at 2026-03-20T09:00:00Z [--type post|story|reel]
buffer publish-now --channel facebook --draft .social/drafts/2026-03-19_some-post.json [--type post|story|reel]
```

## Notes

- This is an unofficial Buffer CLI.
- `draft` is local on purpose. Buffer draft behavior is less stable in the public docs than post creation.
- `list-channels` uses Buffer's GraphQL API when `BUFFER_ORGANIZATION_ID` is available, then falls back to Buffer's legacy profiles endpoint if `BUFFER_ACCESS_TOKEN` is available.
- `--channel` accepts either a raw Buffer channel ID or a simple alias like `facebook`, `tiktok`, or `twitter`.
- Facebook publish calls automatically default to `type: post` when the target channel is Facebook.
- `schedule` and `publish-now` use Buffer's GraphQL `createPost` mutation pattern.
- For local development in this repo, `pnpm social ...` still works and now runs the TypeScript source directly.

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
