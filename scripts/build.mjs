import { build } from "esbuild";
import { mkdir, cp, readdir } from "node:fs/promises";
await mkdir("dist/public", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/web/main.tsx"],
    bundle: true,
    outfile: "dist/public/app.js",
    minify: true,
    sourcemap: true,
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["src/server/index.ts"],
    outfile: "dist/server/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
  }),
  build({
    entryPoints: (await readdir("tests"))
      .filter((n) => n.endsWith(".test.ts"))
      .map((n) => `tests/${n}`),
    outdir: "dist/tests",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
  }),
  cp("public", "dist/public", { recursive: true }),
]);
