CREATE TABLE IF NOT EXISTS push_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_notified_at INTEGER DEFAULT 0,
    last_notified_msg TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS token_starred_teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    teacher_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(token, teacher_name)
);

CREATE INDEX IF NOT EXISTS idx_token_starred_token ON token_starred_teachers(token);
CREATE INDEX IF NOT EXISTS idx_token_starred_teacher ON token_starred_teachers(teacher_name COLLATE NOCASE);
