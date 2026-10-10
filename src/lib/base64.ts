/** Encode bytes without spreading a multi-megabyte array into function arguments. */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    let binary = ''
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i])
    chunks.push(binary)
  }
  return btoa(chunks.join(''))
}
