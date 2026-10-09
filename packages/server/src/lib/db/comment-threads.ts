/** Durable roots and comment receipts, separate from the still-scaffolded M3 config tables. */
import type { Database } from "bun:sqlite";

export function createCommentThreadStore(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_threads (
      topic_key TEXT PRIMARY KEY, message_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comment_receipts (
      topic_key TEXT NOT NULL, comment_key TEXT NOT NULL, message_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (topic_key, comment_key)
    );
  `);
  const root = db.query<{ message_id: string }, [string]>(
    "SELECT message_id FROM comment_threads WHERE topic_key = ?",
  );
  const receipt = db.query<{ message_id: string }, [string, string]>(
    "SELECT message_id FROM comment_receipts WHERE topic_key = ? AND comment_key = ?",
  );
  const save = db.transaction(
    (topic: string, comment: string, messageId: string, activate: boolean) => {
      if (activate)
        db.run("INSERT INTO comment_threads (topic_key, message_id) VALUES (?, ?)", [
          topic,
          messageId,
        ]);
      db.run("INSERT INTO comment_receipts (topic_key, comment_key, message_id) VALUES (?, ?, ?)", [
        topic,
        comment,
        messageId,
      ]);
    },
  );
  return {
    root: (topic: string) => root.get(topic)?.message_id,
    receipt: (topic: string, comment: string) => receipt.get(topic, comment)?.message_id,
    save,
  };
}
export type CommentThreadStore = ReturnType<typeof createCommentThreadStore>;
