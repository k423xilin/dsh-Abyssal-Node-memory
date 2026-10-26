-- dsh-memory v2 schema (structure only)
-- generated 2026-10-26T07:08:40.235Z

CREATE TABLE dsh_msg_text (rowid INTEGER PRIMARY KEY, text TEXT, role TEXT, createdAt INTEGER, scene TEXT);

CREATE VIRTUAL TABLE dsh_msg_fts USING fts5(text, tokenize='trigram');

CREATE TABLE dsh_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, startedAt INTEGER, endedAt INTEGER, keyPoints TEXT, topics TEXT, rawFile TEXT, msgCount INTEGER, sessionType TEXT, createdAt INTEGER);

CREATE TABLE dsh_meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE dsh_memory2 (id INTEGER PRIMARY KEY AUTOINCREMENT, tier TEXT, content TEXT, meaning TEXT, importance REAL DEFAULT 0.5, hits INTEGER DEFAULT 0, sourceKey TEXT, createdAt INTEGER, promotedAt INTEGER, lastHitAt INTEGER, scene TEXT DEFAULT 'unknown');

CREATE TABLE dsh_tendency (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, text TEXT, reaction TEXT, evidence INTEGER, ratio REAL, status TEXT, createdAt INTEGER, updatedAt INTEGER);

CREATE TABLE dsh_boundary (id INTEGER PRIMARY KEY AUTOINCREMENT, herText TEXT, hisText TEXT, grams TEXT, kind TEXT, hits INTEGER, status TEXT, createdAt INTEGER, lastAt INTEGER);

CREATE TABLE dsh_person (qq TEXT PRIMARY KEY, name TEXT, relation TEXT, isOwner INTEGER DEFAULT 0, privateCount INTEGER DEFAULT 0, groupCount INTEGER DEFAULT 0, firstSeen INTEGER, lastSeen INTEGER, note TEXT, msgCount INTEGER DEFAULT 0, lastMsg TEXT);

CREATE TABLE dsh_person_name (qq TEXT, name TEXT, firstSeen INTEGER, lastSeen INTEGER, times INTEGER DEFAULT 1, PRIMARY KEY (qq, name));

CREATE TABLE dsh_person_group (qq TEXT, groupId TEXT, count INTEGER DEFAULT 0, lastSeen INTEGER, PRIMARY KEY (qq, groupId));

CREATE TABLE dsh_vec (kind TEXT NOT NULL, key TEXT NOT NULL, text TEXT, createdAt INTEGER, emb BLOB, updatedAt INTEGER, PRIMARY KEY (kind, key));
