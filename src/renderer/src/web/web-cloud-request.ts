import { parseJsonText, readField, readString } from '../../../shared/json-fields'
import { WEB_CLOUD_ERROR_CODE, WebCloudSessionError } from './web-cloud-error'

export type RequestOptions = { fetchImpl?: typeof fetch }

type RequestInput = RequestOptions & {
  url: string
  method?: 'GET' | 'POST'
  accessToken?: string
  body?: unknown
}

function resolveFetch(options: RequestOptions): typeof fetch {
  return options.fetchImpl ?? globalThis.fetch
}

async function readReplyBody(response: Response): Promise<unknown> {
  try {
    return parseJsonText(await response.text())
  } catch {
    return null
  }
}

/** One JSON request; non-2xx becomes a typed error carrying the platform code. */
export async function requestJson(input: RequestInput): Promise<unknown> {
  let response: Response
  try {
    response = await resolveFetch(input)(input.url, {
      method: input.method ?? 'GET',
      headers: {
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {})
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
    })
  } catch (error) {
    throw new WebCloudSessionError(
      WEB_CLOUD_ERROR_CODE.network,
      error instanceof Error ? error.message : String(error)
    )
  }
  const body = await readReplyBody(response)
  if (!response.ok) {
    // Why fall back to a status code: a proxy or crash page may not be the
    // platform's JSON envelope, and the UI still needs something to branch on.
    const code = readString(readField(body, 'error'), 'code') ?? `http_${response.status}`
    const message =
      readString(readField(body, 'error'), 'message') ??
      `platform request failed ${response.status}`
    throw new WebCloudSessionError(code, message, response.status)
  }
  return body
}
