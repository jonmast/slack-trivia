// Posts a throwaway "question" with a countdown GIF to a channel so the bar can
// be eyeballed in a real Slack client. Uploads the GIF as a Slack file and
// references it via `slack_file` (no public hosting needed).
//
//   COUNTDOWN_BASE_URL=https://host npx tsx scripts/post-countdown-test.ts C0123456789 20
require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const [channel, secsArg] = process.argv.slice(2);
  const secs = Number(secsArg ?? 20);
  if (!channel) throw new Error("usage: post-countdown-test.ts <channelId> [secs]");

  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  const file = join(__dirname, "..", "assets", "countdown", `${secs}.gif`);

  // COUNTDOWN_BASE_URL=https://host/countdown -> image_url (needs no scopes).
  // Otherwise upload via files.uploadV2 and reference by slack_file (needs files:write).
  let imageBlock: any;
  if (process.env.COUNTDOWN_BASE_URL) {
    const url = `${process.env.COUNTDOWN_BASE_URL}/${secs}.gif?q=${Date.now()}`;
    imageBlock = { type: "image", image_url: url, alt_text: `${secs} second countdown` };
    console.log(`using ${url}`);
  } else {
    const t0 = Date.now();
    const upload = await client.filesUploadV2({
      file: readFileSync(file),
      filename: `countdown-${secs}.gif`,
      title: `${secs}s countdown`,
    });
    const fileId = upload.files?.[0]?.files?.[0]?.id;
    if (!fileId) throw new Error(`upload failed: ${JSON.stringify(upload)}`);
    console.log(`uploaded ${fileId} in ${Date.now() - t0}ms`);
    imageBlock = { type: "image", slack_file: { id: fileId }, alt_text: `${secs} second countdown` };
    throw new Error("context image elements need image_url; set COUNTDOWN_BASE_URL");
  }

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Trivia · Question 1 of 3" } },
    {
      type: "section",
      block_id: "test_q",
      text: { type: "mrkdwn", text: "*Which planet has the most moons?*" },
      accessory: {
        type: "radio_buttons",
        action_id: "radio_sel_test",
        options: ["Jupiter", "Saturn", "Uranus", "Neptune"].map((t) => ({
          value: t.toLowerCase(),
          text: { type: "plain_text", text: t },
        })),
      },
    },
    // Context block: image *element* (no file-preview chrome, immune to auto-collapse).
    {
      type: "context",
      elements: [
        { type: "image", image_url: imageBlock.image_url, alt_text: imageBlock.alt_text },
        { type: "mrkdwn", text: `⏱ ${secs} seconds` },
      ],
    },
  ];

  const t1 = Date.now();
  const post = await client.chat.postMessage({ channel, blocks, text: "countdown test" });
  console.log(`posted ts=${post.ts} at ${new Date(t1).toISOString()} (post took ${Date.now() - t1}ms)`);
  console.log(`bar should hit empty at ${new Date(t1 + secs * 1000).toISOString()}`);

  setTimeout(async () => {
    await client.chat.update({
      channel,
      ts: post.ts,
      text: "time's up",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Trivia · Question 1 of 3" } },
        { type: "section", text: { type: "mrkdwn", text: "*Which planet has the most moons?*\n\n⏰ Time's up — server deadline hit." } },
      ],
    });
    console.log(`updated at ${new Date().toISOString()}`);
  }, secs * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
