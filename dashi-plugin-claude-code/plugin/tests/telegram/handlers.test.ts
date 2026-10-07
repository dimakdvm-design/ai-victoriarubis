// Phase 5 fix tests for src/telegram/handlers.ts.
//
// Coverage targets:
//   - Permission text reply (`yes <id>` / `no <id>`) is DM-only — verdict
//     must NOT be emitted in a group/supergroup chat (Fix 2).
//   - OOB short-circuit gates on allowed_chat_ids (Fix 6) — a DM from an
//     allowed user but a chat-id not in the allowlist falls through to the
//     normal channel forward instead of invoking handleOobCommand.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import {
  handleInboundDocument,
  handleInboundText,
  type AlbumEntry,
  type HandlerDeps,
} from '../../src/telegram/handlers.js'
import { AlbumBuffer } from '../../src/telegram/album-buffer.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type {
  PendingPermission,
  PermissionDecision,
  PermissionRelayHooks,
} from '../../src/channel/permissions.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: false, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 600000,
    },
    ...overrides,
  }
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-handlers-test-'))
  return {
    root,
    env: join(root, '.env'),
    config: join(root, 'config.json'),
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
    },
  }
}

interface PermissionSpy {
  hooks: PermissionRelayHooks
  consumed: string[]
  emitted: PermissionDecision[]
}

function makePermissionSpy(pending: Set<string>): PermissionSpy {
  const consumed: string[] = []
  const emitted: PermissionDecision[] = []
  const hooks: PermissionRelayHooks = {
    isPending: (id: string): boolean => pending.has(id),
    consumePending: (id: string): PendingPermission | undefined => {
      if (!pending.has(id)) return undefined
      pending.delete(id)
      consumed.push(id)
      return { toolName: 'Bash', description: 'd', inputPreview: '{}' }
    },
    emitVerdict: async (decision: PermissionDecision): Promise<void> => {
      emitted.push(decision)
    },
  }
  return { hooks, consumed, emitted }
}

interface ServerSpy {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any
  calls: Array<{ method: string; params: unknown }>
}

function makeServerSpy(): ServerSpy {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    server: {
      notification: async (msg: { method: string; params: unknown }): Promise<void> => {
        calls.push({ method: msg.method, params: msg.params })
      },
    },
    calls,
  }
}

function makeTelegramApi(): {
  api: TelegramApi
  reactions: Array<{ chatId: string; messageId: number; emoji: string }>
} {
  const reactions: Array<{ chatId: string; messageId: number; emoji: string }> = []
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in handler test')
  }
  const api: TelegramApi = {
    sendMessage: noop as unknown as TelegramApi['sendMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: async (chatId, messageId, emoji): Promise<void> => {
      reactions.push({ chatId, messageId, emoji })
    },
    sendChatAction: async () => {
      /* noop — status tests cover this surface */
    },
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    sendVideo: noop as unknown as TelegramApi['sendVideo'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
  }
  return { api, reactions }
}

function makeDeps(
  overrides: {
    config?: AppConfig
    permissionHooks?: PermissionRelayHooks
    telegramApi?: TelegramApi
    server?: ServerSpy['server']
  } = {},
): { deps: HandlerDeps; statePaths: StatePaths } {
  const config = overrides.config ?? makeConfig()
  const statePaths = makeStatePaths()
  const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
  const { api } = makeTelegramApi()
  const server = overrides.server ?? makeServerSpy().server
  const deps: HandlerDeps = {
    server,
    config,
    statePaths,
    telegramApi: overrides.telegramApi ?? api,
    log: silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {},
    ...(overrides.permissionHooks ? { permissionHooks: overrides.permissionHooks } : {}),
  }
  return { deps, statePaths }
}

// Build a minimal grammY Context. Handlers read chat, from, message; we
// only need those keys populated for these tests.
function makeCtx(opts: {
  text: string
  chatId: number
  chatType: 'private' | 'group' | 'supergroup'
  fromId: number
}): Context {
  return {
    chat: { id: opts.chatId, type: opts.chatType },
    from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    message: {
      message_id: 42,
      date: 1700000000,
      text: opts.text,
      chat: { id: opts.chatId, type: opts.chatType },
      from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    },
  } as unknown as Context
}

