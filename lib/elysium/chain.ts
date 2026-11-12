/**
 * Elysium (Kinetiq's Hyperliquid L2, Arbitrum Orbit, chain 99901, HYPE as the native coin) as this app sees it:
 * the chain, the relays, the contracts and one public client. Server-side only (node fetch, no window).
 *
 * RPCS. The official RPC (rpc.elysium.kinetiq.xyz, open since 11/8) goes first, with the community relays behind it;
 * they all front the one sequencer. Launches through this list land in about 0.4 s; through the relays alone, before
 * the chain opened, they waited about 15 s. Reads run over the fast ones; every signed transaction goes to ALL of them
 * at once (fanout-send.ts) and the first acceptance wins. ELYSIUM_RPC_URLS (comma list) overrides the defaults.
 *
 * CONTRACTS are Ascend's published mainnet set (from block 422319), cross-checked against live launches and trades.
 */
import { createPublicClient, defineChain, fallback, http, type Address, type Hex, type PublicClient } from "viem"
import { sendBatchTo } from "./fanout-send"
import { appState } from "../state"

export const ELYSIUM_CHAIN_ID = 99901

export type SimCall = { from: Address; to: Address; data: Hex; value: bigint; gas?: bigint }
export type SimStep = { ok: boolean; gasUsed: bigint | null; error: string | null }
/**
 * eth_simulateV1: the calls run one after another on top of the latest block, each seeing the state the previous
 * ones left (so a wrap → approve → create sequence dry-runs as a whole). Tried over the read relays in order; a relay
 * without the method (-32601) is skipped; null when none has it. `validation: false` keeps nonces and balances out of
 * the way except where a call itself needs value.
 */
export async function simulateSequence(calls: SimCall[]): Promise<SimStep[] | null> {
  const r = await simulateRaw(calls, false)
  if (!r) return null
  // the whole simulation was refused (e.g. the sender cannot cover a value): report it on the first call
  if ("refused" in r) return calls.map((_, i) => ({ ok: false, gasUsed: null, error: i === 0 ? r.refused : "not reached" }))
  return r.calls.map((c) => ({ ok: c.status === "0x1", gasUsed: c.gasUsed ? BigInt(c.gasUsed) : null, error: c.status === "0x1" ? null : (c.error?.message ?? "reverted").slice(0, 200) }))
}

type RawSimCall = { status: string; gasUsed?: string; returnData?: string; error?: { message?: string }; logs?: Array<{ address: string; topics: string[]; data: string }> }
export type SimResult = { ok: boolean; returnData: Hex; gasUsed: bigint | null; error: string | null }
/**
 * The calls run in order with `balances` overriding native balances first, so a launch can be tried before its wallet
 * holds the money. What the launcher runs before it signs: each result carries the return data (the coin's address)
 * and the gas used (a launch close to its gas cap is one storage write from reverting). Null when no RPC can simulate.
 */
export async function simulateCalls(calls: SimCall[], balances: Record<string, bigint>): Promise<SimResult[] | null> {
  const r = await simulateRaw(calls, false, balances)
  if (!r) return null
  if ("refused" in r) return calls.map((_, i) => ({ ok: false, returnData: "0x", gasUsed: null, error: i === 0 ? r.refused : "not reached" }))
  return r.calls.map((c) => ({ ok: c.status === "0x1", returnData: (c.returnData ?? "0x") as Hex, gasUsed: c.gasUsed ? BigInt(c.gasUsed) : null, error: c.status === "0x1" ? null : (c.error?.message ?? "reverted").slice(0, 200) }))
}

/** One eth_simulateV1 over the read relays that have it; `refused` when the whole simulation was turned down, null when no relay has the method. */
async function simulateRaw(calls: SimCall[], traceTransfers: boolean, balances: Record<string, bigint> = {}): Promise<{ calls: RawSimCall[] } | { refused: string } | null> {
  const stateOverrides = Object.fromEntries(Object.entries(balances).map(([a, b]) => [a, { balance: `0x${b.toString(16)}` }]))
  const body = { jsonrpc: "2.0", id: 1, method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides, calls: calls.map((c) => ({ from: c.from, to: c.to, data: c.data, value: `0x${c.value.toString(16)}`, ...(c.gas ? { gas: `0x${c.gas.toString(16)}` } : {}) })) }], validation: false, traceTransfers }, "latest"] }
  for (const url of READ_RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      const j = await r.json() as { result?: Array<{ calls: RawSimCall[] }>; error?: { code?: number; message?: string } }
      if (j.error) {
        if (j.error.code === -32601 || /not available|not supported|unknown method/i.test(j.error.message ?? "")) continue
        return { refused: (j.error.message ?? "simulation refused").slice(0, 200) }
      }
      const out = j.result?.[0]?.calls ?? []
      if (out.length !== calls.length) continue
      return { calls: out }
    } catch { continue }
  }
  return null
}

/** The pseudo-address eth_simulateV1's traceTransfers logs native-coin moves under (ERC-20 Transfer shape). */
const NATIVE_TRANSFER_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
/**
 * The HYPE the LAST call of a sequence pays to any of `recipients`, read off a simulation with traceTransfers: the
 * exact output of a sell at the current state, for pools whose hook refuses the V4 Quoter (Montra and BOXA revert any
 * sell quote inside their hooks, while the same sell through the router goes through). Null when a call reverts or
 * no relay can simulate.
 */
