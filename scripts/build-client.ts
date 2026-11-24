import { ensureClientAssets } from "../src/runtime/client/bundle-builder.js";

const outDir = await ensureClientAssets({ force: true });
console.log(`[host] Built client assets to ${outDir}`);
