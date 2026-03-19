/**
 * Run all schema migrations.
 * Uses raw SQL to create tables if they don't exist.
 */
export function migrate(db: { run: (query: any) => any }) {
  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS review_jobs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      comment_id INTEGER NOT NULL,
      findings TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
