import type { Env } from '../../worker/env'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
