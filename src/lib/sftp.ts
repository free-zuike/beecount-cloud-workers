/**
 * SFTP 客户端 - 基于 Cloudflare Workers TCP Sockets
 * 实现 SSH2 连接和 SFTP 文件上传
 */
import { connect } from 'cloudflare:sockets';

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

const SSH_MSG_DISCONNECT = 1;
const SSH_MSG_SERVICE_REQUEST = 5;
const SSH_MSG_SERVICE_ACCEPT = 6;
const SSH_MSG_USERAUTH_REQUEST = 50;
const SSH_MSG_USERAUTH_SUCCESS = 52;
const SSH_MSG_CHANNEL_OPEN = 90;
const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
const SSH_MSG_CHANNEL_REQUEST = 98;
const SSH_MSG_CHANNEL_SUCCESS = 99;
const SFTP_INIT = 1;
const SFTP_VERSION = 3;

class SshPacket {
  private buffer: number[] = [];
  writeUint32(v: number) { this.buffer.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); }
  writeByte(v: number) { this.buffer.push(v & 0xff); }
  writeString(s: string) { const b = new TextEncoder().encode(s); this.writeUint32(b.length); this.buffer.push(...b); }
  writeBytes(data: Uint8Array) { this.writeUint32(data.length); this.buffer.push(...data); }
  toBuffer(): Uint8Array {
    const payload = new Uint8Array(this.buffer);
    const len = new Uint8Array(4);
    len[0] = (payload.length >> 24) & 0xff; len[1] = (payload.length >> 16) & 0xff;
    len[2] = (payload.length >> 8) & 0xff; len[3] = payload.length & 0xff;
    const r = new Uint8Array(4 + payload.length); r.set(len, 0); r.set(payload, 4); return r;
  }
  static fromBuffer(buf: Uint8Array, off = 0): { type: number; data: Uint8Array } {
    const len = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    return { type: buf[off + 4], data: buf.slice(off + 4, off + 4 + len) };
  }
  static readUint32(buf: Uint8Array, off: number): number {
    return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
  }
}

class SftpClient {
  private config: SftpConfig;
  private socket: any = null;
  private channelId = 0;
  private requestId = 0;
  private responseBuf = new Uint8Array(0);

  constructor(config: SftpConfig) { this.config = config; }

  private async connect(): Promise<void> {
    this.socket = connect({ hostname: this.config.host, port: this.config.port });
    await this.socket.opened;
  }

  private async readPacket(): Promise<{ type: number; data: Uint8Array }> {
    const reader = this.socket.readable.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    this.responseBuf = new Uint8Array([...this.responseBuf, ...value]);
    return SshPacket.fromBuffer(this.responseBuf, 0);
  }

