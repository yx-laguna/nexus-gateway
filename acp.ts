/**
 * acp.ts
 *
 * ACP v2 client that routes mint_link calls through the ACPLagunaTranslator
 * provider agent instead of hitting the Laguna MCP directly.
 *
 * One persistent AcpAgent is shared for the lifetime of the process.
 * Call initAcp() once at startup, then use acpMintLink() anywhere.
 */

import "dotenv/config";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  AssetToken,
  SocketTransport,
} from "@virtuals-protocol/acp-node-v2";
import type { JobSession, JobRoomEntry } from "@virtuals-protocol/acp-node-v2";
import { base } from "@account-kit/infra";
import type { MintedLink } from "./laguna.js";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

const CLIENT_WALLET       = () => requireEnv("ACP_CLIENT_WALLET")            as `0x${string}`;
const CLIENT_PRIVY_ID     = () => requireEnv("ACP_CLIENT_PRIVY_WALLET_ID");
const CLIENT_PRIVY_SIGNER = () => requireEnv("ACP_CLIENT_PRIVY_SIGNER_PK");
const PROVIDER_ADDR       = () => requireEnv("ACP_PROVIDER_ADDRESS").toLowerCase();

// ---------------------------------------------------------------------------
// Pending job tracking
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (link: MintedLink) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, Pending>();
// Store real JobSession objects from socket events so the polling fallback can fund jobs
// even when the socket drops mid-flow (budget.set fires on socket, but then it drops).
const sessionMap = new Map<string, JobSession>();
let acpClient: Awaited<ReturnType<typeof AcpAgent.create>> | null = null;
let acpStarted = false;

/** Returns true only after acpClient.start() has resolved — safe to call acpMintLink */
export function isAcpReady(): boolean { return acpStarted; }

// ---------------------------------------------------------------------------
// Init — call once at startup
// ---------------------------------------------------------------------------

export async function initAcp(): Promise<void> {
  acpClient = await AcpAgent.create({
    transport: new SocketTransport(),   // SSE silently swallows connect errors; Socket rejects properly
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: CLIENT_WALLET(),
      walletId: CLIENT_PRIVY_ID(),
      signerPrivateKey: CLIENT_PRIVY_SIGNER(),
      chains: [base],
    }),
  });

  acpClient.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    // Always store the real session so polling fallback can call session.fund()
    sessionMap.set(session.jobId, session);

    if (entry.kind !== "system") return;
    const p = pending.get(session.jobId);

    switch (entry.event.type) {
      case "budget.set": {
        const budgetEntry = entry as unknown as { event: { budget?: { amount?: string | number } } };
        const budgetAmt = Number(budgetEntry.event?.budget?.amount ?? 0.01);
        console.log(`[acp] budget.set job=${session.jobId} amount=${budgetAmt} — funding now`);
        await session.fund(AssetToken.usdc(budgetAmt, session.chainId));
        return;
      }

      case "job.submitted": {
        console.log(`[acp] job.submitted received job=${session.jobId}`);
        try {
          const raw = (entry as unknown as { event: { deliverable: string } }).event.deliverable;
          const deliverable = JSON.parse(raw) as {
            payload?: { shortlink?: string; merchant_id?: string };
            shortlink?: string;
            merchant_id?: string;
          };
          const shortlink =
            deliverable?.payload?.shortlink ?? deliverable?.shortlink;
          const merchant_id =
            deliverable?.payload?.merchant_id ?? deliverable?.merchant_id ?? "";
          if (!shortlink) throw new Error("No shortlink in ACP deliverable");
          await session.complete("thanks");
          p?.resolve({ shortlink, merchant_id });
        } catch (err) {
          p?.reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      case "job.completed": {
        console.log(`[acp] job.completed received job=${session.jobId}`);
        if (!p) { pending.delete(session.jobId); return; }
        try {
          // In skip-eval mode the job auto-completes without a client job.submitted.
          // Fetch full history to find the submitted deliverable.
          const transport = (acpClient as unknown as { transport: { getHistory: (chainId: number, jobId: string) => Promise<JobRoomEntry[]> } }).transport;
          const history = await transport.getHistory(session.chainId, session.jobId);
          console.log(`[acp] job.completed history entries: ${history.length}`);
          const submitEntry = history.find(
            (e) => e.kind === "system" && (e as unknown as { event: { type: string } }).event?.type === "job.submitted"
          ) as unknown as { event: { deliverable: string } } | undefined;
          if (!submitEntry) throw new Error("No job.submitted entry in history");
          const deliverable = JSON.parse(submitEntry.event.deliverable) as {
            payload?: { shortlink?: string; merchant_id?: string };
            shortlink?: string;
            merchant_id?: string;
          };
          const shortlink = deliverable?.payload?.shortlink ?? deliverable?.shortlink;
          const merchant_id = deliverable?.payload?.merchant_id ?? deliverable?.merchant_id ?? "";
          if (!shortlink) throw new Error("No shortlink in ACP deliverable");
          p.resolve({ shortlink, merchant_id });
        } catch (err) {
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
        pending.delete(session.jobId);
        return;
      }

      case "job.rejected":
        console.log(`[acp] job.rejected job=${session.jobId}`);
        p?.reject(new Error("ACP job rejected by provider"));
        pending.delete(session.jobId);
        return;
    }
  });

  await acpClient.start();
  acpStarted = true;
  console.log("[acp] ACP client started — ready for mint jobs");
}

