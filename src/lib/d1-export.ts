/**
 * D1 REST API 分步导出
 * 
 * Step 1: startExport() — 启动导出任务，返回 bookmark
 * Step 2: pollAndDownload(bookmark) — 轮询直到完成并下载
 * 
 * 分步设计避免 waitUntil 超时，由 cron 定时检查
 */

export interface D1ExportState {
  accountId: string;
  databaseId: string;
  bookmark: string;
  startedAt: string;
}

function getAuthHeaders(apiToken: string) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
  };
}

/**
 * Step 1: 启动导出任务
 */
export async function startD1Export(
  apiToken: string,
  databaseName: string = 'beecount-cloud',
): Promise<D1ExportState> {
  const headers = getAuthHeaders(apiToken);

  // 获取 account_id
  const accountsRes = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers });
  if (!accountsRes.ok) throw new Error(`Failed to fetch accounts: ${accountsRes.status}`);
  const accountsData = await accountsRes.json() as any;
  const accountId = accountsData.result?.[0]?.id;
  if (!accountId) throw new Error('No Cloudflare account found');

  // 获取 database_id
  const dbListRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, { headers });
  if (!dbListRes.ok) throw new Error(`Failed to list databases: ${dbListRes.status}`);
  const dbListData = await dbListRes.json() as any;
  const db = dbListData.result?.find((d: any) => d.name === databaseName);
  if (!db) throw new Error(`Database "${databaseName}" not found`);
  const databaseId = db.uuid;

  // 发起导出
  const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
  const startRes = await fetch(exportUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ output_format: 'polling' }),
  });
  if (!startRes.ok) {
    const errBody = await startRes.text().catch(() => '');
    throw new Error(`D1 export start failed (${startRes.status}): ${errBody}`);
  }
  const startData = await startRes.json() as any;
  if (!startData.result?.at_bookmark) throw new Error('D1 export: missing at_bookmark');

  return {
    accountId,
    databaseId,
    bookmark: startData.result.at_bookmark,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Step 2: 轮询并下载（单次调用，不循环）
 * 返回 null 表示还在处理中，返回 Uint8Array 表示下载完成
 */
export async function pollD1Export(
  apiToken: string,
  state: D1ExportState,
): Promise<Uint8Array | null> {
  const headers = getAuthHeaders(apiToken);
  const exportUrl = `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/d1/database/${state.databaseId}/export`;

  const pollRes = await fetch(exportUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ current_bookmark: state.bookmark, output_format: 'polling' }),
  });

  if (!pollRes.ok) {
    const errBody = await pollRes.text().catch(() => '');
    throw new Error(`D1 export poll failed (${pollRes.status}): ${errBody}`);
  }

  const pollData = await pollRes.json() as any;
  if (pollData.result?.signed_url) {
    // 导出完成，下载
    const dumpRes = await fetch(pollData.result.signed_url);
    if (!dumpRes.ok) throw new Error(`D1 export download failed: ${dumpRes.status}`);
    const buffer = await dumpRes.arrayBuffer();
    return new Uint8Array(buffer);
  }

  // 还在处理中
  return null;
}
