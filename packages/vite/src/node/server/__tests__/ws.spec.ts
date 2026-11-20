import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ResolvedConfig } from '../..'
import type { Logger } from '../../logger'
import { createWebSocketServer, HMR_HEADER } from '../ws'

const HMR_PATH = '/'

/**
 * In-memory duplex standing in for a TCP/TLS socket. Nothing is written to
 * the network: handshake bytes are captured so the test can assert whether
 * the upgrade was accepted (101) or rejected (4xx) without binding a port.
 */
class FakeSocket extends Duplex {
  writtenChunks: Buffer[] = []
  destroyed = false

  constructor() {
    super()
    // start paused like a network socket; ws resumes it on a successful upgrade
    this.pause()
  }

  override _read() {
    // noop: this socket only captures writes, it never produces data
  }
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.writtenChunks.push(Buffer.from(chunk))
    callback()
  }

  override destroy(error?: Error) {
    this.destroyed = true
    return super.destroy(error)
  }

  get writtenText() {
    return Buffer.concat(this.writtenChunks).toString('utf8')
  }
}

/**
 * Minimal EventEmitter standing in for node:http Server. createWebSocketServer
 * only needs `on`/`off` for the `upgrade` event in the shared-server case.
 */
class FakeHttpServer extends EventEmitter {}

function createUpgradeReq(options: {
  host: string
  protocol: string
  origin?: string
  url?: string
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: options.host,
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
    'sec-websocket-protocol': options.protocol,
  }
  if (options.origin) {
    headers.origin = options.origin
  }
  return {
    headers,
    url: options.url ?? HMR_PATH,
    method: 'GET',
    socket: new FakeSocket(),
  } as unknown as IncomingMessage
}

function createConfig(
  allowedHosts: string[] | true,
  warnFn: ReturnType<typeof vi.fn>,
): ResolvedConfig {
  return {
    webSocketToken: 'test-hmr-token',
    logger: { warn: warnFn } as unknown as Logger,
    server: {
      hmr: undefined,
      ws: {},
      allowedHosts,
    },
    base: '/',
  } as unknown as ResolvedConfig
}

function upgrade(
  httpServer: FakeHttpServer,
  req: IncomingMessage,
): { socket: FakeSocket } {
  const socket = req.socket as unknown as FakeSocket
  httpServer.emit('upgrade', req, socket, Buffer.alloc(0))
  return { socket }
}

