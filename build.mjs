import * as esbuild from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // Loaded from node_modules at runtime: the SDK ships the Claude Code binary, Playwright ships browsers.
  external: ["vscode", "@anthropic-ai/claude-agent-sdk", "playwright", "playwright-core", "@playwright/*"],
};
const ctxs = await Promise.all([
  esbuild.context({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" }),
  esbuild.context({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", banner: { js: "#!/usr/bin/env node" } }),
]);
if (process.argv.includes("--watch")) {
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
}
