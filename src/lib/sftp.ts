/**
 * SFTP 客户端 - 基于 ssh2 库 + Cloudflare Workers TCP Sockets
 * 参考 tafeng (https://github.com/619dev/tafeng) 的架构实现
 */
import { connect } from 'cloudflare:sockets';
import { Client } from 'ssh2';
import { Duplex } from 'stream';
import { Buffer } from 'buffer';

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

class CloudflareSocketDuplex extends Duplex {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private destroyedByClose = false;

  constructor(tcpSocket: ReturnType<typeof connect>) {
    super();
    this.reader = tcpSocket.readable.getReader();
    this.writer = tcpSocket.writable.getWriter();
    void this.pump();
  }

  _read() {}

  _write(chunk: Buffer | Uint8Array | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, _encoding) : new Uint8Array(chunk);
    this.writer.write(bytes).then(() => callback(), callback);
  }

  _final(callback: (error?: Error | null) => void) {
    this.writer.close().then(() => callback(), callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.destroyedByClose = true;
    Promise.allSettled([this.reader.cancel(), this.writer.abort(error ?? undefined)])
      .then(() => callback(error))
      .catch((closeError) => callback(closeError instanceof Error ? closeError : error));
  }

  private async pump() {
    try {
      while (!this.destroyedByClose) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.push(Buffer.from(value));
      }
      this.push(null);
    } catch (err) {
      if (!this.destroyedByClose) this.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

class SftpClient {
  private config: SftpConfig;
  private conn: Client | null = null;

  constructor(config: SftpConfig) {
    this.config = config;
  }

  private async withSftp<T>(fn: (sftp: any) => Promise<T>): Promise<T> {
    const tcpSocket = connect({ hostname: this.config.host, port: this.config.port });
    await tcpSocket.opened;
    const duplex = new CloudflareSocketDuplex(tcpSocket);
    const conn = new Client();

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timeout'));
      }, 20000);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            reject(err);
            return;
          }
          fn(sftp).then((result) => {
            clearTimeout(timeout);
            sftp.end();
            conn.end();
            resolve(result);
          }).catch((err) => {
            clearTimeout(timeout);
            sftp.end();
            conn.end();
            reject(err);
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({
        host: this.config.host,
        port: this.config.port,
        sock: duplex,
        username: this.config.username,
        password: this.config.password || undefined,
        privateKey: this.config.privateKey || undefined,
        readyTimeout: 20000,
        algorithms: {
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc'],
          hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
        },
      });
    });
  }

  async list(dirPath: string): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
    return this.withSftp((sftp) => {
      return new Promise((resolve, reject) => {
        sftp.readdir(dirPath || '/', (err: Error | undefined, list: any[]) => {
          if (err) return reject(err);
          const items = list.map((item) => {
            const parentPath = (dirPath || '/').replace(/\/$/, '');
            return {
              Name: item.filename,
              Path: `${parentPath}/${item.filename}`,
              IsDir: item.attrs?.isDirectory?.() || false,
            };
          });
          resolve(items);
        });
      });
    });
  }

  async delete(remotePath: string): Promise<boolean> {
    return this.withSftp((sftp) => {
      return new Promise((resolve, reject) => {
        sftp.unlink(remotePath, (err: Error | undefined) => {
          if (err) return reject(err);
          resolve(true);
        });
      });
    });
  }

  async upload(remotePath: string, data: Uint8Array): Promise<boolean> {
    return this.withSftp((sftp) => {
      return new Promise((resolve, reject) => {
        sftp.writeFile(remotePath, Buffer.from(data), (err: Error | undefined) => {
          if (err) return reject(err);
          resolve(true);
        });
      });
    });
  }

  async test(): Promise<{ success: boolean; message: string }> {
    try {
      await this.withSftp((sftp) => {
        return new Promise<void>((resolve, reject) => {
          sftp.realpath('.', (err: Error | undefined) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });
      return { success: true, message: 'SFTP connection successful' };
    } catch (error) {
      return { success: false, message: `SFTP connection failed: ${(error as Error).message}` };
    }
  }
}

export function createSftpClient(config: SftpConfig): SftpClient {
  return new SftpClient(config);
}