// ---------------------------------------------------------------------------
// acpMintLink — drop-in replacement for laguna.mintLink for the mint step
// ---------------------------------------------------------------------------

const ACP_TOTAL_TIMEOUT_MS = 120_000; // 2 min hard ceiling — covers browseAgents + job wait

export async function acpMintLink(params: {
  merchant_id: string;
  geo?: string | null;
  caller_tag?: string;
  wallet_address?: string;
}): Promise<MintedLink> {
  if (!acpClient) throw new Error("[acp] ACP client not initialised — call initAcp() first");

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`[acp] acpMintLink timed out after ${ACP_TOTAL_TIMEOUT_MS / 1000}s`)), ACP_TOTAL_TIMEOUT_MS)
  );

  return Promise.race([_acpMintLink(params), timeoutPromise]);
}

async function _acpMintLink(params: {
  merchant_id: string;
  geo?: string | null;
  caller_tag?: string;
  wallet_address?: string;
}): Promise<MintedLink> {
  // Wait for acpClient.start() to complete before making any calls
  const waitStart = Date.now();
  while (!acpStarted) {
    if (Date.now() - waitStart > 60_000) throw new Error("[acp] timed out waiting for ACP client to start");
    console.log("[acp] waiting for start()...");
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const providerAddr = PROVIDER_ADDR();
  const agents = await acpClient!.browseAgents("Laguna Affiliate", { topK: 5 });
  const provider = agents.find(
    (a) => a.walletAddress.toLowerCase() === providerAddr,
  );
  if (!provider) throw new Error(`[acp] Provider ${providerAddr} not found in registry`);

  console.log(`[acp] provider offerings:`, provider.offerings.map((o) => o.name));
  const offering = provider.offerings.find((o) => o.name === "mint_link");
  if (!offering) throw new Error("[acp] mint_link offering not published");

  // Log full offering object to check requiredFunds, slaMinutes, etc.
  console.log(`[acp] offering object:`, JSON.stringify(offering));

  const requirement: Record<string, string> = {
    merchant_id: params.merchant_id,
  };
  if (params.geo) requirement.geo = params.geo.toUpperCase();
  if (params.caller_tag) requirement.caller_tag = params.caller_tag;
  if (params.wallet_address) requirement.wallet_address = params.wallet_address;

  let jobId!: bigint;
  try {
    // Omit evaluatorAddress → zero address = skip-evaluation mode (auto-completes on submit)
    jobId = await acpClient!.createJobFromOffering(
      base.id,
      offering,
      provider.walletAddress,
      requirement,
    );
  } catch (err) {
    // Log full error chain so we can see HTTP status + URL
    const details: Record<string, unknown> = {};
    if (err instanceof Error) {
      details.name = err.name;
      details.message = err.message;
      details.shortMessage = (err as Record<string, unknown>).shortMessage;
      details.metaMessages = (err as Record<string, unknown>).metaMessages;
      details.status = (err as Record<string, unknown>).status;
      details.url = (err as Record<string, unknown>).url;
      const cause = err.cause;
      if (cause instanceof Error) {
        details.cause = { name: cause.name, message: cause.message };
      }
    }
    console.error(`[acp] createJobFromOffering FAILED:`, JSON.stringify(details, null, 2));
    throw err;
  }

  const jobIdStr = jobId.toString();
  console.log(`[acp] job ${jobIdStr} created for merchant=${params.merchant_id} geo=${params.geo ?? "SG"}`);

  return new Promise<MintedLink>((resolve, reject) => {
    pending.set(jobIdStr, { resolve, reject });

    // ── Polling fallback ────────────────────────────────────────────────────
    // The client socket can drop silently. If that happens the socket-driven
    // handlers (budget.set → fund, job.completed → resolve) never fire.
    // We poll the job's chat history every 5 s so the critical path still
    // works even when the socket is stale.
    let funded = false;
    const pollInterval = setInterval(async () => {
      if (!pending.has(jobIdStr)) { clearInterval(pollInterval); return; }
      try {
        const transport = (acpClient as unknown as { transport: { getHistory: (c: number, j: string) => Promise<Array<{ kind: string; event?: { type?: string; deliverable?: string; budget?: { amount?: number } } }>> } }).transport;
        const history = await transport.getHistory(base.id, jobIdStr);

        type HistEntry = { kind: string; event?: { type?: string; deliverable?: string; budget?: { amount?: number } } };
        const byType = (t: string) => history.find((e: HistEntry) => e.kind === "system" && e.event?.type === t);

        const submitEntry = byType("job.submitted");
        const completedEntry = byType("job.completed");

        // If submitted or completed — extract deliverable and resolve
        if ((submitEntry || completedEntry) && pending.has(jobIdStr)) {
          const raw = (submitEntry ?? completedEntry)?.event?.deliverable;
          if (raw) {
            const d = JSON.parse(raw) as { payload?: { shortlink?: string; merchant_id?: string }; shortlink?: string; merchant_id?: string };
            const shortlink = d?.payload?.shortlink ?? d?.shortlink;
            const merchant_id = d?.payload?.merchant_id ?? d?.merchant_id ?? "";
            if (shortlink) {
              console.log(`[acp] poll: job ${jobIdStr} complete — resolving via history`);
              clearInterval(pollInterval);
              pending.delete(jobIdStr);
              resolve({ shortlink, merchant_id });
              return;
            }
          }
        }

        // If budget.set found but not yet funded — fund it using the stored real session
        const budgetEntry = byType("budget.set");
        const fundedEntry = byType("job.funded");
        if (budgetEntry && !fundedEntry && !funded) {
          const storedSession = sessionMap.get(jobIdStr);
          if (!storedSession) {
            // Socket dropped and never delivered session via on("entry").
            // Call hydrateSessions() to force-load sessions from the API — this will
            // trigger on("entry") callbacks which populate sessionMap and fund the job.
            console.log(`[acp] poll: budget.set for job ${jobIdStr} but no session — calling hydrateSessions`);
            try {
              const agentAny = acpClient as unknown as { hydrateSessions?: () => Promise<void> };
              if (agentAny.hydrateSessions) {
                await agentAny.hydrateSessions();
                console.log(`[acp] poll: hydrateSessions called — on("entry") callbacks should fund job ${jobIdStr}`);
              } else {
                console.warn(`[acp] poll: hydrateSessions not available on acpClient`);
              }
            } catch (hydrateErr) {
              console.warn(`[acp] poll: hydrateSessions error for job ${jobIdStr}:`, hydrateErr instanceof Error ? hydrateErr.message : hydrateErr);
            }
            // If on("entry") funded synchronously, mark funded so we don't double-fund
            if (sessionMap.has(jobIdStr)) funded = true;
          } else {
            funded = true;
            const amt = budgetEntry.event?.budget?.amount ?? 0.01;
            console.log(`[acp] poll: funding job ${jobIdStr} with ${amt} USDC via stored session`);
            try {
              await storedSession.fund(AssetToken.usdc(Number(amt), base.id));
              console.log(`[acp] poll: funded job ${jobIdStr} ✅`);
            } catch (fundErr) {
              console.warn(`[acp] poll: fund failed for job ${jobIdStr}:`, fundErr instanceof Error ? fundErr.message : fundErr);
              funded = false; // allow retry next tick
            }
          }
        }
      } catch (pollErr) {
        console.warn(`[acp] poll error for job ${jobIdStr}:`, pollErr instanceof Error ? pollErr.message : pollErr);
      }
    }, 5_000);

    setTimeout(() => {
      if (pending.has(jobIdStr)) {
        clearInterval(pollInterval);
        pending.delete(jobIdStr);
        reject(new Error(`[acp] Job ${jobIdStr} timed out (5min waiting for provider)`));
      }
    }, 300_000);
  });
}
