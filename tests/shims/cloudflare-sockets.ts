// 测试 shim：模拟 Cloudflare Workers 的 `cloudflare:sockets` 模块。
// 生产运行时是 Workers 专属；vitest(node) 无法解析，这里提供存根。
// 测试不会真正连接 FTP/SFTP，所以返回一个「永不出数据、可正常 open/close」的空 socket，
// 足够让 ftp.ts / sftp.ts / storage-adapter 模块加载并走到可测的代码路径。
export class CloudflareSocketStub {
  constructor(private _info: { hostname: string; port: number }) {}
  opened = Promise.resolve();
  readable = new CloudflareReadableStreamStub();
  writable = new CloudflareWritableStreamStub();
  closed = Promise.resolve();
  close(): void {
    // no-op; 测试里不存在真实网络连接要关
  }
  startTls(): Promise<unknown> {
    return Promise.resolve(this);
  }
}

class CloudflareReadableStreamStub {
  getReader() {
    // 一个永不 end、也不产生数据的 reader —— 调用方 await reader.read() 会一直挂起，
    // 但测试不会真的走到网络读（FTP/SFTP 需要真实服务器），只要求模块可加载。
    return {
      read: () => new Promise(() => {}),
      cancel: () => Promise.resolve(),
      releaseLock: () => {},
    };
  }
}

class CloudflareWritableStreamStub {
  getWriter() {
    return {
      write: () => Promise.resolve(),
      close: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      releaseLock: () => {},
    };
  }
}

export function connect(info: { hostname: string; port: number }) {
  return new CloudflareSocketStub(info);
}

export default { connect, CloudflareSocketStub };