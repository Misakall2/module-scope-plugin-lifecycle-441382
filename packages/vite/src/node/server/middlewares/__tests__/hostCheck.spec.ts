import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Logger } from '../../../logger'
import {
  getAdditionalAllowedHosts,
  hostValidationMiddleware,
  logHostPolicyRejection,
} from '../hostCheck'

test('getAdditionalAllowedHosts', async () => {
  const actual = getAdditionalAllowedHosts(
    {
      host: 'vite.host.example.com',
      ws: {
        host: 'vite.hmr-host.example.com',
      },
      origin: 'http://vite.origin.example.com:5173',
    },
    {
      host: 'vite.preview-host.example.com',
    },
  ).sort()
  expect(actual).toStrictEqual(
    [
      'vite.host.example.com',
      'vite.hmr-host.example.com',
      'vite.origin.example.com',
      'vite.preview-host.example.com',
    ].sort(),
  )
})

function createReqRes(host: string | undefined) {
  const req = { headers: { host } } as unknown as IncomingMessage
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
    body: '',
    ended: false,
    writeHead(statusCode: number, headers?: Record<string, string | string[]>) {
      this.statusCode = statusCode
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk
      this.ended = true
    },
  } as unknown as ServerResponse & {
    statusCode: number
    body: string
    ended: boolean
  }
  return { req, res }
}

describe('hostValidationMiddleware strict mode', () => {
  let warnFn: ReturnType<typeof vi.fn>
  let logger: Logger
  const allowedHosts = ['allowed.example.test']

  beforeEach(() => {
    warnFn = vi.fn()
    logger = { warn: warnFn } as unknown as Logger
  })

  test('rejects a blocked host in strict mode without calling downstream', async () => {
    const middleware = hostValidationMiddleware(
      allowedHosts,
      false,
      true,
      logger,
    )
    const { req, res } = createReqRes('evil.example.test')
    const next = vi.fn()

    await middleware(req, res, next)

    // blocked request never reaches downstream middlewares / file reads
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(res.ended).toBe(true)
    // evidence of the host rejection is retained, without the host value
    expect(warnFn).toHaveBeenCalledTimes(1)
    const loggedMessage = warnFn.mock.calls[0][0]
    expect(loggedMessage).toContain('HTTP request')
    expect(loggedMessage).toContain('allowed hosts check')
    expect(loggedMessage).not.toContain('evil.example.test')
  })

  test('allows an explicitly configured host in strict mode and calls downstream', async () => {
    const middleware = hostValidationMiddleware(
      allowedHosts,
      false,
      true,
      logger,
    )
    const { req, res } = createReqRes('allowed.example.test')
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.ended).toBe(false)
    expect(warnFn).not.toHaveBeenCalled()
  })

  test('keeps the current compatible behavior when strict mode is disabled', async () => {
    // no strict flag / logger: the shared middleware is returned unchanged
    const middleware = hostValidationMiddleware(allowedHosts, false)
    const { req, res } = createReqRes('evil.example.test')
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    // compatible path does not log anything
    expect(warnFn).not.toHaveBeenCalled()
  })

  test('does not log credentials or host header on rejection', () => {
    const token = 'super-secret-hmr-token'
    logHostPolicyRejection(logger, 'http', 'host')
    logHostPolicyRejection(logger, 'ws', 'host')
    logHostPolicyRejection(logger, 'ws', 'token')

    const messages = warnFn.mock.calls.map((call) => call[0])
    for (const message of messages) {
      expect(message).not.toContain(token)
      expect(message).not.toMatch(/token=[^&]+/)
    }
    // entry type and rejection category are the only retained information
    expect(messages[1]).toContain('HMR WebSocket upgrade')
    expect(messages[2]).toContain('HMR token authorization check')
  })
})
