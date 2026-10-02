import { TestCase, TestSuite } from "./types";

export type Target = "salesforce" | "web";

const SALESFORCE_HOST = /(^|\.)(salesforce\.com|force\.com|salesforce-setup\.com|salesforce-sites\.com|visualforce\.com|lightning\.force\.com|my\.site\.com|cloudforce\.com)$/i;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+|\blocalhost(:\d+)?(\/[^\s"'<>)]*)?/gi;

/** Hosts mentioned in free text (full URLs and bare localhost). */
function hosts(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => {
    try {
      return new URL(/^https?:/i.test(u) ? u : `http://${u}`).hostname;
    } catch {
      return "";
    }
  });
}

export const isSalesforceUrl = (url: string) => hosts(url).some((h) => SALESFORCE_HOST.test(h));

/**
 * What a test case runs against.
 * - explicit `target` on the case, else on the suite ("salesforce" | "web");
 * - "auto" (default): web when the case (steps/preconditions) or the suite base URL points at a non-Salesforce
 *   site - e.g. http://localhost:8080 - otherwise the connected Salesforce org.
 */
export function resolveTarget(tc: TestCase, suite: TestSuite): Target {
  if (tc.target === "salesforce" || tc.target === "web") return tc.target;
  if (suite.target === "salesforce" || suite.target === "web") return suite.target;
  const caseHosts = hosts([...(tc.preconditions ?? []), ...tc.steps].join("\n")).filter(Boolean);
  if (caseHosts.length) return caseHosts.some((h) => !SALESFORCE_HOST.test(h)) ? "web" : "salesforce";
  if (suite.baseUrl && !isSalesforceUrl(suite.baseUrl)) return "web";
  return "salesforce";
}
