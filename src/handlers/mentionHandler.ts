import { WebClient } from '@slack/web-api';
import { db } from '../db';
import { embedText, answerQuery, QueryContext, StoredExpert, StoredTask, StoredResource } from '../llm';
import { sql, ilike, or, desc } from 'drizzle-orm';
import { experts, tasks, resources } from '../schema';

const DECISION_SIMILARITY_THRESHOLD = 0.75; // slightly lower for queries
const MAX_DECISIONS = 5;
const MAX_EXPERTS = 10;
const MAX_TASKS = 10;
const MAX_RESOURCES = 5;

// ---------------------------------------------------------------------------
// Find decisions similar to the query using pgvector
// ---------------------------------------------------------------------------
async function findRelevantDecisions(embedding: number[]) {
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await db.execute(sql`
    SELECT 
      question, answer, participants, created_at, channel_id, thread_ts,
      1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM decisions
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${vectorLiteral}::vector) > ${DECISION_SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT ${MAX_DECISIONS}
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
// Find experts matching keywords in the query
// We look for any skill that appears as a substring of the query (case-insensitive)
// or any expert row whose skill is mentioned by the user.
// ---------------------------------------------------------------------------
async function findRelevantExperts(query: string): Promise<StoredExpert[]> {
  // Extract potential keywords: words 4+ chars, strip common words
  const stopWords = new Set(['what', 'which', 'where', 'when', 'does', 'know', 'good', 'best',
    'with', 'have', 'that', 'this', 'from', 'about', 'there', 'their', 'team',
    'who', 'our', 'has', 'can', 'work', 'anyone', 'expert', 'experts', 'skill']);
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  if (keywords.length === 0) return [];

  // Build OR conditions for each keyword against the skill column
  const conditions = keywords.map((kw) => ilike(experts.skill, `%${kw}%`));
  const orCondition = or(...conditions);

  const rows = await db
    .select()
    .from(experts)
    .where(orCondition)
    .orderBy(desc(experts.evidenceCount))
    .limit(MAX_EXPERTS);

  return rows.map((r) => ({
    userId: r.userId,
    skill: r.skill,
    evidenceCount: r.evidenceCount,
  }));
}

// ---------------------------------------------------------------------------
// Find open tasks, optionally filtering by keywords in the query
// ---------------------------------------------------------------------------
async function findRelevantTasks(query: string): Promise<StoredTask[]> {
  // Check if query is about tasks
  const taskKeywords = ['task', 'tasks', 'todo', 'to-do', 'action', 'pending', 'due', 'assign', 'open'];
  const isTaskQuery = taskKeywords.some((kw) => query.toLowerCase().includes(kw));

  // Only fetch tasks if the query seems task-related
  if (!isTaskQuery) return [];

  const rows = await db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt))
    .limit(MAX_TASKS);

  return rows.map((r) => ({
    description: r.description,
    ownerId: r.ownerId,
    dueDate: r.dueDate,
    completed: r.completed,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Find resources matching keywords in the query
// ---------------------------------------------------------------------------
async function findRelevantResources(query: string): Promise<StoredResource[]> {
  const resourceKeywords = ['resource', 'link', 'doc', 'documentation', 'tool', 'library', 'repo',
    'reference', 'guide', 'wiki', 'url', 'site', 'package'];
  const isResourceQuery = resourceKeywords.some((kw) => query.toLowerCase().includes(kw));

  if (!isResourceQuery) return [];

  // Extract keywords from query to filter resources
  const stopWords = new Set(['what', 'which', 'where', 'link', 'url', 'resource', 'resources',
    'find', 'show', 'list', 'any', 'doc', 'docs']);
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  let rows;
  if (keywords.length > 0) {
    const titleConditions = keywords.map((kw) => ilike(resources.title, `%${kw}%`));
    const descConditions = keywords.map((kw) => ilike(resources.description, `%${kw}%`));
    const condition = or(...titleConditions, ...descConditions);
    rows = await db.select().from(resources).where(condition).orderBy(desc(resources.createdAt)).limit(MAX_RESOURCES);
  } else {
    rows = await db.select().from(resources).orderBy(desc(resources.createdAt)).limit(MAX_RESOURCES);
  }

  return rows.map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    createdAt: r.createdAt,
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
      text: `:wave: Hi <@${userId}>! Ask me anything about past decisions, experts, tasks, or resources discussed in this workspace.`,
    });
    return;
  }

  console.log(`[mentionHandler] Query from ${userId}: "${query}"`);

  try {
    // 1. Show thinking indicator
    await client.reactions.add({ channel: channelId, timestamp: ts, name: 'brain' });

    // 2. Run all retrieval in parallel for speed
    const [embedding, relevantExperts, relevantTasks, relevantResources] = await Promise.all([
      embedText(query),
      findRelevantExperts(query),
      findRelevantTasks(query),
      findRelevantResources(query),
    ]);

    // 3. Find semantically relevant decisions using the embedding
    const relevantDecisions = await findRelevantDecisions(embedding);

    console.log(
      `[mentionHandler] Found: ${relevantDecisions.length} decisions, ` +
      `${relevantExperts.length} experts, ${relevantTasks.length} tasks, ` +
      `${relevantResources.length} resources`
    );

    // 4. Build unified context and generate answer
    const context: QueryContext = {
      decisions: relevantDecisions,
      experts: relevantExperts,
      tasks: relevantTasks,
      resources: relevantResources,
    };

    const answer = await answerQuery(query, context);

    // 5. Remove thinking indicator and post answer
    await client.reactions.remove({ channel: channelId, timestamp: ts, name: 'brain' });
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs ?? ts,
      text: answer,
    });
  } catch (err) {
    console.error('[mentionHandler] Error handling mention:', err);
    // Try to remove indicator even on error
    try {
      await client.reactions.remove({ channel: channelId, timestamp: ts, name: 'brain' });
    } catch { /* ignore */ }
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs ?? ts,
      text: ':warning: Sorry, I ran into an error retrieving that information. Please try again.',
    });
  }
}
