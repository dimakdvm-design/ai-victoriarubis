// Per-chat outbound queue for Telegram.
//
// Telegram allows roughly one message per second per chat; bursts get
// answered with 429 Too Many Requests and, if repeated, a flood ban of
// several minutes. This wrapper serialises every message-creating call
// (sendMessage / sendDocument / sendPhoto / sendVideo) per chat, keeps a minimum gap
// between them, and on 429 waits `retry_after` seconds and retries the same
// call so the message is never dropped.
//
// Other calls (edits, reactions, chat actions, deletes, downloads) pass
// through untouched: they do not create messages and the status/progress
// layers already throttle and tolerate their failures.

import type { TelegramApi } from '../channel/tools.js'
import type { Logger } from '../log.js'

export const DEFAULT_MIN_INTERVAL_MS = 1200
export const DEFAULT_MAX_ATTEMPTS = 5
// A tool call must not hang the agent for the length of a flood ban: waits longer
// than this are not slept through, the 429 is rethrown so the caller can switch channel.
export const DEFAULT_MAX_WAIT_MS = 120_000

export interface SendQueueOptions {
  minIntervalMs?: number
  // Total attempts per call including the first one. 429s past this limit
  // are rethrown so a permanently blocked bot does not hang forever.
  maxAttempts?: number
  maxWaitMs?: number
  log?: Logger
  // Injectable for tests.
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface Lane {
  tail: Promise<void>
  nextAt: number
}

// Returns the wait in ms if `err` is a Telegram 429, otherwise undefined.
// grammY's GrammyError carries `error_code` and `parameters.retry_after`;
// we check structurally so tests and other clients work too. Falls back to
// parsing "retry after N" from the description.
export function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as {
    error_code?: unknown
    parameters?: { retry_after?: unknown }
    description?: unknown
    message?: unknown
  }
  if (e.error_code !== 429) return undefined
  const fromParams = e.parameters?.retry_after
  if (typeof fromParams === 'number' && fromParams >= 0) return fromParams * 1000
  const text = `${typeof e.description === 'string' ? e.description : ''} ${typeof e.message === 'string' ? e.message : ''}`
  const m = /retry after (\d+)/i.exec(text)
  if (m) return Number(m[1]) * 1000
  // 429 without a hint: back off for one second.
  return 1000
}

export function createQueuedTelegramApi(inner: TelegramApi, opts: SendQueueOptions = {}): TelegramApi {
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const log = opts.log
  const lanes = new Map<string, Lane>()

  function enqueue<T>(chatId: string, method: string, task: () => Promise<T>): Promise<T> {
    let lane = lanes.get(chatId)
    if (!lane) {
      lane = { tail: Promise.resolve(), nextAt: 0 }
      lanes.set(chatId, lane)
    }
    const l = lane
    const run = l.tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        const wait = l.nextAt - now()
        if (wait > 0) await sleep(wait)
        try {
          const result = await task()
          l.nextAt = now() + minIntervalMs
          return result
        } catch (err) {
          const retryMs = retryAfterMs(err)
          if (retryMs === undefined || attempt >= maxAttempts || retryMs > maxWaitMs) {
            l.nextAt = now() + minIntervalMs
            throw err
          }
          log?.warn('telegram 429, waiting before retry', {
            chat_id: chatId,
            method,
            attempt,
            retry_after_ms: retryMs,
          })
          l.nextAt = now() + Math.max(retryMs, minIntervalMs)
        }
      }
    })
    // Keep the chain alive after a failure so later sends still go out.
    l.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    ...inner,
    sendMessage: (chatId, text, o) => enqueue(chatId, 'sendMessage', () => inner.sendMessage(chatId, text, o)),
    sendDocument: (chatId, filePath, o) =>
      enqueue(chatId, 'sendDocument', () => inner.sendDocument(chatId, filePath, o)),
    sendPhoto: (chatId, filePath, o) => enqueue(chatId, 'sendPhoto', () => inner.sendPhoto(chatId, filePath, o)),
    sendVideo: (chatId, filePath, o) => enqueue(chatId, 'sendVideo', () => inner.sendVideo(chatId, filePath, o)),
  }
}
