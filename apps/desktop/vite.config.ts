import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "./"),
  plugins: [tailwindcss()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      // Radix ships "use client" directives that are meaningless in this bundle.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
