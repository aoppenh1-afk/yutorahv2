import { Pool } from 'pg';
if (process.env.TEST_DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    // Database-global setup happens once before test files create their schemas.
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } finally {
    await pool.end();
  }
}
