import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The bridge (Podium engine + REST/WS) runs on :8787.
// Vite dev server proxies /api and /ws to it so the browser talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
