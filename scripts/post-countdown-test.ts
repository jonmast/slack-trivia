// Posts a throwaway "question" with a countdown GIF to a channel so the bar can
// be eyeballed in a real Slack client. The GIF is served from the Worker's
// static assets and referenced by `image_url`, so a public base URL is required.
//
//   npx tsx scripts/post-countdown-test.ts C0123456789 https://trivia.example.com 20
require("dotenv").config();
const { WebClient } = require("@slack/web-api");

async function main() {
  const [channel, baseUrl, secsArg] = process.argv.slice(2);
  const secs = Number(secsArg ?? 20);
  if (!channel || !baseUrl) throw new Error("usage: post-countdown-test.ts <channelId> <baseUrl> [secs]");

  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  const url = `${baseUrl.replace(/\/$/, "")}/countdown/${secs}.gif?q=${Date.now()}`;
  const imageBlock = { type: "image", image_url: url, alt_text: `${secs} second countdown` };
  console.log(`using ${url}`);

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
