import { describe, expect, it } from 'vitest'
import { readFormData, type H3Event } from 'h3'
import {
  readFormDataFieldValues,
  readFormDataFiles
} from './multipart-form'

async function parseFormData(form: FormData): Promise<FormData> {
  const request = new Request('http://localhost/upload', {
    method: 'POST',
    body: form
  })
  return readFormData({ web: { request } } as unknown as H3Event)
}

describe('web FormData helpers', () => {
  it('reads text fields and files from a multipart request', async () => {
    const form = new FormData()
    form.append('key', ' videos/2026/10/test.mov ')
    form.append('tagNames', '["a","b"]')
    form.append(
      'file',
      new File([new Uint8Array(1024)], 'test.mov', { type: 'video/quicktime' })
    )

    const parsed = await parseFormData(form)

    expect(parsed.get('key')).toBe(' videos/2026/10/test.mov ')
    expect(readFormDataFieldValues(parsed, 'tagNames')).toEqual(['a', 'b'])
    expect(readFormDataFiles(parsed, ['file'])[0]).toMatchObject({
      name: 'test.mov',
      size: 1024,
      type: 'video/quicktime'
    })
  })

  it('keeps repeated field values and ignores empty files', async () => {
    const form = new FormData()
    form.append('tagNames', 'a,b')
    form.append('tagNames', 'c')
    form.append('files', new File([], 'empty.txt'))

    const parsed = await parseFormData(form)

    expect(readFormDataFieldValues(parsed, 'tagNames')).toEqual(['a,b', 'c'])
    expect(readFormDataFiles(parsed, ['files'])).toEqual([])
  })
})
