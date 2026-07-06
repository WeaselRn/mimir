# 🧠 Mimir — Slack Org-Memory Agent

Mimir is a Slack bot that passively listens to your workspace conversations, extracts structured knowledge (decisions, experts, tasks, resources) using Gemini AI, stores them in Supabase with vector embeddings, and proactively surfaces relevant past decisions when similar topics are discussed.

---

## Features

- 📥 **Passive listening** — monitors all channels/DMs/group messages
- 🧠 **Fact extraction** — uses Gemini to identify decisions, experts, tasks, and resources
- 🔍 **Semantic search** — pgvector cosine similarity search on 768-dim embeddings
- 💡 **Proactive hints** — automatically posts when a new message is > 80% similar to a past decision
- 💬 **Query answering** — `@mimir what did we decide about X?` returns an AI-generated answer grounded in stored memory

---

## Tech Stack

| Layer | Technology |
|---|---|
| Slack | `@slack/bolt` v4 — Socket Mode |
| AI | `@google/genai` — Gemini 2.0 Flash + Embedding |
| Database | Supabase (PostgreSQL + pgvector) |
| ORM | Drizzle ORM + `postgres` driver |
| Runtime | Node.js 20 + TypeScript |
| Deploy | Railway |

---

## Setup

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd mimir
npm install
```

### 2. Configure Environment

Copy the `.env` file and fill in all values:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
GEMINI_API_KEY=...
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
DATABASE_URL=postgresql://postgres:[password]@db.<ref>.supabase.co:5432/postgres
GITHUB_TOKEN=ghp_...
NODE_ENV=development
```

> **DATABASE_URL** — Find this in your [Supabase dashboard](https://supabase.com/dashboard) → Project Settings → Database → Connection String. Use the **Direct Connection** string (port 5432) for development.

### 3. Set Up Supabase Database

Run the migration in the **Supabase SQL Editor**:

```sql
-- Copy and paste the contents of migrations/0000_init.sql
```

Or use Drizzle push (requires correct DATABASE_URL):

```bash
npm run db:push
```

### 4. Configure Slack App

In [api.slack.com/apps](https://api.slack.com/apps), configure your app:

**OAuth & Permissions — Bot Token Scopes:**
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`
- `app_mentions:read`
- `chat:write`
- `reactions:write`
- `users:read`

**Event Subscriptions — Subscribe to Bot Events:**
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`
- `app_mention`

**Socket Mode:** Enable → Generate App-Level Token with `connections:write` scope → copy to `SLACK_APP_TOKEN`

### 5. Run Locally

```bash
npm run dev
```

---

## Development

```bash
# Start with hot-reload
npm run dev

# Type check
npx tsc --noEmit

# Open Drizzle Studio (database GUI)
npm run db:studio

# Build for production
npm run build
```

---

## Deployment (Railway)

1. Push code to GitHub
2. In [Railway](https://railway.app): New Project → Deploy from GitHub repo
3. Add all `.env` variables as Railway environment variables:
   - `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`
   - `GEMINI_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `DATABASE_URL` — use the **Transaction Pooler** URL (port 6543) on Railway
   - `NODE_ENV=production`
4. Railway auto-detects the `railway.json` config and runs `npm run start`

> **Note:** For Railway / Transaction Pooler (port 6543), the `db.ts` automatically disables prepared statements. Make sure your `DATABASE_URL` uses port `6543` in production.

---

## Architecture

```
Slack Events (Socket Mode)
        │
        ▼
   src/index.ts
   ┌────────────────────────────┐
   │  app.message()             │──▶ messageHandler.ts
   │  app.event('app_mention')  │──▶ mentionHandler.ts
   └────────────────────────────┘
          │                │
          ▼                ▼
      src/llm.ts       src/db.ts
   ┌──────────────┐  ┌──────────────┐
   │ embedText()  │  │  Drizzle ORM │──▶ Supabase (pgvector)
   │ extractFacts │  │  decisions   │
   │ answerQuery  │  │  experts     │
   └──────────────┘  └──────────────┘
   (Gemini AI)
```

---

## Environment Variables Reference

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Used to verify Slack request signatures |
| `GEMINI_API_KEY` | Google Gemini API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (full DB access) |
| `DATABASE_URL` | Full PostgreSQL connection string |
| `GITHUB_TOKEN` | GitHub PAT (for CI/CD or GitHub integrations) |
| `NODE_ENV` | `development` or `production` |
| `PORT` | HTTP port (not used in Socket Mode, optional) |
