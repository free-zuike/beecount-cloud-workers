/**
 * Minimal TAR archive creator for Cloudflare Workers
 * Compatible with POSIX.1-2001 (ustar) format
 */

interface TarEntry {
  name: string;
  data: Uint8Array;
  mode?: number;
  mtime?: number;
}

const BLOCK_SIZE = 512;

/**
 * Calculate CRC32 checksum for tar header
 */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Write an octal number to a fixed-width field
 */
function writeOctal(value: number, offset: number, length: number, buffer: Uint8Array): void {
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  for (let i = 0; i < length && i < str.length; i++) {
    buffer[offset + i] = str.charCodeAt(i);
  }
}

/**
 * Write a string to a fixed-width field
 */
function writeString(value: string, offset: number, length: number, buffer: Uint8Array): void {
  for (let i = 0; i < length && i < value.length; i++) {
    buffer[offset + i] = value.charCodeAt(i);
  }
}

/**
 * Create a TAR header for a file entry
 */
function createHeader(entry: TarEntry, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  
  // File name (offset 0, 100 bytes)
  writeString(entry.name, 0, 100, header);
  
  // File mode (offset 100, 8 bytes)
  writeOctal(entry.mode ?? 0o644, 100, 8, header);
  
  // Owner ID (offset 108, 8 bytes)
  writeOctal(0, 108, 8, header);
  
  // Group ID (offset 116, 8 bytes)
  writeOctal(0, 116, 8, header);
  
  // File size (offset 124, 12 bytes)
  writeOctal(size, 124, 12, header);
  
  // Modification time (offset 136, 12 bytes)
  writeOctal(entry.mtime ?? Math.floor(Date.now() / 1000), 136, 12, header);
  
  // Checksum placeholder (offset 148, 8 bytes) - filled with spaces initially
  for (let i = 148; i < 156; i++) {
    header[i] = 0x20; // space
  }
  
  // Type flag (offset 156, 1 byte) - '0' for regular file
  header[156] = 0x30; // '0'
  
  // USTAR magic (offset 257, 6 bytes)
  writeString('ustar', 257, 6, header);
  
  // USTAR version (offset 263, 2 bytes)
  header[263] = 0x30; // '0'
  header[264] = 0x30; // '0'
  
  // Calculate checksum
  const checksum = crc32(header);
  writeOctal(checksum, 148, 7, header);
  header[155] = 0x00; // null terminator
  
  return header;
}

/**
 * Create a TAR archive from multiple file entries
 */
export function createTar(entries: TarEntry[]): Uint8Array {
  // Calculate total size
  let totalSize = 0;
  for (const entry of entries) {
    totalSize += BLOCK_SIZE; // header
    totalSize += Math.ceil(entry.data.length / BLOCK_SIZE) * BLOCK_SIZE; // data (padded)
  }
  totalSize += BLOCK_SIZE * 2; // end blocks
  
  const tar = new Uint8Array(totalSize);
  let offset = 0;
  
  for (const entry of entries) {
    // Write header
    const header = createHeader(entry, entry.data.length);
    tar.set(header, offset);
    offset += BLOCK_SIZE;
    
    // Write data
    tar.set(entry.data, offset);
    offset += entry.data.length;
    
    // Pad to block boundary
    const padding = Math.ceil(entry.data.length / BLOCK_SIZE) * BLOCK_SIZE - entry.data.length;
    offset += padding;
  }
  
  // Write end blocks (two 512-byte zero blocks)
  // Already zero-initialized, so nothing to write
  
  return tar;
}

/**
 * Compress data using gzip (CompressionStream API)
 */
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  const response = new Response(stream);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Create a tar.gz archive from multiple file entries
 */
export async function createTarGz(entries: TarEntry[]): Promise<Uint8Array> {
  const tar = createTar(entries);
  return gzip(tar);
}
