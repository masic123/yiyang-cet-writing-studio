CREATE TABLE notebook_items(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','mastered','ignored')),
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,signature)
);
CREATE TABLE notebook_occurrences(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES notebook_items(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE notebook_sources(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,review_id)
);
CREATE TABLE notebook_exercises(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  task TEXT NOT NULL CHECK(task IN ('writing','translation')),
  exam_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
  targets TEXT NOT NULL,
  content TEXT,
  revealed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id,request_key)
);
CREATE TABLE notebook_attempts(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES notebook_exercises(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  answer TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
  feedback TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id,request_key)
);
CREATE INDEX notebook_items_owner ON notebook_items(user_id,status,updated_at);
CREATE INDEX notebook_occurrences_owner ON notebook_occurrences(user_id,created_at);
CREATE INDEX notebook_exercises_owner ON notebook_exercises(user_id,created_at);
CREATE INDEX notebook_attempts_owner ON notebook_attempts(user_id,exercise_id,created_at);
CREATE UNIQUE INDEX notebook_generation_pending ON notebook_exercises(user_id) WHERE status='processing';
CREATE UNIQUE INDEX notebook_attempt_pending ON notebook_attempts(user_id) WHERE status='processing';
