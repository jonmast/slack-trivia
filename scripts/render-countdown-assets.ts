// Renders the countdown pie GIFs to public/countdown/.
// These are build output served as Workers static assets; never commit them.
//
//   npx tsx scripts/render-countdown-assets.ts    -> public/countdown/1.gif .. 60.gif
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCountdownGif, COUNTDOWN_LEAD_SECS } from "../src/countdown";
import { MAX_TIMEOUT_SECS, RESULTS_SECS } from "../src/trivia-core";

const outDir = join(__dirname, "..", "public", "countdown");
mkdirSync(outDir, { recursive: true });

for (const file of readdirSync(outDir)) {
  if (file.endsWith(".gif")) rmSync(join(outDir, file));
}

const durations = new Set<number>();
for (let secs = 1; secs <= MAX_TIMEOUT_SECS; secs++) durations.add(secs);
durations.add(RESULTS_SECS);

let totalBytes = 0;
for (const secs of [...durations].sort((a, b) => a - b)) {
  const bytes = renderCountdownGif(secs, COUNTDOWN_LEAD_SECS);
  writeFileSync(join(outDir, `${secs}.gif`), bytes);
  totalBytes += bytes.length;
}

console.log(`wrote ${durations.size} countdown GIFs (${(totalBytes / 1024).toFixed(0)} KB) to public/countdown`);