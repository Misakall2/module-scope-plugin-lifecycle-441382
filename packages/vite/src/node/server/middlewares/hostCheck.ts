import {
  hostValidationMiddleware as originalHostValidationMiddleware,
  isHostAllowed,
} from 'host-validation-middleware'
import colors from 'picocolors'
import type { Connect } from '#dep-types/connect'
import type { ResolvedPreviewOptions, ResolvedServerOptions } from '../..'
import type { Logger } from '../../logger'

export function getAdditionalAllowedHosts(
  resolvedServerOptions: Pick<ResolvedServerOptions, 'host' | 'ws' | 'origin'>,
  resolvedPreviewOptions: Pick<ResolvedPreviewOptions, 'host'>,
): string[] {
  const list = []

  // allow host option by default as that indicates that the user is
  // expecting Vite to respond on that host
  if (
    typeof resolvedServerOptions.host === 'string' &&
    resolvedServerOptions.host
  ) {
    list.push(resolvedServerOptions.host)
  }
  if (
    typeof resolvedServerOptions.ws === 'object' &&
    resolvedServerOptions.ws.host
  ) {
    list.push(resolvedServerOptions.ws.host)
  }
  if (
    typeof resolvedPreviewOptions.host === 'string' &&
    resolvedPreviewOptions.host
  ) {
    list.push(resolvedPreviewOptions.host)
  }

  // allow server origin by default as that indicates that the user is
  // expecting Vite to respond on that host
  if (resolvedServerOptions.origin) {
    // some frameworks may pass the origin as a placeholder, so it's not
    // possible to parse as URL, so use a try-catch here as a best effort
    try {
      const serverOriginUrl = new URL(resolvedServerOptions.origin)
      list.push(serverOriginUrl.hostname)
    } catch {}
  }

  return list
}

/**
 * The entry point at which a request was blocked. Only the category of the
 * entry is recorded, never its contents.
 */
export type HostPolicyEntryType = 'http' | 'ws'

/**
 * The check that rejected a request. Host policy failures and the HMR
 * authorization failure are kept as distinct categories so that passing the
 * host check is never observable as passing the later authorization check.
 */
export type HostPolicyRejectionReason = 'host' | 'token'

/**
 * Emit a single structured warning for a blocked entry. The log only contains
 * the entry type and the rejection category. Host names, URLs, origins and
 * connection credentials (e.g. the HMR token) are intentionally excluded.
 */
export function logHostPolicyRejection(
  logger: Logger,
  entryType: HostPolicyEntryType,
  reason: HostPolicyRejectionReason,
): void {
  const entry = entryType === 'http' ? 'HTTP request' : 'HMR WebSocket upgrade'
  const check =
    reason === 'host' ? 'allowed hosts check' : 'HMR token authorization check'
  logger.warn(colors.yellow(`Blocked ${entry}: rejected by ${check}.`))
}

export function hostValidationMiddleware(
  allowedHosts: string[],
  isPreview: boolean,
  strictHostCheck: boolean = false,
  logger?: Logger,
): Connect.NextHandleFunction {
  // Freeze the array to allow caching
  const frozenAllowedHosts = Object.freeze([...allowedHosts])
  const middleware = originalHostValidationMiddleware({
    allowedHosts: frozenAllowedHosts,
    generateErrorMessage(hostname) {
      const hostnameWithQuotes = JSON.stringify(hostname)
      const optionName = `${isPreview ? 'preview' : 'server'}.allowedHosts`
      return (
        `Blocked request. This host (${hostnameWithQuotes}) is not allowed.\n` +
        `To allow this host, add ${hostnameWithQuotes} to \`${optionName}\` in vite.config.js.`
      )
    },
  })

  if (!strictHostCheck || !logger) {
    return middleware
  }

  // Strict mode applies the same resolved host policy to encrypted requests.
  // The rejection is logged first without recording the host header or any
  // credential, and the shared middleware still produces the 403 response,
  // so the request never reaches downstream middlewares or file reads.
  return function strictHostValidationMiddleware(req, res, next) {
    if (!isHostAllowed(req.headers.host, frozenAllowedHosts)) {
      logHostPolicyRejection(logger, 'http', 'host')
    }
    return middleware(req, res, next)
  }
}
