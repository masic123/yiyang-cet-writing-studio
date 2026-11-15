import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
const releaseDirectory = process.env.CET_RELEASE_DIRECTORY || "storage/vps-release";
await mkdir(releaseDirectory, { recursive: true });
for (const [source, name] of [["start", "server"]]) {
  await build({
    entryPoints: [`server/${source}.ts`],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: `${releaseDirectory}/${name}.mjs`,
    minify: true,
    sourcemap: false,
    logLevel: "info",
  });
}
