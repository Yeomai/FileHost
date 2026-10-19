interface UploadError extends Error {
  statusCode: number
  statusMessage: string
  data: unknown
}

function uploadErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback

  const body = data as {
    message?: unknown
    error?: { message?: unknown }
    data?: { error?: { message?: unknown } }
  }
  const message = body.data?.error?.message ?? body.error?.message ?? body.message
  return typeof message === 'string' ? message : fallback
}

export function uploadFormDataWithProgress<T>(
  url: string,
  formData: FormData,
  onProgress: (percent: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      let data: unknown = null
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        // 非 JSON 响应交给状态码和状态文本报错
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T)
        return
      }

      const error = new Error(
        uploadErrorMessage(data, xhr.statusText || 'Upload failed')
      ) as UploadError
      error.statusCode = xhr.status
      error.statusMessage = xhr.statusText
      error.data = data
      reject(error)
    }

    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(formData)
  })
}
