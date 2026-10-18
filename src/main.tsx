import { isTauri } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { watchTheme } from "./features/settings/theme";
import { watchLanguage } from "./i18n";
import "./index.css";

// Dev-only: lets the MCP plugin read the webview's console and IPC traffic. The DEV check
// is removed from production builds, so the import never reaches them.
if (import.meta.env.DEV && isTauri()) {
  import("tauri-plugin-mcp").then((m) => m.setupPluginListeners());
}

// Before the first render: <html> gets its `dark` class and `lang` right away.
watchTheme();
watchLanguage();

// Dev-only, plain browser (`pnpm dev`): a simulated Rust side. Same DEV check, so neither the
// mock nor @tauri-apps/api/mocks reaches a production build. Installed before the first
// render, so the app's first `invoke`/`listen` already finds it.
const backend =
  import.meta.env.DEV && !isTauri()
    ? import("./lib/ipc.mock").then((m) => m.installMock())
    : Promise.resolve();

backend.then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
