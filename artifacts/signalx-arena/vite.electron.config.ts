// ─── Vite config for Electron desktop build ──────────────────────────────────
// Produces a self-contained static bundle in dist-electron/
// suitable for loading via file:// protocol inside an Electron BrowserWindow.
//
// IMPORTANT: vite-plugin-pwa is intentionally NOT included here.
// Service Worker registration throws under the file:// protocol (insecure
// context), which aborts the entry module and produces a blank window.
// The PWA stays enabled in the regular web build (vite.config.ts).

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  // Relative base so all assets work with file:// protocol
  base: "./",

  plugins: [
    react(),
    tailwindcss(),
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
