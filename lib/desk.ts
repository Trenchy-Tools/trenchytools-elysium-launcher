/**
 * Desk actions on the wallet folder: deploy one for a wallet, fund it with HYPE, take HYPE or a coin back out. Every
 * action is signed by the owner wallet (its file must exist) and broadcast through the fan-out. Buys and sells
 * through the desk are not here: the chain client routes them itself (lib/elysium/api.ts tradeLocal) whenever a
 * wallet has a desk, so the Trading page's buttons and the auto-sell use it without knowing.
 */
import { formatEther, parseEther, type Address, type Hex } from "viem"
import { Nonces, signTx, waitSuccess } from "./core/evm"
import { DESK_BYTECODE, DESK_DEPLOY_GAS, deskOf, deskView, deskWithdrawHypeData, deskWithdrawTokenData, rememberDesk, verifyDesk, type DeskView } from "./elysium/desk"
import { TRANSFER_GAS } from "./elysium/chain"
import { chainApi } from "./settings"
import { accountOf, assertBackedUp } from "./wallets"

export type DeskStatus = { publicKey: string; desk: Address | null; hype?: string; token?: string | null; tokens?: string }

export async function deskStatus(publicKey: string, token?: string | null): Promise<DeskStatus> {
  const desk = await verifyDesk(publicKey)
  if (!desk) return { publicKey, desk: null }
  const v: DeskView = await deskView(desk, (token as Address) ?? null)
  return { publicKey, desk, hype: formatEther(v.hypeWei), token: token ?? null, tokens: formatEther(v.tokenWei) }
}

async function send(publicKey: string, tx: { to?: Address; data: Hex; value: bigint; gas: bigint }, what: string): Promise<Hex> {
  assertBackedUp(publicKey)
  const api = chainApi()
  const acct = await api.rh.account(publicKey)
  const raw = await signTx(accountOf(publicKey), acct, new Nonces(acct), { label: "transfer", to: tx.to ?? "", data: tx.data, value: tx.value.toString(), gas: tx.gas.toString() })
  const { hash } = await api.rh.send(raw)
  if (!(await waitSuccess(api, hash, 90_000))) throw new Error(`${what} ${hash.slice(0, 10)}… not confirmed in time`)
  return hash as Hex
}

/** Deploy a desk owned by the wallet (one per wallet; an existing one is returned). */
export async function deployDesk(publicKey: string): Promise<{ desk: Address; hash?: string }> {
  const existing = await verifyDesk(publicKey)
  if (existing) return { desk: existing }
  assertBackedUp(publicKey)
  const api = chainApi()
  const acct = await api.rh.account(publicKey)
  const account = accountOf(publicKey)
  const raw = await account.signTransaction({ type: "eip1559", chainId: acct.chainId, nonce: new Nonces(acct).take(), data: DESK_BYTECODE, value: 0n, gas: DESK_DEPLOY_GAS, maxFeePerGas: BigInt(acct.maxFeePerGas), maxPriorityFeePerGas: 0n })
  const { hash } = await api.rh.send(raw)
  if (!(await waitSuccess(api, hash, 120_000))) throw new Error(`desk deploy ${hash.slice(0, 10)}… not confirmed in time`)
  const r = await api.rh.tx(hash)
  const receipt = await (await import("./elysium/chain")).publicClient().getTransactionReceipt({ hash: hash as Hex })
  if (r.status !== "success" || !receipt.contractAddress) throw new Error(`desk deploy reverted: ${hash}`)
  rememberDesk(publicKey, receipt.contractAddress)
  return { desk: receipt.contractAddress, hash }
}

export async function fundDesk(publicKey: string, hype: number): Promise<{ desk: Address; hash: string }> {
  const desk = deskOf(publicKey)
  if (!desk) throw new Error("This wallet has no desk yet")
  const hash = await send(publicKey, { to: desk, data: "0x", value: parseEther(String(hype) as `${number}`), gas: TRANSFER_GAS }, "funding")
  return { desk, hash }
}

export async function withdrawDeskHype(publicKey: string, hype?: number): Promise<{ desk: Address; hash: string }> {
  const desk = deskOf(publicKey)
  if (!desk) throw new Error("This wallet has no desk yet")
  const hash = await send(publicKey, { to: desk, data: deskWithdrawHypeData(publicKey as Address, hype ? parseEther(String(hype) as `${number}`) : 0n), value: 0n, gas: 80_000n }, "withdraw")
  return { desk, hash }
}

export async function withdrawDeskToken(publicKey: string, token: string): Promise<{ desk: Address; hash: string }> {
  const desk = deskOf(publicKey)
  if (!desk) throw new Error("This wallet has no desk yet")
  const hash = await send(publicKey, { to: desk, data: deskWithdrawTokenData(token as Address, publicKey as Address, 0n), value: 0n, gas: 120_000n }, "withdraw")
  return { desk, hash }
}