  private async sendRaw(data: string | Uint8Array): Promise<void> {
    const writer = this.socket.writable.getWriter();
    await writer.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  async upload(remotePath: string, data: Uint8Array): Promise<boolean> {
    try {
      await this.connect();
      await this.readPacket();
      await this.sendRaw('SSH-2.0-BeecountSFTP\r\n');
      const ver = await this.readPacket();

      const svcReq = new SshPacket();
      svcReq.writeByte(5); svcReq.writeUint32(0); svcReq.writeString('ssh-userauth');
      await this.sendRaw(svcReq.toBuffer());
      await this.readPacket();

      const authReq = new SshPacket();
      authReq.writeByte(50); authReq.writeUint32(0);
      authReq.writeString(this.config.username);
      authReq.writeString('ssh-connection');
      authReq.writeString('password');
      authReq.writeString(this.config.password || '');
      await this.sendRaw(authReq.toBuffer());
      const authResp = await this.readPacket();
      if (authResp.type !== 52) { this.socket.close(); return false; }

      const chOpen = new SshPacket();
      chOpen.writeByte(90); chOpen.writeUint32(0); chOpen.writeString('session');
      chOpen.writeUint32(0); chOpen.writeUint32(32768);
      await this.sendRaw(chOpen.toBuffer());
      const chResp = await this.readPacket();
      if (chResp.type !== 91) { this.socket.close(); return false; }
      this.channelId = SshPacket.readUint32(chResp.data, 0);

      const sftpReq = new SshPacket();
      sftpReq.writeByte(98); sftpReq.writeUint32(this.channelId);
      sftpReq.writeString('subsystem'); sftpReq.writeByte(1); sftpReq.writeString('sftp');
      await this.sendRaw(sftpReq.toBuffer());
      await this.readPacket();

      const sftpInit = new SshPacket();
      sftpInit.writeByte(SFTP_INIT); sftpInit.writeUint32(SFTP_VERSION);
      const chData = new SshPacket();
      chData.writeByte(94); chData.writeUint32(this.channelId);
      chData.writeBytes(sftpInit.toBuffer());
      await this.sendRaw(chData.toBuffer());
      await this.readPacket();

      const dir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
      if (dir !== '/') {
        const mkReq = new SshPacket();
        mkReq.writeByte(94); mkReq.writeUint32(this.channelId);
        const mkSftp = new SshPacket();
        mkSftp.writeByte(8); mkSftp.writeUint32(++this.requestId);
        mkSftp.writeString(dir); mkSftp.writeUint32(0);
        mkReq.writeBytes(mkSftp.toBuffer());
        await this.sendRaw(mkReq.toBuffer());
        await this.readPacket();
      }

      const openId = ++this.requestId;
      const openPkt = new SshPacket();
      openPkt.writeByte(94); openPkt.writeUint32(this.channelId);
      const openSftp = new SshPacket();
      openSftp.writeByte(3); openSftp.writeUint32(openId);
      openSftp.writeString(remotePath); openSftp.writeUint32(2); openSftp.writeUint32(0);
      openPkt.writeBytes(openSftp.toBuffer());
      await this.sendRaw(openPkt.toBuffer());
      const openResp = await this.readPacket();

      const wrtId = ++this.requestId;
      const wrtPkt = new SshPacket();
      wrtPkt.writeByte(94); wrtPkt.writeUint32(this.channelId);
      const wrtSftp = new SshPacket();
      wrtSftp.writeByte(6); wrtSftp.writeUint32(wrtId);
      wrtSftp.writeBytes(openResp.data.slice(5));
      wrtSftp.writeUint32(0); wrtSftp.writeBytes(data);
      wrtPkt.writeBytes(wrtSftp.toBuffer());
      await this.sendRaw(wrtPkt.toBuffer());
      await this.readPacket();

      await this.sendRaw(new Uint8Array([1, 0, 0, 0, 0]));
      this.socket.close();
      return true;
    } catch (e) {
      console.error('[SFTP] Upload error:', e);
      this.socket?.close();
      return false;
    }
  }

  async test(): Promise<{ success: boolean; message: string }> {
    try {
      await this.connect();
      await this.readPacket();
      await this.sendRaw('SSH-2.0-BeecountSFTP\r\n');
      await this.readPacket();
      const svcReq = new SshPacket();
      svcReq.writeByte(5); svcReq.writeUint32(0); svcReq.writeString('ssh-userauth');
      await this.sendRaw(svcReq.toBuffer());
      await this.readPacket();
      const authReq = new SshPacket();
      authReq.writeByte(50); authReq.writeUint32(0);
      authReq.writeString(this.config.username);
      authReq.writeString('ssh-connection');
      authReq.writeString('password');
      authReq.writeString(this.config.password || '');
      await this.sendRaw(authReq.toBuffer());
      const resp = await this.readPacket();
      this.socket.close();
      return resp.type === 52
        ? { success: true, message: 'SFTP authentication successful' }
        : { success: false, message: 'SFTP authentication failed' };
    } catch (e) {
      this.socket?.close();
      return { success: false, message: `SFTP connection failed: ${(e as Error).message}` };
    }
  }
}

export function createSftpClient(config: SftpConfig): SftpClient {
  return new SftpClient(config);
}
