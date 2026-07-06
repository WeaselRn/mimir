import { WebClient } from '@slack/web-api';
import { db } from '../db';
import { decisions } from '../schema';
import { embedText, answerQuery, StoredDecision } from '../llm';
import { sql } from 'drizzle-orm';

const SIMILARITY_THRESHOLD = 0.75; // slightly lower for queries
const MAX_RESULTS = 5;

// ---------------------------------------------------------------------------
// Find decisions similar to the query using pgvector
// ---------------------------------------------------------------------------
async function findRelevantDecisions(embedding: number[]): Promise<StoredDecision[]> {
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await db.execute(sql`
    SELECT 
      question, answer, participants, created_at, channel_id, thread_ts,
      1 - (embedding <=> ${vectorLiteral}::extensions.vector) AS similarity
    FROM decisions
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorLiteral}::extensions.vector) > ${SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT ${MAX_RESULTS}
  `);

  return ((rows as unknown) as Array<{
    question: string;
    answer: string;
    participants: string[] | null;
    created_at: Date;
    channel_id: string | null;
    thread_ts: string | null;
    similarity: number;
  }>).map((r) => ({
    question: r.question,
    answer: r.answer,
    participants: r.participants,
    createdAt: new Date(r.created_at),
    channelId: r.channel_id,
    threadTs: r.thread_ts,
  }));
}

// ---------------------------------------------------------------------------
// Strip the @mention from the query text
// ---------------------------------------------------------------------------
function cleanQuery(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
}

// ---------------------------------------------------------------------------
// Main mention handler
// ---------------------------------------------------------------------------
export async function handleMention(params: {
  client: WebClient;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  botUserId: string;
}) {
  const { client, channelId, userId, text, ts, threadTs, botUserId } = params;

  const query = cleanQuery(text, botUserId);
  if (!query || query.length < 3) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs ?? ts,
      text: `:wave: Hi <@${userId}>! Ask me anything about past decisions, experts, or topics discussed in this workspace.`,
    });
    return;
  }

  console.log(`[mentionHandler] Query from ${userId}: "${query}"`);

  try {
    // 1. Show typing indicator
    await client.reactions.add({ channel: channelId, timestamp: ts, name: 'brain' });

    // 2. Embed query
    const embedding = await embedText(query);

    // 3. Find relevant decisions
    const relevantDecisions = await findRelevantDecisions(embedding);
    console.log(`[mentionHandler] Found ${relevantDecisions.length} relevant decisions`);

    // 4. Generate answer
    const answer = await answerQuery(query, relevantDecisions);

    // 5. Remove thinking indicator and post answer
    await client.reactions.remove({ channel: channelId, timestamp: ts, name: 'brain' });
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs ?? ts,
      text: answer,
    });
  } catch (err) {
    console.error('[mentionHandler] Error handling mention:', err);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs ?? ts,
      text: ':warning: Sorry, I ran into an error retrieving that information. Please try again.',
    });
  }
}
