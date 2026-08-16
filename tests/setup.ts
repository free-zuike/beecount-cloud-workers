import nodeCrypto from 'crypto';

const g = globalThis as any;

if (typeof g.crypto !== 'undefined' && g.crypto.subtle) {
  if (!(g.crypto.subtle as any).timingSafeEqual) {
    (g.crypto.subtle as any).timingSafeEqual = async function timingSafeEqual(
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
