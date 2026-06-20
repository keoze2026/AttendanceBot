import { Pool } from 'pg';
import { Config } from './config';

/**
 * A single shared connection pool to the PostgreSQL database.
 * On the VPS this is the same instance the CallFlow CRM uses (db "crm").
 */
export function createPool(config: Config): Pool {
  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
}
