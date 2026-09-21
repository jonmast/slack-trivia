import { DurableObject } from "cloudflare:workers";
import { parseQuizzoArgs } from "../src/trivia-core";
import type { Env } from "./env";

export type StartQuizResult = { ok: boolean; text: string };

/**
 * One Durable Object per Slack channel, addressed by `idFromName(channelId)`.
 * It owns everything that channel's quizzes need; for now it only echoes the
 * parsed `/quizzo` arguments back for the ephemeral reply.
 */
export class ChannelObject extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // No request is served until the schema exists.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const { version } = this.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM migrations",
      )
      .one();

    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE channel (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          channel_id TEXT NOT NULL
        );
        INSERT INTO migrations (id) VALUES (1);
      `);
    }
  }

  /**
   * Start a channel quiz. Stub: parses the `/quizzo` arguments and returns the
   * ephemeral text the Worker sends back through `response_url`.
   */
  startQuiz(channelId: string, text: string): StartQuizResult {
    this.rememberChannel(channelId);

    const parsed = parseQuizzoArgs(text);
    if (!parsed.ok) {
      return { ok: false, text: parsed.error };
    }

    const { numQuestions, timeoutSecs } = parsed.args;
    const questions = `${numQuestions} question${numQuestions === 1 ? "" : "s"}`;
    return {
      ok: true,
      text: `Ready: ${questions} with a ${timeoutSecs}s answer window. (Quiz logic isn't wired up yet.)`,
    };
  }

  /** The channel this object belongs to, or null before its first use. */
  getChannelId(): string | null {
    const row = this.sql
      .exec<{ channel_id: string }>("SELECT channel_id FROM channel WHERE id = 1")
      .toArray()[0];
    return row?.channel_id ?? null;
  }

  // The object is addressed by a hash of the channel ID, so it can only learn
  // which channel that is from the first request that reaches it.
  private rememberChannel(channelId: string): void {
    this.sql.exec(
      "INSERT INTO channel (id, channel_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING",
      channelId,
    );
  }
}
