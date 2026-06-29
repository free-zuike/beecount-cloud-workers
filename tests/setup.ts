import nodeCrypto from 'crypto';

if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
  if (!(globalThis.crypto.subtle as any).timingSafeEqual) {
    (globalThis.crypto.subtle as any).timingSafeEqual = async function timingSafeEqual(
      a: ArrayBuffer,
      b: ArrayBuffer
    ): Promise<boolean> {
      const bufA = Buffer.from(a);
      const bufB = Buffer.from(b);
      if (bufA.length !== bufB.length) return false;
      return nodeCrypto.timingSafeEqual(bufA, bufB);
    };
  }
}
