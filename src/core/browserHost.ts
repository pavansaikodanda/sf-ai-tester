import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { chromium, BrowserContext } from "playwright";

export interface BrowserHost {
  /** Chrome DevTools Protocol endpoint each model's Playwright MCP attaches to */
  cdpEndpoint: string;
  close(): Promise<void>;
}

/** Finds a free localhost port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * One browser per test case, owned by the runner rather than by an agent session. Each model attempt's
 * Playwright MCP attaches to it over CDP, so when a case escalates the fallback model continues on the exact
 * page the previous model left off - same tabs, same form state, same session - instead of starting again.
 */
export async function startBrowserHost(opts: { storageStatePath: string; headless: boolean }): Promise<BrowserHost> {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sf-ai-tester-browser-"));
  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    headless: opts.headless,
    viewport: { width: 1440, height: 900 },
    args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
  });
  // Log the org session in: the saved storage state from authenticate().
  try {
    const state = JSON.parse(fs.readFileSync(opts.storageStatePath, "utf8"));
    if (state.cookies?.length) await context.addCookies(state.cookies);
  } catch {
    // no saved session (e.g. public test page) - the browser simply starts logged out
  }
  if (!context.pages().length) await context.newPage();
  return {
    cdpEndpoint: `http://127.0.0.1:${port}`,
    close: async () => {
      await context.close().catch(() => undefined);
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}
