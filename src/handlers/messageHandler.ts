import { WebClient } from '@slack/web-api';
import { db } from '../db';
import { decisions, experts, tasks, resources, NewDecision, NewTask, NewResource } from '../schema';
import { embedText, extractFacts, ExtractedTask, ExtractedResource } from '../llm';
import { sql } from 'drizzle-orm';

const SIMILARITY_THRESHOLD = 0.8;
const MAX_CONTEXT_MESSAGES = 50;

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
      1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM decisions
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorLiteral}::vector) > ${SIMILARITY_THRESHOLD}
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
// Save decisions extracted from a message
// ---------------------------------------------------------------------------
async function saveDecisions(
  extracted: Awaited<ReturnType<typeof extractFacts>>['decisions'],
  channelId: string,
  messageTs: string,
  threadTs?: string
) {
  for (const d of extracted) {
    // Embed per-decision for more precise similarity matching

    const decisionEmbedding = await embedText(d.question + ' ' + d.answer);
    console.log("[saveDecisions] Embedding:");
    console.log(JSON.stringify(decisionEmbedding, null, 2));

    const newDecision: NewDecision = {
      question: d.question,
      answer: d.answer,
      participants: d.participants,
      channelId,
      messageTs,
      threadTs: threadTs ?? null,
      embedding: decisionEmbedding,
    };
    await db.insert(decisions).values(newDecision);
  }
}

// ---------------------------------------------------------------------------
// Upsert experts — increments evidence_count on conflict
// (Requires UNIQUE(user_id, skill) constraint on the experts table)
// ---------------------------------------------------------------------------
async function saveExperts(
  extracted: Awaited<ReturnType<typeof extractFacts>>['experts'],
  userId: string,
  messageTs: string
) {
  for (const e of extracted) {
    console.log("[saveExperts]");
    console.log(JSON.stringify(e, null, 2));

    for (const skill of e.skills) {
      await db.execute(sql`
        INSERT INTO experts (user_id, skill, evidence_count, message_ts)
        VALUES (${userId}, ${skill}, 1, ${messageTs})
        ON CONFLICT ON CONSTRAINT experts_user_skill_unique
        DO UPDATE SET evidence_count = experts.evidence_count + 1
      `);
    }
  }
}

// ---------------------------------------------------------------------------
// Save tasks extracted from a message
// ---------------------------------------------------------------------------
async function saveTasks(
  extracted: ExtractedTask[],
  channelId: string,
  messageTs: string
) {
  for (const t of extracted) {
    const newTask: NewTask = {
      description: t.title,
      ownerId: t.assignee ?? null,
      dueDate: t.due_date ?? null,
      completed: false,
      channelId,
      messageTs,
    };
    await db.insert(tasks).values(newTask);
  }
}

// ---------------------------------------------------------------------------
// Save resources extracted from a message
// ---------------------------------------------------------------------------
async function saveResources(
  extracted: ExtractedResource[],
  channelId: string,
  messageTs: string
) {
  for (const r of extracted) {
    const newResource: NewResource = {
      title: r.title,
      url: r.url ?? null,
      description: r.description ?? null,
      channelId,
      messageTs,
    };
    await db.insert(resources).values(newResource);
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
  // Skip very short messages (bot commands, empty pings)
  if (!text || text.trim().length < 5) return;

  console.log(`[messageHandler] Processing message in ${channelId} from ${userId}`);

  try {
    // 1. Fetch thread/channel context
    const context = await fetchContext(client, channelId, threadTs, botUserId);

    // 2. Extract facts with LLM
    const facts = await extractFacts(text, context);

    console.log("========== GEMINI EXTRACTION ==========");
    console.log("Message:");
    console.log(text);

    console.log("Context:");
    console.log(context || "(none)");

    console.log("Facts:");
    console.log(JSON.stringify(facts, null, 2));

    console.log(
      `[messageHandler] Extracted: ${facts.decisions.length} decisions, ` +
      `${facts.experts.length} experts, ` +
      `${facts.tasks.length} tasks, ` +
      `${facts.resources.length} resources`
    );

    console.log("=======================================");

    // 3. Embed the message text (used for proactive similarity check)
    const embedding = await embedText(text);

    // 4. Save extracted decisions (each gets its own embedding)
    if (facts.decisions.length > 0) {
      console.log("[messageHandler] Saving decisions...");
      console.log(JSON.stringify(facts.decisions, null, 2));

      await saveDecisions(facts.decisions, channelId, ts, threadTs);

      console.log("[messageHandler] ✅ Decisions saved.");
    } else {
      console.log("[messageHandler] ❌ No decisions extracted.");
    }

    // 5. Save extracted experts (upserts evidence count)
    if (facts.experts.length > 0) {
      console.log("[messageHandler] Saving experts...");
      console.log(JSON.stringify(facts.experts, null, 2));

      await saveExperts(facts.experts, userId, ts);

      console.log("[messageHandler] ✅ Experts saved.");
    } else {
      console.log("[messageHandler] ❌ No experts extracted.");
    }

    // 6. Save extracted tasks
    if (facts.tasks.length > 0) {
      await saveTasks(facts.tasks, channelId, ts);
      console.log(`[messageHandler] Saved ${facts.tasks.length} task(s)`);
    }

    // 7. Save extracted resources
    if (facts.resources.length > 0) {
      await saveResources(facts.resources, channelId, ts);
      console.log(`[messageHandler] Saved ${facts.resources.length} resource(s)`);
    }

    // 8. Check similarity against stored decisions for proactive hint
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
