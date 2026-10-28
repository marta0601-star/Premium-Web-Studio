import { defineConfig } from "vitest/config";
import path from "path";

// Unit tests cover pure logic only (src/lib), so none of the app's Vite plugins
// (React, Tailwind, Replit overlays) are loaded here.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
