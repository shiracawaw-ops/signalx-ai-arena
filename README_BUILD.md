# Building SignalX AI Arena — Windows EXE

## Overview

The production build produces two Windows artefacts (via electron-builder):

| Artefact | File | Use |
|----------|------|-----|
| NSIS Installer | `SignalX-AI-Arena-<version>-Setup.exe` | End-user install |
| Portable | `SignalX-AI-Arena-<version>-Portable.exe` | Run without installing |

Both are placed in `artifacts/electron/dist-app/` after a successful build.

---

## Building Locally (Windows)

### Prerequisites

- Node.js 22+
- pnpm 10+ (`npm install -g pnpm@latest`)
- Windows 10/11 x64 (cross-compilation from Linux/macOS requires Wine — not covered here)

### Option A — Batch script (easiest)

Double-click **`build-and-package.bat`** in the repo root, or run from a plain Command Prompt:

```bat
build-and-package.bat
```

The script runs all steps automatically and prints the output path on success.

### Option B — Manual steps

```bash
# 1. Install dependencies
pnpm install --frozen-lockfile

# 2. Build the frontend (Electron mode) + API server bundle
pnpm run build:electron

# 3. Package for Windows
npx electron-builder --win --config electron-builder.yml
```

Output: `artifacts/electron/dist-app/`

---

## Build Pipeline Explained

```
pnpm run build:electron
    └─ pnpm --filter @workspace/signalx-arena run build:electron
    │     └─ vite build --config vite.electron.config.ts
    │           → artifacts/signalx-arena/dist-electron/
    └─ pnpm --filter @workspace/api-server run build
          → artifacts/api-server/dist/

electron-builder --win
    └─ packages electron/main.js + electron/preload.js  (main process)
    └─ bundles  artifacts/signalx-arena/dist-electron/  → resources/frontend/
    └─ bundles  artifacts/api-server/dist/              → resources/api-server/dist/
    └─ produces artifacts/electron/dist-app/
```

---

## Building via GitHub Actions (CI)

> **Note:** The `.github/workflows/` file cannot be pushed via the Replit GitHub connector due to connector security restrictions. You must add it manually through the GitHub web UI.

### Step-by-step

1. Go to your repository: **https://github.com/shiracawaw-ops/signalx-ai-arena**
2. Click **Actions** → **New workflow** → **set up a workflow yourself**
3. Name the file `.github/workflows/electron-build.yml`
4. Paste the workflow content below and commit it.

### Workflow file content

```yaml
name: Build Windows EXE

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build-windows:
    runs-on: windows-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install pnpm
        run: npm install -g pnpm@latest

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build Electron app
        run: pnpm run build:electron

      - name: Package Windows installer
        run: npx electron-builder --win --config electron-builder.yml
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload artefacts
        uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: artifacts/electron/dist-app/*.exe
          retention-days: 14
```

5. After committing, the workflow will trigger on every push to `main` and produce downloadable `.exe` artefacts in the **Actions** tab.

---

## Electron Builder Config Reference

The full configuration lives in **`electron-builder.yml`** at the repo root. Key paths:

| Key | Value | Meaning |
|-----|-------|---------|
| `directories.output` | `artifacts/electron/dist-app` | Where installers are written |
| `extraResources[0].from` | `artifacts/signalx-arena/dist-electron` | Bundled frontend |
| `extraResources[1].from` | `artifacts/api-server/dist` | Bundled API server |
| `win.target` | `nsis`, `portable` | Both installer types built |
