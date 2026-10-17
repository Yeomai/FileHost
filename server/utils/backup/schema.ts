import { getDb } from '../db'

export function ensureBackupSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS backup_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('full_export', 'full_restore', 'backend_sync')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed')),
      progress INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      output_path TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_created_at
      ON backup_jobs(created_at DESC);
  `)

  const columns = getDb().prepare('PRAGMA table_info(backup_jobs)').all() as Array<{
    name: string
  }>
  if (!columns.some(column => column.name === 'user_id')) {
    getDb().exec('ALTER TABLE backup_jobs ADD COLUMN user_id INTEGER')
  }
  getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_user_created
      ON backup_jobs(user_id, created_at DESC);
    UPDATE backup_jobs
    SET user_id = (
      SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1
    )
    WHERE user_id IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE role = 'admin');
  `)
}
