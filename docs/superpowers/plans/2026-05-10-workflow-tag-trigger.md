# Workflow Tag Trigger & Desktop Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate GitHub workflows to tag-based triggers, remove server-agent from desktop packaging, and fix rebrand leftovers.

**Architecture:** Tag push events (`app@*`, `cli@*`) replace branch-push and manual dispatch triggers. Desktop packaging drops server-agent dependency since desktop now serves web-agent statically. CLI publish extracts version from tag and publishes both server-agent and cli-agent to npm `@meshbot` org.

**Tech Stack:** GitHub Actions, pnpm, npm, electron-builder

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `.github/workflows/package-desktop.yml` | Modify | Desktop packaging workflow: tag trigger, path filters, artifact naming |
| `.github/workflows/publish-cli.yml` | Modify | CLI publish workflow: tag trigger, version extraction, dual-package publish |
| `package.json` (root) | Modify | Remove server-agent scripts from build chain |
| `apps/desktop/electron-builder.yml` | Modify | App ID and product name rebrand |
| `apps/cli-agent/package.json` | Modify | CLI binary name rebrand |
| `scripts/prepare-server-agent.mjs` | Delete | Obsolete script (desktop no longer bundles server-agent) |

---

### Task 1: Update Desktop Packaging Workflow

**Files:**
- Modify: `.github/workflows/package-desktop.yml`

- [ ] **Step 1: Change trigger to tag-based, remove server-agent from paths, update artifact name**

Replace the entire file content:

```yaml
name: Package desktop

on:
  push:
    tags:
      - "app@*"

concurrency:
  group: package-desktop-${{ github.ref }}
  cancel-in-progress: true

jobs:
  package:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            pkg: pkg:app
          - os: ubuntu-latest
            pkg: pkg:app
          - os: windows-latest
            pkg: pkg:app

    runs-on: ${{ matrix.os }}
    timeout-minutes: 120

    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm

      - name: Install Linux build deps
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            build-essential \
            python3 \
            libarchive-tools

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Package (${{ matrix.pkg }})
        run: pnpm run ${{ matrix.pkg }}

      - name: Stage distributables (exclude unpacked */
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p upload
          find apps/desktop/release -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' -o -name '*.appimage' -o -name '*.zip' -o -name '*.blockmap' -o -name 'latest*.yml' \) -exec cp {} upload/ ';'
          if [[ ! "$(find upload -type f | head -1)" ]]; then
            echo "No distributable files staged; listing release/:"
            ls -la apps/desktop/release/ || true
            exit 1
          fi
          ls -lh upload/

      - uses: actions/upload-artifact@v7
        with:
          name: meshbot-desktop-${{ matrix.os }}
          path: upload/
          if-no-files-found: error
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/package-desktop.yml
git commit -m "ci: trigger desktop package on app@* tags

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Update CLI Publish Workflow

**Files:**
- Modify: `.github/workflows/publish-cli.yml`

- [ ] **Step 1: Change trigger to tag-based, extract version from tag, publish both packages**

Replace the entire file content:

```yaml
name: Publish CLI

on:
  push:
    tags:
      - "cli@*"

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: "https://registry.npmjs.org"

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      - name: Extract version from tag
        id: version
        run: |
          VERSION="${GITHUB_REF#refs/tags/cli@}"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "Publishing version: $VERSION"

      - name: Publish server-agent
        run: |
          cd apps/server-agent
          npm version ${{ steps.version.outputs.version }} --no-git-tag-version
          pnpm publish --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Publish cli-agent
        run: |
          cd apps/cli-agent
          npm version ${{ steps.version.outputs.version }} --no-git-tag-version
          pnpm publish --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Key changes:
- Trigger: `push: tags: ['cli@*']` instead of `workflow_dispatch`
- Version extracted from tag via `${GITHUB_REF#refs/tags/cli@}`
- `--no-git-tag-version` prevents `npm version` from creating a new tag (tag already exists)
- Removed `git push --follow-tags` (tag already on remote)

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/publish-cli.yml
git commit -m "ci: trigger cli publish on cli@* tags, extract version from tag

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Remove Server-Agent from Desktop Build Chain

**Files:**
- Modify: `package.json` (root)
- Delete: `scripts/prepare-server-agent.mjs`

- [ ] **Step 1: Update root package.json scripts**

Remove these three lines from the `scripts` object:

```json
    "pkg:prepare-server-agent": "node scripts/prepare-server-agent.mjs",
    "pkg:rebuild-server-agent-native": "pnpm --filter @meshbot/desktop exec electron-rebuild -v 41.5.0 -m ../../apps/server-agent/.bundle/pack/srv -o better-sqlite3,bcrypt --build-from-source",
```

And in the `pkg:app` script, remove the `build:server-agent` step. Change:

```json
    "pkg:app": "pnpm run build:types && pnpm run build:common && pnpm run build:types-agent && pnpm run build:shared && pnpm run build:web-agent && pnpm run build:server-agent && pnpm run build:desktop && pnpm --filter @meshbot/desktop run dist",
```

to:

```json
    "pkg:app": "pnpm run build:types && pnpm run build:common && pnpm run build:types-agent && pnpm run build:shared && pnpm run build:web-agent && pnpm run build:desktop && pnpm --filter @meshbot/desktop run dist",
```

- [ ] **Step 2: Delete obsolete script**

```bash
rm scripts/prepare-server-agent.mjs
```

- [ ] **Step 3: Commit**

```bash
git add package.json scripts/prepare-server-agent.mjs
git commit -m "build: remove server-agent from desktop packaging

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Fix Desktop Rebrand Leftovers

**Files:**
- Modify: `apps/desktop/electron-builder.yml`

- [ ] **Step 1: Update appId and productName**

Replace the file content:

```yaml
appId: com.meshbot.desktop
productName: Meshbot
directories:
  output: release
files:
  - dist/**/*
mac:
  target:
    - dmg
win:
  target:
    - nsis
linux:
  target:
    - AppImage
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/electron-builder.yml
git commit -m "chore(desktop): rebrand appId and productName to meshbot

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Fix CLI Binary Name

**Files:**
- Modify: `apps/cli-agent/package.json`

- [ ] **Step 1: Rename bin from anybot to meshbot**

Change:

```json
  "bin": {
    "anybot": "./dist/index.js"
  },
```

to:

```json
  "bin": {
    "meshbot": "./dist/index.js"
  },
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli-agent/package.json
git commit -m "chore(cli-agent): rename binary from anybot to meshbot

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- [x] Desktop packaging triggered by `app@*` tags — Task 1
- [x] CLI publish triggered by `cli@*` tags — Task 2
- [x] Remove server-agent from desktop build chain — Task 3
- [x] Fix electron-builder rebrand leftovers — Task 4
- [x] Fix CLI binary name — Task 5
- [x] Extract version from tag for CLI publish — Task 2 Step 1
- [x] Publish both server-agent and cli-agent on CLI tag — Task 2 Step 1

**Placeholder scan:** All steps contain exact file paths and exact code changes. No TBDs or vague instructions.

**Type consistency:** N/A — this is YAML/JSON config changes, no custom types.
