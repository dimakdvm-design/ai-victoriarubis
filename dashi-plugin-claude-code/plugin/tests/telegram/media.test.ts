// downloadPhotoToInbox must shrink incoming photos before persisting them —
// Dima sends screenshots straight off his phone (1178x2560+) and every extra
// pixel Claude reads eats into the weekly usage cap. See
// core/strategy (memory) "ekonomiya-limita": scaling to ~760px wide keeps
// text readable at roughly half the bytes.

import { describe, expect, test } from 'bun:test'

import { downloadPhotoToInbox, type BotApiForDownload } from '../../src/telegram/media.js'

function makeBot(filePath: string, fileSize?: number): BotApiForDownload {
  return {
    api: {
      getFile: async () => ({
        file_id: 'f1',
        file_unique_id: 'u1',
        file_path: filePath,
        ...(fileSize !== undefined ? { file_size: fileSize } : {}),
      }),
    },
  }
}

describe('downloadPhotoToInbox — shrinking', () => {
  test('writes the scaled bytes returned by scaleImage, not the raw download', async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5])
    const scaled = new Uint8Array([9, 9])
    let scaleImageCalledWith: Uint8Array | undefined
    let written: Uint8Array | undefined

    const path = await downloadPhotoToInbox(makeBot('photos/big.jpg'), 'TOKEN', 'f1', '/inbox', {
      fetchImpl: (async () => new Response(raw)) as unknown as typeof fetch,
      mkdir: async () => {},
      writeFile: async (_p, data) => {
        written = data
      },
      now: () => 1000,
      scaleImage: async (bytes) => {
        scaleImageCalledWith = bytes
        return scaled
      },
    })

    expect(path).toBe('/inbox/1000-u1.jpg')
    expect(scaleImageCalledWith).toEqual(raw)
    expect(written).toEqual(scaled)
  })

  test('falls back to the original bytes when scaling fails', async () => {
    const raw = new Uint8Array([7, 7, 7])
    let written: Uint8Array | undefined

    const path = await downloadPhotoToInbox(makeBot('photos/big.jpg'), 'TOKEN', 'f1', '/inbox', {
      fetchImpl: (async () => new Response(raw)) as unknown as typeof fetch,
      mkdir: async () => {},
      writeFile: async (_p, data) => {
        written = data
      },
      now: () => 1000,
      scaleImage: async () => {
        throw new Error('ffmpeg not found')
      },
    })

    expect(path).toBe('/inbox/1000-u1.jpg')
    expect(written).toEqual(raw)
  })

  test('skips scaling when scaleImage dep is not provided (still writes raw bytes)', async () => {
    // Guards against a future refactor silently making scaling mandatory
    // and breaking callers/tests that don't stub it.
    const raw = new Uint8Array([4, 2])
    let written: Uint8Array | undefined

    await downloadPhotoToInbox(makeBot('photos/big.jpg'), 'TOKEN', 'f1', '/inbox', {
      fetchImpl: (async () => new Response(raw)) as unknown as typeof fetch,
      mkdir: async () => {},
      writeFile: async (_p, data) => {
        written = data
      },
      now: () => 1000,
    })

    expect(written).toEqual(raw)
  })
})

// A stalled CDN download or a wedged ffmpeg must not hang the handler: the
// poller handles updates one at a time, so one stuck photo would stop every
// later message from reaching the agent.
describe('downloadPhotoToInbox — never hangs', () => {
  // fetch that only settles when its AbortSignal fires — models a dead socket.
  const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch

  test('gives up on a stalled download after timeoutMs and returns undefined', async () => {
    const started = Date.now()
    const path = await downloadPhotoToInbox(makeBot('photos/big.jpg'), 'TOKEN', 'f1', '/inbox', {
      fetchImpl: hangingFetch,
      mkdir: async () => {},
      writeFile: async () => {},
      timeoutMs: 50,
    })
    expect(path).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('falls back to raw bytes when scaling hangs past scaleTimeoutMs', async () => {
    const raw = new Uint8Array([3, 1, 4])
    let written: Uint8Array | undefined
    const path = await downloadPhotoToInbox(makeBot('photos/big.jpg'), 'TOKEN', 'f1', '/inbox', {
      fetchImpl: (async () => new Response(raw)) as unknown as typeof fetch,
      mkdir: async () => {},
      writeFile: async (_p, data) => {
        written = data
      },
      now: () => 1000,
      scaleImage: () => new Promise<Uint8Array>(() => {}),
      scaleTimeoutMs: 50,
    })
    expect(path).toBe('/inbox/1000-u1.jpg')
    expect(written).toEqual(raw)
  })
})
