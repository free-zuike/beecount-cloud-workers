function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((part) => Number(part))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums
}

function isBlockedIpv4(host: string): boolean {
  const ip = parseIpv4(host)
  if (!ip) return false
  const [a, b] = ip
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && ip[2] === 100))) ||
    (a === 203 && b === 0 && ip[2] === 113) ||
    a >= 224
  )
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h.includes(':')) return false
  // WHATWG URL canonicalizes IPv4-mapped IPv6 literals (for example
  // ::ffff:127.0.0.1 -> ::ffff:7f00:1), so reject mapped literals as a class.
  if (h.startsWith('::ffff:')) return true
  return (
    h === '::' ||
    h === '::1' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    /^fe[89ab]/.test(h) ||
    h.startsWith('ff') ||
    h.startsWith('2001:db8:')
  )
}

/**
 * Validate a user-controlled outbound URL before Worker fetch().
 * Custom public providers remain supported, but loopback/private/link-local and
 * non-HTTPS targets are rejected.
 */
export function parseSafeExternalHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid external URL')
  }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS external URLs are allowed')
  if (url.username || url.password) throw new Error('Credentials in external URLs are not allowed')

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private/internal URLs are not allowed')
  }
  if (isBlockedIpv4(host) || isBlockedIpv6(host)) {
    throw new Error('Private/internal URLs are not allowed')
  }
  return url
}

export async function readResponseBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Remote response too large (max ${maxBytes} bytes)`)
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('response too large')
        throw new Error(`Remote response too large (max ${maxBytes} bytes)`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
