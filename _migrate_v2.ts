export default {
  async fetch(request, env) {
    const BUCKET = env.BEECOUNT_R2;
    // 只迁移 avatars 和 attachments，limit 100 避免超时
    const prefixes = ['avatars/', 'attachments/'];
    let migrated = 0;

    for (const prefix of prefixes) {
      let cursor = undefined;
      let count = 0;
      do {
        const list = await BUCKET.list({ prefix, cursor, limit: 100 });
        for (const obj of list.objects) {
          const destKey = `beecount/${obj.key}`;
          try {
            const src = await BUCKET.get(obj.key);
            if (!src) continue;
            const body = await src.arrayBuffer();
            const metadata = src.httpMetadata ? {
              contentType: src.httpMetadata.contentType,
              contentDisposition: src.httpMetadata.contentDisposition,
              cacheControl: src.httpMetadata.cacheControl,
            } : undefined;
            await BUCKET.put(destKey, body, metadata);
            await BUCKET.delete(obj.key);
            migrated++;
          } catch {}
          count++;
          if (count >= 50) break;
        }
        cursor = list.cursor;
      } while (cursor && count < 50);
      if (count >= 50) break;
    }

    // 统计
    let bcCount = 0;
    let c = undefined;
    do {
      const l = await BUCKET.list({ prefix: 'beecount/', cursor: c, limit: 1000 });
      bcCount += l.objects.length;
      c = l.cursor;
    } while (c);

    return new Response(JSON.stringify({ migrated, beecount_count: bcCount }), {
      headers: { 'Content-Type': 'application/json' }
    });
  },
};
