import { describe, expect, test } from 'bun:test'

import type { SendDocumentOpts, SendMessageOpts, TelegramApi } from '../../src/channel/tools.js'
import { createQueuedTelegramApi, retryAfterMs } from '../../src/telegram/send-queue.js'

// Fake clock: sleep advances virtual time instantly so tests never wait.
function makeClock() {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms)
      clock.t += ms
    },
  }
  return clock
}

interface Call {
  method: string
  chatId: string
  arg: string
  at: number
}

function makeApi(clock: { now: () => number }, failures: Record<string, unknown[]> = {}) {
  const calls: Call[] = []
  let nextId = 100
  const record = (method: string, chatId: string, arg: string) => {
    calls.push({ method, chatId, arg, at: clock.now() })
    const queue = failures[arg]
    if (queue && queue.length > 0) throw queue.shift()
    return { message_id: nextId++ }
  }
  const api: TelegramApi = {
    sendMessage: async (chatId: string, text: string, _o: SendMessageOpts) => record('sendMessage', chatId, text),
    sendDocument: async (chatId: string, p: string, _o: SendDocumentOpts) => record('sendDocument', chatId, p),
    sendPhoto: async (chatId: string, p: string, _o: SendDocumentOpts) => record('sendPhoto', chatId, p),
    sendVideo: async (chatId: string, p: string, _o: SendDocumentOpts) => record('sendVideo', chatId, p),
    editMessageText: async () => {},
    setMessageReaction: async () => {},
    sendChatAction: async () => {},
    deleteMessage: async () => {},
    downloadFile: async () => ({ path: '/tmp/x' }),
  }
  return { api, calls }
}

function tooMany(retryAfter: number) {
  return Object.assign(new Error(`Call to 'sendMessage' failed! (429: Too Many Requests: retry after ${retryAfter})`), {
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  })
}

describe('retryAfterMs', () => {
  test('reads parameters.retry_after from a 429', () => {
    expect(retryAfterMs(tooMany(7))).toBe(7000)
  })

  test('falls back to parsing the description', () => {
    expect(retryAfterMs({ error_code: 429, description: 'Too Many Requests: retry after 12' })).toBe(12_000)
  })

  test('returns undefined for non-429 errors', () => {
    expect(retryAfterMs({ error_code: 400, description: "Bad Request: can't parse entities" })).toBeUndefined()
    expect(retryAfterMs(new Error('network down'))).toBeUndefined()
    expect(retryAfterMs(null)).toBeUndefined()
  })
})

describe('createQueuedTelegramApi', () => {
  test('sends to one chat strictly in order with >= 1200ms gap', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock)
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    // Fire all at once, as a burst from the agent would.
    const results = await Promise.all([
      q.sendMessage('1', 'a', {}),
      q.sendMessage('1', 'b', {}),
      q.sendDocument('1', 'c.pdf', {}),
      q.sendMessage('1', 'd', {}),
    ])

    expect(calls.map(c => c.arg)).toEqual(['a', 'b', 'c.pdf', 'd'])
    expect(results.map(r => r.message_id)).toEqual([100, 101, 102, 103])
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(1200)
    }
    // The very first send goes out immediately.
    expect(calls[0]!.at).toBe(0)
  })

  test('different chats do not wait for each other', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock)
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    await Promise.all([q.sendMessage('1', 'a', {}), q.sendMessage('2', 'b', {})])

    expect(calls.map(c => c.at)).toEqual([0, 0])
    expect(clock.sleeps).toEqual([])
  })

  test('on 429 waits retry_after and resends the same message', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock, { a: [tooMany(5)] })
    const warns: Record<string, unknown>[] = []
    const log = { debug() {}, info() {}, error() {}, warn: (_m: string, ctx?: Record<string, unknown>) => void warns.push(ctx ?? {}) }
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep, log })

    const [first, second] = await Promise.all([q.sendMessage('1', 'a', {}), q.sendMessage('1', 'b', {})])

    expect(calls.map(c => c.arg)).toEqual(['a', 'a', 'b'])
    expect(calls[1]!.at - calls[0]!.at).toBe(5000)
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(1200)
    expect(first.message_id).toBe(100)
    expect(second.message_id).toBe(101)
    expect(warns).toHaveLength(1)
    expect(warns[0]!.retry_after_ms).toBe(5000)
  })

  test('long flood ban (retry_after 600s) is waited out, not dropped', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock, { a: [tooMany(600)] })
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep, maxWaitMs: 1e9 })

    const out = await q.sendMessage('1', 'a', {})

    expect(out.message_id).toBe(100)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.at).toBe(600_000)
  })

  test('a flood ban longer than maxWaitMs is rethrown at once, not slept through', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock, { a: [tooMany(600)] })
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    await expect(q.sendMessage('1', 'a', {})).rejects.toMatchObject({ error_code: 429 })
    expect(calls).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  test('gives up after maxAttempts 429s and rethrows', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock, { a: [tooMany(1), tooMany(1), tooMany(1)] })
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep, maxAttempts: 3 })

    await expect(q.sendMessage('1', 'a', {})).rejects.toMatchObject({ error_code: 429 })
    expect(calls).toHaveLength(3)
  })

  test('non-429 errors are rethrown immediately and the queue keeps working', async () => {
    const clock = makeClock()
    const parseErr = Object.assign(new Error('bad html'), { error_code: 400 })
    const { api, calls } = makeApi(clock, { a: [parseErr] })
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    const a = q.sendMessage('1', 'a', {})
    const b = q.sendMessage('1', 'b', {})
    await expect(a).rejects.toBe(parseErr)
    expect((await b).message_id).toBe(100)
    expect(calls.map(c => c.arg)).toEqual(['a', 'b'])
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1200)
  })

  test('a late send after a quiet period goes out without extra delay', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock)
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    await q.sendMessage('1', 'a', {})
    clock.t += 10_000
    await q.sendMessage('1', 'b', {})

    expect(calls[1]!.at).toBe(10_000)
    expect(clock.sleeps).toEqual([])
  })

  test('non-send methods pass through unqueued', async () => {
    const clock = makeClock()
    const { api } = makeApi(clock)
    let edits = 0
    api.editMessageText = async () => {
      edits++
    }
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    await q.sendMessage('1', 'a', {})
    await q.editMessageText('1', 100, 'x', {})
    await q.editMessageText('1', 100, 'y', {})

    expect(edits).toBe(2)
    expect(clock.sleeps).toEqual([])
  })

  test('sendVideo also creates a message: queued and retried on 429, not dropped', async () => {
    const clock = makeClock()
    const { api, calls } = makeApi(clock, { '/v.mp4': [tooMany(3)] })
    const q = createQueuedTelegramApi(api, { now: clock.now, sleep: clock.sleep })

    const [text, video] = await Promise.all([
      q.sendMessage('1', 'before', {}),
      q.sendVideo('1', '/v.mp4', {}),
    ])
    expect(text.message_id).toBeGreaterThan(0)
    expect(video.message_id).toBeGreaterThan(0)
    const videoCalls = calls.filter((c) => c.method === 'sendVideo')
    expect(videoCalls.length).toBe(2)
    // Waited the gap after the text message, then retry_after after the 429.
    expect(videoCalls[0]!.at).toBeGreaterThanOrEqual(1200)
    expect(videoCalls[1]!.at - videoCalls[0]!.at).toBeGreaterThanOrEqual(3000)
  })
})