describe('createWebSocketServer host policy', () => {
  let warnFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    warnFn = vi.fn()
  })

  test('rejects an HMR upgrade from a host not in the resolved list', () => {
    const httpServer = new FakeHttpServer()
    const wss = createWebSocketServer(
      httpServer as never,
      createConfig(['allowed.example.test'], warnFn),
    )
    const connectCallback = vi.fn()
    wss.on('connection', connectCallback)

    const req = createUpgradeReq({
      host: 'fictional.example.test',
      protocol: HMR_HEADER,
      // browser-like request so the token check would otherwise apply
      origin: 'http://fictional.example.test',
      url: `${HMR_PATH}?token=test-hmr-token`,
    })
    const { socket } = upgrade(httpServer, req)

    // the handshake is rejected before any subscription is created
    expect(socket.writtenText).toContain('HTTP/1.1 400')
    expect(connectCallback).not.toHaveBeenCalled()
    expect(wss.clients.size).toBe(0)
    // host rejection evidence is retained, containing neither host nor token
    expect(warnFn).toHaveBeenCalledTimes(1)
    const loggedMessage = warnFn.mock.calls[0][0]
    expect(loggedMessage).toContain('HMR WebSocket upgrade')
    expect(loggedMessage).toContain('allowed hosts check')
    expect(loggedMessage).not.toContain('fictional.example.test')
    expect(loggedMessage).not.toContain('test-hmr-token')
  })

  test('keeps separate resolved host lists between two instances', () => {
    const sharedFictionalHost = 'fictional.example.test'

    const serverA = new FakeHttpServer()
    const wssA = createWebSocketServer(
      serverA as never,
      createConfig([sharedFictionalHost], vi.fn()),
    )
    const serverB = new FakeHttpServer()
    const wssB = createWebSocketServer(
      serverB as never,
      createConfig([], vi.fn()),
    )
    const callbackA = vi.fn()
    const callbackB = vi.fn()
    wssA.on('connection', callbackA)
    wssB.on('connection', callbackB)

    // instance A explicitly allows the fictional host: the upgrade succeeds
    const reqA = createUpgradeReq({
      host: sharedFictionalHost,
      protocol: HMR_HEADER,
      url: `${HMR_PATH}?token=test-hmr-token`,
    })
    const { socket: socketA } = upgrade(serverA, reqA)
    expect(socketA.writtenText).toContain('101 Switching Protocols')
    expect(callbackA).toHaveBeenCalledTimes(1)

    // the same host was never added to instance B: rejected, no subscription
    const reqB = createUpgradeReq({
      host: sharedFictionalHost,
      protocol: HMR_HEADER,
      url: `${HMR_PATH}?token=test-hmr-token`,
    })
    const { socket: socketB } = upgrade(serverB, reqB)
    expect(socketB.writtenText).toContain('HTTP/1.1 400')
    expect(callbackB).not.toHaveBeenCalled()
    expect(wssB.clients.size).toBe(0)
  })

  test('does not treat passing the host policy as passing the token check', () => {
    const httpServer = new FakeHttpServer()
    const wss = createWebSocketServer(
      httpServer as never,
      createConfig(['allowed.example.test'], warnFn),
    )
    const connectCallback = vi.fn()
    wss.on('connection', connectCallback)

    // host is allowed, but the browser-like upgrade carries a wrong token
    const req = createUpgradeReq({
      host: 'allowed.example.test',
      protocol: HMR_HEADER,
      origin: 'http://allowed.example.test',
      url: `${HMR_PATH}?token=wrong-token`,
    })
    const { socket } = upgrade(httpServer, req)

    expect(socket.writtenText).toContain('HTTP/1.1 400')
    expect(connectCallback).not.toHaveBeenCalled()
    expect(wss.clients.size).toBe(0)
    // the failure is attributed to the authorization check, not the host check
    expect(warnFn).toHaveBeenCalledTimes(1)
    const loggedMessage = warnFn.mock.calls[0][0]
    expect(loggedMessage).toContain('HMR token authorization check')
    expect(loggedMessage).not.toContain('wrong-token')
  })

  test('accepts an upgrade that passes both checks and emits one connection event', () => {
    const httpServer = new FakeHttpServer()
    const wss = createWebSocketServer(
      httpServer as never,
      createConfig(['allowed.example.test'], warnFn),
    )
    const connectCallback = vi.fn()
    wss.on('connection', connectCallback)

    const req = createUpgradeReq({
      host: 'allowed.example.test',
      protocol: HMR_HEADER,
      origin: 'http://allowed.example.test',
      url: `${HMR_PATH}?token=test-hmr-token`,
    })
    const { socket } = upgrade(httpServer, req)

    expect(socket.writtenText).toContain('101 Switching Protocols')
    expect(connectCallback).toHaveBeenCalledTimes(1)
    expect(wss.clients.size).toBe(1)
    expect(warnFn).not.toHaveBeenCalled()
  })

  test('keeps vite-ping compatible: no subscription and no business events', () => {
    const httpServer = new FakeHttpServer()
    const wss = createWebSocketServer(
      httpServer as never,
      createConfig([], warnFn),
    )
    const connectCallback = vi.fn()
    const clientConnectCallback = vi.fn()
    // business event emitted from the connection handler for real clients
    wss.on('connection', connectCallback)
    wss.on('vite:client:connect', clientConnectCallback)

    // vite-ping is a liveness probe that must work from any host
    const req = createUpgradeReq({
      host: 'evil.example.test',
      protocol: 'vite-ping',
    })
    const { socket } = upgrade(httpServer, req)

    // the probe handshake still completes, but the resulting socket is closed
    // immediately and never produces a connection event or a business event
    expect(socket.writtenText).toContain('101 Switching Protocols')
    expect(connectCallback).not.toHaveBeenCalled()
    expect(clientConnectCallback).not.toHaveBeenCalled()
    const probeClients = [...wss.clients]
    expect(probeClients).toHaveLength(1)
    // 2 = CLOSING: it is a probe being torn down, not an active subscription
    expect(probeClients[0].socket.readyState).toBe(2)
    expect(warnFn).not.toHaveBeenCalled()
  })

  test('allows non-browser upgrades without a token for backward compatibility', () => {
    const httpServer = new FakeHttpServer()
    const wss = createWebSocketServer(
      httpServer as never,
      createConfig(['allowed.example.test'], warnFn),
    )
    const connectCallback = vi.fn()
    wss.on('connection', connectCallback)

    // no Origin header: non-browser client keeps the existing token exemption
    const req = createUpgradeReq({
      host: 'allowed.example.test',
      protocol: HMR_HEADER,
    })
    const { socket } = upgrade(httpServer, req)

    expect(socket.writtenText).toContain('101 Switching Protocols')
    expect(connectCallback).toHaveBeenCalledTimes(1)
    expect(warnFn).not.toHaveBeenCalled()
  })
})
