/**
 * The chain client: what the shared flows (lib/core/*) ask of "the API", answered straight from Elysium with viem.
 * Same method names and shapes the pons starter got from api.trenchy.tools, so the flows and routes read the same;
 * nothing here talks to any service but the chain's relays and an IPFS pinner. Server-side only.
 *
 *   rh.account        chainId, pending nonce, gas, balance            (one read per wallet per batch)
 *   rh.tradeLocal     the unsigned transactions of a buy / sell / create / collectCreatorFee, in order
 *   rh.simulate       each transaction run through eth_call from its sender
 *   rh.send           raw bytes to every relay at once (fan-out)
 *   rh.tx             receipt → success | reverted | pending_or_unknown
 *   rh.quote          the V4 quoter
 *   rh.token          name, symbol, pool
 *   rh.tradeHistory   the pool's swaps, newest first
 *   rh.creatorFees    the creator escrow
 *   rh.ethBalances / rh.balances
 *   uploadMetadata    pin the image, then Ascend's metadata JSON
 *
 * A wallet with a desk (lib/elysium/desk.ts) buys through it when the desk holds enough HYPE and sells through it
 * when the coin sits there: one call, nothing to approve. Otherwise the UniversalRouter, with the approvals first.
 */
import { formatEther, parseEther, type Address, type Hex } from "viem"
import { ADDR, ELYSIUM_CHAIN_ID, publicClient, sendRaw, simulateSequence, TRANSFER_GAS } from "./chain"
import { ApiError } from "../core/errors"
import { APPROVE_GAS, BUY_GAS, ERC20_ABI, SELL_GAS, ascendKey, poolIdOf, quote as v4Quote, sellApprovals, buyCall, sellCall } from "./v4"
import { LAUNCH_GAS, approveWhypeCalldata, claimCalldata, decodeLaunchReceipt, feeView, launchCalldata, pickStartTick, tokenInfo, wrapCalldata, WETH9_ABI, type LaunchParams } from "./ascend"
import { DESK_BUY_GAS, DESK_SELL_GAS, deskBuyData, deskHolding, deskOf, deskSellData } from "./desk"
import { swapsOf, launchBlockOf } from "./tape"
import { pinBuffer, pinMetadata, type Metadata } from "./pin"

export { ApiError }

