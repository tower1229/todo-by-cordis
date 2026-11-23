import { ensureV3ClientAssets } from "../dist/v3/client-bundle-builder.js";

const outDir = await ensureV3ClientAssets({ forceRebuild: true });
console.log(`[v3] Built client assets to ${outDir}`);
