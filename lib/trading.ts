/**
 * Trading after the launch: the flows in lib/core/trading.ts run on the wallet folder (lib/env.ts). Live trades are
 * read off the chain (lib/elysium/tape.ts) by a 600 ms poller per followed coin, held in server memory and relayed
 * to the page as server-sent events.
 */
import * as core from "./core/trading"
import { serverEnv } from "./env"
import { serverState } from "./paths"
import { listWallets } from "./wallets"
import { launchBlockOf, swapsOf, type Swap } from "./elysium/tape"
import { publicClient } from "./elysium/chain"
import { allDesks } from "./elysium/desk"
import type { LiveTrade, SellAllResult, TradeResult } from "./core/trading"

export type { Holding, LiveTrade, SellAllResult, TradeResult } from "./core/trading"

export const holdings = (token: string) => core.holdings(serverEnv(), token)
export const balanceRows = (token?: string | null) => core.balanceRows(serverEnv(), token)
export const sell = (publicKey: string, token: string, percent: number, slippage?: number): Promise<TradeResult> => core.sell(serverEnv(), publicKey, token, percent, slippage)
export const buy = (publicKey: string, token: string, eth: number, slippage?: number): Promise<TradeResult> => core.buy(serverEnv(), publicKey, token, eth, slippage)
export const sellAll = (publicKeys: string[], token: string, percent: number): Promise<SellAllResult> => core.sellAll(serverEnv(), publicKeys, token, percent)
export const creatorOf = (token: string) => core.creatorOf(serverEnv(), token)
export const creatorFees = (token: string) => core.creatorFees(serverEnv(), token)
export const collectCreatorFees = (token: string) => core.collectCreatorFees(serverEnv(), token)

// ── live trades: a poller per followed coin ────────────────────────────────────

type Feed = { token: string | null; trades: LiveTrade[]; seen: Set<string>; listeners: Set<(t: LiveTrade) => void>; cursor: bigint; timer: ReturnType<typeof setInterval> | null; backfilled: string | null }
const feed = serverState<Feed>("feed", () => ({ token: null, trades: [], seen: new Set(), listeners: new Set(), cursor: 0n, timer: null, backfilled: null }))

const POLL_MS = 600

/** A swap as the pages read it; our wallets AND their desks are tagged as ours. */
function toLive(s: Swap, token: string): LiveTrade {
  const wallets = listWallets()
  const desks = allDesks()
  const t = s.trader.toLowerCase()
  const own = wallets.find((w) => w.publicKey.toLowerCase() === t) ?? wallets.find((w) => desks[w.publicKey.toLowerCase()]?.toLowerCase() === t)
  return { hash: `${s.hash}:${s.logIndex}`, token, type: s.type, trader: s.trader, eth: s.hype, tokens: s.tokens, priceEth: s.tokens > 0 ? s.hype / s.tokens : null, timestamp: s.timestamp, ours: own ? `${own.label} · ${own.role}` : null, venue: "uniswap-v4" }
}

async function poll(): Promise<void> {
  const token = feed.token
  if (!token) return
  try {
    if (feed.cursor === 0n) feed.cursor = (await publicClient().getBlockNumber()) - 2n
    const head = await publicClient().getBlockNumber()
    if (head < feed.cursor) return
    const swaps = await swapsOf(token as `0x${string}`, feed.cursor, head)
    feed.cursor = head + 1n
    for (const s of swaps) {
      const t = toLive(s, token)
      if (feed.seen.has(t.hash) || feed.token !== token) continue
      feed.seen.add(t.hash)
      feed.trades.unshift(t)
      if (feed.trades.length > 300) feed.trades.length = 300
      for (const cb of feed.listeners) cb(t)
    }
  } catch (e) { console.warn("[feed]", e instanceof Error ? e.message : e) }
}

/** The coin's history from its launch block, merged into the tape once per followed coin. Newest first. */
export async function backfillToken(token: string): Promise<LiveTrade[]> {
  const key = token.toLowerCase()
  if (feed.token?.toLowerCase() !== key || feed.backfilled === key) return feed.trades
  feed.backfilled = key
  try {
    const launch = await launchBlockOf(token as `0x${string}`)
    const head = await publicClient().getBlockNumber()
    const from = launch ?? (head > 20_000n ? head - 20_000n : 0n)
    for (const s of await swapsOf(token as `0x${string}`, from, head)) {
      const t = toLive(s, token)
      if (feed.seen.has(t.hash)) continue
      feed.seen.add(t.hash)
      feed.trades.push(t)
    }
    feed.trades.sort((a, b) => b.timestamp - a.timestamp)
    if (feed.trades.length > 300) feed.trades.length = 300
  } catch (e) { console.warn("[feed] history:", e instanceof Error ? e.message : e) }
  return feed.trades
}

/** Follow one coin (the previous one is dropped). Returns the trades seen so far. */
export function followToken(token: string): LiveTrade[] {
  if (feed.token?.toLowerCase() !== token.toLowerCase()) {
    feed.token = token
    feed.trades = []
    feed.seen = new Set()
    feed.cursor = 0n
    feed.backfilled = null
  }
  if (!feed.timer) feed.timer = setInterval(() => void poll(), POLL_MS)
  return feed.trades
}

/** Outsiders' net HYPE on the coin over the last `windowMs` (buys − sells by wallets that are not ours). Follows the coin if needed. */
export function outsideNet(token: string, windowMs: number): { net: number; inHype: number; outHype: number; buys: number; sells: number } {
  if (feed.token?.toLowerCase() !== token.toLowerCase()) followToken(token)
  const since = Date.now() - windowMs
  let inHype = 0, outHype = 0, buys = 0, sells = 0
  for (const t of feed.trades) {
    if (t.timestamp < since || t.ours) continue
    if (t.type === "buy") { inHype += t.eth; buys++ } else { outHype += t.eth; sells++ }
  }
  return { net: inHype - outHype, inHype, outHype, buys, sells }
}

/** How many sells by OUR wallets (desks included) the tape shows on the coin since `sinceMs` (epoch ms). */
export function ownSells(token: string, sinceMs: number): number {
  if (feed.token?.toLowerCase() !== token.toLowerCase()) followToken(token)
  let n = 0
  for (const t of feed.trades) if (t.ours && t.type === "sell" && t.timestamp >= sinceMs - 2_000) n++
  return n
}

export function onTrade(cb: (t: LiveTrade) => void): () => void {
  feed.listeners.add(cb)
  return () => feed.listeners.delete(cb)
}
