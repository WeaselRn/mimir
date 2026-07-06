import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error('GEMINI_API_KEY environment variable is required');
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ExtractedDecision {
  question: string;
  answer: string;
  participants: string[]; // Slack user IDs if detectable, else names
}

export interface ExtractedExpert {
  user_id: string;
  skills: string[];
}

export interface ExtractedTask {
  title: string;
  assignee?: string;
  due_date?: string;
}

export interface ExtractedResource {
  title: string;
  url?: string;
  description?: string;
}

export interface ExtractedFacts {
  decisions: ExtractedDecision[];
  experts: ExtractedExpert[];
  tasks: ExtractedTask[];
  resources: ExtractedResource[];
}

// ---------------------------------------------------------------------------
// Gemini Embedding
// ---------------------------------------------------------------------------
export async function embedText(text: string): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: 'gemini-embedding-exp-03-07',
    contents: text,
    config: { outputDimensionality: 768 },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error('Empty embedding returned from Gemini');
  }
  return values;
}

// ---------------------------------------------------------------------------
// Fact Extraction
// ---------------------------------------------------------------------------
const EXTRACT_SYSTEM_PROMPT = `You are an organizational memory assistant. 
Given a Slack message (and optionally its thread context), extract structured knowledge.

Return a JSON object with:
- decisions: array of {question, answer, participants} — only concrete decisions made
- experts: array of {user_id, skills} — only demonstrated knowledge, not guesses  
- tasks: array of {title, assignee?, due_date?} — only explicit commitments
- resources: array of {title, url?, description?} — links, docs, tools mentioned

Rules:
- If nothing meaningful was decided or shared, return empty arrays.
- participants should be Slack user IDs (e.g. U12345) when available, else names.
- Be conservative: prefer quality over quantity.`;

export async function extractFacts(
  message: string,
  context: string = ''
): Promise<ExtractedFacts> {
  const prompt = context
    ? `Thread context:\n${context}\n\nLatest message:\n${message}`
    : message;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      { role: 'user', parts: [{ text: prompt }] },
    ],
    config: {
      systemInstruction: EXTRACT_SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object' as const,
        properties: {
          decisions: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                question: { type: 'string' as const },
                answer: { type: 'string' as const },
                participants: { type: 'array' as const, items: { type: 'string' as const } },
              },
              required: ['question', 'answer', 'participants'],
            },
          },
          experts: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                user_id: { type: 'string' as const },
                skills: { type: 'array' as const, items: { type: 'string' as const } },
              },
              required: ['user_id', 'skills'],
            },
          },
          tasks: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                title: { type: 'string' as const },
                assignee: { type: 'string' as const },
                due_date: { type: 'string' as const },
              },
              required: ['title'],
            },
          },
          resources: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                title: { type: 'string' as const },
                url: { type: 'string' as const },
                description: { type: 'string' as const },
              },
              required: ['title'],
            },
          },
        },
        required: ['decisions', 'experts', 'tasks', 'resources'],
      },
    },
  });

  const text = response.text;
  if (!text) {
    return { decisions: [], experts: [], tasks: [], resources: [] };
  }

  try {
    return (JSON.parse(text) as unknown) as ExtractedFacts;
  } catch {
    console.error('[llm] Failed to parse extractFacts response:', text);
    return { decisions: [], experts: [], tasks: [], resources: [] };
  }
}

// ---------------------------------------------------------------------------
// Query Answering — multi-source context
// ---------------------------------------------------------------------------
const ANSWER_SYSTEM_PROMPT = `You are Mimir, an organizational memory assistant for a Slack workspace.
You have access to past decisions, known experts, tasks, and resources stored in the org's memory.
Answer the user's question based on the provided context. Be concise and direct.
If the stored context doesn't contain enough information, say so honestly.
Format your answer for Slack (use *bold*, _italic_, bullet points as needed).`;

export interface StoredDecision {
  question: string;
  answer: string;
  participants: string[] | null;
  createdAt: Date;
  channelId: string | null;
  threadTs: string | null;
}

export interface StoredExpert {
  userId: string;
  skill: string;
  evidenceCount: number;
}

export interface StoredTask {
  description: string;
  ownerId: string | null;
  dueDate: string | null;
  completed: boolean;
  createdAt: Date;
}

export interface StoredResource {
  title: string;
  url: string | null;
  description: string | null;
  createdAt: Date;
}

export interface QueryContext {
  decisions: StoredDecision[];
  experts: StoredExpert[];
  tasks: StoredTask[];
  resources: StoredResource[];
}

export async function answerQuery(
  query: string,
  context: QueryContext
): Promise<string> {
  const sections: string[] = [];

  // Format decisions
  if (context.decisions.length > 0) {
    const decisionsText = context.decisions
      .map((d, i) => {
        const date = d.createdAt.toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
        });
        const who = d.participants?.join(', ') || 'unknown';
        return `[${i + 1}] *Decision* (${date}, participants: ${who})\nQ: ${d.question}\nA: ${d.answer}`;
      })
      .join('\n\n');
    sections.push(`*Past Decisions:*\n${decisionsText}`);
  }

  // Format experts
  if (context.experts.length > 0) {
    const expertsText = context.experts
      .map((e) => `• <@${e.userId}> — *${e.skill}* (${e.evidenceCount} evidence${e.evidenceCount !== 1 ? 's' : ''})`)
      .join('\n');
    sections.push(`*Known Experts:*\n${expertsText}`);
  }

  // Format tasks
  if (context.tasks.length > 0) {
    const tasksText = context.tasks
      .map((t) => {
        const owner = t.ownerId ? `<@${t.ownerId}>` : 'unassigned';
        const due = t.dueDate ? ` (due ${t.dueDate})` : '';
        const status = t.completed ? '✅' : '⏳';
        return `${status} ${t.description} — ${owner}${due}`;
      })
      .join('\n');
    sections.push(`*Tasks:*\n${tasksText}`);
  }

  // Format resources
  if (context.resources.length > 0) {
    const resourcesText = context.resources
      .map((r) => {
        const link = r.url ? ` (<${r.url}|link>)` : '';
        const desc = r.description ? ` — ${r.description}` : '';
        return `• ${r.title}${link}${desc}`;
      })
      .join('\n');
    sections.push(`*Resources:*\n${resourcesText}`);
  }

  const contextBlock = sections.length > 0
    ? sections.join('\n\n')
    : '(No relevant information found in org memory.)';

  const prompt = `Relevant org memory:\n\n${contextBlock}\n\nUser query: ${query}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: ANSWER_SYSTEM_PROMPT,
    },
  });

  return response.text ?? "I couldn't find relevant information in the org memory.";
}
