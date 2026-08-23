/**
 * FTP 客户端 - 基于 Cloudflare Workers TCP Sockets
 * 支持基本的文件上传/下载/目录操作
 */
import { connect } from 'cloudflare:sockets';

export interface FtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  secure?: boolean;
}

class FtpClient {
  private config: FtpConfig;

  constructor(config: FtpConfig) {
    this.config = config;
  }

  private async sendCommand(socket: any, command: string): Promise<string> {
    const writer = socket.writable.getWriter();
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(command + '\r\n'));
    writer.releaseLock();

    const reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    let response = '';

    try {
      while (true) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) =>
          setTimeout(() => reject(new Error('FTP response timeout')), 10000)
        );
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        response += decoder.decode(value);
        const lines = response.split('\r\n');
        const lastLine = lines[lines.length - 2] || lines[lines.length - 1];
        if (lastLine && /^\d{3}\s/.test(lastLine) && !lastLine.startsWith('1')) {
          break;
        }
        if (lastLine && /^\d{3}-/.test(lastLine)) {
          continue;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return response;
  }

  private async connect(): Promise<any> {
    const socket = connect({
      hostname: this.config.host,
      port: this.config.port,
    });
    await socket.opened;
    return socket;
  }

  async list(dirPath: string): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
    let socket: any;
    try {
      socket = await this.connect();
      await this.sendCommand(socket, '');
      await this.sendCommand(socket, `USER ${this.config.username}`);
      await this.sendCommand(socket, `PASS ${this.config.password}`);
      await this.sendCommand(socket, 'TYPE A');

      const pasvResponse = await this.sendCommand(socket, 'PASV');
      const pasvMatch = pasvResponse.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
      if (!pasvMatch) { socket.close(); return []; }

      const host = `${pasvMatch[1]}.${pasvMatch[2]}.${pasvMatch[3]}.${pasvMatch[4]}`;
      const port = parseInt(pasvMatch[5]) * 256 + parseInt(pasvMatch[6]);
      const dataSocket = connect({ hostname: host, port });
      await dataSocket.opened;

      await this.sendCommand(socket, `MLSD ${dirPath || '/'}`);

      const reader = dataSocket.readable.getReader();
      const decoder = new TextDecoder();
      let listData = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        listData += decoder.decode(value);
      }
      reader.releaseLock();
      dataSocket.close();
      await this.sendCommand(socket, '');
      await this.sendCommand(socket, 'QUIT');
      socket.close();

      const items: Array<{ Name: string; Path: string; IsDir: boolean }> = [];
      for (const line of listData.split('\n')) {
        const parts = line.trim().split(';');
        const namePart = parts[parts.length - 1]?.trim();
        if (!namePart || namePart === '.' || namePart === '..') continue;
        const isDir = line.includes('type=dir');
        const path = dirPath ? `${dirPath}/${namePart}` : namePart;
        items.push({ Name: namePart, Path: path, IsDir: isDir });
      }
      return items;
    } catch { socket?.close(); return []; }
  }

  async listRecursive(dirPath: string): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
    const allItems: Array<{ Name: string; Path: string; IsDir: boolean }> = [];
    const dirsToScan = [dirPath || ''];
    const scanned = new Set<string>();

    while (dirsToScan.length > 0) {
      const currentDir = dirsToScan.shift()!;
      if (scanned.has(currentDir)) continue;
      scanned.add(currentDir);

      const items = await this.list(currentDir);
      for (const item of items) {
        allItems.push(item);
        if (item.IsDir) {
          dirsToScan.push(item.Path);
        }
      }
    }

    return allItems;
  }

  async delete(remotePath: string): Promise<boolean> {
    let socket: any;
    try {
      socket = await this.connect();
      await this.sendCommand(socket, '');
      await this.sendCommand(socket, `USER ${this.config.username}`);
      await this.sendCommand(socket, `PASS ${this.config.password}`);
      const resp = await this.sendCommand(socket, `DELE ${remotePath}`);
      await this.sendCommand(socket, 'QUIT');
      socket.close();
      return resp.startsWith('2');
    } catch { socket?.close(); return false; }
  }

  async upload(remotePath: string, data: Uint8Array): Promise<boolean> {
    let socket: any;
    try {
      socket = await this.connect();

      // Read welcome message
      await this.sendCommand(socket, '');

      // Login
      await this.sendCommand(socket, `USER ${this.config.username}`);
      await this.sendCommand(socket, `PASS ${this.config.password}`);

      // Enter binary mode
      await this.sendCommand(socket, 'TYPE I');

      // 递归创建目录（忽略已存在的错误）
      const dirPath = remotePath.substring(0, remotePath.lastIndexOf('/'));
      if (dirPath) {
        const parts = dirPath.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
          current += '/' + part;
          try { await this.sendCommand(socket, `MKD ${current}`); } catch {}
        }
      }

      // Enter passive mode to get data connection
      const pasvResponse = await this.sendCommand(socket, 'PASV');
      const pasvMatch = pasvResponse.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
      if (!pasvMatch) {
        throw new Error('Failed to enter passive mode');
      }

      const host = `${pasvMatch[1]}.${pasvMatch[2]}.${pasvMatch[3]}.${pasvMatch[4]}`;
      const port = parseInt(pasvMatch[5]) * 256 + parseInt(pasvMatch[6]);

      // Create data connection
      const dataSocket = connect({ hostname: host, port });
      await dataSocket.opened;

      // Store file
      await this.sendCommand(socket, `STOR ${remotePath}`);

      // Write data
      const writer = dataSocket.writable.getWriter();
      await writer.write(data);
      await writer.close();
      dataSocket.close();

      // Check response
      const storeResponse = await this.sendCommand(socket, '');
      const success = storeResponse.startsWith('2') || storeResponse.startsWith('1');

      // Quit
      await this.sendCommand(socket, 'QUIT');
      socket.close();

      return success;
    } catch (error) {
      console.error('[FTP] Upload failed:', error);
      socket?.close();
      return false;
    }
  }

  async test(): Promise<{ success: boolean; message: string }> {
    let socket: any;
    try {
      socket = await this.connect();
      const welcome = await this.sendCommand(socket, '');
      if (!welcome.startsWith('2')) {
        return { success: false, message: `Connection failed: ${welcome.trim()}` };
      }
      const loginResponse = await this.sendCommand(socket, `USER ${this.config.username}`);
      const passResponse = await this.sendCommand(socket, `PASS ${this.config.password}`);
      await this.sendCommand(socket, 'QUIT');
      socket.close();
      return { success: true, message: 'FTP connection successful' };
    } catch (error) {
      socket?.close();
      return { success: false, message: `FTP connection failed: ${(error as Error).message}` };
    }
  }
}

export function createFtpClient(config: FtpConfig): FtpClient {
  return new FtpClient(config);
}
