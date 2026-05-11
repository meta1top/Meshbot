---
name: Workflow Tag Trigger & Desktop Cleanup
description: Migrate GitHub workflows to tag-based triggers, remove server-agent from desktop packaging, and fix rebrand leftovers.
type: project
---

# Workflow Tag Trigger & Desktop Cleanup

## Background

The project recently rebranded from `@meshbot` to `@meshbot`. Desktop app no longer depends on `server-agent` (it now serves `web-agent` via an embedded static server). The current workflows use branch-push and manual dispatch triggers.

## Goals

1. Trigger desktop packaging on `app@*` tags (e.g. `app@0.0.1`).
2. Trigger CLI publish on `cli@*` tags (e.g. `cli@0.0.1`).
3. Remove `server-agent` from desktop packaging pipeline.
4. Fix remaining rebrand leftovers.

## Changes

### `package-desktop.yml`

- **Trigger**: `push: tags: ['app@*']`
- **Paths**: Remove `apps/server-agent/**`
- **Artifact name**: `meshbot-desktop-*` → `meshbot-desktop-*`

### `publish-cli.yml`

- **Trigger**: `push: tags: ['cli@*']`
- **Version source**: Extract version from tag (`${GITHUB_REF#refs/tags/cli@}`), set it in both `server-agent` and `cli-agent` package.json before publishing
- **Publish order**: `server-agent` first, then `cli-agent`
- **Remove**: `git push --follow-tags` (tag already exists on remote)

### Root `package.json`

- Remove `pkg:prepare-server-agent` script
- Remove `pkg:rebuild-server-agent-native` script
- Remove `build:server-agent` from `pkg:app` build chain

### Other rebrand fixes

- `apps/desktop/electron-builder.yml`: `appId: com.meshbot.desktop`, `productName: Meshbot`
- `apps/cli-agent/package.json`: `bin.meshbot` instead of `bin.meshbot`
- Delete `scripts/prepare-server-agent.mjs` (no longer referenced)
