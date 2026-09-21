import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'
import { defineConfig } from 'vitest/config'

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
          poolOptions: {
            workers: {
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  SLACK_SIGNING_SECRET: 'test-signing-secret',
                  SLACK_BOT_TOKEN: 'xoxb-test-token',
                },
              },
            },
          },
        },
      }),
    ],
  },
})
