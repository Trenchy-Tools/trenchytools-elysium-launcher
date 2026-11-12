/**
 * Signed transactions from one wallet, every RPC at once. The same send the launcher uses.
 *
 * Elysium has one sequencer: the official RPC and a row of community relays all lead to it. The sequencer orders by
 * arrival and includes a hash once, so an RPC choice only changes how fast the bytes get there. So the transactions go
 * to every RPC in parallel, as one ordered JSON-RPC batch, and the first RPC to take the first transaction wins.
 *
 * THE LOSERS LIE. An RPC that gets the transaction second answers with an error ("already known", "nonce too low", a
 * relay's own wording), so a duplicate counts as accepted and a live transaction is never reported as failed on an
 * RPC's word. A "nonce gap" only means the RPC has not registered the transaction ahead of this one yet, and "rate
 * limited" or a timeout only means it is busy: what it did not take goes back to it, in order, every 250 ms for up to
 * 14 s. Sending the same bytes twice is harmless. The caller confirms by receipt either way.
 */
import { keccak256, type Hex } from "viem"

const DUPLICATE = /already known|known transaction|already exists|already imported|already relayed|on its way|nonce too low|replacement transaction underpriced|transaction underpriced|earlier relay reservations|duplicate/i
const GAP = /nonce gap|nonce too high|future nonce/i
const BUSY = /rate limit|slow down|aborted due to timeout|timed out|fetch failed|failed to fetch|no answer|HTTP (429|5\d\d)/i
const RETRY_FOR_MS = 14_000
const RETRY_EVERY_MS = 250
/** A batch every RPC called busy can still land: 11/8 a launch landed 10 s after all four relays said no. */
const WATCH_AFTER_BUSY_MS = 25_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Answer = { id?: number | string; result?: unknown; error?: { message?: string } }

/** One RPC's share of a send: resolves once it has taken the first transaction, rejects if it really refused it. */
function pushToRpc(url: string, raws: Hex[]): Promise<void> {
  const host = new URL(url).host
  return new Promise<void>((accepted, refused) => {
    void (async () => {
      let waiting = raws.map((_, i) => i)
      const deadline = Date.now() + RETRY_FOR_MS
      while (waiting.length) {
        const body = JSON.stringify(waiting.map((i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_sendRawTransaction", params: [raws[i]] })))
        let answers: Answer[] = []
        let problem = ""
        try {
          const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(6_000) })
          const j = (await r.json().catch(() => null)) as Answer[] | Answer | null
          if (Array.isArray(j)) answers = j
          else problem = j?.error?.message ?? `HTTP ${r.status}`
        } catch (e) { problem = (e as Error).message }
        const again: number[] = []
        for (const i of waiting) {
          const a = answers.find((x) => Number(x.id) === i + 1)
          const said = a?.error?.message ?? (a ? "" : problem || "no answer")
          const ok = typeof a?.result === "string" || DUPLICATE.test(said)
          if (!ok && (GAP.test(said) || BUSY.test(said)) && Date.now() < deadline) { again.push(i); continue }
          if (i === 0) { if (ok) accepted(); else refused(new Error(`${host}: ${said}`)) }
        }
        waiting = again
        if (waiting.length) await sleep(RETRY_EVERY_MS)
      }
    })()
  })
}

/**
 * Broadcast `raws` (consecutive nonces of one wallet, or just one) to every url at once. Resolves with the hashes once
 * any RPC has taken the first transaction; throws only when every RPC refused it. `landed` looks for the first
 * transaction on chain, so a batch every RPC called busy is watched for a while before it counts as failed.
 */
export async function sendBatchTo(urls: readonly string[], raws: Hex[], landed: (hash: Hex) => Promise<boolean>): Promise<Hex[]> {
  if (!urls.length) throw new Error("No RPC to broadcast through.")
  const hashes = raws.map((r) => keccak256(r))
  try {
    await Promise.any(urls.map((url) => pushToRpc(url, raws)))
  } catch (agg) {
    const why = ((agg as AggregateError).errors as Error[]).map((e) => e.message).join(" | ").slice(0, 300)
    if (BUSY.test(why) || GAP.test(why)) {
      const end = Date.now() + WATCH_AFTER_BUSY_MS
      while (Date.now() < end) {
        if (await landed(hashes[0]).catch(() => false)) return hashes
        await sleep(1_500)
      }
    }
    throw new Error(`Every RPC refused the transaction: ${why}`)
  }
  return hashes
}
