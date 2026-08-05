import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  modules: ["workflow/nitro"],
  workflow: {
    dirs: ["server/workflows"],
    runtime: "nodejs22.x",
  },
  vercel: { entryFormat: "node" },
  externals: { external: ["fsevents"] },
  publicAssets: [{ dir: "./dist", baseURL: "/" }],
  routes: {
    "/**": { handler: "./server/index.ts", format: "node" },
  },
});
