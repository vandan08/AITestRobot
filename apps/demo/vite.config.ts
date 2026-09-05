import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4000",
      "/__test__": "http://localhost:4000",
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
