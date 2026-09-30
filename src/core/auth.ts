import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { BrowserContext, Page, chromium } from "playwright";
import { LoginOptions, OrgConfig } from "./types";

export interface AuthSession {
  /** Playwright storageState file with the logged-in Salesforce cookies */
  storageStatePath: string;
  /** e.g. https://acme--uat.sandbox.lightning.force.com */
  instanceUrl: string;
}

export interface AuthCallbacks {
  log: (m: string) => void;
  /** Called when a human has to act in the login window (passkey, MFA, SSO, device verification). */
  needsUser?: (m: string) => void;
}

/**
 * Really inside the org: on the Lightning domain (or a classic home/setup page) and not on an identity page
 * (passkey / MFA / verification). A my.salesforce.com/lightning/... URL is not enough - Salesforce can still
 * bounce from there to a mandatory passkey or authenticator registration.
 */
const LOGGED_IN = (u: URL | string): boolean => {
  let url: URL;
  try {
    url = typeof u === "string" ? new URL(u) : u;
  } catch {
    return false;
  }
  if (/\/(_ui\/)?identity\/|\/secur\/|^\/login/i.test(url.pathname)) return false;
  return url.hostname.endsWith(".lightning.force.com") || /^\/(home\/home\.jsp|setup\/)/.test(url.pathname);
};
const HEADLESS_ATTEMPT_MS = 30_000;

