import 'dotenv/config';
import { App } from '@slack/bolt';
import { handleMessage } from './handlers/messageHandler';
import { handleMention } from './handlers/mentionHandler';

// ---------------------------------------------------------------------------
// Validate required env vars early
// ---------------------------------------------------------------------------
const required = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'DATABASE_URL',
  'GEMINI_API_KEY',
];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Initialize Slack Bolt App (Socket Mode)
// ---------------------------------------------------------------------------
const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  socketMode: true,
  logLevel: process.env.NODE_ENV === 'development' ? 'DEBUG' : 'INFO',
});

// ---------------------------------------------------------------------------
// Resolve bot's own user ID once on startup
// ---------------------------------------------------------------------------
let botUserId = '';

async function getBotUserId(): Promise<string> {
  const auth = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN! });
  return auth.user_id as string;
}

// ---------------------------------------------------------------------------
// Message event handler
// Covers: message.channels, message.groups, message.im, message.mpim
// ---------------------------------------------------------------------------
app.message(async ({ message, client }) => {
  // Type guard — only process user messages (not sub-typed system messages)
  if (message.subtype) return;
  if (!('user' in message) || !message.user) return;
  if (!('text' in message) || !message.text) return;

  await handleMessage({
    client,
    channelId: message.channel,
    userId: message.user,
    text: message.text,
    ts: message.ts,
    threadTs: ('thread_ts' in message ? message.thread_ts : undefined) as string | undefined,
    botUserId,
  });
});

// ---------------------------------------------------------------------------
// App mention event handler
// ---------------------------------------------------------------------------
app.event('app_mention', async ({ event, client }) => {
  await handleMention({
    client,
    channelId: event.channel,
    userId: event.user,
    text: event.text,
    ts: event.ts,
    threadTs: event.thread_ts,
    botUserId,
  });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.error(async (error) => {
  console.error('[Mimir] Unhandled Slack app error:', error);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  try {
    await app.start();
    botUserId = await getBotUserId();
    console.log(`✅ Mimir is running in Socket Mode (bot user: @${botUserId})`);
    console.log('📡 Listening for messages and @mentions...');
  } catch (err) {
    console.error('❌ Failed to start Mimir:', err);
    process.exit(1);
  }
})();
