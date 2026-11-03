import * as fs from "fs";
import * as path from "path";
import { BrowserHost } from "./browserHost";
import { TestCase } from "./types";
import { caseHash } from "./runner";

/**
 * Browser actions of a manual run that passed, as the Playwright code Playwright MCP reported for each action.
 * A later manual run of the unchanged case replays them at Playwright speed, and the AI only judges the results.
 */
export interface Recording {
  caseHash: string;
  /** Page the case started on (the flow may begin by clicking around it rather than navigating) */
  startUrl?: string;
  actions: string[];
  recordedAt: string;
  model?: string;
}

export const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "suite";

/** Recordings of one suite, one JSON file per case under .sf-ai-tester/recordings/<suite>/. */
export class Recordings {
  constructor(private dir: string) {}
  private file(tc: TestCase) {
    return path.join(this.dir, `${slug(tc.id)}.json`);
  }
  /** The case's recording, only while the case definition is unchanged. */
  get(tc: TestCase): Recording | undefined {
    try {
      const rec = JSON.parse(fs.readFileSync(this.file(tc), "utf8")) as Recording;
      return rec.caseHash === caseHash(tc) && rec.actions?.length ? rec : undefined;
    } catch {
      return undefined;
    }
  }
  save(tc: TestCase, rec: Omit<Recording, "caseHash" | "recordedAt">) {
    fs.mkdirSync(this.dir, { recursive: true });
    const full: Recording = { caseHash: caseHash(tc), recordedAt: new Date().toISOString(), ...rec };
    fs.writeFileSync(this.file(tc), JSON.stringify(full, null, 2));
  }
  remove(tc: TestCase) {
    fs.rmSync(this.file(tc), { force: true });
  }
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/**
 * Replays a recording in the worker's browser, in-process. Every action auto-waits like a Playwright test, so slow
 * Lightning pages do not need AI round trips. Stops at the first action that fails.
 */
export async function replayRecording(rec: Recording, host: BrowserHost): Promise<{ ok: true; seconds: number } | { ok: false; error: string }> {
  const page = await host.page();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(60_000);
  const started = Date.now();
  let i = -1;
  try {
    if (rec.startUrl && /^https?:/.test(rec.startUrl)) await page.goto(rec.startUrl, { waitUntil: "domcontentloaded" });
    for (i = 0; i < rec.actions.length; i++) await new AsyncFunction("page", rec.actions[i])(page);
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    const where = i < 0 ? `the start page ${rec.startUrl}` : `action ${i + 1}/${rec.actions.length} (${rec.actions[i].split("\n")[0].slice(0, 120)})`;
    return { ok: false, error: `${where}: ${String((e as Error).message ?? e).split("\n")[0]}` };
  }
}
