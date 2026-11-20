import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { onTestFinished, expect, test, vi } from 'vitest'
import { createServer, type PluginOption, type ViteDevServer } from '../index'

/**
 * Drive the real connect middleware stack through a loopback-only HTTP
 * server. The listener binds to 127.0.0.1 on an ephemeral port, so it is not
 * reachable externally, and no TLS material is generated.
 *
 * The dev server itself stays in middleware mode and is resolved with an
 * `https` option, which is exactly the "encrypted connection" configuration
 * in which the host check used to be skipped.
 */
async function startLoopbackServer(
  middlewares: ViteDevServer['middlewares'],
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    middlewares(req, res)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * Connect to the loopback server while presenting an arbitrary Host header,
 * mirroring how a request for a configured hostname reaches the dev server.
 */
function requestWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        host: '127.0.0.1',
        headers: { Host: host },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function createStrictServer(
  strictHostCheck: boolean,
  allowedHosts: string[],
) {
  // A post configureServer hook runs after the host check middleware, so it
  // stands in for every downstream middleware / file serving stage.
  const downstreamSpy = vi.fn()
  const downstreamProbe: PluginOption = {
    name: 'host-policy-downstream-probe',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        downstreamSpy(req.headers.host)
        next()
      })
    },
  }
  const server = await createServer({
    configFile: false,
    root: import.meta.dirname,
    logLevel: 'silent',
    plugins: [downstreamProbe],
    server: {
      middlewareMode: true,
      ws: false,
      // marks the dev server as serving encrypted connections without
      // producing or loading any certificate
      https: {} as never,
      allowedHosts,
      strictHostCheck,
    },
  })
  const loopback = await startLoopbackServer(server.middlewares)
  onTestFinished(async () => {
    await loopback.close()
    await server.close()
  })
  return { port: loopback.port, downstreamSpy }
}

test('strict mode enforces the host policy on encrypted regular requests', async () => {
  const { port, downstreamSpy } = await createStrictServer(true, [
    'allowed.example.test',
  ])

  // a host not in the resolved list is blocked before downstream middlewares
  const blockedStatus = await requestWithHost(port, 'fictional.example.test')
  expect(blockedStatus).toBe(403)
  // the request never leaves the host check: no downstream middleware,
  // transform or static file stage runs, so no file is ever read
  expect(downstreamSpy).not.toHaveBeenCalled()

  // an explicitly allowed host passes the host policy and reaches downstream
  const allowedStatus = await requestWithHost(port, 'allowed.example.test')
  expect(allowedStatus).not.toBe(403)
  expect(downstreamSpy).toHaveBeenCalledWith('allowed.example.test')
})

test('without strict mode encrypted regular requests keep compatible behavior', async () => {
  const { port, downstreamSpy } = await createStrictServer(false, [
    'allowed.example.test',
  ])

  // the host check middleware is not mounted for HTTPS when strict mode is
  // off, so an unknown fictional host is not rejected with 403
  const statusCode = await requestWithHost(port, 'fictional.example.test')
  expect(statusCode).not.toBe(403)
  expect(downstreamSpy).toHaveBeenCalledWith('fictional.example.test')
})
