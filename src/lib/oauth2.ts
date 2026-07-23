/**
 * OAuth2 支持 - 用于 Google Drive / OneDrive / Dropbox
 * Cloudflare Workers 中实现 OAuth2 流程
 */

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface OAuth2Token {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

// Google Drive OAuth2 配置
export const GOOGLE_DRIVE_CONFIG: OAuth2Config = {
  clientId: '',
  clientSecret: '',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/drive.file'],
};

// OneDrive OAuth2 配置
export const ONEDRIVE_CONFIG: OAuth2Config = {
  clientId: '',
  clientSecret: '',
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: ['files.readwrite'],
};

// Dropbox OAuth2 配置
export const DROPBOX_CONFIG: OAuth2Config = {
  clientId: '',
  clientSecret: '',
  authUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropbox.com/oauth2/token',
  scopes: [],
};

/**
 * 生成 OAuth2 授权 URL
 */
export function generateAuthUrl(
  config: OAuth2Config,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${config.authUrl}?${params.toString()}`;
}

/**
 * 用授权码换取 access token
 */
export async function exchangeCodeForToken(
  config: OAuth2Config,
  code: string,
  redirectUri: string
): Promise<OAuth2Token> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

/**
 * 刷新 access token
 */
export async function refreshAccessToken(
  config: OAuth2Config,
  refreshToken: string
): Promise<OAuth2Token> {
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  return response.json();
}

/**
 * 获取 Google Drive 文件列表
 */
export async function listGoogleDriveFiles(
  accessToken: string,
  folderId: string = 'root'
): Promise<any[]> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents&fields=files(id,name,mimeType,size)`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Google Drive API failed: ${response.status}`);
  }

  const data = await response.json();
  return data.files || [];
}

/**
 * 上传文件到 Google Drive
 */
export async function uploadToGoogleDrive(
  accessToken: string,
  fileName: string,
  fileContent: ArrayBuffer,
  folderId: string = 'root'
): Promise<any> {
  const metadata = {
    name: fileName,
    parents: [folderId],
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([fileContent]), fileName);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Drive upload failed: ${error}`);
  }

  return response.json();
}

/**
 * 获取 OneDrive 文件列表
 */
export async function listOneDriveFiles(
  accessToken: string,
  folderId: string = 'root'
): Promise<any[]> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`OneDrive API failed: ${response.status}`);
  }

  const data = await response.json();
  return data.value || [];
}

/**
 * 上传文件到 OneDrive
 */
export async function uploadToOneDrive(
  accessToken: string,
  fileName: string,
  fileContent: ArrayBuffer,
  folderId: string = 'root'
): Promise<any> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${fileName}:/content`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: fileContent,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OneDrive upload failed: ${error}`);
  }

  return response.json();
}

/**
 * 获取 Dropbox 文件列表
 */
export async function listDropboxFiles(
  accessToken: string,
  path: string = ''
): Promise<any[]> {
  const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });

  if (!response.ok) {
    throw new Error(`Dropbox API failed: ${response.status}`);
  }

  const data = await response.json();
  return data.entries || [];
}

/**
 * 上传文件到 Dropbox
 */
export async function uploadToDropbox(
  accessToken: string,
  path: string,
  fileContent: ArrayBuffer
): Promise<any> {
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'overwrite',
      }),
    },
    body: fileContent,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Dropbox upload failed: ${error}`);
  }

  return response.json();
}
