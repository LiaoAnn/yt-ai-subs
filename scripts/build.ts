// Builds the unpacked extension into dist/.
//
//   node scripts/build.ts           one-off production build
//   node scripts/build.ts --watch   rebuild on change (development)
//
// Chrome loads each entry point differently, so each gets its own Vite build:
//   popup.html  React page                    -> normal Vite HTML build (vite.config.ts)
//   background  service worker                -> ES module ("type": "module" in the manifest)
//   content     content script, isolated world -> single classic script (IIFE)
//   page        MAIN world, document_start    -> single classic script (IIFE)
// Content scripts cannot be ES modules, and the page script must run synchronously at
// document_start (before YouTube's player code), so both are bundled into one file
// with no imports or chunks.
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, type InlineConfig } from "vite";

const watch = process.argv.includes("--watch");
const mode = watch ? "development" : "production";
const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const outDir = r("../dist");

function scriptEntry(name: string, format: "es" | "iife"): InlineConfig {
  return {
    configFile: false,
    mode,
    root: r(".."),
    publicDir: false,
    resolve: { alias: { "@": r("../src") } },
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: !watch,
      sourcemap: watch ? "inline" : false,
      watch: watch ? {} : null,
      rolldownOptions: {
        input: { [name]: r(`../src/${name}/index.ts`) },
        output: {
          format,
          entryFileNames: `${name}.js`,
          // A classic script must be one file; refuse to split it into chunks.
          ...(format === "iife" ? { codeSplitting: false } : {}),
        },
      },
    },
  };
}

const configs: InlineConfig[] = [
  {
    configFile: r("../vite.config.ts"),
    mode,
    build: {
      minify: !watch,
      sourcemap: watch ? "inline" : false,
      watch: watch ? {} : null,
    },
  },
  scriptEntry("background", "es"),
  scriptEntry("content", "iife"),
  scriptEntry("page", "iife"),
];

// Each build writes its own files into the shared dist/, so empty it once up front
// instead of letting a (re)build wipe the others' output.
await rm(outDir, { recursive: true, force: true });
await Promise.all(configs.map((config) => build(config)));
