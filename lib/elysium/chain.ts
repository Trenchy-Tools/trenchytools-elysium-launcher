/**
 * Elysium (Kinetiq's Hyperliquid L2, Arbitrum Orbit, chain 99901, HYPE as the native coin) as this app sees it:
 * the chain, the relays, the contracts and one public client. Server-side only (node fetch, no window).
 *
 * RELAYS. There is no official public RPC before the public launch; the community relays all front the one
 * sequencer. Measured 11/5: Agoradex ~200 ms, Volta ~250 ms, Kleos ~500 ms, BOXA ~250 ms but refuses web origins and
 * holds sends in its own queue, ElysPump 2–5 s with drops. Reads run over the fast three; every signed transaction
 * goes to ALL send relays at once (fanout-send.ts) and the first acceptance wins. ELYSIUM_RPC_URLS (comma list)
 * overrides the defaults; the official Conduit endpoint goes first the day it opens.
 *
 * CONTRACTS are Ascend's published mainnet set (from block 422319), cross-checked against live launches and trades.
 */
import { createPublicClient, defineChain, fallback, http, type Address, type Hex, type PublicClient } from "viem"
import { fanoutSendRaw } from "./fanout-send"

export const ELYSIUM_CHAIN_ID = 99901

export type SimCall = { from: Address; to: Address; data: Hex; value: bigint }
export type SimStep = { ok: boolean; gasUsed: bigint | null; error: string | null }
/**
 * eth_simulateV1: the calls run one after another on top of the latest block, each seeing the state the previous
 * ones left (so a wrap → approve → create sequence dry-runs as a whole). Tried over the read relays in order; a relay
 * without the method (-32601) is skipped; null when none has it. `validation: false` keeps nonces and balances out of
 * the way except where a call itself needs value.
 */
export async function simulateSequence(calls: SimCall[]): Promise<SimStep[] | null> {
  const body = { jsonrpc: "2.0", id: 1, method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls: calls.map((c) => ({ from: c.from, to: c.to, data: c.data, value: `0x${c.value.toString(16)}` })) }], validation: false, traceTransfers: false }, "latest"] }
  for (const url of READ_RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      const j = await r.json() as { result?: Array<{ calls: Array<{ status: string; gasUsed?: string; returnData?: string; error?: { message?: string } }> }>; error?: { code?: number; message?: string } }
      if (j.error) {
        if (j.error.code === -32601 || /not available|not supported|unknown method/i.test(j.error.message ?? "")) continue
        // the whole simulation was refused (e.g. the sender cannot cover a value): report it on the first call
        return calls.map((_, i) => ({ ok: false, gasUsed: null, error: i === 0 ? (j.error!.message ?? "simulation refused").slice(0, 200) : "not reached" }))
      }
      const out = j.result?.[0]?.calls ?? []
      if (out.length !== calls.length) continue
      return out.map((c) => ({ ok: c.status === "0x1", gasUsed: c.gasUsed ? BigInt(c.gasUsed) : null, error: c.status === "0x1" ? null : (c.error?.message ?? "reverted").slice(0, 200) }))
    } catch { continue }
  }
  return null
}

const DEFAULT_RPCS = ["https://rpc.agoradex.app", "https://rpc.volta.family", "https://rpc.thekleos.pro/rpc", "https://rpc-live.elysp.com"]
const envList = (k: string) => (process.env[k] || "").split(",").map((s) => s.trim()).filter((u) => /^https:\/\//.test(u))

/** Every relay a signed transaction is broadcast to. */
export const SEND_RPCS: string[] = envList("ELYSIUM_RPC_URLS").length ? envList("ELYSIUM_RPC_URLS") : DEFAULT_RPCS
/** The relays reads run over: the ones that answered at full speed. ElysPump throttles, so it only backs the others up. */
export const READ_RPCS: string[] = envList("ELYSIUM_READ_RPC_URLS").length ? envList("ELYSIUM_READ_RPC_URLS") : SEND_RPCS.filter((u) => !/elysp\.com/.test(u)).concat(SEND_RPCS.filter((u) => /elysp\.com/.test(u)))

export const elysium = defineChain({
  id: ELYSIUM_CHAIN_ID,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: READ_RPCS } },
  blockExplorers: { default: { name: "Elyscan", url: "https://elyscan.live" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
})

export const ADDR = {
  whype: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address,
  usdc: "0xb47c4C8F3cA1b4b4A5B5bFfE6b2b2fE3B19F6f0a" as Address,
  poolManager: "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1" as Address,
  universalRouter: "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a" as Address,
  quoter: "0x379F556c5a748BD7Cc9baF0F7A344094Ac1814f5" as Address,
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE" as Address,
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  // Ascend
  launchpad: "0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC" as Address,
  escrowFactory: "0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19" as Address,
  ruleSet: "0xA9a627729D04576D8f79E3279bd17429C7794712" as Address,
} as const

let client: PublicClient | null = null
/** One public client over the read relays, 200 ms receipt polling (160 ms blocks). */
export function publicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: elysium,
      transport: fallback(READ_RPCS.map((u) => http(u, { timeout: 8_000, retryCount: 1, batch: false })), { retryCount: 0 }),
      pollingInterval: 200,
    }) as PublicClient
  }
  return client
}

/** Broadcast signed bytes to every send relay at once; the hash, however it was accepted. */
export async function sendRaw(raw: Hex): Promise<Hex> {
  const r = await fanoutSendRaw(SEND_RPCS, raw, { onRefusal: (url, err) => console.info(`[fanout] ${new URL(url).host}: ${err.slice(0, 80)}`) })
  console.info(`[fanout] ${r.acceptedBy ? `accepted by ${new URL(r.acceptedBy).host}` : "every relay already had it"} ${r.hash.slice(0, 12)}`)
  return r.hash
}

export const EXPLORER = "https://elyscan.live"
export const ASCEND_APP = "https://app.ascendlaunch.xyz"
export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addressLink = (a: string) => `${EXPLORER}/address/${a}`
export const tokenLink = (t: string) => `${EXPLORER}/token/${t}`
export const ascendToken = (t: string) => `${ASCEND_APP}/tokens/${t.toLowerCase()}`

/** A plain HYPE transfer on an Orbit chain needs the L1 data fee folded into gas: 200k is the floor, the real estimate is ~142k. */
export const TRANSFER_GAS = 200_000n
