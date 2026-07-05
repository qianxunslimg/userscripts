import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/userscripts/",
  publicDir: "scripts",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
