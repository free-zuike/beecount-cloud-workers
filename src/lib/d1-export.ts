/**
 * 通过 Cloudflare REST API 导出 D1 数据库为 SQLite 文件
 * 
 * 只需要 CLOUDFLARE_API_TOKEN 一个 secret
 * account_id 和 database_id 自动从 API 获取
 */
export async function exportD1ViaRestApi(
  apiToken: string,
  databaseName: string = 'beecount-cloud',
): Promise<Uint8Array> {
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
  };

  // Step 1: 获取 account_id
  console.debug('[D1 Export] Fetching account info...');
  const accountsRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
    headers: authHeaders,
  });
  if (!accountsRes.ok) {
    throw new Error(`Failed to fetch accounts: ${accountsRes.status}`);
  }
  const accountsData = await accountsRes.json() as any;
  const accountId = accountsData.result?.[0]?.id;
  if (!accountId) {
    throw new Error('No Cloudflare account found');
  }
  console.debug(`[D1 Export] Account ID: ${accountId}`);

  // Step 2: 获取 database_id（按名称查找）
  console.debug(`[D1 Export] Looking up database "${databaseName}"...`);
  const dbListRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
    { headers: authHeaders },
  );
  if (!dbListRes.ok) {
    throw new Error(`Failed to list D1 databases: ${dbListRes.status}`);
  }
  const dbListData = await dbListRes.json() as any;
  const db = dbListData.result?.find((d: any) => d.name === databaseName);
  if (!db) {
    const names = dbListData.result?.map((d: any) => d.name) || [];
    throw new Error(`Database "${databaseName}" not found. Available: ${names.join(', ')}`);
  }
  const databaseId = db.uuid;
  console.debug(`[D1 Export] Database ID: ${databaseId}`);

  // Step 3: 发起导出任务
  const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
  console.debug('[D1 Export] Starting export job...');
  const startRes = await fetch(exportUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ output_format: 'polling' }),
  });
  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => '');
    throw new Error(`D1 export start failed (${startRes.status}): ${errText}`);
  }
  const startData = await startRes.json() as any;
  if (!startData.result?.at_bookmark) {
    throw new Error('D1 export: missing at_bookmark');
  }
  const bookmark = startData.result.at_bookmark;
  console.debug(`[D1 Export] Job started, bookmark: ${bookmark}`);

  // Step 4: 轮询等待导出完成
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pollRes = await fetch(exportUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ current_bookmark: bookmark }),
    });
    if (!pollRes.ok) {
      throw new Error(`D1 export poll failed: ${pollRes.status}`);
    }
    const pollData = await pollRes.json() as any;

    if (pollData.result?.signed_url) {
      console.debug('[D1 Export] Export ready, downloading...');
      const dumpRes = await fetch(pollData.result.signed_url);
      if (!dumpRes.ok) {
        throw new Error(`D1 export download failed: ${dumpRes.status}`);
      }
      const buffer = await dumpRes.arrayBuffer();
      const data = new Uint8Array(buffer);
      console.debug(`[D1 Export] Downloaded: ${data.length} bytes`);
      return data;
    }
    console.debug(`[D1 Export] Waiting... (${attempt + 1}/30)`);
  }

  throw new Error('D1 export timed out');
}
