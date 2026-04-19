// ─── Vite config for Electron desktop build ──────────────────────────────────
// Produces a self-contained static bundle in dist-electron/frontend/
// suitable for loading via file:// protocol inside an Electron BrowserWindow.
// Run with:
//   PORT=1 BASE_PATH="./" pnpm --filter @workspace/signalx-arena build:electron

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base so all assets work with file:// protocol
  base: "./",

  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      base: "./",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "SignalX AI Arena",
        short_name: "SignalX",
        description: "AI-powered virtual trading simulator",
        theme_color: "#09090b",
        background_color: "#09090b",
        display: "standalone",
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        navigateFallback: null,
      },
      devOptions: { enabled: false },
    }),
  ],

  // Inject the Electron flag so api-client can detect runtime env
  define: {
    "import.meta.env.VITE_IS_ELECTRON": JSON.stringify("true"),
    "import.meta.env.VITE_ELECTRON_API_PORT": JSON.stringify("18080"),
  },

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },

  root: path.resolve(import.meta.dirname),

  build: {
    outDir:     path.resolve(import.meta.dirname, "dist-electron"),
    emptyOutDir: true,
    // Chunk size warning threshold (electron bundles can be larger)
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:   ["react", "react-dom"],
          ui:       ["@radix-ui/react-dialog", "@radix-ui/react-tabs"],
          charts:   ["recharts"],
          motion:   ["framer-motion"],
        },
      },
    },
  },
});
