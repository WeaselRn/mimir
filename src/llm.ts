import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error('GEMINI_API_KEY environment variable is required');
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey });

export const MODELS = {
  chat: 'gemini-3.1-flash-lite',
  embedding: 'gemini-embedding-001',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ExtractedDecision {
  question: string;
  answer: string;
  participants: string[]; // Slack user IDs if detectable, else names
}

export interface ExtractedExpert {
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
    model: MODELS.embedding,
    contents: text,
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
const EXTRACT_SYSTEM_PROMPT = `You are an organizational memory engine for a Slack workspace.
Your task is to extract information that another employee would want to remember six months later.
Given the conversation context and the latest message, extract structured knowledge.

Return a JSON object with four arrays: decisions, experts, tasks, resources.

1. decisions — architectural decisions, technology choices, rejected alternatives, and their reasoning.
   - Infer decisions whenever there is clear agreement.
   - Example conversation:
     Alice: "Should we use Clerk?"
     Bob: "We'll use Clerk."
     -> Output decision: { "question": "Should we use Clerk?", "answer": "Use Clerk for authentication.", "participants": ["Alice", "Bob"] }
   - Example conversation:
     Alice: "Should we use Redis or PostgreSQL for caching?"
     Bob: "Redis because it has built-in TTL support."
     -> Output decision: { "question": "Should we use Redis or PostgreSQL for caching?", "answer": "Redis because of built-in TTL support.", "participants": ["Alice", "Bob"] }
   - Each entry must be: { "question", "answer", "participants" (Slack IDs/names of involved users) }.
   - If no decision is present, output [].

2. experts — skills or topics that the message author demonstrably knows.
   - Look for concrete evidence of expertise (e.g., explaining concepts, debugging, solving problems, recommending technologies, saying "I've used...", "I know...", comparing technologies, teaching another user).
   - Do not invent skills. Only list skills demonstrated with high confidence.
   - Each entry must be: { "skills": ["Topic1", "Topic2"] } (Do NOT include a user_id field).
   - Example: "I have 10 years of experience with Docker and Kubernetes" -> { "skills": ["Docker", "Kubernetes"] }
   - If no expertise is demonstrated, output [].

3. tasks — commitments, action items, ownership, or deadlines.
   - Look for explicit commitments (e.g., "I'll do X by Y", "We need to complete Z").
   - Each entry must be: { "title", "assignee"? (Slack ID), "due_date"? }.
   - Example: "I'll finish the API by tomorrow" -> { "title": "Finish the API", "assignee": "U1234", "due_date": "2026-07-09" }
   - If no task is mentioned, output [].

4. resources — links, documents, tools, or references shared.
   - Each entry must be: { "title", "url"?, "description"? }.
   - If nothing is shared, output [].

Rules & Filtering:
- Ignore greetings, acknowledgements, jokes, or casual conversation.
- Be inclusive: prefer capturing a real item over missing it, as long as it has long-term organizational value.
- participants should be Slack user IDs (e.g., U12345) when available, else display names.
- Do NOT include any user_id or userId inside the expert entries.
- Return strict JSON only.`;

export async function extractFacts(
  message: string,
  context: string = ''
): Promise<ExtractedFacts> {
  const prompt = context
    ? `Thread context:\n${context}\n\nLatest message:\n${message}`
    : message;

  const response = await ai.models.generateContent({
    model: MODELS.chat,
    contents: [
      { role: 'user', parts: [{ text: prompt }] },
    ],
    config: {
      systemInstruction: EXTRACT_SYSTEM_PROMPT,
      temperature: 0.1,
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
                skills: { type: 'array' as const, items: { type: 'string' as const } },
              },
              required: ['skills'],
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
    console.log('No organizational memory extracted.');
    return { decisions: [], experts: [], tasks: [], resources: [] };
  }

  try {
    const parsed = JSON.parse(text) as unknown as ExtractedFacts;
    const hasData =
      (parsed.decisions && parsed.decisions.length > 0) ||
      (parsed.experts && parsed.experts.length > 0) ||
      (parsed.tasks && parsed.tasks.length > 0) ||
      (parsed.resources && parsed.resources.length > 0);

    if (!hasData) {
      console.log('No organizational memory extracted.');
    }
    return parsed;
  } catch (error) {
    console.error('Failed to parse Gemini response as JSON:');
    console.error('Raw response:', text);
    console.error('Parsing error:', error);
    throw error;
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
    model: MODELS.chat,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: ANSWER_SYSTEM_PROMPT,
    },
  });

  return response.text ?? "I couldn't find relevant information in the org memory.";
}
