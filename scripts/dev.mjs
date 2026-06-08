// scripts/dev.mjs — one command, cross-platform: watch+rebuild the TS client
// (esbuild) AND run the TS server with hot reload (tsx), together.
//
// Why a script and not "esbuild --watch & tsx watch": Windows shells don't run
// '&' as parallel, so we spawn both from Node instead. Type errors still surface
// in your editor (and on `npm run build`, which runs the client typecheck);
// this loop just keeps the bundle and server fresh as you edit.

import { context } from "esbuild";
import { spawn } from "node:child_process";

const ctx = await context({
    entryPoints: ["client/vision-client.ts"],
    bundle: true,
    format: "iife",
    outfile: "public/vision-client.js",
    target: ["es2020"],
    sourcemap: true,
    logLevel: "info",
});
await ctx.watch();
console.log("[client] watching client/vision-client.ts → public/vision-client.js");

const server = spawn("npx", ["tsx", "watch", "src/server.ts"], {
    stdio: "inherit",
    shell: true,
});

const shutdown = () => {
    ctx.dispose();
    if (!server.killed) server.kill();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("exit", (code) => {
    ctx.dispose();
    process.exit(code ?? 0);
});
