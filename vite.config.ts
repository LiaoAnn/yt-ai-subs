// Vite config for the popup (React + Tailwind + shadcn/ui).
// The other entry points (background, content, page) are built by scripts/build.ts,
// which reuses this file for the popup; `vite build` alone builds only the popup.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: r("./src/popup"),
  base: "./",
  publicDir: r("./public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": r("./src") },
  },
  build: {
    outDir: r("./dist"),
    emptyOutDir: false,
    rolldownOptions: {
      input: r("./src/popup/popup.html"),
    },
  },
});
