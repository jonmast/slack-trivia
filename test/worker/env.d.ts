import type { D1Migration } from 'cloudflare:test'
import type { Env } from '../../worker/env'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    /** `./migrations`, read by vitest.config.ts and applied before each test file. */
    TEST_MIGRATIONS: D1Migration[]
  }
}
