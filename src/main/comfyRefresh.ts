export class ComfyRefreshError extends Error {
  constructor(readonly kind: 'auth-required' | 'unavailable', readonly reason: 'revoked' | 'connection' | 'timeout' | 'process') {
    super(`Comfy OAuth ${reason}`)
  }
}

/** Native diagnostic text is inspected in memory only; never forward it. */
export function isRevokedComfyAuth(text: string): boolean {
  return /invalid_grant|refresh token reuse|refresh token.{0,40}(?:revoked|expired)|invalid refresh token/i.test(text)
}

export async function waitForComfyConnection(
  list: () => Promise<unknown>,
  revoked: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 40_000)
  do {
    const result = await list() as { data?: Array<{ name?: string; runtimeStatus?: string; error?: unknown }> }
    const row = result?.data?.find(s => s.name === 'comfy-cloud' || s.name === 'local:comfy-cloud')
    if (row?.runtimeStatus === 'connected') return
    if (revoked() || row?.runtimeStatus === 'authenticationRequired') throw new ComfyRefreshError('auth-required', 'revoked')
    if (row?.runtimeStatus === 'failed' || row?.runtimeStatus === 'disabled') throw new ComfyRefreshError('unavailable', 'connection')
    // Missing rows and 'starting' are startup progress, not proof of bad OAuth.
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 500))
  } while (Date.now() < deadline)
  throw new ComfyRefreshError('unavailable', 'timeout')
}
