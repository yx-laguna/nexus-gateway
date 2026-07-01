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

      case "job.completed":
        pending.delete(session.jobId);
        return;

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
    setTimeout(() => {
      if (pending.has(jobIdStr)) {
        pending.delete(jobIdStr);
        reject(new Error(`[acp] Job ${jobIdStr} timed out (90s waiting for provider)`));
      }
    }, 90_000);
  });
}
