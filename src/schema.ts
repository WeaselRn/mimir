import {
  pgTable,
  serial,
  text,
  jsonb,
  timestamp,
  integer,
  customType,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom pgvector column type
// ---------------------------------------------------------------------------
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `extensions.vector(${config?.dimensions ?? 768})`;
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
  messageTts: text('message_ts'),
  channelId: text('channel_id'),
  threadTs: text('thread_ts'),
  embedding: vector('embedding', { dimensions: 768 }),
});

// ---------------------------------------------------------------------------
// experts — tracks which users have demonstrated expertise in which skills
// ---------------------------------------------------------------------------
export const experts = pgTable('experts', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  skill: text('skill').notNull(),
  evidenceCount: integer('evidence_count').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  messageTts: text('message_ts'),
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type Expert = typeof experts.$inferSelect;
export type NewExpert = typeof experts.$inferInsert;
