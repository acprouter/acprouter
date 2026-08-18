import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Lean, self-contained server build (`.next/standalone`) — the Docker
  // image (Dockerfile) copies only this output plus its traced
  // node_modules subset, instead of the whole monorepo's node_modules
  // tree. See apps/acprouter/README.md "Deploying it for real".
  output: "standalone",
  turbopack: {
    root: monorepoRoot,
  },
  devIndicators: false,
  transpilePackages: ["@acprouter/contract", "@acprouter/core"],
};

export default config;