/** URL without query/fragment - frontdoor URLs carry a session id that must never reach logs. */
const safeUrl = (u: string) => u.split(/[?#]/)[0];

/** Salesforce wants something only a person can provide (passkey, MFA code, SSO, device verification). */
class NeedsUserError extends Error {}

/**
 * Produces a logged-in browser session for the org. The agent and generated specs reuse it, so
 * credentials never appear in prompts or code, and a passkey/MFA login is needed only when the
 * saved session has expired.
 */
export async function authenticate(
  org: OrgConfig,
  stateDir: string,
  login: LoginOptions,
  cb: AuthCallbacks,
  force = false,
): Promise<AuthSession> {
  fs.mkdirSync(stateDir, { recursive: true });
  const slug = org.name.replace(/[^A-Za-z0-9_-]/g, "_");
  const storageStatePath = path.join(stateDir, `${slug}.storage.json`);
  const metaPath = path.join(stateDir, `${slug}.meta.json`);
  // Persistent login profile: Salesforce's "remember this browser" cookie survives between logins,
  // which avoids repeated device verification.
  const profileDir = path.join(stateDir, `${slug}.profile`);

  if (!force && fs.existsSync(storageStatePath) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (Date.now() - meta.savedAt < login.sessionMaxAgeHours * 3_600_000) {
      if (await sessionIsValid(storageStatePath, meta.instanceUrl)) {
        cb.log(`Reusing saved session for ${org.name} (${meta.instanceUrl})`);
        return { storageStatePath, instanceUrl: meta.instanceUrl };
      }
      cb.log("Saved session has expired - logging in again.");
    }
  }

  const save = async (context: BrowserContext, url: string): Promise<AuthSession> => {
    const instanceUrl = new URL(url).origin;
    await context.storageState({ path: storageStatePath });
    fs.writeFileSync(metaPath, JSON.stringify({ instanceUrl, savedAt: Date.now() }, null, 2));
    cb.log(`Logged in. Instance: ${instanceUrl}`);
    return { storageStatePath, instanceUrl };
  };

  const attempt = async (headless: boolean): Promise<AuthSession> => {
    const context = await launchLoginBrowser(profileDir, headless, login.browser, cb.log);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(org.authMode === "sfcli" ? frontdoorUrl(org) : org.loginUrl, { waitUntil: "domcontentloaded" });
      await skipInterstitial(page);

      // Already logged in thanks to the persistent profile, or via sf CLI frontdoor.
      if (LOGGED_IN(page.url())) {
        await settleOnLightning(page);
        return await save(context, page.url());
      }

      if (org.authMode !== "sfcli") await prefillLogin(page, org);

      if (!headless) {
        cb.needsUser?.(
          (org.authMode === "password"
            ? `Username and password entered for "${org.name}" - verify your passkey / MFA in the browser window. `
            : `Complete the Salesforce login for "${org.name}" in the browser window (passkey, MFA, SSO...). `) +
            `Waiting up to ${login.timeoutMinutes} minutes.`,
        );
      }
      try {
        await waitForLogin(page, headless ? HEADLESS_ATTEMPT_MS : login.timeoutMinutes * 60_000);
      } catch (e) {
        if ((e as Error).message.startsWith("Salesforce login failed")) throw e;
        if (headless) throw new NeedsUserError(`Login needs user interaction (stopped at ${safeUrl(page.url())})`);
        throw new Error(`Login was not completed within ${login.timeoutMinutes} minutes (stopped at ${safeUrl(page.url())})`);
      }
      await settleOnLightning(page);
      return await save(context, page.url());
    } finally {
      await context.close();
    }
  };

  const label = { password: "username/password", sfcli: "sf CLI frontdoor", interactive: "interactive login" }[org.authMode];
  cb.log(`Logging in to ${org.name} via ${label} (login browser: ${login.browserMode})...`);

  // sf CLI logins use the CLI token via frontdoor, so start in the background. If the org enforces passkey/MFA
  // registration, Salesforce still demands it once in the browser - then a window opens, exactly as in "auto".
  if (org.authMode === "sfcli" && login.browserMode === "headed") login = { ...login, browserMode: "auto" };
  if (login.browserMode === "headed" || (login.browserMode === "auto" && org.authMode === "interactive")) {
    return attempt(false);
  }
  if (login.browserMode === "headless") {
    try {
      return await attempt(true);
    } catch (e) {
      if (e instanceof NeedsUserError) {
        throw new Error(
          `${e.message}. Salesforce is asking for a passkey/MFA/verification - set the login browser to "auto" or ` +
            `"headed" (or click ESTABLISH UPLINK in the console) to complete it once.`,
        );
      }
      throw e;
    }
  }
  // auto: try silently first, open a visible window only if Salesforce wants a human.
  try {
    return await attempt(true);
  } catch (e) {
    if (!(e instanceof NeedsUserError)) throw e;
    cb.log("Salesforce needs interactive verification (passkey/MFA/SSO) - opening a visible browser.");
    return attempt(false);
  }
}

/**
 * Handles both login page styles:
 *  - classic: username + password on one page
 *  - identifier-first (login.salesforce.com since passkeys): username -> "Log In" -> password step,
 *    or a passkey/verification prompt for users that have one - that part is left to the user.
 */
async function prefillLogin(page: Page, org: OrgConfig) {
  const username = page.locator("#username");
  const password = page.locator("#password");
  await username.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (!org.username || !(await username.isVisible())) return;
  await username.fill(org.username);
  if (org.authMode !== "password" || !org.password) return; // interactive: user continues from here

  if (!(await password.isVisible())) {
    const clicked = await page.click("#Login", { timeout: 5000 }).then(() => true, () => false);
    if (!clicked) return;
    const next = await Promise.race([
      password.waitFor({ state: "visible", timeout: 15_000 }).then(() => "password"),
      page.locator("#error").waitFor({ state: "visible", timeout: 15_000 }).then(() => "error"),
      page.waitForURL(LOGGED_IN, { timeout: 15_000 }).then(() => "done"),
    ]).catch(() => "other"); // passkey prompt / verification page
    if (next !== "password") return;
  }
  await password.fill(org.password);
  await page.click("#Login");
}

/** Resolves when logged in; rejects with the Salesforce error text as soon as the login page shows one. */
/**
 * Post-login prompts ("Add a passkey", "Add your phone number", ...). Optional ones offer Skip / Remind me later
 * and are clicked through; mandatory ones ("Your account requires a passkey") are left to the user.
 */
const INTERSTITIAL = /\/_ui\/identity\/(webauthn\/AddPasskeyUi|phone\/AddPhoneNumber|verification\/method\/AddVerificationMethod)/i;
const SKIP_LABEL = /^\s*(skip|remind me later|not now|maybe later|do this later|i.ll do it later)\s*$/i;

/** Waits for the redirect to the Lightning domain so its cookies are part of the saved session. */
async function settleOnLightning(page: Page) {
  await page.waitForURL(/\.lightning\.force\.com/, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function skipInterstitial(page: Page): Promise<boolean> {
  if (!INTERSTITIAL.test(page.url())) return false;
  const skip = page.getByRole("link", { name: SKIP_LABEL }).or(page.getByRole("button", { name: SKIP_LABEL })).first();
  if (!(await skip.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  await skip.click().catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  return true;
}

async function waitForLogin(page: Page, timeout: number) {
  const failed = page
    .locator("#error")
    .filter({ hasText: /\S/ })
    .waitFor({ state: "visible", timeout })
    .then(async () => {
      throw new Error(`Salesforce login failed: ${(await page.locator("#error").textContent())?.trim()}`);
    });
  failed.catch(() => undefined);
  const nudges = (async () => {
    const end = Date.now() + timeout;
    while (Date.now() < end && !page.isClosed()) {
      await skipInterstitial(page);
      if (LOGGED_IN(page.url())) return;
      await page.waitForTimeout(1000);
    }
    throw new Error("timeout");
  })();
  nudges.catch(() => undefined);
  await Promise.race([page.waitForURL(LOGGED_IN, { timeout }), failed, nudges]);
}

async function launchLoginBrowser(
  profileDir: string,
  headless: boolean,
  browser: LoginOptions["browser"],
  log: (m: string) => void,
): Promise<BrowserContext> {
  // Branded Edge/Chrome talk to the OS passkey providers (Windows Hello, phone via QR) most reliably.
  const channel = browser === "default" ? (process.platform === "win32" ? "msedge" : "chrome") : browser;
  const opts = { headless, viewport: { width: 1440, height: 900 } };
  if (channel !== "chromium") {
    try {
      return await chromium.launchPersistentContext(`${profileDir}-${channel}`, { ...opts, channel });
    } catch (e) {
      log(`Could not start ${channel} (${(e as Error).message.split("\n")[0]}); falling back to bundled Chromium.`);
    }
  }
  return chromium.launchPersistentContext(`${profileDir}-chromium`, opts);
}

async function sessionIsValid(storageStatePath: string, instanceUrl: string): Promise<boolean> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: storageStatePath });
    const page = await context.newPage();
    await page.goto(`${instanceUrl}/lightning/page/home`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForURL(LOGGED_IN, { timeout: 15_000 }).catch(() => undefined);
    return LOGGED_IN(page.url());
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}

function frontdoorUrl(org: OrgConfig): string {
  const alias = org.sfAlias ?? "";
  if (!/^[\w.@+-]+$/.test(alias)) throw new Error(`Invalid sf CLI alias/username: "${alias}"`);
  const out = execFileSync("sf", ["org", "open", "--target-org", alias, "--url-only", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const url = JSON.parse(out)?.result?.url;
  if (!url) throw new Error(`sf org open returned no URL for "${alias}"`);
  return url;
}
