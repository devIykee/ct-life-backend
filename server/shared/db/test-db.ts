/**
 * Test database isolation.
 *
 * Tests create a fresh schema per run and clean up tables that belong
 * to the test schema only. Never touches the dev database.
 *
 * Usage in tests:
 *   beforeAll(async () => {
 *     await setupTestDb();
 *   });
 *   afterAll(async () => {
 *     await teardownTestDb();
 *   });
 */
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';

let testSchema: string | null = null;
let testPool: Pool | null = null;

/**
 * Create a fresh schema for this test run. All queries in the test
 * pool will target this schema.
 */
export async function setupTestDb(): Promise<void> {
  if (testSchema !== null) {
    throw new Error('setupTestDb called twice without teardown');
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL not set');
  }

  // Generate a unique schema name for this test run
  testSchema = `test_${randomBytes(8).toString('hex')}`;

  // Connect to the main database to create the schema
  const adminPool = new Pool({ connectionString: dbUrl });

  try {
    // Create the test schema
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${testSchema}`);

    // Copy all table structures from public to test schema
    const tables = await adminPool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `);

    for (const row of tables.rows) {
      const tableName = row.tablename as string;
      await adminPool.query(`
        CREATE TABLE IF NOT EXISTS ${testSchema}.${tableName}
        (LIKE public.${tableName} INCLUDING ALL)
      `);
    }

    // Copy sequences
    const sequences = await adminPool.query(`
      SELECT sequence_name FROM information_schema.sequences
      WHERE sequence_schema = 'public'
    `);

    for (const row of sequences.rows) {
      const seqName = row.sequence_name as string;
      await adminPool.query(`
        CREATE SEQUENCE IF NOT EXISTS ${testSchema}.${seqName}
      `);
    }
  } finally {
    await adminPool.end();
  }

  // Create a test pool with search_path set to the test schema
  testPool = new Pool({
    connectionString: dbUrl,
    max: 5,
    options: `-c search_path=${testSchema},public`,
  });

  // Override DATABASE_URL for the test environment
  process.env.TEST_SCHEMA = testSchema;
}

/**
 * Drop the test schema and close the pool.
 */
export async function teardownTestDb(): Promise<void> {
  if (testSchema === null || testPool === null) {
    return; // Already torn down or never set up
  }

  const schema = testSchema;
  testSchema = null;

  try {
    await testPool.end();
  } catch {
    // Ignore pool close errors
  }
  testPool = null;

  // Drop the test schema
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const adminPool = new Pool({ connectionString: dbUrl });
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } catch {
      // Ignore drop errors
    } finally {
      await adminPool.end();
    }
  }

  delete process.env.TEST_SCHEMA;
}

/**
 * Get a pool connected to the test schema. Throws if setupTestDb
 * was not called.
 */
export function getTestPool(): Pool {
  if (testPool === null) {
    throw new Error('Call setupTestDb() before accessing test pool');
  }
  return testPool;
}

/**
 * Get the current test schema name.
 */
export function getTestSchema(): string {
  if (testSchema === null) {
    throw new Error('Call setupTestDb() before accessing test schema');
  }
  return testSchema;
}
