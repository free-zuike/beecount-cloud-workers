/**
 * Minimal TAR archive creator for Cloudflare Workers
 * Compatible with POSIX.1-2001 (ustar) format
 */

/**
 * tar 条目源：data 直接给字节；或 stream 提供已知大小(size)的字节流
 * （大附件场景：归档时逐个从存储流式读入，不整包驻留内存）。
 */
export type TarEntrySource = {
  name: string;
  data?: Uint8Array;
  size?: number;
  stream?: () => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  mode?: number;
  mtime?: number;
};

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
function createHeader(entry: { name: string; mode?: number; mtime?: number }, size: number): Uint8Array {
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
 * Compress data using gzip (CompressionStream API)
 */
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  const response = new Response(stream);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Create a tar.gz archive from multiple file entries（含流式附件时物化后打包，
 * 仅用于本地/缓冲调用方；生产 DO 打包走 createTarGzStream 真流式）
 */
export async function createTarGz(entries: TarEntrySource[]): Promise<Uint8Array> {
  const stream = createTarGzStream(entries);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 流式创建 tar.gz — 接受异步迭代器，逐个写入条目。
 * 条目可以是 {name, data}（直接字节），或 {name, size, stream}（归档时
 * 从 stream 逐块读入，同一时间只有一块在内存）。用于大附件场景：
 * 附件从 R2 逐个流式下载写入 tar，不全加载到内存。
 * 返回 ReadableStream，调用方直接 r2.put(key, stream) 流式上传，压缩包不落内存。
 */
export function createTarGzStream(
  entries: Iterable<TarEntrySource> | AsyncIterable<TarEntrySource>,
): ReadableStream<Uint8Array> {
  const tarStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const entry of entries) {
        const size = entry.data ? entry.data.length : (entry.size ?? 0);
        // 写 header
        const header = createHeader(entry, size);
        controller.enqueue(header);
        if (entry.data) {
          // 写数据
          controller.enqueue(entry.data);
        } else if (entry.stream) {
          // 从存储流式读（逐块 enqueue，内存只占一块）
          const src = await entry.stream();
          const reader = src.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          throw new Error(`tar entry has no data or stream: ${entry.name}`);
        }
        // 写 padding 到 512 字节边界
        const padding = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE - size;
        if (padding > 0) controller.enqueue(new Uint8Array(padding));
      }
      // 写结束块（两个 512 字节零块）
      controller.enqueue(new Uint8Array(BLOCK_SIZE * 2));
      controller.close();
    },
  });
  return tarStream.pipeThrough(new CompressionStream('gzip'));
}
