/**
 * charted-sea-client.ts
 *
 * Thin client for Charted Sea (chartedsea.com) — a paid scraping-as-a-service API
 * that gives structured access to Shopee's and Lazada's own backend APIs (see
 * chartedsea.com/docs/api-reference). NOT an affiliate/deep-link service — it
 * returns the platforms' own canonical data (including, conveniently, their own
 * canonical product page URLs), nothing wrapped or tracked.
 *
 * Used by:
 *   - lazada-search.ts — live Lazada keyword search, called inline on every
 *     recommendation turn. Verified live (2026-07-06): fast (~25s) and reliable.
 *   - shopee-live-search.ts — live Shopee keyword search, commit-time price-check
 *     ONLY, never inline. Verified live (2026-07-06) that Shopee's web scraper can
 *     take 2+ minutes and fail outright (BLOCKED_TOO_MANY_TIMES) even on a plain
 *     keyword search — a real, routine failure mode, not an edge case.
 *
 * Task lifecycle (see docs): submit with waitForCompletion=false, then poll
 * /scraping-tasks/{scraper}?uuids=... until a terminal status. Deliberately NOT
 * using waitForCompletion=true — a held-open HTTP connection that outlives our own
 * wait budget would cancel the task server-side too (per Charted Sea's own docs),
 * so polling gives us control over exactly how long we're willing to wait instead
 * of an all-or-nothing single request.
 */

const BASE_URL = "https://continuous-scraper.common.chartedapi.com";

export type ChartedSeaScraper = "shopee" | "lazada";

function getToken(): string {
  const token = process.env.CHARTEDSEA_API_TOKEN;
  if (!token) throw new Error("CHARTEDSEA_API_TOKEN is not set.");
  return token;
}

interface SubmitResponseItem {
  uuid?: string;
  status?: string;
}

async function submitTask(scraper: ChartedSeaScraper, url: string): Promise<string> {
  // Per-request timeout — without this, a single stalled HTTP request (not a slow
  // scrape, an actually-hung connection) could block past runScrapingTask's own
  // maxWaitMs deadline entirely, since that deadline is only checked BETWEEN loop
  // iterations, not during an in-flight fetch. Caught live (2026-07-06) while smoke
  // testing this file.
  const res = await fetch(`${BASE_URL}/scraping-tasks/${scraper}/run?waitForCompletion=false`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [{ url }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`[charted-sea] submit failed for ${scraper}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as SubmitResponseItem[];
  const uuid = body[0]?.uuid;
  if (!uuid) throw new Error(`[charted-sea] submit response for ${scraper} missing a task uuid`);
  return uuid;
}

interface PollResponseItem {
  status: string;
  responseBody: string | null;
  errorMessage: string | null;
}

async function pollTask(scraper: ChartedSeaScraper, uuid: string): Promise<PollResponseItem | null> {
  const res = await fetch(`${BASE_URL}/scraping-tasks/${scraper}?uuids=${uuid}&includeAllFields=true`, {
    headers: { Authorization: `Bearer ${getToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[charted-sea] poll failed for ${scraper}: HTTP ${res.status}`);
  const body = (await res.json()) as { items?: PollResponseItem[] };
  return body.items?.[0] ?? null;
}

// Statuses that mean "the task will never progress further" — see the lifecycle
// listed in the API docs. BLOCKED/ERROR (without "_TOO_MANY_TIMES") are recoverable
// and get retried automatically server-side, so those are NOT terminal here.
const TERMINAL_STATUSES = new Set(["SUCCESS", "BLOCKED_TOO_MANY_TIMES", "ERROR_TOO_MANY_TIMES", "CANCELLED", "REPLACED"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submit a scraping task and poll until it reaches a terminal status or maxWaitMs
 * elapses. Returns the parsed JSON responseBody on SUCCESS, or null for every other
 * outcome — a block/timeout/error here is a normal, expected result (especially for
 * Shopee), not a bug, so this deliberately never throws for those cases. Only a
 * missing CHARTEDSEA_API_TOKEN or a malformed API response throws.
 */
export async function runScrapingTask(
  scraper: ChartedSeaScraper,
  url: string,
  opts: { maxWaitMs?: number; pollIntervalMs?: number } = {}
): Promise<unknown | null> {
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + maxWaitMs;

  let uuid: string;
  try {
    uuid = await submitTask(scraper, url);
  } catch (err) {
    console.error(`[charted-sea] ${scraper} submit error for ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    let task: PollResponseItem | null;
    try {
      task = await pollTask(scraper, uuid);
    } catch (err) {
      console.warn(`[charted-sea] ${scraper} poll error (will retry):`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!task) continue;

    if (task.status === "SUCCESS") {
      try {
        return JSON.parse(task.responseBody ?? "null");
      } catch {
        console.warn(`[charted-sea] ${scraper} task SUCCEEDED but responseBody wasn't valid JSON`);
        return null;
      }
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      console.warn(
        `[charted-sea] ${scraper} task ended in ${task.status} for ${url}${task.errorMessage ? `: ${task.errorMessage}` : ""}`
      );
      return null;
    }
    // PENDING / RUNNING / BLOCKED (still being retried server-side) — keep polling.
  }

  console.warn(`[charted-sea] ${scraper} task for ${url} did not finish within ${maxWaitMs}ms — giving up`);
  return null;
}
