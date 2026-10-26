# dsh-Abyssal Node-memory

A **persistent memory loop** for [Koishi](https://koishi.chat) chatbots.

One file, one SQLite database, no cloud dependency. Only embedding calls the local
Ollama — everything else is plain SQL.

```
full-text index · session archive · two-tier memory · tendencies · boundaries · QQ-number identity · memory gate
```

---

## Why this exists

An LLM does not remember. When a chatbot appears to remember, exactly two things
went right:

1. **Write** — while the session was alive, the thing worth keeping reached disk.
2. **Read** — the next time the prompt was assembled, that thing was placed in it.

This plugin implements those two steps, and keeps them from contaminating each other.
It was extracted from a chatbot that has been running in production; every design
decision in it came from a bug.

---

## Features

| Layer | Table | What it does |
|---|---|---|
| Full-text index | `dsh_msg_text` + `dsh_msg_fts` | Find exact utterances by word (FTS5 trigram, Chinese works) |
| Session archive | `dsh_archive` | One row per conversation: title, key points, size |
| Two-tier memory | `dsh_memory2` | Short-term pool + long-term store, each with a "what it meant" field |
| Tendency | `dsh_tendency` | Repeated events become one line: "what it does when you do X" |
| Boundary | `dsh_boundary` | Lines the user drew, promoted after the third strike, fades in 14 days |
| People | `dsh_person` / `_name` / `_group` | **Identity keyed by QQ number**; nickname is only a label |
| Memory gate | — | Scores each message; recall only when it clears the bar |
| Vectors | `dsh_vec` + Ollama `bge-m3` | Semantic recall (async, optional) |

**Private/group isolation**: `dsh_msg_text.scene` (`private` / `group` / `legacy`).
Recall only reads rows matching the current scene — private chats never surface group
gossip, and vice versa.

---

## Install

```bash
npm install koishi-plugin-dsh-abyssal-node-memory
```

```yaml
# koishi.yml
plugins:
  dsh-memory:
    dbPath: data/koishi.db
    ownerQQ: 'YOUR_QQ_NUMBER'
```

**Or without npm** — drop `index.js` into your local plugin directory:

```js
app.plugin(require('./dsh-memory'), {
  dbPath: 'data/koishi.db',
  ownerQQ: 'YOUR_QQ_NUMBER',
})
```

Requirements: **Node 22+** (uses built-in `node:sqlite`), Koishi 4.18+.

Vectors are optional:

```bash
ollama pull bge-m3
curl http://127.0.0.1:11434/api/tags
```

Everything except semantic search works without Ollama.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `dbPath` | `data/koishi.db` | SQLite path (share it with Koishi) |
| `ownerQQ` | — | **Required.** Owner's QQ number |
| `ownerName` | `owner` | How the owner is referred to |
| `embedModel` | `bge-m3:latest` | Ollama embedding model |
| `ollamaUrl` | `http://127.0.0.1:11434` | |
| `enableTools` | `true` | Register `dsh-memory.status` |
| `enableInject` | `true` | Inject recalled context each turn |
| `enableTimers` | `true` | Background index / archive / decay |
| `memGateThreshold` | `3` | Gate threshold, higher = recall less |
| `memMinImportance` | `0.35` | Minimum importance to be recalled |
| `indexIntervalMs` | `600000` | Index catch-up |
| `archiveIntervalMs` | `86400000` | Archive build |
| `tendencyIntervalMs` | `86400000` | Tendency extraction |
| `boundaryIntervalMs` | `86400000` | Boundary fade |
| `tendencyMinHits` | `3` | Occurrences before a tendency exists |
| `tendencyMinRatio` | `0.66` | Dominant reaction share |
| `boundaryPromoteAt` | `3` | Hits that promote a soft note |
| `boundaryFadeDays` | `14` | Days before fading |
| `keepVectorDays` | `90` | Vector retention |
| `maxTextLen` | `1200` | Per-row cap |

---

## Host API

Everything is on `ctx.dshMemory`:

```js
ctx.dshMemory.memGate(text)                       // { need, score, why }
ctx.dshMemory.extractKeywords(text)               // ['harbor', 'painting']
ctx.dshMemory.keywordSearch(db, 'harbor', 3, 'private')
ctx.dshMemory.archiveSearch(db, 'painting', 2, 'group')
ctx.dshMemory.mem2Add(db, content, meaning, 4.5)  // >= 4 goes straight to long-term
ctx.dshMemory.mem2Recall(db, 'the sea', 2, 'private')
ctx.dshMemory.tendList(db, 4)
ctx.dshMemory.boundaryNote(db, botText, userText) // record one "over the line"
ctx.dshMemory.boundaryHit(db, userMessage)
ctx.dshMemory.personSeen(db, qq, nick, isDirect, groupId, lastMsg)
ctx.dshMemory.personById(db, qq)                  // includes nickname history
ctx.dshMemory.personContext(db, qq, nick, isDirect, groupId)
ctx.dshMemory.vecSearch(db, 'msg', 'keyword', 8, 'private')
ctx.dshMemory.indexBatch(db, 200)
```

The host only needs three jobs:

```
1. On every message: personSeen(...) and store the raw text where the plugin can read it
2. Before each model call: memGate() to decide, then keywordSearch / mem2Recall
3. Every ~10 minutes: indexBatch() to catch up
```

---

## Design decisions

**Identity is the QQ number, never the nickname.** Nicknames change and people
impersonate. A stranger who renames himself to the owner's name is still caught.

**Private and group never mix.** Scene is resolved at write time from the conversation
binding key. Rows that cannot be resolved are marked `legacy` and excluded from recall —
better to forget than to cross the wires.

**Trivial messages do not trigger recall.** "hey", "morning", "good night" are answered
directly. "do you remember last time…" is not. Scoring: past tense +4, promise +3,
anaphora +2, small talk −5.

**Tendencies are grown, not written.** A tendency exists only after 3 occurrences with a
66% dominant reaction; three contrary reactions later it retires itself.

**Boundaries need three strikes.** First two are soft notes; the third promotes; 14 quiet
days retire it.

---

## Verify the install

```
dsh-memory.status
→ index 4878 / archive 147 / memory 4 / tendency 0 / boundary 2 / people 20
```

```
[memory] tables ready (data/koishi.db)
[memory] indexed {"text":18,"archive":1,"mem":0}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `keywordSearch` returns 0 | Single-character query | Minimum 2 chars; 2 chars uses LIKE, 3+ uses FTS |
| Vector search empty | Ollama not running | `ollama serve`, check port 11434 |
| Memory never grows | `text_cursor` stuck | Delete that row in `dsh_meta`, re-index |
| Private chat can't recall group memories | By design | Loosen the scene check at the call site |
| Columns missing on an old DB | Schema drift | `init()` runs `ALTER TABLE ... ADD COLUMN` |

---

## License

MIT. Use it, modify it, ship it. One request: **do not use the `boundary` table as
training data.** Those are somebody's actual limits.

---

[中文说明](README.zh-CN.md)
