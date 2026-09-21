import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'
import { defineConfig } from 'vitest/config'

// Wrangler loads a local `.env` as dev vars, and every key the bindings below
// don't happen to override reaches the worker under test: the Node app's `.env`
// holds real Slack credentials. Tests get their env from `miniflare.bindings`.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'

export default defineConfig({
  test: {
    projects: [
      // Pure modules (trivia-core, slack-ui) run in plain node.
      {
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: ['test/*.test.ts'],
        },
      },
      // The channel Durable Object runs in the real Workers runtime.
      defineWorkersProject({
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          // Alarm-driven tests wait out real answer windows.
          testTimeout: 20_000,
          poolOptions: {
            workers: {
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  SLACK_SIGNING_SECRET: 'test-signing-secret',
                  SLACK_BOT_TOKEN: 'xoxb-test-token',
                  // A 1-second results window keeps alarm-driven flow tests
                  // to a few seconds of real time.
                  RESULTS_SECS: '1',
                },
              },
            },
          },
        },
      }),
    ],
  },
})
