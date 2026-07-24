/**
 * 通过 Cloudflare REST API 导出 D1 数据库为 SQLite 文件
 * 
 * 使用 POST /accounts/{account_id}/d1/database/{database_id}/export 端点
 * 该端点支持所有 D1 数据库（alpha 和 production），不区分版本
 */
export async function exportD1ViaRestApi(
  accountId: string,
  databaseId: string,
  apiToken: string,
): Promise<Uint8Array> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
  };

  // Step 1: 发起导出任务
  console.debug('[D1 Export] Starting export job...');
  const startRes = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ output_format: 'polling' }),
  });

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => '');
    throw new Error(`D1 export start failed (${startRes.status}): ${errText}`);
  }

  const startData = await startRes.json() as any;
  if (!startData.result?.at_bookmark) {
    throw new Error(`D1 export start: missing at_bookmark in response`);
  }
  const bookmark = startData.result.at_bookmark;
  console.debug(`[D1 Export] Job started, bookmark: ${bookmark}`);

  // Step 2: 轮询等待导出完成
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 等待 2 秒
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pollRes = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ current_bookmark: bookmark }),
    });

    if (!pollRes.ok) {
      const errText = await pollRes.text().catch(() => '');
      throw new Error(`D1 export poll failed (${pollRes.status}): ${errText}`);
    }

    const pollData = await pollRes.json() as any;

    if (pollData.result?.signed_url) {
      // 导出完成，下载文件
      console.debug(`[D1 Export] Export ready, downloading...`);
      const dumpRes = await fetch(pollData.result.signed_url);
      if (!dumpRes.ok) {
        throw new Error(`D1 export download failed: ${dumpRes.status}`);
      }
      const buffer = await dumpRes.arrayBuffer();
      const data = new Uint8Array(buffer);
      console.debug(`[D1 Export] Downloaded: ${data.length} bytes`);
      return data;
    }

    // 继续轮询
    console.debug(`[D1 Export] Waiting... (attempt ${attempt + 1}/${maxAttempts})`);
  }

  throw new Error('D1 export timed out after 60 seconds');
}
