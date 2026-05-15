# BeeCount Cloud Workers

A Cloudflare Workers implementation of BeeCount Cloud - a fast, edge-deployed personal finance tracking system.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- 🚀 **Global Edge Deployment** - Deploy to 200+ edge locations worldwide
- 💾 **D1 SQLite Database** - Free 5GB per account
- 🔐 **JWT Authentication** - Secure token-based auth with 2FA support
- 📎 **External S3 Storage** - Optional S3-compatible storage for attachments
- 🤖 **AI Integration** - OpenAI-compatible API support (Zhipu, DeepSeek, etc.)
- 📊 **Full API** - 60+ endpoints covering all BeeCount Cloud features

## Quick Deploy

### Option 1: One-Click Deploy (Recommended)

1. Fork this repository to your GitHub account
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
3. Navigate to **Workers & Pages** → **Create Application** → **Connect to Git**
4. Connect your forked repository
5. Configure environment variables:
   - `JWT_SECRET`: Your JWT signing secret (generate with `openssl rand -base64 32`)
6. Click **Deploy**

### Option 2: Manual Deploy

```bash
# Clone the repository
git clone https://github.com/your-username/beecount-cloud-workers.git
cd beecount-cloud-workers

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create D1 database
npx wrangler d1 create beecount-cloud

# Update wrangler.toml with your database_id
# Then apply the schema
npx wrangler d1 migrations apply beecount-cloud --remote

# Deploy
npm run deploy
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret (min 32 chars) | `openssl rand -base64 32` |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database UUID | From `wrangler d1 create` output |

### Optional S3 Configuration

For external S3-compatible storage (attachments):

| Variable | Description | Example |
|----------|-------------|---------|
| `S3_ENDPOINT` | S3 API endpoint | `https://s3.us-east-1.amazonaws.com` |
| `S3_REGION` | AWS region | `us-east-1` |
| `S3_ACCESS_KEY_ID` | Access key ID | `AKIA...` |
| `S3_SECRET_ACCESS_KEY` | Secret access key | `...` |
| `S3_BUCKET_NAME` | Bucket for attachments | `beecount-attachments` |

### AI Configuration

AI features require user-level configuration in their profile's `ai_config_json` field:

```json
{
  "providers": [{
    "id": "zhipu_glm",
    "apiKey": "your-api-key",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "textModel": "glm-4-flash",
    "visionModel": "glm-4v-flash"
  }],
  "binding": {
    "textProviderId": "zhipu_glm",
    "visionProviderId": "zhipu_glm"
  }
}
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Refresh token
- `POST /api/v1/two-factor/*` - 2FA management

### Sync (Mobile App)
- `POST /api/v1/sync/push` - Push changes
- `POST /api/v1/sync/pull` - Pull changes
- `GET /api/v1/sync/ledgers` - List ledgers for sync
- `POST /api/v1/sync/full-sync` - Full sync

### CRUD Operations
- `/api/v1/read/*` - Query data
- `/api/v1/write/*` - Create/Update/Delete
- `/api/v1/batch/*` - Batch operations

### Utilities
- `/api/v1/attachments/*` - File uploads
- `/api/v1/import/*` - CSV import
- `/api/v1/ai/*` - AI features
- `/api/v1/backup/*` - Snapshots & restore

## Database Schema

The schema is defined in `schema.sql`. To initialize:

```bash
# Local development
npx wrangler d1 migrations apply beecount-cloud --local

# Production
npx wrangler d1 migrations apply beecount-cloud --remote
```

## Development

```bash
# Install dependencies
npm install

# Start local dev server (uses Miniflare)
npm run dev

# Type check
npm run typecheck

# Lint
npm run lint
```

## Project Structure

```
beecount-cloud-workers/
├── src/
│   ├── index.ts           # Entry point, route registration
│   ├── auth.ts            # JWT utilities
│   └── routes/            # API route handlers
│       ├── auth.ts        # Authentication
│       ├── two_factor.ts  # 2FA/TOTP
│       ├── sync.ts        # Mobile sync
│       ├── read.ts        # Query endpoints
│       ├── write.ts       # Write endpoints
│       ├── workspace.ts   # Cross-ledger queries
│       ├── batch_write.ts # Batch operations
│       ├── attachments.ts # File uploads (S3)
│       ├── ai.ts          # AI integration
│       ├── import_data.ts # CSV import
│       ├── backup.ts      # Snapshots
│       ├── admin_backup.ts # Admin backup management
│       └── admin.ts       # Admin endpoints
├── schema.sql             # D1 database schema
├── wrangler.toml          # Cloudflare config
├── deploy.html            # One-click deploy page
└── .github/workflows/     # CI/CD
```

## License

MIT
