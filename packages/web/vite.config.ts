import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env["SDLC_API"] ?? "http://127.0.0.1:7331";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api/events": { target: api.replace(/^http/, "ws"), ws: true },
      "/api": { target: api, changeOrigin: true },
    },
  },
});
