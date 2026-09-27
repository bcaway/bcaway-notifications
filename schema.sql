CREATE TABLE IF NOT EXISTS push_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens(token);

CREATE TABLE IF NOT EXISTS token_starred_teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    teacher_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(token, teacher_name)
);

CREATE INDEX IF NOT EXISTS idx_token_starred_token ON token_starred_teachers(token);
CREATE INDEX IF NOT EXISTS idx_token_starred_teacher ON token_starred_teachers(teacher_name COLLATE NOCASE);
