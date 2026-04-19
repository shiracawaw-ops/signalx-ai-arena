# Running SignalX AI Arena Locally

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22+ | https://nodejs.org |
| pnpm | 10+ | `npm install -g pnpm@latest` |

## Quick Start — Electron Desktop (3 commands)

This is the primary way to run the app as a full desktop client:

```bash
# 1. Install all dependencies
pnpm install

# 2. Build the frontend (Electron mode) and the API server bundle
pnpm run build:electron

# 3. Launch the Electron shell
npx electron .
```

Electron starts the embedded API server on port **18080** automatically and
opens the app window. No separate terminal is needed.

---

## Alternative — Browser Dev Mode (hot-reload)

Use this when iterating on UI or API code (changes rebuild on save):

```bash
# Terminal 1 — API server (stays running)
pnpm --filter @workspace/api-server run dev

# Terminal 2 — Vite frontend
BASE_PATH=/ pnpm --filter @workspace/signalx-arena run dev
```

Open the URL printed by Vite (typically **http://localhost:5173**) in your browser.

---

## Environment Variables

Copy `.env.example` to `.env` in the repo root. Minimum required values:

```dotenv
PORT=8080
BASE_PATH=/
NODE_ENV=development
```

See `.env.example` for the full list with descriptions.

> **Note:** `BASE_PATH` is required by the Vite frontend build and throws an
> error at build time if unset. In the Electron flow (`build:electron`) this
> is handled by `vite.electron.config.ts`; when running the browser dev server
> directly you must set it yourself (e.g. `BASE_PATH=/`).

---

## Port Map

| Service | Port | Notes |
|---------|------|-------|
| Vite frontend (dev) | 5173 | Browser dev mode only |
| Express API server (dev) | 8080 | Configured via `PORT` env var |
| Electron embedded API | 18080 | Hardcoded in `electron/main.js` |

---

## Troubleshooting

### Port already in use

```
Error: listen EADDRINUSE :::8080
```

Kill the existing process and restart:

```bash
# macOS / Linux
lsof -ti:8080 | xargs kill

# Windows (PowerShell)
netstat -ano | findstr :8080
taskkill /PID <PID> /F
```

Or change the API port by setting `PORT=8081` in `.env`.

---

### Missing BASE_PATH (Vite build error)

```
BASE_PATH environment variable is required but was not provided.
```

Add `BASE_PATH=/` to your `.env` file (or prefix the command with
`BASE_PATH=/ pnpm ...`).

---

### Electron not found

```
'electron' is not recognized as an internal or external command
```

Run `pnpm install` from the repo root to install the `electron` devDependency,
then use `npx electron .` instead of a bare `electron` command.
