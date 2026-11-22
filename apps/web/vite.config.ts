import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.RB_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
