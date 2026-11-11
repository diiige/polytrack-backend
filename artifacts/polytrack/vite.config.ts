import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { communityTrackImports } from "./community-track-imports.js";
import {
  patchPolytrackMainBundle,
  patchPolytrackProfileSettingsBundle,
} from "./main-bundle-startup-patch.js";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

function patchPolytrackStartup() {
  const sourcePath = path.resolve(import.meta.dirname, "public/main.bundle.js");
  const patchedBundle = patchPolytrackMainBundle(
    readFileSync(sourcePath, "utf8"),
  );
  const profileSettingsPath = path.resolve(
    import.meta.dirname,
    "public/280.bundle.js",
  );
  const patchedProfileSettingsBundle = patchPolytrackProfileSettingsBundle(
    readFileSync(profileSettingsPath, "utf8"),
  );
  const siteFeaturesPath = path.resolve(
    import.meta.dirname,
    "public/site-features.js",
  );
  const weeklyTrackPool = communityTrackImports.map(
    ({ id, name, author, assetFile }) => ({
      id,
      name,
      author,
      thumbnail: `main/tracks/community/thumbnails/${assetFile.replace(/\.track$/, ".png")}`,
    }),
  );
  const patchedSiteFeaturesBundle =
    `window.__polytrackWeeklyTrackPool = Object.freeze(${JSON.stringify(weeklyTrackPool)});\n` +
    readFileSync(siteFeaturesPath, "utf8");
  const patchedBundles = new Map([
    ["main.bundle.js", patchedBundle],
    ["280.bundle.js", patchedProfileSettingsBundle],
    ["site-features.js", patchedSiteFeaturesBundle],
  ]);

  return {
    name: "polytrack-bundle-patches",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const entry = [...patchedBundles].find(([filename]) =>
          pathname.endsWith(`/${filename}`),
        );
        if (!entry) return next();
        const [, bundle] = entry;

        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Length", Buffer.byteLength(bundle));
        response.end(bundle);
      });
    },
    writeBundle(output) {
      const outputDirectory =
        output.dir ?? path.resolve(import.meta.dirname, "dist/public");
      for (const [filename, bundle] of patchedBundles) {
        const outputPath = path.resolve(outputDirectory, filename);
        if (!existsSync(outputPath)) {
          throw new Error(`Expected Polytrack bundle at ${outputPath}`);
        }
        writeFileSync(outputPath, bundle);
      }
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    patchPolytrackStartup(),
    react(),
    tailwindcss(),
    ...(false ? [runtimeErrorOverlay()] : []),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
