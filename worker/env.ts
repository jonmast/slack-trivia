import type { SlackEdgeAppEnv } from "slack-cloudflare-workers";
import type { ChannelObject } from "./channel-object";

export type Env = SlackEdgeAppEnv & {
  CHANNEL_OBJECT: DurableObjectNamespace<ChannelObject>;
  ASSETS: Fetcher;
  /** Every screening verdict, shared by all channels. */
  DB: D1Database;
  /** OpenCode Console API key for Jev; questions go unscreened without it. */
  OPENCODE_API_KEY?: string;
  /**
   * How long results stay up before the next question, in seconds. Unset in
   * production; tests shorten it so a whole quiz runs in a few seconds.
   */
  RESULTS_SECS?: string;
  /** How long the ready screen stays up, in seconds; shortened like `RESULTS_SECS`. */
  READY_SECS?: string;
  /** How long screening waits on Jev, in milliseconds; shortened like `RESULTS_SECS`. */
  JEV_TIMEOUT_MS?: string;
  /** How long an extended ready screen lasts, in seconds; shortened like `RESULTS_SECS`. */
  EXTENDED_READY_SECS?: string;
};
