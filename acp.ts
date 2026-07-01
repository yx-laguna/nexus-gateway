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
} from "@virtuals-protocol/acp-node-v2";
import type { JobSession, JobRoomEntry } from "@virtuals-protocol/acp-node-v2";
import { baseSepolia } from "@account-kit/infra";
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

// ---------------------------------------------------------------------------
// Init — call once at startup
// ---------------------------------------------------------------------------

export async function initAcp(): Promise<void> {
  acpClient = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: CLIENT_WALLET(),
      walletId: CLIENT_PRIVY_ID(),
      signerPrivateKey: CLIENT_PRIVY_SIGNER(),
      chains: [baseSepolia],
    }),
  });

  acpClient.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind !== "system") return;
    const p = pending.get(session.jobId);

    switch (entry.event.type) {
      case "budget.set":
        await session.fund(AssetToken.usdc(0, session.chainId));
        return;

      case "job.submitted": {
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
        p?.reject(new Error("ACP job rejected by provider"));
        pending.delete(session.jobId);
        return;
    }
  });

  await acpClient.start();
  console.log("[acp] ACP client started");
}

// ---------------------------------------------------------------------------
// acpMintLink — drop-in replacement for laguna.mintLink for the mint step
// ---------------------------------------------------------------------------

export async function acpMintLink(params: {
  merchant_id: string;
  geo?: string | null;
  caller_tag?: string;
}): Promise<MintedLink> {
  if (!acpClient) throw new Error("[acp] ACP client not initialised — call initAcp() first");

  const providerAddr = PROVIDER_ADDR();
  const agents = await acpClient.browseAgents("Laguna Affiliate", { topK: 5 });
  const provider = agents.find(
    (a) => a.walletAddress.toLowerCase() === providerAddr,
  );
  if (!provider) throw new Error(`[acp] Provider ${providerAddr} not found in registry`);

  const offering = provider.offerings.find((o) => o.name === "mint-affiliate-link");
  if (!offering) throw new Error("[acp] mint-affiliate-link offering not published");

  const requirement: Record<string, string> = {
    merchant_id: params.merchant_id,
  };
  if (params.geo) requirement.geo = params.geo.toUpperCase();
  if (params.caller_tag) requirement.caller_tag = params.caller_tag;

  const jobId = await acpClient.createJobFromOffering(
    baseSepolia.id,
    offering,
    provider.walletAddress,
    requirement,
    { evaluatorAddress: await acpClient.getAddress() },
  );

  console.log(`[acp] job ${jobId} created for merchant=${params.merchant_id} geo=${params.geo ?? "SG"}`);

  return new Promise<MintedLink>((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    setTimeout(() => {
      if (pending.has(jobId)) {
        pending.delete(jobId);
        reject(new Error(`[acp] Job ${jobId} timed out (90s)`));
      }
    }, 90_000);
  });
}
