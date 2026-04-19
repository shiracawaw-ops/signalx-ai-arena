# SignalX AI Arena

  > AI-powered virtual trading simulator with 12 exchange integrations

  ## Features
  - 12 exchange adapters (Binance, Coinbase, Kraken, OKX, Bybit, KuCoin, Bitfinex, MEXC, Gate.io, HTX, Bitget, Deribit)
  - AutoPilot trading engine with risk management
  - Demo & Live modes with safety arm
  - Electron desktop app (Windows EXE via GitHub Actions)

  ## Quick Start (Web)
  ```bash
  pnpm install
  pnpm --filter @workspace/api-server run dev &
  pnpm --filter @workspace/signalx-arena run dev
  ```

  ## Build Windows EXE
  Push to `main` branch → GitHub Actions automatically builds `dist-electron/*.exe`

  ## Demo Login
  - demo@signalx.ai / demo123
  - admin@signalx.ai / admin123
  