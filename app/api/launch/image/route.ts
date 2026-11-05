import { fail, isAddress, ok } from "@/lib/http"
import { chainApi } from "@/lib/settings"
import { mainWallet } from "@/lib/wallets"

/**
 * POST /api/launch/image (multipart: file, name, symbol, description?, twitter?, telegram?, website?, creator?) → the
 * image pinned on IPFS and Ascend's metadata JSON pinned around it → { image, metadataUri }. The metadata URI rides
 * the launch calldata; the image goes into the coin's record.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File) || !file.size) return fail(new Error("file: a PNG, JPG, GIF or WebP up to 4 MB"), 400)
    const creator = String(form.get("creator") ?? "")
    const r = await chainApi().uploadMetadata(form, (isAddress(creator) ? creator : mainWallet()?.publicKey) as `0x${string}` | undefined)
    return ok({ image: r.metadata.image, metadataUri: r.metadataUri })
  } catch (e) {
    return fail(e)
  }
}
