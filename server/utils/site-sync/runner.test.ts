import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSiteSyncJson, retrySiteSyncOperation } from './runner'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSiteSyncJson', () => {
  it('retries a broken connection up to three attempts', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSiteSyncJson('http://target/api', 'token')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries client errors because every sync failure gets three attempts', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response('{"message":"invalid"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSiteSyncJson('http://target/api', 'token')).rejects.toThrow('invalid')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails after three server errors', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response('{"message":"unavailable"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSiteSyncJson('http://target/api', 'token')).rejects.toThrow('unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries local sync failures and stops after the third attempt', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('database is busy'))

    await expect(retrySiteSyncOperation(operation)).rejects.toThrow('database is busy')
    expect(operation).toHaveBeenCalledTimes(3)
  })
})
