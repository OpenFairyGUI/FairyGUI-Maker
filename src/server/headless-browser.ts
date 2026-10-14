import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

import { COOKIE_NAME } from "./auth"

export const HEADLESS_BROWSER_CHANNELS = ["chrome", "msedge", "chromium"] as const
export type HeadlessBrowserChannel = typeof HEADLESS_BROWSER_CHANNELS[number]

const LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader"]

// Host-owned browser for Viewer/Player pages, so Agents can render without a person keeping Workbench open.
// It launches on first use, prefers the installed Chrome or Edge, and never downloads a browser.
export function createHeadlessBrowser({ token, channel }: { token: string; channel?: HeadlessBrowserChannel }) {
  const authorize = async (context: BrowserContext, url: string) => {
    // The same HttpOnly cookie the token bootstrap sets; the token never appears in URLs, history or error messages.
    await context.addCookies([{ name: COOKIE_NAME, value: token, url: new URL(url).origin, httpOnly: true, sameSite: "Strict" }])
  }
  let launching: Promise<{ browser: Browser; context: BrowserContext }> | null = null
  const pages = new Map<string, Page>()
  let closed = false

  const launch = async () => {
    const failures: string[] = []
    for (const candidate of channel ? [channel] : ["chrome", "msedge"] as const) {
      try {
        // Playwright's own Chromium has no channel name; it must be installed with `npx playwright install chromium`.
        const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, ...(candidate === "chromium" ? {} : { channel: candidate }) })
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
        return { browser, context }
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
      }
    }
    throw new Error(`headless_browser_unavailable: install Google Chrome or Microsoft Edge, or run "npx playwright install chromium" and start Maker with --headless-browser chromium (${failures.join("; ")})`)
  }

  return {
    /** Loads a Workbench page once and keeps it open; the page registers its renderer with the Host on its own. */
    async open(url: string) {
      if (closed) throw new Error("headless_browser_closed")
      launching ??= launch().catch((error) => { launching = null; throw error })
      const { context } = await launching
      const current = pages.get(url)
      if (current && !current.isClosed()) return
      await authorize(context, url)
      const page = await context.newPage()
      pages.set(url, page)
      page.once("close", () => { if (pages.get(url) === page) pages.delete(url) })
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })
      } catch (error) {
        pages.delete(url)
        await page.close().catch(() => undefined)
        throw new Error(`headless_page_load_failed: ${url} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`)
      }
    },
    async close() {
      closed = true
      const current = launching
      launching = null
      pages.clear()
      if (current) await current.then(({ browser }) => browser.close(), () => undefined)
    },
  }
}
