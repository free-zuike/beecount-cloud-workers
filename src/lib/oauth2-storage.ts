/**
 * OAuth2 云存储提供商 — Google Drive / OneDrive / Dropbox
 *
 * 使用 refresh_token 获取 access_token，然后调用各提供商 REST API
 * 实现备份文件的上传、列出、删除。
 */

// ==================== Token 刷新 ====================

async function refreshAccessToken(
  provider: 'drive' | 'onedrive' | 'dropbox',
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string | null> {
  const endpoints: Record<string, string> = {
    drive: 'https://oauth2.googleapis.com/token',
    onedrive: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    dropbox: 'https://api.dropbox.com/oauth2/token',
  };

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  if (provider === 'onedrive') {
    body.set('scope', 'https://graph.microsoft.com/Files.ReadWrite.All offline_access');
  }

  try {
    const res = await fetch(endpoints[provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string };
    return data.access_token || null;
  } catch {
    return null;
  }
}

// ==================== Google Drive ====================

export async function uploadToDrive(
  config: Record<string, string>,
  fileName: string,
  data: Uint8Array,
): Promise<boolean> {
  const token = await refreshAccessToken('drive', config.client_id!, config.client_secret!, config.token!);
  if (!token) return false;

  try {
    // 1. 创建文件元数据
    const metaRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: fileName, parents: config.folder_id ? [config.folder_id] : [] }),
    });
    if (!metaRes.ok) return false;
    const uploadUrl = metaRes.headers.get('Location');
    if (!uploadUrl) return false;

    // 2. 上传文件内容
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(data.length) },
      body: data,
    });
    return uploadRes.ok;
  } catch {
    return false;
  }
}

export async function listDriveFiles(
  config: Record<string, string>,
): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
  const token = await refreshAccessToken('drive', config.client_id!, config.client_secret!, config.token!);
  if (!token) return [];

  try {
    const folderQuery = config.folder_id ? ` and '${config.folder_id}' in parents` : '';
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name contains 'backup'${folderQuery}&fields=files(id,name,mimeType)&orderBy=name`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = await res.json() as { files?: Array<{ id: string; name: string; mimeType: string }> };
    return (data.files || []).map(f => ({ Name: f.name, Path: f.id, IsDir: f.mimeType === 'application/vnd.google-apps.folder' }));
  } catch {
    return [];
  }
}

export async function deleteDriveFile(
  config: Record<string, string>,
  fileId: string,
): Promise<boolean> {
  const token = await refreshAccessToken('drive', config.client_id!, config.client_secret!, config.token!);
  if (!token) return false;

  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// ==================== Microsoft OneDrive ====================

export async function uploadToOneDrive(
  config: Record<string, string>,
  fileName: string,
  data: Uint8Array,
): Promise<boolean> {
  const token = await refreshAccessToken('onedrive', config.client_id!, config.client_secret!, config.token!);
  if (!token) return false;

  try {
    const path = config.folder_path ? `/${config.folder_path}/${fileName}` : `/${fileName}`;
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/root:${encodeURI(path)}:/content`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: data,
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOneDriveFiles(
  config: Record<string, string>,
): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
  const token = await refreshAccessToken('onedrive', config.client_id!, config.client_secret!, config.token!);
  if (!token) return [];

  try {
    const searchUrl = config.folder_path
      ? `https://graph.microsoft.com/v1.0/me/drive/root:/${config.folder_path}:/search(q='backup')`
      : `https://graph.microsoft.com/v1.0/me/drive/root/search(q='backup')`;
    const res = await fetch(
      searchUrl,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = await res.json() as { value?: Array<{ name: string; id: string; folder?: unknown }> };
    return (data.value || []).map(f => ({ Name: f.name, Path: f.id, IsDir: !!f.folder }));
  } catch {
    return [];
  }
}

export async function deleteOneDriveFile(
  config: Record<string, string>,
  fileId: string,
): Promise<boolean> {
  const token = await refreshAccessToken('onedrive', config.client_id!, config.client_secret!, config.token!);
  if (!token) return false;

  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// ==================== Dropbox ====================

export async function uploadToDropbox(
  config: Record<string, string>,
  fileName: string,
  data: Uint8Array,
): Promise<boolean> {
  const token = await refreshAccessToken('dropbox', config.client_id!, config.client_secret!, config.token!);
  if (!token) return false;

  try {
    const path = config.folder_path ? `/${config.folder_path}/${fileName}` : `/${fileName}`;
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add' }),
        'Content-Type': 'application/octet-stream',
      },
      body: data,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listDropboxFiles(
  config: Record<string, string>,
): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
  const token = await refreshAccessToken('dropbox', config.client_id!, config.client_secret!, config.token!);
  if (!token) return [];

  try {
    const path = config.folder_path ? `/${config.folder_path}` : '';
    const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, recursive: true, include_media_info: false }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { entries?: Array<{ name: string; path_display: string; '.tag': string }> };
    return (data.entries || []).map(f => ({ Name: f.name, Path: f.path_display, IsDir: f['.tag'] === 'folder' }));
  } catch {
    return [];
  }
}

export async function deleteDropboxFile(
  config: Record<string, string>,
  filePath: string,
): Promise<boolean> {
  const token = await refreshAccessToken('dropbox', config.client_id!, config.client_secret!, config.token!);
  if (!token) return false;

  try {
    const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: filePath }),
    });
    return res.ok || res.status === 409;
  } catch {
    return false;
  }
}

// ==================== 统一接口（用于 backup-executor） ====================

export async function uploadToOAuth2Provider(
  config: Record<string, string>,
  fileName: string,
  data: Uint8Array,
): Promise<boolean> {
  switch (config.backend_type) {
    case 'drive': return await uploadToDrive(config, fileName, data);
    case 'onedrive': return await uploadToOneDrive(config, fileName, data);
    case 'dropbox': return await uploadToDropbox(config, fileName, data);
    default: return false;
  }
}

export async function listOAuth2Files(
  config: Record<string, string>,
): Promise<Array<{ Name: string; Path: string; IsDir: boolean }>> {
  switch (config.backend_type) {
    case 'drive': return await listDriveFiles(config);
    case 'onedrive': return await listOneDriveFiles(config);
    case 'dropbox': return await listDropboxFiles(config);
    default: return [];
  }
}

export async function deleteOAuth2File(
  config: Record<string, string>,
  fileId: string,
): Promise<boolean> {
  switch (config.backend_type) {
    case 'drive': return await deleteDriveFile(config, fileId);
    case 'onedrive': return await deleteOneDriveFile(config, fileId);
    case 'dropbox': return await deleteDropboxFile(config, fileId);
    default: return false;
  }
}