export async function simulateNativeReceived(calls: SimCall[], recipients: Address[]): Promise<bigint | null> {
  const r = await simulateRaw(calls, true)
  if (!r || "refused" in r || r.calls.some((c) => c.status !== "0x1")) return null
  const to = new Set(recipients.map((a) => a.toLowerCase()))
  let total = 0n
  for (const l of r.calls[r.calls.length - 1].logs ?? []) {
    if (l.address.toLowerCase() !== NATIVE_TRANSFER_LOG || l.topics.length < 3) continue
    if (to.has(`0x${l.topics[2].slice(26)}`.toLowerCase())) total += BigInt(l.data)
  }
  return total
}

const DEFAULT_RPCS = ["https://rpc.elysium.kinetiq.xyz", "https://rpc.agoradex.app", "https://rpc.volta.family", "https://rpc.thekleos.pro/rpc", "https://rpc-live.elysp.com"]
// a browser (demo mode) has no server env: the defaults
const envList = (k: string) => ((typeof process !== "undefined" && process.env ? process.env[k] : "") || "").split(",").map((s) => s.trim()).filter((u) => /^https:\/\//.test(u))

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

/** Relays that answer the cheap ping fast but stall or refuse real reads under load ("server busy", 2–5 s): never first. */
const PATIENT = /elysp\.com/
const PATIENT_KEY = "patient-relay"

/**
 * THE READ LADDER, RANKED. The public relays answer the same call anywhere from 200 ms to 8 s within a minute of each
 * other, and a fixed-order fallback only moves on after a timeout: one stalling relay held every read for seconds.
 * With `rank`, viem pings every relay every 20 s and reorders the ladder by latency and stability, so reads drift to
 * whichever relay is answering now. The ping is eth_blockNumber (not every relay answers viem's default
 * net_listening). A patient relay's ping is refused, so it ranks last and is reached only when every fast relay fails.
 * ONE fallback level, created once: a ranked fallback nested inside another starts a new ranker loop per request.
 * Sends are untouched: every signed transaction still goes to every relay at once (fanout-send.ts).
 */
function readTransport() {
  const transports = READ_RPCS.map((u) => http(u, { timeout: 4_000, retryCount: 0, batch: false, ...(PATIENT.test(u) ? { key: PATIENT_KEY } : {}) }))
  if (transports.length < 2) return fallback(transports, { retryCount: 1 })
  return fallback(transports, {
    retryCount: 1,
    rank: {
      interval: 20_000, sampleCount: 4, timeout: 1_500, weights: { latency: 0.6, stability: 0.4 },
      ping: ({ transport }) => (transport.config?.key === PATIENT_KEY ? Promise.reject(new Error("a patient relay never leads the ladder")) : transport.request({ method: "eth_blockNumber" })),
    },
  })
}

/**
 * One public client over the read relays (ranked, see readTransport), 200 ms receipt polling (160 ms blocks). Kept on
 * the process (serverState), so a module loaded twice by the bundler still shares one client and one ranker.
 */
export function publicClient(): PublicClient {
  return appState("publicClient", () => createPublicClient({ chain: elysium, transport: readTransport(), pollingInterval: 200 }) as PublicClient)
}

/**
 * One read asked of every fast RPC at once; the first answer wins. Receipts use this: through the ranked fallback a
 * third of reads stalled 4 to 5 s on a hanging relay (measured 11/7), raced they took 155 to 178 ms every time.
 */
export async function raceRpc<T>(method: string, params: unknown[]): Promise<T> {
  const fast = READ_RPCS.filter((u) => !PATIENT.test(u))
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  return Promise.any((fast.length ? fast : READ_RPCS).map(async (url) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3_000) })
    const j = (await r.json()) as { result?: T | null }
    if (j.result === null || j.result === undefined) throw new Error(`${new URL(url).host}: no ${method}`)
    return j.result
  }))
}

/** Signed transactions from one wallet, in nonce order, sent together to every RPC at once; their hashes. */
export function sendBatch(raws: Hex[]): Promise<Hex[]> {
  return sendBatchTo(SEND_RPCS, raws, (hash) => raceRpc("eth_getTransactionReceipt", [hash]).then(() => true))
}

/** One signed transaction, the same way. */
export async function sendRaw(raw: Hex): Promise<Hex> {
  return (await sendBatch([raw]))[0]
}

export const EXPLORER = "https://elyscan.live"
export const ASCEND_APP = "https://app.ascendlaunch.xyz"
export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addressLink = (a: string) => `${EXPLORER}/address/${a}`
export const tokenLink = (t: string) => `${EXPLORER}/token/${t}`
export const ascendToken = (t: string) => `${ASCEND_APP}/tokens/${t.toLowerCase()}`

/** A plain HYPE transfer on an Orbit chain needs the L1 data fee folded into gas: 200k is the floor, the real estimate is ~142k. */
export const TRANSFER_GAS = 200_000n
