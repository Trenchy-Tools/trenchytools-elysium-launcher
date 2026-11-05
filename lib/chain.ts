/**
 * What differs on the shared pages: the chain's name, its native coin, how addresses look, where things are seen,
 * and which extras exist. Client-safe (no node imports).
 */
export type ChainConfig = {
  name: string
  symbol: string
  /** the query / body field a coin travels in on this app's routes */
  coinParam: "mint" | "token"
  coinNoun: string
  keyNoun: string
  isAddress: (s: string) => boolean
  isCoin: (s: string) => boolean
  short: (s: string) => string
  /** a native amount for a table cell */
  fmt: (n: number | null | undefined) => string
  explorerAddress: (address: string) => string
  explorerTx: (sig: string) => string
  coinLinks: (coin: string) => Array<{ label: string; href: string }>
  /** an embeddable candle chart, or null when the chain has none */
  chartUrl: (coin: string, theme: "dark" | "light") => string | null
  /** the launch-log stream of this app, and one entry of it read into a common shape */
  launchLog: { path: (id: string) => string; read: (e: Record<string, unknown>) => { stage: string; message: string; done: boolean; error: boolean } }
  /** the "Set every amount to" pills, in the native coin */
  pills: string[]
  /** the default of the "Amount each" input (funding) and of a buy */
  defaultEach: string
  defaultBuy: string
  features: { tokenAccounts: boolean; creatorFees: boolean; mayhem: boolean }
}

const ADDR = /^0x[0-9a-fA-F]{40}$/
const EXPLORER = "https://elyscan.live"

export const chain: ChainConfig = {
  name: "Elysium",
  symbol: "HYPE",
  coinParam: "token",
  coinNoun: "token address",
  keyNoun: "0x private key",
  isAddress: (s) => ADDR.test(s.trim()),
  isCoin: (s) => ADDR.test(s.trim()),
  short: (s) => (s.length > 13 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s),
  fmt: (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 5 })),
  explorerAddress: (a) => `${EXPLORER}/address/${a}`,
  explorerTx: (hash) => `${EXPLORER}/tx/${hash}`,
  coinLinks: (token) => [
    { label: "ascend", href: `https://app.ascendlaunch.xyz/tokens/${token.toLowerCase()}` },
    { label: "elyscan", href: `${EXPLORER}/token/${token}` },
  ],
  // no embeddable chart for Elysium yet; the Ascend page has one
  chartUrl: () => null,
  launchLog: {
    path: (id) => `/api/launch/${id}/log`,
    read: (e) => ({ stage: String(e.stage ?? ""), message: String(e.msg ?? ""), done: e.done === true, error: e.level === "error" }),
  },
  // HYPE amounts (~$80): a 0.1 HYPE buy is the size the Elysium bots trade with
  pills: ["0.05", "0.1", "0.25", "0.5", "1"],
  defaultEach: "0.3",
  defaultBuy: "0.1",
  // creator fees: Ascend's CreatorEscrow (the share above 1 % claimable as it accrues; the base cut held until graduation)
  features: { tokenAccounts: false, creatorFees: true, mayhem: false },
}
