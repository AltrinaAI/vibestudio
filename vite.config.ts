import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Vite config for the Tauri frontend. `@` -> ./src.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Tauri expects a fixed dev server.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The browser dev UI talks to the backend (skill-server) purely over HTTP —
    // identical to the remote/separated deployment. Point VITE_API_TARGET at a
    // backend on another machine for the VS Code-remote-style split.
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
    watch: {
      // Don't watch the Rust crate from Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Build for the WebKit/WebView2 engines Tauri ships.
  build: {
    target: ["es2022", "chrome110", "safari15"],
    sourcemap: false,
  },
});
