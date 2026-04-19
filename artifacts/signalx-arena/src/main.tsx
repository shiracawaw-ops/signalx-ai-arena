import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// ─── Renderer error overlay ───────────────────────────────────────────────────
// Guarantees that a JS crash in the renderer is never invisible.
// In packaged Electron builds DevTools are closed, so a silent throw would
// otherwise produce a blank black window with no diagnostics.

function showFatalError(label: string, err: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;

  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}\n\n${err.stack ?? ""}`
      : String(err);

  root.innerHTML = `
    <div style="
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #09090b;
      color: #fca5a5;
      padding: 24px;
      min-height: 100vh;
      box-sizing: border-box;
      overflow: auto;
    ">
      <h1 style="color:#ef4444;font-size:18px;margin:0 0 12px;">
        SignalX — Renderer Error (${label})
      </h1>
      <p style="color:#a1a1aa;margin:0 0 16px;font-size:13px;">
        The app failed to load. Please report this with a screenshot.
      </p>
      <pre style="
        background:#18181b;
        border:1px solid #27272a;
        border-radius:6px;
        padding:14px;
        font-size:12px;
        white-space:pre-wrap;
        word-break:break-word;
        color:#fecaca;
      ">${message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  showFatalError("window.onerror", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showFatalError("unhandledrejection", event.reason);
});

try {
  const container = document.getElementById("root");
  if (!container) {
    throw new Error('Root element "#root" not found in index.html');
  }
  createRoot(container).render(<App />);
} catch (err) {
  showFatalError("mount", err);
}
