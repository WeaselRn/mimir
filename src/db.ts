import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Use a single connection for the long-running bot process.
// For Supabase Transaction Pooler (port 6543) set prepare: false.
const isPooler = databaseUrl.includes(':6543');

const client = postgres(databaseUrl, {
  max: 10,
  idle_timeout: 30,
  prepare: !isPooler, // prepared statements not supported on pgBouncer/Transaction Pooler
});

export const db = drizzle(client, { schema });
export type DB = typeof db;
