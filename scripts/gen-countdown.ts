// Writes countdown pie GIFs to assets/countdown/ for eyeballing outside Slack.
// The app renders these on demand (src/countdown.ts); nothing here ships.
//
//   npx tsx scripts/gen-countdown.ts 20        -> assets/countdown/20.gif
//   npx tsx scripts/gen-countdown.ts all       -> 1..60
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCountdownGif, COUNTDOWN_LEAD_SECS } from "../src/countdown";

const arg = process.argv[2] ?? "all";
const outDir = join(__dirname, "..", "assets", "countdown");
mkdirSync(outDir, { recursive: true });

const list = arg === "all" ? Array.from({ length: 60 }, (_, i) => i + 1) : [Number(arg)];
for (const secs of list) {
  if (!Number.isInteger(secs) || secs < 1) throw new Error(`bad seconds: ${arg}`);
  const bytes = renderCountdownGif(secs, COUNTDOWN_LEAD_SECS);
  const file = join(outDir, `${secs}.gif`);
  writeFileSync(file, bytes);
  console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KB`);
}
