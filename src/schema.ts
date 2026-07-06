import {
  pgTable,
  serial,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  date,
  unique,
  customType,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom pgvector column type (public schema — matches migration)
// ---------------------------------------------------------------------------
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
  fromDriver(value: string): number[] {
    // pgvector returns '[0.1,0.2,...]' — strip brackets and parse
    return value
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(Number);
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

// ---------------------------------------------------------------------------
// decisions — stores extracted decisions / important topics
// ---------------------------------------------------------------------------
export const decisions = pgTable('decisions', {
  id: serial('id').primaryKey(),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  /** Array of Slack user IDs involved */
  participants: jsonb('participants').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  messageTs: text('message_ts'),
  channelId: text('channel_id'),
  threadTs: text('thread_ts'),
  embedding: vector('embedding', { dimensions: 768 }),
});

// ---------------------------------------------------------------------------
// experts — tracks which users have demonstrated expertise in which skills
// ---------------------------------------------------------------------------
export const experts = pgTable(
  'experts',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    skill: text('skill').notNull(),
    evidenceCount: integer('evidence_count').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    messageTs: text('message_ts'),
  },
  (table) => ({
    userSkillUnique: unique('experts_user_skill_unique').on(table.userId, table.skill),
  })
);

// ---------------------------------------------------------------------------
// tasks — stores explicitly assigned action items / commitments
// ---------------------------------------------------------------------------
export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  description: text('description').notNull(),
  /** Slack user ID of the task owner */
  ownerId: text('owner_id'),
  dueDate: date('due_date'),
  completed: boolean('completed').default(false).notNull(),
  messageTs: text('message_ts'),
  channelId: text('channel_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// resources — stores links, docs, tools mentioned in conversations
// ---------------------------------------------------------------------------
export const resources = pgTable('resources', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  url: text('url'),
  description: text('description'),
  messageTs: text('message_ts'),
  channelId: text('channel_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type Expert = typeof experts.$inferSelect;
export type NewExpert = typeof experts.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Resource = typeof resources.$inferSelect;
export type NewResource = typeof resources.$inferInsert;
