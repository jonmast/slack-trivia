import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

function channelObject(channelId: string) {
  return env.CHANNEL_OBJECT.get(env.CHANNEL_OBJECT.idFromName(channelId))
}

describe('ChannelObject', () => {
  it('echoes the parsed /quizzo arguments', async () => {
    const reply = await channelObject('C123').startQuiz('C123', '3 10s')

    expect(reply.ok).toBe(true)
    expect(reply.text).toBe(
      "Ready: 3 questions with a 10s answer window. (Quiz logic isn't wired up yet.)",
    )
  })

  it('falls back to the default arguments when none are given', async () => {
    const reply = await channelObject('C123').startQuiz('C123', '')

    expect(reply.ok).toBe(true)
    expect(reply.text).toContain('3 questions')
    expect(reply.text).toContain('5s answer window')
  })

  it('returns the parse error for a bad argument', async () => {
    const reply = await channelObject('C123').startQuiz('C123', '3 10')

    expect(reply.ok).toBe(false)
    expect(reply.text).toContain("Seconds must be suffixed with 's'")
  })

  it('records its channel on first use', async () => {
    const channel = channelObject('C999')
    expect(await channel.getChannelId()).toBeNull()

    await channel.startQuiz('C999', '1 5s')

    expect(await channel.getChannelId()).toBe('C999')
  })

  it('keeps one object per channel', async () => {
    await channelObject('CAAA').startQuiz('CAAA', '1 5s')
    await channelObject('CBBB').startQuiz('CBBB', '1 5s')

    expect(await channelObject('CAAA').getChannelId()).toBe('CAAA')
    expect(await channelObject('CBBB').getChannelId()).toBe('CBBB')
  })
})
