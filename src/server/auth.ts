import { timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { getCookie, setCookie } from "hono/cookie"

export const COOKIE_NAME = "fairygui_maker_token"
export const OWNER_COOKIE_NAME = "fairygui_maker_owner"
export const OWNER_COOKIE_PATH = "/api/save-approvals"
export const MAX_OWNER_SESSIONS = 32

export function tokensMatch(actual: string | undefined | null, expected: string) {
  if (typeof actual !== "string") return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

// Host binding, Origin and token checks for every request. Hosts and Origins are only known after listen, so they are read per request.
export function hostGuard({ token, publicAssets, isClosing, allowedHosts, allowedOrigins }: {
  token: string
  publicAssets: Set<string>
  isClosing(): boolean
  allowedHosts(): Set<string>
  allowedOrigins(): Set<string>
}): MiddlewareHandler {
  return async (c, next) => {
    c.header("Cache-Control", "no-store")
    if (isClosing()) return c.json({ error: "Host is closing" }, 503)
    c.header("Content-Security-Policy", "default-src 'self' blob:; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Frame-Options", "SAMEORIGIN")

    if (!allowedHosts().has((c.req.header("host") ?? "").toLowerCase())) {
      return c.json({ error: "Invalid Host header" }, 403)
    }
    const runtimePage = /^\/(viewer|player)-runtime\.html$/.test(c.req.path)
    if ((c.req.method === "GET" || c.req.method === "HEAD") && (publicAssets.has(c.req.path) || runtimePage)) {
      if (runtimePage) {
        const assetOrigin = new URL(c.req.url).origin
        c.header("Content-Security-Policy", `default-src 'none'; sandbox allow-scripts; script-src ${assetOrigin}/assets/ ${assetOrigin}/viewer-runtime/; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src blob: data:; connect-src blob:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`)
      } else {
        c.header("Access-Control-Allow-Origin", "*")
      }
      await next()
      return
    }
    const requestOrigin = c.req.header("origin")
    if (requestOrigin && !allowedOrigins().has(requestOrigin)) {
      return c.json({ error: "Invalid Origin header" }, 403)
    }
    const url = new URL(c.req.url)
    const queryToken = url.searchParams.get("token")
    if (c.req.method === "GET" && tokensMatch(queryToken, token)) {
      url.searchParams.delete("token")
      setCookie(c, COOKIE_NAME, token, { httpOnly: true, sameSite: "Strict", path: "/" })
      return c.redirect(`${url.pathname}${url.search}`)
    }

    // Opaque frames also make GET/no-cors/navigation requests without an Origin header.
    // A valid explicit bootstrap token above is allowed; Cookie alone is not.
    const site = c.req.header("sec-fetch-site")
    if (site && site !== "same-origin" && site !== "none") return c.json({ error: "Cross-origin Host access denied" }, 403)

    const authorization = c.req.header("authorization")
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    if (!tokensMatch(bearer, token) && !tokensMatch(getCookie(c, COOKIE_NAME), token)) {
      return c.json({ error: "Authentication required" }, 401)
    }
    await next()
  }
}
