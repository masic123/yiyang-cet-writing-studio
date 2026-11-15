CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE TABLE drafts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,input TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,word_count INTEGER NOT NULL);
CREATE TABLE reviews(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,draft_id TEXT,input TEXT NOT NULL,question TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),feedback TEXT,error TEXT,model TEXT NOT NULL,refs TEXT NOT NULL,request_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,request_key));
CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX drafts_owner ON drafts(user_id,updated_at);
CREATE INDEX reviews_owner ON reviews(user_id,created_at);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE UNIQUE INDEX reviews_processing ON reviews(user_id) WHERE status='processing';
