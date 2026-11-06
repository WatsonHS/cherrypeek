import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "./"),
  build: { outDir: "dist/renderer", emptyOutDir: true, sourcemap: false },
});
