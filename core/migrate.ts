/**
 * Run all schema migrations.
 * Uses raw SQL to create tables if they don't exist.
 */
export function migrate(db: { run: (query: any) => any }) {
  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      issue_key TEXT,
      issue_title TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms REAL
    )
  `);

  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);

  db.run(/* sql */ `
    CREATE INDEX IF NOT EXISTS idx_run_events_run_id
    ON run_events(run_id)
  `);
}
