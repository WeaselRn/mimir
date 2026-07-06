import { WebClient } from '@slack/web-api';
import { db } from '../db';
import { decisions, experts, NewDecision, NewExpert } from '../schema';
import { embedText, extractFacts } from '../llm';
import { sql, gt } from 'drizzle-orm';

const SIMILARITY_THRESHOLD = 0.8;
const MAX_CONTEXT_MESSAGES = 10;

// ---------------------------------------------------------------------------
// Fetch thread / channel context
// ---------------------------------------------------------------------------
async function fetchContext(
  client: WebClient,
  channelId: string,
  threadTs: string | undefined,
  botUserId: string
): Promise<string> {
  try {
    let messages: { user?: string; text?: string; ts?: string }[] = [];

    if (threadTs) {
      const result = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: MAX_CONTEXT_MESSAGES,
      });
      messages = (result.messages ?? []).slice(0, -1); // exclude the triggering message
    } else {
      const result = await client.conversations.history({
        channel: channelId,
        limit: MAX_CONTEXT_MESSAGES,
      });
      messages = (result.messages ?? []).reverse().slice(0, -1);
    }

    return messages
      .filter((m) => m.user !== botUserId && m.text)
      .map((m) => `<@${m.user ?? 'unknown'}>: ${m.text}`)
      .join('\n');
  } catch (err) {
    console.error('[messageHandler] Failed to fetch context:', err);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Find similar decisions using pgvector cosine distance
// ---------------------------------------------------------------------------
async function findSimilarDecisions(embedding: number[]) {
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await db.execute(sql`
    SELECT 
      id, question, answer, participants, created_at, channel_id, thread_ts,
      1 - (embedding <=> ${vectorLiteral}::extensions.vector) AS similarity
    FROM decisions
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorLiteral}::extensions.vector) > ${SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT 5
  `);

  return (rows as unknown) as Array<{
    id: number;
    question: string;
    answer: string;
    participants: string[] | null;
    created_at: Date;
    channel_id: string | null;
    thread_ts: string | null;
    similarity: number;
  }>;
}

// ---------------------------------------------------------------------------
// Upsert decisions extracted from a message
// ---------------------------------------------------------------------------
async function saveDecisions(
  extracted: Awaited<ReturnType<typeof extractFacts>>['decisions'],
  embedding: number[],
  channelId: string,
  messageTts: string,
  threadTs?: string
) {
  for (const d of extracted) {
    const newDecision: NewDecision = {
      question: d.question,
      answer: d.answer,
      participants: d.participants,
      channelId,
      messageTts,
      threadTs: threadTs ?? null,
      embedding,
    };
    await db.insert(decisions).values(newDecision);
  }
}

// ---------------------------------------------------------------------------
// Upsert experts extracted from a message
// ---------------------------------------------------------------------------
async function saveExperts(
  extracted: Awaited<ReturnType<typeof extractFacts>>['experts'],
  messageTts: string
) {
  for (const e of extracted) {
    for (const skill of e.skills) {
      // Try to increment evidence_count if record exists, otherwise insert
      await db.execute(sql`
        INSERT INTO experts (user_id, skill, evidence_count, message_ts)
        VALUES (${e.user_id}, ${skill}, 1, ${messageTts})
        ON CONFLICT (user_id, skill) 
        DO UPDATE SET evidence_count = experts.evidence_count + 1
      `);
    }
  }
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------
export async function handleMessage(params: {
  client: WebClient;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  botUserId: string;
}) {
  const { client, channelId, userId, text, ts, threadTs, botUserId } = params;

  // Skip bot messages
  if (userId === botUserId) return;
  // Skip very short messages (reactions, acknowledgements)
  if (!text || text.trim().length < 20) return;

  console.log(`[messageHandler] Processing message in ${channelId} from ${userId}`);

  try {
    // 1. Fetch thread/channel context
    const context = await fetchContext(client, channelId, threadTs, botUserId);

    // 2. Extract facts with LLM
    const facts = await extractFacts(text, context);
    console.log(
      `[messageHandler] Extracted: ${facts.decisions.length} decisions, ${facts.experts.length} experts`
    );

    // 3. Embed the message text
    const embedding = await embedText(text);

    // 4. Save extracted decisions with their embeddings
    if (facts.decisions.length > 0) {
      await saveDecisions(facts.decisions, embedding, channelId, ts, threadTs);
    }

    // 5. Save extracted experts
    if (facts.experts.length > 0) {
      await saveExperts(facts.experts, ts);
    }

    // 6. Check similarity against stored decisions for proactive hint
    const similar = await findSimilarDecisions(embedding);

    if (similar.length > 0) {
      const top = similar[0];
      const date = new Date(top.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });

      const threadLink = top.channel_id && top.thread_ts
        ? `\n> See thread: slack://channel?team=T&id=${top.channel_id}&message=${top.thread_ts}`
        : '';

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs ?? ts,
        text:
          `:brain: *Org Memory Hint* (${Math.round(top.similarity * 100)}% similar topic)\n` +
          `This was already decided on *${date}*:\n` +
          `> *Q:* ${top.question}\n` +
          `> *A:* ${top.answer}` +
          threadLink,
      });
    }
  } catch (err) {
    console.error('[messageHandler] Error processing message:', err);
  }
}
