import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * GitHub Pages serves this app from a subpath (https://<user>.github.io/<repo>/),
 * so `base` must match the repository name. Set VITE_BASE_PATH=/ in .env when
 * deploying to a custom domain or when running the dev server locally.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    base: env.VITE_BASE_PATH || "/word-refinery/",
    plugins: [react()],
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
