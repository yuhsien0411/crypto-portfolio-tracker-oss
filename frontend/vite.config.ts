import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // Source maps off in production builds — we don't want to ship readable
    // source to every visitor. Set VITE_SOURCEMAP=1 locally to debug a build.
    sourcemap: process.env.VITE_SOURCEMAP === "1",
  },
});
