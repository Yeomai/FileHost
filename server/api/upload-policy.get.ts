import {
  getAllowedMimeTypesList,
  getAllowedVideoExtensions,
  getForbiddenFileExtensions
} from '../utils/upload-policy'

export default defineEventHandler((event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    allowedMimeTypes: getAllowedMimeTypesList(),
    allowedVideoExtensions: getAllowedVideoExtensions(),
    forbiddenFileExtensions: getForbiddenFileExtensions()
  }
})
