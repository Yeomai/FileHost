import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadFormDataWithProgress } from './upload-progress'

class FakeXhr {
  static current: FakeXhr

  upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null
  }

  status = 200
  statusText = 'OK'
  responseText = '{"ok":true}'
  withCredentials = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    FakeXhr.current = this
  }

  open() {}

  send() {}
}

describe('uploadFormDataWithProgress', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the uploaded byte percentage', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const onProgress = vi.fn()
    const result = uploadFormDataWithProgress<{ ok: boolean }>(
      '/upload',
      new FormData(),
      onProgress
    )

    FakeXhr.current.upload.onprogress!({
      lengthComputable: true,
      loaded: 40,
      total: 100
    } as ProgressEvent)
    FakeXhr.current.onload!()

    await expect(result).resolves.toEqual({ ok: true })
    expect(onProgress).toHaveBeenCalledWith(40)
  })

  it('keeps the HTTP status and server error message', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const result = uploadFormDataWithProgress(
      '/upload',
      new FormData(),
      () => {}
    )

    FakeXhr.current.status = 401
    FakeXhr.current.statusText = 'Unauthorized'
    FakeXhr.current.responseText = JSON.stringify({
      data: { error: { message: '未登录' } }
    })
    FakeXhr.current.onload!()

    await expect(result).rejects.toMatchObject({
      statusCode: 401,
      message: '未登录'
    })
  })
})
