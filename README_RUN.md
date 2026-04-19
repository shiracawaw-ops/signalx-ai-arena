# Running SignalX AI Arena Locally

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22+ | https://nodejs.org |
| pnpm | 10+ | `npm install -g pnpm@latest` |

## Quick Start (3 commands)

```bash
# 1. Install all dependencies
pnpm install

# 2. Start the API server (keep this terminal open)
pnpm --filter @workspace/api-server run dev

# 3. In a second terminal, start the web frontend
pnpm --filter @workspace/signalx-arena run dev
```

Open **http://localhost:5173** (or the URL printed in the terminal) in your browser.

## Port Map

| Service | Default Port | Environment Variable |
|---------|-------------|----------------------|
| Vite frontend (dev) | 5173 | `PORT` (set by Vite) |
| Express API server | 8080 | `PORT` |
| Electron embedded API | 18080 | `ELECTRON_API_PORT` |

## Environment Variables

Copy `.env.example` to `.env` in the repo root and set at minimum:

```
SESSION_SECRET=any_long_random_string
NODE_ENV=development
```

See `.env.example` for the full list with descriptions.

## Running the Electron Shell (desktop)

```bash
# Build the frontend in Electron mode first
pnpm run build:electron

# Launch Electron (dev — loads the built frontend)
npx electron .
```

The Electron shell starts the API server automatically on port 18080 and opens the app window.

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

Or change the port by setting `PORT=8081` in `.env`.

---

### Missing SESSION_SECRET / env var not found

The API server will log a warning and may refuse to start. Make sure:

1. `.env` exists at the **repo root** (not inside `artifacts/`).
2. `SESSION_SECRET` is set to any non-empty string for local development.

---

### Electron not found

```
'electron' is not recognized as an internal or external command
```

Run `pnpm install` from the repo root to install the local `electron` devDependency, then use `npx electron .` instead of a global `electron` command.