export type TxLabel = "approve" | "buy" | "sell" | "create" | "wrap" | "fee" | "transfer" | "deposit" | "sweep" | "claim"
export type EvmTx = { chainId: number; from: string; to: string; data: string; value: string; valueEth?: string; gas?: string; label: TxLabel }
export type Expected = { tokens: number; eth: number }
export type TokenMetadata = Metadata & { image: string }
export type TradeBody = {
  wallet: string
  action: "buy" | "sell" | "create" | "collectCreatorFee"
  token?: string
  amount?: number | string
  denominatedInEth?: "true" | "false"
  slippage?: number
  tokenMetadata?: TokenMetadata
  /** create: the pool's trade fee in hundredths of a bip (10000 = 1 %); the pinned metadata URI for the calldata suffix */
  feePpm?: number
  metadataUri?: string | null
}
export type Built = { chainId: number; transactions: EvmTx[]; expected: Expected; venue: "v4" | "desk" | "launch"; predicted?: { token?: string; escrow?: string; devReceiver?: string }; launchFeeEth?: number }
export type TxStatus = { hash: string; status: "success" | "reverted" | "pending_or_unknown"; block?: number; gasUsed?: string; logs?: Array<{ address: Address; topics: readonly Hex[]; data: Hex }> }
export type Simulation = { ok: boolean; steps: Array<{ label: string; ok: boolean; gasUsed: string | null; error: string | null }> }
export type Quote = { venue: string; action: "buy" | "sell"; ethIn?: number; tokensOut?: number; tokensIn?: number; ethOut?: number }
export type TokenInfo = { token: string; name: string; symbol: string; venue: "uniswap-v4"; poolId: string; hasPool: boolean; creator: string; totalSupply: number }
export type CreatorFees = { wallet: string; escrow: string; claimableWei: string; claimableEth: number; eth: number; heldEth: number; deadline: number; feePpm: number }
export type AccountData = { wallet: string; chainId: number; nonce: number; pendingNonce: number; balanceEth: string; block: number; gasPrice: string; maxFeePerGas: string; maxPriorityFeePerGas: string; transferGas: string }
export type ApiCall = { method: string; path: string; status: number; ms: number; note?: string; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const str = (n: bigint) => n.toString()

export class ElysiumApi {
  readonly url = "elysium"
  get configured(): boolean { return true }

  /** The dry run's trace: while on, every chain action is recorded. */
  private trace: ApiCall[] | null = null
  beginTrace(): void { this.trace = [] }
  endTrace(): ApiCall[] { const t = this.trace ?? []; this.trace = null; return t }
  private async step<T>(method: string, path: string, run: () => Promise<T>, note?: (r: T) => string): Promise<T> {
    if (!this.trace) return run()
    const t0 = Date.now()
    try { const r = await run(); this.trace.push({ method, path, status: 200, ms: Date.now() - t0, note: note?.(r) }); return r }
    catch (e) { this.trace.push({ method, path, status: 0, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) }); throw e }
  }

  me() { return this.step("GET", "eth_chainId", async () => ({ keyPrefix: "chain", chainId: await publicClient().getChainId() })) }

  rh = {
    account: (wallet: string): Promise<AccountData> => this.step("GET", `account ${wallet.slice(0, 10)}`, async () => {
      const c = publicClient()
      const [nonce, pendingNonce, balance, block, gasPrice] = await Promise.all([
        c.getTransactionCount({ address: wallet as Address }),
        c.getTransactionCount({ address: wallet as Address, blockTag: "pending" }),
        c.getBalance({ address: wallet as Address }),
        c.getBlockNumber(),
        c.getGasPrice(),
      ])
      // Orbit: a legacy gas price is the base fee; 1.5× leaves room for a bump between the read and the block, no tip.
      return { wallet, chainId: ELYSIUM_CHAIN_ID, nonce, pendingNonce, balanceEth: formatEther(balance), block: Number(block), gasPrice: str(gasPrice), maxFeePerGas: str((gasPrice * 15n) / 10n), maxPriorityFeePerGas: "0", transferGas: str(TRANSFER_GAS) }
    }),

    tradeLocal: (b: TradeBody): Promise<Built> => this.step("POST", `build ${b.action}${b.token ? ` ${b.token.slice(0, 10)}` : ""}`, () => this.build(b), (r) => `${r.transactions.length} tx · ${r.venue}`),

    simulate: (transactions: EvmTx[]): Promise<Simulation> => this.step("POST", "simulate", async () => {
      // the sequence as a whole first: a create needs the wrap and the approve before it to have happened
      const seq = await simulateSequence(transactions.map((t) => ({ from: t.from as Address, to: t.to as Address, data: t.data as Hex, value: BigInt(t.value || "0") })))
      if (seq) {
        const steps = seq.map((s, i) => ({ label: transactions[i].label, ok: s.ok, gasUsed: s.gasUsed === null ? null : str(s.gasUsed), error: s.error }))
        return { ok: steps.every((s) => s.ok), steps }
      }
      // no relay with eth_simulateV1: each call on its own against the live state (a create after an approve reads "TRANSFER_FROM_FAILED" here, which only means the approve is not on chain yet)
      const c = publicClient()
      const steps: Simulation["steps"] = []
      for (const t of transactions) {
        try {
          const gas = await c.estimateGas({ account: t.from as Address, to: t.to as Address, data: t.data as Hex, value: BigInt(t.value || "0") })
          steps.push({ label: t.label, ok: true, gasUsed: str(gas), error: null })
        } catch (e) {
          steps.push({ label: t.label, ok: false, gasUsed: null, error: ((e as { shortMessage?: string })?.shortMessage ?? (e as Error).message).slice(0, 200) })
        }
      }
      return { ok: steps.every((s) => s.ok), steps }
    }),

    send: (transaction: string): Promise<{ hash: string }> => this.step("POST", "send (fan-out)", async () => ({ hash: await sendRaw(transaction as Hex) })),

    tx: async (hash: string): Promise<TxStatus> => {
      const r = await publicClient().getTransactionReceipt({ hash: hash as Hex }).catch(() => null)
      if (!r) return { hash, status: "pending_or_unknown" }
      return { hash, status: r.status === "success" ? "success" : "reverted", block: Number(r.blockNumber), gasUsed: str(r.gasUsed), logs: r.logs as TxStatus["logs"] }
    },

    quote: (p: { token: string; action: "buy" | "sell"; amount: number; wallet?: string }): Promise<Quote> => this.step("GET", `quote ${p.action} ${p.amount}`, async () => {
      const amountIn = parseEther(String(p.amount) as `${number}`)
      const out = await v4Quote(p.token as Address, p.action, amountIn)
      if (out === null) throw new ApiError("No Ascend pool answers for this coin (not launched there, or the hook refused)", 404, "no_pool")
      return p.action === "buy" ? { venue: "uniswap-v4", action: "buy", ethIn: p.amount, tokensOut: Number(formatEther(out)) } : { venue: "uniswap-v4", action: "sell", tokensIn: p.amount, ethOut: Number(formatEther(out)) }
    }),

    token: (token: string): Promise<TokenInfo> => this.step("GET", `token ${token.slice(0, 10)}`, async () => {
      const i = await tokenInfo(token as Address)
      let creator = ""
      try { const fv = await feeView(token as Address, ADDR.escrowFactory); creator = fv.recipient } catch { /* no escrow */ }
      return { token, name: i.name, symbol: i.symbol, venue: "uniswap-v4", poolId: i.poolId, hasPool: i.hasPool, creator, totalSupply: Number(formatEther(i.totalSupply)) }
    }),

    tradeHistory: async (token: string, limit = 100) => {
      const launch = await launchBlockOf(token as Address)
      const head = await publicClient().getBlockNumber()
      const from = launch ?? (head > 20_000n ? head - 20_000n : 0n)
      const swaps = await swapsOf(token as Address, from)
      const trades = swaps.slice(-limit).reverse().map((s) => ({ hash: s.hash, token, txType: s.type, trader: s.trader, ethAmount: s.hype, tokenAmount: s.tokens, ts: s.timestamp, venue: "uniswap-v4", block: s.block }))
      return { token, curve: "", launchBlock: Number(launch ?? 0n), trades }
    },

    creatorFees: (wallet: string, token?: string): Promise<CreatorFees> => this.step("GET", `fees ${wallet.slice(0, 10)}`, async () => {
      if (!token) throw new ApiError("token is required", 400, "bad_request")
      const f = await feeView(token as Address, wallet as Address)
      return { wallet, escrow: f.escrow, claimableWei: str(f.claimableWei), claimableEth: Number(formatEther(f.claimableWei)), eth: Number(formatEther(f.claimableWei)), heldEth: Number(formatEther(f.heldWei)), deadline: f.deadline, feePpm: f.feePpm }
    }),

    ethBalances: async (wallets: string[]): Promise<Map<string, number>> => {
      const c = publicClient()
      const out = new Map<string, number>()
      await Promise.all(wallets.map(async (w) => { out.set(w.toLowerCase(), Number(formatEther(await c.getBalance({ address: w as Address }).catch(() => 0n)))) }))
      return out
    },

    /** HYPE and this coin's balance of a wallet; a desk's holding of the coin counts as the wallet's. */
    balances: async (wallet: string, tokens: string[]) => {
      const c = publicClient()
      const eth = await c.getBalance({ address: wallet as Address })
      const desk = deskOf(wallet)
      const rows = await Promise.all(tokens.map(async (t) => {
        const [own, inDesk] = await Promise.all([
          c.readContract({ address: t as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet as Address] }).catch(() => 0n),
          desk ? c.readContract({ address: t as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [desk] }).catch(() => 0n) : Promise.resolve(0n),
        ])
        return { token: t, balance: formatEther(own + inDesk), inWallet: formatEther(own), inDesk: formatEther(inDesk) }
      }))
      return { wallet, eth: formatEther(eth), tokens: rows }
    },
  }

  /** Poll until success (true), reverted (throws), or timed out (false). */
  async waitSuccess(hash: string, timeoutMs = 60_000, onProgress?: (msg: string) => void): Promise<boolean> {
    const start = Date.now()
    let lastNote = 0
    while (Date.now() - start < timeoutMs) {
      const s = await this.rh.tx(hash).catch(() => null)
      if (s?.status === "success") return true
      if (s?.status === "reverted") throw new ApiError(`Transaction reverted: ${hash}`, 502, "reverted")
      if (onProgress && Date.now() - lastNote > 4000) { lastNote = Date.now(); onProgress(`Still waiting for ${hash.slice(0, 10)}… (${Math.round((Date.now() - start) / 1000)}s)`) }
      await sleep(400)
    }
    return false
  }

  /** Pin the image, then Ascend's metadata JSON around it. `creator` goes into the JSON. */
  async uploadMetadata(form: FormData, creator?: Address): Promise<{ metadataUri: string; metadata: { image: string } }> {
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) throw new ApiError("file: a PNG, JPG, GIF or WebP up to 4 MB", 400, "bad_request")
    const image = await pinBuffer(new Uint8Array(await file.arrayBuffer()), file.type || "image/png", "art")
    const m: Metadata = { name: String(form.get("name") ?? ""), symbol: String(form.get("symbol") ?? ""), description: String(form.get("description") ?? ""), website: String(form.get("website") ?? ""), twitter: String(form.get("twitter") ?? ""), telegram: String(form.get("telegram") ?? "") }
    const metadataUri = creator ? await pinMetadata(m, image.uri, creator) : image.uri
    return { metadataUri, metadata: { image: image.uri } }
  }

  // ── building transactions ───────────────────────────────────────────────────

  private async build(b: TradeBody): Promise<Built> {
    const wallet = b.wallet as Address
    const tx = (t: { to: Address; data: Hex; value: bigint }, label: TxLabel, gas: bigint): EvmTx => ({ chainId: ELYSIUM_CHAIN_ID, from: wallet, to: t.to, data: t.data, value: str(t.value), valueEth: formatEther(t.value), gas: str(gas), label })
    const slip = (out: bigint) => (out * BigInt(Math.max(0, Math.round(100 - Math.min(100, b.slippage ?? 10))))) / 100n

    if (b.action === "buy") {
      const token = b.token as Address
      const hypeIn = parseEther(String(b.amount) as `${number}`)
      const dh = await deskHolding(wallet, token)
      const deskHype = dh ? await publicClient().getBalance({ address: dh.desk }) : 0n
      const quoted = (await v4Quote(token, "buy", hypeIn)) ?? 0n
      const expected = { tokens: Number(formatEther(quoted)), eth: Number(formatEther(hypeIn)) }
      if (dh && deskHype >= hypeIn) return { chainId: ELYSIUM_CHAIN_ID, venue: "desk", expected, transactions: [tx({ to: dh.desk, data: deskBuyData(token, hypeIn, slip(quoted)), value: 0n }, "buy", DESK_BUY_GAS)] }
      return { chainId: ELYSIUM_CHAIN_ID, venue: "v4", expected, transactions: [tx(buyCall(token, hypeIn, slip(quoted)), "buy", BUY_GAS)] }
    }

    if (b.action === "sell") {
      const token = b.token as Address
      const c = publicClient()
      const dh = await deskHolding(wallet, token)
      const own = await c.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] })
      const pct = typeof b.amount === "string" && b.amount.endsWith("%") ? Math.max(1, Math.min(100, Number(b.amount.slice(0, -1)) || 100)) : 100
      const txs: EvmTx[] = []
      let ethOut = 0n, tokensIn = 0n
      // the desk's bag first (one call, nothing to approve), then whatever the wallet itself holds
      if (dh && dh.held > 0n) {
        const part = pct >= 100 ? 0n : (dh.held * BigInt(pct)) / 100n
        const q = (await v4Quote(token, "sell", part || dh.held)) ?? 0n
        txs.push(tx({ to: dh.desk, data: deskSellData(token, part, slip(q)), value: 0n }, "sell", DESK_SELL_GAS))
        ethOut += q; tokensIn += part || dh.held
      }
      if (own > 0n) {
        const part = (own * BigInt(pct)) / 100n
        if (part > 0n) {
          for (const a of await sellApprovals(wallet, token)) txs.push(tx(a, "approve", APPROVE_GAS))
          const q = (await v4Quote(token, "sell", part)) ?? 0n
          txs.push(tx(sellCall(token, part, slip(q)), "sell", SELL_GAS))
          ethOut += q; tokensIn += part
        }
      }
      if (!txs.length) throw new ApiError("This wallet (and its desk) holds none of the coin", 409, "nothing_to_sell")
      return { chainId: ELYSIUM_CHAIN_ID, venue: dh?.held ? "desk" : "v4", expected: { tokens: Number(formatEther(tokensIn)), eth: Number(formatEther(ethOut)) }, transactions: txs }
    }

    if (b.action === "create") {
      const m = b.tokenMetadata
      if (!m) throw new ApiError("tokenMetadata is required for a create", 400, "bad_request")
      const devBuyWei = parseEther(String(b.amount ?? 0) as `${number}`)
      const feePpm = b.feePpm && b.feePpm >= 10_000 && b.feePpm <= 100_000 ? b.feePpm : 10_000
      const c = publicClient()
      const txs: EvmTx[] = []
      if (devBuyWei > 0n) {
        const [held, allowance] = await Promise.all([
          c.readContract({ address: ADDR.whype, abi: WETH9_ABI, functionName: "balanceOf", args: [wallet] }),
          c.readContract({ address: ADDR.whype, abi: WETH9_ABI, functionName: "allowance", args: [wallet, ADDR.escrowFactory] }),
        ])
        if (held < devBuyWei) txs.push(tx({ to: ADDR.whype, data: wrapCalldata(), value: devBuyWei - held }, "wrap", 60_000n))
        if (allowance < devBuyWei) txs.push(tx({ to: ADDR.whype, data: approveWhypeCalldata(devBuyWei), value: 0n }, "approve", 80_000n))
      }
      const desk = deskOf(wallet)
      const params: LaunchParams = { name: m.name, symbol: m.symbol.replace(/^\$/, ""), devBuyWei, feePpm, metadataUri: b.metadataUri ?? null, devReceiver: desk ?? undefined }
      // the terms (rule set, opening tick) are checked with a dev buy of 0 so the simulation does not need the allowance yet
      const { ruleSet, startTick } = await pickStartTick(wallet, { ...params, devBuyWei: 0n })
      txs.push(tx({ to: ADDR.escrowFactory, data: launchCalldata(wallet, params, ruleSet, startTick), value: 0n }, "create", LAUNCH_GAS))
      return { chainId: ELYSIUM_CHAIN_ID, venue: "launch", expected: { tokens: 0, eth: Number(formatEther(devBuyWei)) }, transactions: txs, predicted: { devReceiver: desk ?? wallet }, launchFeeEth: 0 }
    }

    if (b.action === "collectCreatorFee") {
      const token = b.token as Address
      const f = await feeView(token, wallet)
      if (f.claimableWei === 0n) throw new ApiError(`Nothing claimable yet${f.heldWei > 0n ? ` (${formatEther(f.heldWei)} HYPE held until the coin graduates)` : ""}`, 409, "nothing_to_claim")
      return { chainId: ELYSIUM_CHAIN_ID, venue: "launch", expected: { tokens: 0, eth: Number(formatEther(f.claimableWei)) }, transactions: [tx({ to: f.escrow, data: claimCalldata(wallet), value: 0n }, "claim", 300_000n)] }
    }
    throw new ApiError(`unknown action ${String(b.action)}`, 400, "bad_request")
  }

  /** The coin a confirmed launch created, off its receipt. */
  async launchResult(hash: string, devReceiver: Address) {
    const r = await this.rh.tx(hash)
    if (r.status !== "success" || !r.logs) return null
    return decodeLaunchReceipt(r.logs, devReceiver)
  }

  static poolIdFor = (token: Address) => poolIdOf(ascendKey(token).key)
}
