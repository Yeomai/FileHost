import type { MultiPartData } from 'h3'

function parseFieldValues(rawValues: string[]): string[] {
  const values = rawValues.map(value => value.trim()).filter(Boolean)
  if (values.length !== 1) return values

  const raw = values[0]!
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item).trim()).filter(Boolean)
    }
  } catch {
    // fall through to comma-separated parsing
  }
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

export function readMultipartFormFieldValues(
  formData: MultiPartData[],
  fieldName: string
): string[] {
  const field = formData.find(part => part.name === fieldName)
  if (field?.data?.length) {
    return parseFieldValues([new TextDecoder().decode(field.data)])
  }

  const repeatFields = formData.filter(
    part => part.name === fieldName && part.data?.length
  )
  if (!repeatFields.length) return []

  return parseFieldValues(
    repeatFields.map(part => new TextDecoder().decode(part.data!))
  )
}

export function readFormDataFieldValues(
  formData: FormData,
  fieldName: string
): string[] {
  return parseFieldValues(
    formData.getAll(fieldName).filter((value): value is string => typeof value === 'string')
  )
}

export function readFormDataFiles(
  formData: FormData,
  fieldNames: string[]
): File[] {
  return fieldNames
    .flatMap(name => formData.getAll(name))
    .filter((value): value is File => value instanceof File && value.size > 0)
}