describe('handleInboundText — permission text DM-only guard (Fix 2)', () => {
  test('approver "yes <id>" in private DM emits verdict', async () => {
    const pending = new Set(['abcde'])
    const spy = makePermissionSpy(pending)
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({
      permissionHooks: spy.hooks,
      telegramApi: tg.api,
    })
    const ctx = makeCtx({
      text: 'yes abcde',
      chatId: 164795011,
      chatType: 'private',
      fromId: 164795011,
    })

    await handleInboundText(ctx, deps)

    expect(spy.consumed).toEqual(['abcde'])
    expect(spy.emitted).toEqual([{ behavior: 'allow', requestId: 'abcde' }])
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('approver "yes <id>" in a GROUP does NOT consume or emit verdict', async () => {
    const pending = new Set(['abcde'])
    const spy = makePermissionSpy(pending)
    const serverSpy = makeServerSpy()
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({
      permissionHooks: spy.hooks,
      telegramApi: tg.api,
      server: serverSpy.server,
    })
    const ctx = makeCtx({
      text: 'yes abcde',
      chatId: -1001234,
      chatType: 'group',
      fromId: 164795011,
    })

    await handleInboundText(ctx, deps)

    // Permission path must NOT have fired.
    expect(spy.consumed).toEqual([])
    expect(spy.emitted).toEqual([])
    // Pending request id still parked.
    expect(pending.has('abcde')).toBe(true)
    // And because group is not DM, the gate drops the message — no channel
    // notification either. (Verifying the no-spoof outcome end-to-end.)
    expect(serverSpy.calls.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('approver "yes <id>" in a SUPERGROUP also blocked', async () => {
    const pending = new Set(['abcde'])
    const spy = makePermissionSpy(pending)
    const { deps, statePaths } = makeDeps({ permissionHooks: spy.hooks })
    const ctx = makeCtx({
      text: 'yes abcde',
      chatId: -1009999,
      chatType: 'supergroup',
      fromId: 164795011,
    })

    await handleInboundText(ctx, deps)

    expect(spy.consumed).toEqual([])
    expect(spy.emitted).toEqual([])
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

describe('handleInboundText — OOB allowed_chat_ids gate (Fix 6)', () => {
  test('allowed user in chat NOT in allowed_chat_ids: OOB rejected, falls through', async () => {
    // Config: user is allowed, but chat 99999 is NOT.
    const config = makeConfig({
      allowed_user_ids: [164795011],
      allowed_chat_ids: [164795011],
    })
    const serverSpy = makeServerSpy()
    const { deps, statePaths } = makeDeps({ config, server: serverSpy.server })
    const ctx = makeCtx({
      text: '/help',
      chatId: 99999,
      chatType: 'private',
      fromId: 164795011,
    })

    await handleInboundText(ctx, deps)

    // OOB never executed → no channel notification fired (the fall-through
    // path runs gateAndNotify, which drops because chat is not allowlisted).
    expect(serverSpy.calls.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('allowed user in allowed chat: OOB still works (/help responds)', async () => {
    // Sanity: confirm the gate addition didn't accidentally block the happy
    // path. /help is handled inline (no channel notify), so we expect zero
    // server calls AND no throw. Telegram api setMessageReaction isn't used.
    const config = makeConfig()
    const serverSpy = makeServerSpy()
    const tg = makeTelegramApi()
    // /help replies via tg.sendMessage; allow it to no-op so the call doesn't
    // throw through executeOobResult.
    const api: TelegramApi = {
      ...tg.api,
      sendMessage: async () => ({ message_id: 100 }),
    }
    const { deps, statePaths } = makeDeps({ config, server: serverSpy.server, telegramApi: api })
    const ctx = makeCtx({
      text: '/help',
      chatId: 164795011,
      chatType: 'private',
      fromId: 164795011,
    })

    await handleInboundText(ctx, deps)

    // OOB handled inline — no channel notify for /help.
    expect(serverSpy.calls.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Album path robustness.
// ─────────────────────────────────────────────────────────────────────

function makeAlbumCtx(messageId: number, mgid: string, caption = ''): Context {
  const chat = { id: 164795011, type: 'private' as const }
  const from = { id: 164795011, is_bot: false, first_name: 'x' }
  return {
    chat,
    from,
    message: {
      message_id: messageId,
      date: 1700000000,
      chat,
      from,
      media_group_id: mgid,
      caption,
      document: { file_id: `f${messageId}`, file_unique_id: `u${messageId}`, file_name: 'a.pdf' },
    },
  } as unknown as Context
}

// Timers fire only when the test calls fire() — keeps album flush deterministic.
function makeManualAlbumBuffer(): { buffer: AlbumBuffer<AlbumEntry>; fire: () => void } {
  const pending: Array<() => void> = []
  const buffer = new AlbumBuffer<AlbumEntry>({
    flushMs: 2000,
    setTimer: (cb) => {
      pending.push(cb)
      return pending.length as unknown as NodeJS.Timeout
    },
    clearTimer: (h) => {
      pending[(h as unknown as number) - 1] = () => {}
    },
  })
  return {
    buffer,
    fire: () => {
      for (const cb of pending.splice(0)) cb()
    },
  }
}

describe('album handling', () => {
  test('opens the "Печатает..." status once per album, not once per item', async () => {
    const { deps } = makeDeps({ config: makeConfig({ status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true } }) })
    const starts: string[] = []
    deps.statusManager = {
      start: async (chatId: string) => {
        starts.push(chatId)
        return { chatId, messageId: 1, startedAt: 0 }
      },
    } as unknown as NonNullable<HandlerDeps['statusManager']>
    const { buffer } = makeManualAlbumBuffer()
    deps.albumBuffer = buffer

    for (const id of [1, 2, 3]) {
      await handleInboundDocument(makeAlbumCtx(id, 'mg1'), deps)
    }
    // Each extra start() supersedes the previous bubble: one send + one
    // delete per photo through the 1.2 s send queue, which also stalls the
    // poller long enough to split the album in two.
    expect(starts.length).toBe(1)
  })

  test('album whose channel notify fails is dead-lettered, not silently lost', async () => {
    const failingServer = {
      notification: async (): Promise<void> => {
        throw new Error('transport closed')
      },
    }
    const { deps, statePaths } = makeDeps({ server: failingServer })
    mkdirSync(statePaths.deadLetterUpdates, { recursive: true })
    const { buffer, fire } = makeManualAlbumBuffer()
    deps.albumBuffer = buffer

    await handleInboundDocument(makeAlbumCtx(1, 'mg2', 'look'), deps)
    await handleInboundDocument(makeAlbumCtx(2, 'mg2'), deps)
    fire()
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1))

    const files = readdirSync(statePaths.deadLetterUpdates)
    expect(files.length).toBe(1)
    const saved = readFileSync(join(statePaths.deadLetterUpdates, files[0]!), 'utf8')
    expect(saved).toContain('mg2')
    expect(saved).toContain('look')
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})
