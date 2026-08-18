import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { serverLogger } from '../lib/logger';

type Env = {
  DB: D1Database;
  R2: R2Bucket;
  JWT_SECRET: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  BEECOUNT_DO: DurableObjectNamespace;
};

export class BackupWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    // database_id from wrangler.toml — but we need it at runtime
    // We'll query it from the D1 binding metadata or use a hardcoded value
    const databaseId = this.env.DB.databaseId || '';

    if (!accountId || !databaseId) {
      serverLogger.error('src.workflows.backup', 'Missing CLOUDFLARE_ACCOUNT_ID or databaseId');
      return;
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
    const headers = new Headers();
    headers.append('Content-Type', 'application/json');
    headers.append('Authorization', `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`);

    // Step 1: Start D1 export
    const bookmark = await step.do('start D1 export', async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ output_format: 'polling' }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`D1 export failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const { result } = (await res.json()) as any;
      if (!result?.at_bookmark) throw new Error('Missing at_bookmark from D1 export');
      return result.at_bookmark as string;
    });

    // Step 2: Poll until export is ready, then download
    const signedUrl = await step.do(
      'download D1 export',
      {
        retries: { limit: 10, delay: '5 seconds', backoff: 'exponential' },
        timeout: '5 minutes',
      },
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ current_bookmark: bookmark }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`D1 export poll failed: ${res.status} ${text.slice(0, 200)}`);
        }
        const { result } = (await res.json()) as any;
        if (!result?.signed_url) throw new Error('Export not ready yet');
        return result.signed_url as string;
      },
    );

    // Step 3: Download the SQL dump
    const sqlDump = await step.do('download SQL dump', async () => {
      const res = await fetch(signedUrl);
      if (!res.ok) throw new Error(`Failed to download dump: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });

    // Step 4: Encrypt with age (if password is configured)
    const backupPath = `backups/d1-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    try {
      const { encryptData } = await import('../lib/encryption');
      // We need a password — for now, store unencrypted
      // TODO: get password from remote config
      await this.env.R2.put(backupPath, sqlDump, {
        httpMetadata: { contentType: 'application/sql' },
      });
      serverLogger.info('src.workflows.backup', `Backup saved to R2: ${backupPath} (${sqlDump.length} bytes)`);
    } catch (e) {
      // Fallback: store unencrypted
      await this.env.R2.put(backupPath, sqlDump, {
        httpMetadata: { contentType: 'application/sql' },
      });
      serverLogger.info('src.workflows.backup', `Backup saved to R2 (unencrypted): ${backupPath}`);
    }
  }
}

export default { BackupWorkflow };