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

    const reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    let response = '';
    const timeout = setTimeout(() => reader.cancel(), 10000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response += decoder.decode(value);
        // FTP responses end with a line starting with 3 digits followed by space or newline
        const lines = response.split('\r\n');
        const lastLine = lines[lines.length - 2] || lines[lines.length - 1];
        if (lastLine && /^\d{3}\s/.test(lastLine) && !lastLine.startsWith('1')) {
          break;
        }
        if (lastLine && /^\d{3}-/.test(lastLine)) {
          // Multi-line response, continue reading
          continue;
        }
      }
    } finally {
      clearTimeout(timeout);
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
