/// <reference types="vitest" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const slackClientId = env.SLACK_CLIENT_ID || '';

  return {
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true, // Allow all hosts for development
    open: "/",
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },

  preview: {
    host: "::",
    port: 8080,
    allowedHosts: true, // Allow all hosts for Render preview URLs
  },

  define: {
    'import.meta.env.VITE_SLACK_CLIENT_ID': JSON.stringify(slackClientId),
  },

  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/test/**",
      ],
    },
  },
};
});
