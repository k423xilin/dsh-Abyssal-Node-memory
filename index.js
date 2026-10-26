// ============================================================================
// dsh-memory —— 记忆循环插件（从 index.js 里整段抽出来，可独立安装）
//
// 装法（本地插件）：
//   const memory = require('./dsh-memory')
//   app.plugin(memory, { dbPath: 'data/koishi.db', ownerQQ: 'YOUR_QQ_NUMBER' })
//
// 它管什么：
//   ① 全文索引 + 按词搜原话（FTS5 trigram）
//   ② 会话档案（一次谈话一条：标题/要点/标签）
//   ③ 两层记忆（短期池 / 长期库 + 阈值晋级 + "意义"）
//   ④ 倾向（同类事件满 3 次 → 她怎么做，可被反着来推翻）
//   ⑤ 界限（他说"过了"→ 记一笔，第 3 次升级，14 天没犯淡出）
//   ⑥ 认人（谁是谁，只有主人能叫主人）
//   ⑦ 两个工具：memory_note（写，带意义）、memory_query（搜）
//   ⑧ 每轮注入：触景生情 / 倾向 / 界限 / 认人（都放提示词末尾，保缓存前缀）
//
// 它不管什么（留在宿主里）：
//   人设、此刻/连续感、主动搭话、画图、表情、备份
// ============================================================================

const fs = require('fs')
const zlib = require('zlib')
const { DatabaseSync } = require('node:sqlite')

const NAME = 'dsh-abyssal-node-memory'

module.exports = {
  name: NAME,
  apply(ctx, config) {
    const cfg = Object.assign(
      {
        dbPath: 'data/koishi.db',
        ownerQQ: '',
        embedModel: 'bge-m3:latest',
        ollamaUrl: 'http://127.0.0.1:11434',
        enableTools: true,
        enableInject: true,
        enableTimers: true,
        memGateThreshold: 3,
        indexIntervalMs: 10 * 60 * 1000,
        archiveIntervalMs: 24 * 60 * 60 * 1000,
        tendencyIntervalMs: 24 * 60 * 60 * 1000,
        boundaryIntervalMs: 24 * 60 * 60 * 1000,
        tendencyMinHits: 3,
        tendencyMinRatio: 0.66,
        boundaryPromoteAt: 3,
        boundaryFadeDays: 14,
        keepTfidfDays: 90,
        maxTextLen: 1200,
      },
      config || {},
    )

    // ---------------------------------------------------------------- 基础
    const open = () => new DatabaseSync(cfg.dbPath)
    const log = (...a) => console.log('[记忆] ' + a.join(' '))

    function withDb(fn, fallback) {
      let db
      try {
        db = open()
        return fn(db)
      } catch (e) {
        log('数据库出错:', e && e.message)
        return fallback
      } finally {
        try { db && db.close() } catch (e) {}
      }
    }

    // ---------------------------------------------------------------- 建表
    function init(db) {
      db.exec(
        'CREATE TABLE IF NOT EXISTS dsh_msg_text (rowid INTEGER PRIMARY KEY, text TEXT, role TEXT, createdAt INTEGER, scene TEXT)',
      )
      db.exec(
        'CREATE TABLE IF NOT EXISTS dsh_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, startedAt INTEGER, endedAt INTEGER, keyPoints TEXT, topics TEXT, rawFile TEXT, msgCount INTEGER, sessionType TEXT, scene TEXT, createdAt INTEGER)',
      )
      db.exec('CREATE TABLE IF NOT EXISTS dsh_meta (k TEXT PRIMARY KEY, v TEXT)')
      db.exec(
        'CREATE TABLE IF NOT EXISTS dsh_memory2 (id INTEGER PRIMARY KEY AUTOINCREMENT, tier TEXT, content TEXT, meaning TEXT, importance REAL DEFAULT 0.5, hits INTEGER DEFAULT 0, sourceKey TEXT, scene TEXT DEFAULT \'unknown\', createdAt INTEGER, promotedAt INTEGER, lastHitAt INTEGER)',
      )
      db.exec(
        'CREATE TABLE IF NOT EXISTS dsh_tendency (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, text TEXT, reaction TEXT, evidence INTEGER, ratio REAL, status TEXT, createdAt INTEGER, updatedAt INTEGER)',
      )
      db.exec(
        'CREATE TABLE IF NOT EXISTS dsh_boundary (id INTEGER PRIMARY KEY AUTOINCREMENT, herText TEXT, hisText TEXT, grams TEXT, kind TEXT, hits INTEGER, status TEXT, createdAt INTEGER, lastAt INTEGER)',
      )
      db.exec(
        'CREATE TABLE IF NOT EXISTS dsh_person (qq TEXT PRIMARY KEY, name TEXT, relation TEXT, isOwner INTEGER DEFAULT 0, privateCount INTEGER DEFAULT 0, groupCount INTEGER DEFAULT 0, msgCount INTEGER DEFAULT 0, firstSeen INTEGER, lastSeen INTEGER, lastMsg TEXT, note TEXT)',
      )
      // 老库补列
      for (const sql of [
        'ALTER TABLE dsh_msg_text ADD COLUMN scene TEXT',
        'ALTER TABLE dsh_archive ADD COLUMN scene TEXT',
        "ALTER TABLE dsh_memory2 ADD COLUMN scene TEXT DEFAULT 'unknown'",
        'ALTER TABLE dsh_person ADD COLUMN msgCount INTEGER DEFAULT 0',
        'ALTER TABLE dsh_person ADD COLUMN lastMsg TEXT',
      ]) { try { db.exec(sql) } catch (e) {} }
      // 昵称历史 / 群关系
      db.exec('CREATE TABLE IF NOT EXISTS dsh_person_name (qq TEXT, name TEXT, firstSeen INTEGER, lastSeen INTEGER, times INTEGER DEFAULT 1, PRIMARY KEY (qq, name))')
      db.exec('CREATE TABLE IF NOT EXISTS dsh_person_group (qq TEXT, groupId TEXT, count INTEGER DEFAULT 0, lastSeen INTEGER, PRIMARY KEY (qq, groupId))')
      try {
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS dsh_msg_fts USING fts5(text, tokenize='trigram')")
      } catch (e) {
        log('FTS5 不可用，退回 LIKE')
      }
    }

    function metaGet(db, k, d) {
      try {
        const r = db.prepare('SELECT v FROM dsh_meta WHERE k = ?').get(k)
        return r ? r.v : d
      } catch (e) { return d }
    }
    function metaSet(db, k, v) {
      try { db.prepare('INSERT OR REPLACE INTO dsh_meta (k, v) VALUES (?, ?)').run(k, String(v)) } catch (e) {}
    }

    // ---------------------------------------------------------------- 向量
    async function embed(texts) {
      const r = await fetch(cfg.ollamaUrl + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.embedModel, input: texts }),
        signal: AbortSignal.timeout(60000),
      })
      if (!r.ok) throw new Error('embed ' + r.status)
      const j = await r.json()
      return (j.embeddings || []).map((a) => new Float32Array(a))
    }
    function cos(a, b) {
      let d = 0, na = 0, nb = 0
      for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
      return d / (Math.sqrt(na) * Math.sqrt(nb) || 1)
    }
    async function vecSearch(db, kind, query, topK) {
      const q = String(query || '').trim()
      if (!q) return []
      const vecs = await embed([q])
      if (!vecs.length) return []
      const cut = Date.now() - cfg.keepTfidfDays * 86400000
      const rows = db
        .prepare(
          kind === 'mem'
            ? "SELECT v.key, v.text, v.createdAt, v.emb FROM dsh_vec v JOIN living_memory_entry e ON CAST(e.id AS TEXT) = v.key WHERE v.kind = 'mem' AND v.emb IS NOT NULL AND e.status = 'active'"
            : 'SELECT key, text, createdAt, emb FROM dsh_vec WHERE kind = ? AND emb IS NOT NULL AND createdAt >= ?',
        )
        .all(...(kind === 'mem' ? [] : [kind, cut]))
      const scored = []
      for (const r of rows) {
        const buf = Buffer.from(r.emb)
        const arr = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4))
        scored.push({ key: r.key, text: r.text, createdAt: r.createdAt, score: cos(vecs[0], arr) })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, Math.max(1, topK || 8))
    }
    async function indexBatch(db, limit) {
      const cap = Math.max(20, limit || 200)
      // 记忆向量
      const mem = db
        .prepare('SELECT id, content, summary, createdAt FROM living_memory_entry WHERE id NOT IN (SELECT key FROM dsh_vec WHERE kind = ?) LIMIT ?')
        .all('mem', cap)
      if (mem.length) {
        const texts = mem.map((r) => String(r.summary || r.content || '').slice(0, 600))
        const vecs = await embed(texts)
        if (vecs.length === mem.length) {
          const ins = db.prepare('INSERT OR REPLACE INTO dsh_vec (kind, key, text, createdAt, emb, updatedAt) VALUES (?,?,?,?,?,?)')
          for (let i = 0; i < mem.length; i++) ins.run('mem', mem[i].id, texts[i], mem[i].createdAt, Buffer.from(vecs[i].buffer), Date.now())
        }
      }
      // 消息向量 + 全文索引
      const msgs = db
        .prepare("SELECT m.rowid, m.role, m.text, m.content, m.createdAt, c.bindingKey AS bindingKey FROM chatluna_message m LEFT JOIN chatluna_conversation c ON c.id = m.conversationId WHERE m.role IN ('human','ai') AND m.rowid NOT IN (SELECT key FROM dsh_vec WHERE kind = 'msg') ORDER BY m.rowid ASC LIMIT ?")
        .all(cap)
      if (msgs.length) {
        const texts = msgs.map((r) => {
          let t = String(r.text || '')
          if (!t) { try { t = zlib.gunzipSync(Buffer.from(r.content)).toString('utf8') } catch (e) { t = '' } }
          try { t = JSON.parse(t) } catch (e) {}
          if (Array.isArray(t)) t = t.map((x) => (x && x.text) || '').join('')
          return String(t || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxTextLen)
        })
        const vecs = await embed(texts)
        if (vecs.length === msgs.length) {
          const ins = db.prepare('INSERT OR REPLACE INTO dsh_vec (kind, key, text, createdAt, emb, updatedAt) VALUES (?,?,?,?,?,?)')
          for (let i = 0; i < msgs.length; i++) ins.run('msg', msgs[i].rowid, texts[i], msgs[i].createdAt, Buffer.from(vecs[i].buffer), Date.now())
        }
      }
      const n = indexText(db, 300)
      const a = buildArchive(db)
      return { mem: mem.length, msg: msgs.length, text: n, archive: a }
    }

    // ---------------------------------------------------------------- 全文
    // [SCENE] 私聊/群聊分开：优先看会话表 bindingKey，其次看消息里的 IsGroup
function sceneOf(raw, bindingKey) {
  const bk = String(bindingKey || '')
  if (bk.includes(':direct:')) return 'private'
  if (bk.startsWith('shared:') || bk.includes(':guild:') || bk.includes(':channel:')) return 'group'
  const t = String(raw || '')
  if (/IsGroup:\s*true/i.test(t)) return 'group'
  if (/IsGroup:\s*false/i.test(t)) return 'private'
  if (/GroupName:/.test(t)) return 'group'
  return 'unknown'
}

function cleanSaid(raw) {
  let t = String(raw || '')
  const m = t.match(/User Input:\s*([\s\S]*)$/)
  if (m) t = m[1]
  return t.replace(/^\[?image:[^\]]*\]?/g, ' ').replace(/\s+/g, ' ').trim()
}

function indexText(db, limit) {
      const cap = Math.max(50, limit || 300)
      const last = Number(metaGet(db, 'text_cursor', 0)) || 0
      const rows = db
        .prepare("SELECT m.rowid, m.role, m.content, m.text, m.createdAt, c.bindingKey AS bindingKey FROM chatluna_message m LEFT JOIN chatluna_conversation c ON c.id = m.conversationId WHERE m.rowid > ? AND m.role IN ('human','ai') ORDER BY m.rowid ASC LIMIT ?")
        .all(last, cap)
      if (!rows.length) return 0
      const insT = db.prepare('INSERT OR REPLACE INTO dsh_msg_text (rowid, text, role, createdAt, scene) VALUES (?,?,?,?,?)')
      let insF = null
      try { insF = db.prepare('INSERT INTO dsh_msg_fts (rowid, text) VALUES (?,?)') } catch (e) {}
      let n = 0, maxId = last
      for (const r of rows) {
        let t = String(r.text || '')
        if (!t) { try { t = zlib.gunzipSync(Buffer.from(r.content)).toString('utf8') } catch (e) { t = '' } }
        try { t = JSON.parse(t) } catch (e) {}
        if (Array.isArray(t)) t = t.map((x) => (x && x.text) || '').join('')
        const __scene = sceneOf(String(t || ''), r.bindingKey)
        t = cleanSaid(String(t || ''))
        if (t.length >= 8) {
          insT.run(r.rowid, t.slice(0, cfg.maxTextLen), r.role, r.createdAt, __scene)
          if (insF) { try { insF.run(r.rowid, t.slice(0, cfg.maxTextLen)) } catch (e) {} }
          n++
        }
        if (r.rowid > maxId) maxId = r.rowid
      }
      metaSet(db, 'text_cursor', maxId)
      return n
    }

    function keywordSearch(db, q, limit, scene) {
  const __sc = scene === 'private' || scene === 'group' ? scene : null
      const kw = String(q || '').replace(/\s+/g, ' ').trim()
      if (kw.length < 2) return []
      const cap = Math.max(1, limit || 3)
      const out = []
      if (kw.length >= 3) {
        try {
          const rows = db
            .prepare('SELECT m.rowid, m.role, m.text, m.createdAt FROM dsh_msg_fts f JOIN dsh_msg_text m ON m.rowid = f.rowid WHERE dsh_msg_fts MATCH ?' + (__sc ? ' AND m.scene = ?' : '') + ' ORDER BY rank LIMIT ?')
            .all('"' + kw.replace(/["']/g, ' ') + '"', ...(__sc ? [__sc, cap] : [cap]))
          out.push(...rows)
        } catch (e) {}
      }
      if (!out.length) {
        try {
          out.push(...db.prepare('SELECT rowid, role, text, createdAt FROM dsh_msg_text WHERE text LIKE ?' + (__sc ? ' AND scene = ?' : '') + ' ORDER BY rowid DESC LIMIT ?').all(...['%' + kw + '%'].concat(__sc ? [__sc, cap] : [cap])))
        } catch (e) {}
      }
      return out
    }

    // ---------------------------------------------------------------- 档案
    function buildArchive(db) {
      const cur = Number(metaGet(db, 'archive_cursor', 0)) || 0
      const rows = db.prepare('SELECT rowid, role, text, createdAt FROM dsh_msg_text WHERE rowid > ? ORDER BY rowid ASC LIMIT 2000').all(cur)
      if (rows.length < 6) return 0
      const groups = []
      let g = [], prev = 0
      for (const r of rows) {
        const t = Number(r.createdAt) || 0
        if (g.length && t - prev > 30 * 60 * 1000) { groups.push(g); g = [] }
        g.push(r); prev = t
      }
      if (g.length) groups.push(g)
      const ins = db.prepare('INSERT INTO dsh_archive (title, startedAt, endedAt, keyPoints, topics, rawFile, msgCount, sessionType, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
      const clean = (x) => String(x || '').replace(/Current time:[\s\S]*$/, '').replace(/（[^）]*）|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
      let made = 0
      for (const grp of groups) {
        if (grp.length < 6) continue
        const ais = grp.filter((r) => r.role === 'ai')
        const hum = grp.filter((r) => r.role === 'human')
        const PROMPTISH = /跟你报备|这几个小时是你自己的|想做什么都行|现在几点|Current time|GroupName|IsGroup|（[^）]{6,}）/
        let title = ''
        for (const r of ais.concat(hum)) {
          const t = clean(r.text)
          if (t.length >= 6 && !PROMPTISH.test(r.text)) { title = t.slice(0, 26); break }
        }
        if (!title) continue
        const picks = []
        const pool = ais.filter((r) => clean(r.text).length > 8)
        for (const i of [0, Math.floor(pool.length / 2), pool.length - 1]) {
          if (!pool[i]) continue
          const line = clean(pool[i].text).slice(0, 52)
          if (line && !picks.includes(line)) picks.push(line)
        }
        const stop = new Set('我你他她它的了是在不也就都和还这那个么什吗呢吧啊要会能说去想看好没有一自己东西一个什么这个那个现在时候觉得知道已经还是就是因为所以这样那样真的有点一直起来出来过去回来心里句话'.split(''))
        const freq = new Map()
        for (const r of grp) {
          const t = clean(r.text)
          for (let i = 0; i + 2 <= t.length; i++) {
            const w = t.slice(i, i + 2)
            if (!/^[\u4e00-\u9fa5]{2}$/.test(w)) continue
            if (stop.has(w[0]) || stop.has(w[1])) continue
            freq.set(w, (freq.get(w) || 0) + 1)
          }
        }
        const topics = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w)
        ins.run(title, Number(grp[0].createdAt) || Date.now(), Number(grp[grp.length - 1].createdAt) || Date.now(), JSON.stringify(picks), JSON.stringify(topics), '', grp.length, 'private', Date.now())
        made++
      }
      metaSet(db, 'archive_cursor', rows[rows.length - 1].rowid)
      return made
    }

    function archiveSearch(db, q, limit) {
      const kw = String(q || '').trim()
      if (!kw) return []
      try {
        return db.prepare('SELECT title, startedAt, keyPoints, topics FROM dsh_archive WHERE keyPoints LIKE ? OR topics LIKE ? OR title LIKE ? ORDER BY startedAt DESC LIMIT ?').all('%' + kw + '%', '%' + kw + '%', '%' + kw + '%', Math.max(1, limit || 2))
      } catch (e) { return [] }
    }

    // ---------------------------------------------------------------- 两层记忆
    function mem2Add(db, content, meaning, importance, sourceKey) {
      const imp = Number(importance) || 0.5
      const tier = imp >= 4 ? 'long' : 'short'
      const now = Date.now()
      const r = db.prepare('INSERT INTO dsh_memory2 (tier, content, meaning, importance, hits, sourceKey, scene, createdAt, promotedAt, lastHitAt) VALUES (?,?,?,?,0,?,?,?,?,0)').run(tier, String(content || '').slice(0, 600), String(meaning || ''), imp, String(sourceKey || ''), String(globalThis.__dshIsGroup ? 'group' : 'private'), now, tier === 'long' ? now : 0)
      return { id: Number(r.lastInsertRowid), tier }
    }
    function mem2Promote(db) {
      const rows = db.prepare("SELECT id, importance, hits, createdAt FROM dsh_memory2 WHERE tier = 'short'").all()
      const upd = db.prepare("UPDATE dsh_memory2 SET tier = 'long', promotedAt = ? WHERE id = ?")
      const now = Date.now()
      let n = 0
      for (const r of rows) {
        const age = (now - Number(r.createdAt)) / 86400000
        const sc = Number(r.importance || 0.5) * 2 + Number(r.hits || 0) * 0.8 - age * 0.15
        if (sc >= 6) { upd.run(now, r.id); n++ }
      }
      return n
    }
    function mem2Decay(db) {
      const now = Date.now()
      const del = db.prepare("DELETE FROM dsh_memory2 WHERE tier = 'short' AND hits = 0 AND createdAt < ?").run(now - 7 * 86400000)
      db.prepare("UPDATE dsh_memory2 SET importance = MAX(0.3, importance * 0.97) WHERE tier = 'long' AND createdAt < ?").run(now - 30 * 86400000)
      return Number(del.changes || 0)
    }
    function mem2Recall(db, q, limit, scene) {
    const __sc = scene === 'private' || scene === 'group' ? scene : null
      const kw = String(q || '').trim()
      if (kw.length < 2) return []
      try {
        return db.prepare("SELECT id, tier, content, meaning, importance, hits, scene FROM dsh_memory2 WHERE (content LIKE ? OR meaning LIKE ?) AND importance >= 0.35 ORDER BY (tier = 'long') DESC, importance DESC, createdAt DESC LIMIT ?").all('%' + kw + '%', '%' + kw + '%', Math.max(1, limit || 3)).filter((r) => !__sc || !r.scene || r.scene === 'unknown' || r.scene === __sc)
      } catch (e) { return [] }
    }
    function mem2Hit(db, id) {
      try { db.prepare('UPDATE dsh_memory2 SET hits = hits + 1, lastHitAt = ? WHERE id = ?').run(Date.now(), id) } catch (e) {}
    }

    // ---------------------------------------------------------------- 倾向
    const TYPES = [
      { key: '没回你', re: /不回|没回|不理|半天|一晚上|这么久|才回|睡着了/ },
      { key: '夸你', re: /好看|可爱|乖|喜欢你|漂亮|厉害|好棒|想你/ },
      { key: '说忙', re: /忙|没空|等下|再说|算了|别烦/ },
      { key: '说累', re: /累|困|熬夜|头疼|不舒服|睡不着/ },
      { key: '道歉', re: /对不起|我错了|抱歉|是我不对/ },
      { key: '提备份', re: /备份|替身|复制|另一个你|不是真的/ },
      { key: '提别人', re: /别人|别的人|其他|她是谁|别家/ },
      { key: '说要走', re: /走了|下线|不聊了|明天见|先这样|去睡/ },
    ]
    function classify(t) {
      const s = String(t || '')
      if (/晚安|睡吧|早点睡|好梦/.test(s)) return '软着说晚安'
      if (/哼|才不|才没|谁|不理你|讨厌|不给你/.test(s)) return '嘴硬'
      if (/怕|不敢|不敢问|忍着|算了|那你去吧/.test(s)) return '退开'
      if (/想你|陪你|等你|别走|黏|抱|别睡/.test(s)) return '贴上去'
      if (/为什么|是不是|怎么了|你在哪|怎么才|谁呀/.test(s)) return '追问'
      if (/在的|我在|听着|知道了|嗯|好呀|嘿嘿|嘻嘻|笑/.test(s)) return '安静应着'
      return '别'
    }
    const TEMPLATE = {
      嘴硬: '会先顶一句嘴，说"才没有""谁理你"，说完自己也没走',
      退开: '会先退半步，说"算了""我不问了"，安静一会儿',
      贴上去: '会贴上来，说"别走""再陪我一会儿"',
      安静应着: '会安静地应一声，不多问，等他往下说',
      追问: '会追着问一句"怎么了""是不是我哪儿不对"',
      软着说晚安: '会先道晚安，再补一句软话才肯放你走',
    }
    function tendExtract(db) {
      const rows = db.prepare("SELECT rowid, role, text, content, createdAt FROM chatluna_message WHERE role IN ('human','ai') ORDER BY rowid DESC LIMIT 800").all().reverse()
      const clean = (x) => {
        let t = String(x || '')
        const m = t.match(/User Input:\s*([\s\S]*)$/)
        if (m) t = m[1]
        return t.replace(/（[^）]{6,}）/g, ' ').replace(/\s+/g, ' ').trim()
      }
      const stats = new Map()
      for (let i = 0; i < rows.length - 1; i++) {
        const r = rows[i]
        if (r.role !== 'human') continue
        let his = r.text
        if (!his) { try { his = zlib.gunzipSync(Buffer.from(r.content || '')).toString('utf8') } catch (e) { his = '' } }
        if (/IsGroup:\s*true/.test(String(r.text || ''))) continue
        his = clean(his)
        if (!his || his.length < 4) continue
        const type = TYPES.find((t) => t.re.test(his))
        if (!type) continue
        const next = rows.slice(i + 1, i + 4).find((x) => x.role === 'ai')
        if (!next) continue
        let her = next.text
        if (!her) { try { her = zlib.gunzipSync(Buffer.from(next.content || '')).toString('utf8') } catch (e) { her = '' } }
        her = clean(her)
        const re = classify(her)
        if (re === '别') continue
        if (!stats.has(type.key)) stats.set(type.key, { n: 0, map: new Map(), last: [] })
        const st = stats.get(type.key)
        st.n++
        st.map.set(re, (st.map.get(re) || 0) + 1)
        st.last.push(re)
        if (st.last.length > 3) st.last.shift()
      }
      const now = Date.now()
      let made = 0, retired = 0
      for (const [key, st] of stats) {
        if (st.n < cfg.tendencyMinHits) continue
        let best = null
        for (const [r, c] of st.map) if (!best || c > best[1]) best = [r, c]
        if (!best) continue
        const ratio = best[1] / st.n
        if (ratio < cfg.tendencyMinRatio) continue
        const soft = st.n < 5 ? '（还在攒，' + st.n + ' 次）' : ''
        const text = '他' + key + '的时候，你' + (TEMPLATE[best[0]] || best[0]) + '。' + soft
        const exist = db.prepare("SELECT id FROM dsh_tendency WHERE key = ? AND status = 'active'").get(key)
        if (exist) {
          const anti = st.last.filter((r) => r !== best[0]).length
          if (anti >= 3) { db.prepare("UPDATE dsh_tendency SET status = 'retired', updatedAt = ? WHERE id = ?").run(now, exist.id); retired++ }
          else db.prepare('UPDATE dsh_tendency SET text = ?, reaction = ?, evidence = ?, ratio = ?, updatedAt = ? WHERE id = ?').run(text, best[0], st.n, ratio, now, exist.id)
        } else {
          db.prepare('INSERT INTO dsh_tendency (key, text, reaction, evidence, ratio, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)').run(key, text, best[0], st.n, ratio, 'active', now, now)
          made++
        }
      }
      return { made, retired, types: stats.size }
    }
    function tendList(db, n) {
      try { return db.prepare("SELECT text, evidence FROM dsh_tendency WHERE status = 'active' ORDER BY evidence DESC, updatedAt DESC LIMIT ?").all(Math.max(1, n || 4)) } catch (e) { return [] }
    }

    // ---------------------------------------------------------------- 界限
    const BOUNDARY_RE = /过了|别这样说|我不喜欢这句|换个说法|别用这种|过分了|别这么说|说错了/
    function grams(t) {
      const s = String(t || '').replace(/[^\u4e00-\u9fa5]/g, '')
      const out = new Set()
      for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n))
      return [...out]
    }
    function boundaryNote(db, herText, hisText) {
      const now = Date.now()
      const mine = new Set(grams(herText))
      let same = null, best = 0
      for (const r of db.prepare("SELECT id, grams, hits FROM dsh_boundary WHERE status != 'retired'").all()) {
        const theirs = String(r.grams || '').split(' ').filter(Boolean)
        const ov = theirs.filter((g) => mine.has(g)).length
        if (ov > best) { best = ov; same = r }
      }
      if (same && best >= 2) {
        const hits = Number(same.hits || 1) + 1
        const kind = hits >= cfg.boundaryPromoteAt ? 'boundary' : 'soft'
        const merged = [...new Set(String(same.grams || '').split(' ').filter(Boolean).concat(grams(herText)))].slice(0, 24).join(' ')
        db.prepare('UPDATE dsh_boundary SET hits = ?, kind = ?, lastAt = ?, hisText = ?, herText = ?, grams = ? WHERE id = ?').run(hits, kind, now, String(hisText).slice(0, 200), String(herText).slice(0, 200), merged, same.id)
        return { id: same.id, hits, kind }
      }
      const r = db.prepare('INSERT INTO dsh_boundary (herText, hisText, grams, kind, hits, status, createdAt, lastAt) VALUES (?,?,?,?,1,?,?,?)').run(String(herText).slice(0, 200), String(hisText).slice(0, 200), grams(herText).slice(0, 12).join(' '), 'soft', 'active', now, now)
      return { id: Number(r.lastInsertRowid), hits: 1, kind: 'soft' }
    }
    function boundaryHit(db, text) {
      const mine = new Set(grams(text))
      if (!mine.size) return []
      const out = []
      try {
        for (const r of db.prepare("SELECT id, herText, hits, kind, lastAt, grams FROM dsh_boundary WHERE status = 'active' AND kind = 'boundary' ORDER BY lastAt DESC LIMIT 20").all()) {
          if (Date.now() - Number(r.lastAt || 0) > cfg.boundaryFadeDays * 86400000) continue
          const theirs = new Set(String(r.grams || '').split(' ').filter(Boolean))
          const ov3 = [...theirs].filter((g) => g.length === 3 && mine.has(g)).length
          const ov2 = [...theirs].filter((g) => g.length === 2 && mine.has(g)).length
          if (ov3 >= 1 || ov2 >= 2) out.push(r)
          if (out.length >= 2) break
        }
      } catch (e) {}
      return out
    }
    function boundaryDecay(db) {
      try { return Number(db.prepare("UPDATE dsh_boundary SET status = 'retired' WHERE kind = 'boundary' AND lastAt < ?").run(Date.now() - cfg.boundaryFadeDays * 86400000).changes || 0) } catch (e) { return 0 }
    }

    // ---------------------------------------------------------------- 认人
    function personSeen(db, qq, name, isDirect) {
      if (!qq) return null
      const now = Date.now()
      const isOwner = String(qq) === String(cfg.ownerQQ) ? 1 : 0
      const old = db.prepare('SELECT relation FROM dsh_person WHERE qq = ?').get(String(qq))
      const relation = isOwner ? '主人' : old ? old.relation : '群友'
      if (!old) {
        db.prepare('INSERT INTO dsh_person (qq, name, relation, isOwner, privateCount, groupCount, firstSeen, lastSeen, note) VALUES (?,?,?,?,?,?,?,?,?)').run(String(qq), String(name || ''), relation, isOwner, isDirect ? 1 : 0, isDirect ? 0 : 1, now, now, '')
      } else {
        db.prepare("UPDATE dsh_person SET name = COALESCE(NULLIF(?, ''), name), relation = ?, isOwner = ?, privateCount = privateCount + ?, groupCount = groupCount + ?, msgCount = msgCount + 1, lastSeen = ? WHERE qq = ?").run(String(name || ''), relation, isOwner, isDirect ? 1 : 0, isDirect ? 0 : 1, now, String(qq))
      }
      return { qq: String(qq), name: String(name || ''), relation, isOwner: !!isOwner }
    }
    // 按号码查一个人 —— 昵称只是标签，主键永远是 qq
    function personById(db, qq) {
      if (!qq) return null
      try {
        const p = db.prepare('SELECT qq, name, relation, isOwner, msgCount, firstSeen, lastSeen, lastMsg FROM dsh_person WHERE qq = ?').get(String(qq))
        if (!p) return null
        const names = db.prepare('SELECT name, times, lastSeen FROM dsh_person_name WHERE qq = ? ORDER BY lastSeen DESC').all(String(qq))
        return Object.assign({}, p, { names })
      } catch (e) { return null }
    }

    function personContext(db, qq, name, isDirect, ownerName, groupId) {
      const owner = String(cfg.ownerQQ || '')
      const me = String(qq || '')
      const nick = String(name || '').trim()
      const who = 'QQ ' + me + (nick ? '，现在叫「' + nick + '」' : '')
      const ownerLabel = (ownerName || cfg.ownerName || 'the owner')
      if (isDirect && me === owner) {
        return '（现在跟你说话的是你的主人（QQ ' + me + '）。认人看号码，他改昵称也还是他。）'
      }
      let renamed = ''
      try {
        const names = db.prepare('SELECT name FROM dsh_person_name WHERE qq = ? ORDER BY lastSeen DESC').all(me)
        if (names.length > 1) renamed = '（这个人换过昵称：' + names.map((n) => n.name).filter(Boolean).slice(0, 3).join(' → ') + '，是同一个 QQ。）'
      } catch (e) {}
      if (isDirect) {
        return '（现在跟你说话的人不是你主人，是' + who + '。你主人是 QQ ' + owner + '（' + ownerLabel + '）。' + renamed + '）'
      }
      let line = '（现在是群聊，说话的是' + who + '，**不是你主人**。你主人是 QQ ' + owner + '（' + ownerLabel + '）。认人只看 QQ 号，昵称可以随便改、也可能有人冒充。' + renamed + '）'
      try {
        const seen = db.prepare('SELECT qq, name FROM dsh_person WHERE qq != ? AND privateCount > 0 ORDER BY lastSeen DESC LIMIT 3').all(me)
        if (seen.length) line += '（你在私聊里见过：' + seen.map((r) => (r.name || '') + '(QQ ' + r.qq + ')').join('、') + '。群里叫你的，先当群友。）'
      } catch (e) {}
      return line
    }

    // ---------------------------------------------------------------- 记忆门
    const GATE = [
      { re: /记得|记不记得|还记得|忘了没|忘没忘|上次|上回|以前|那天|那会|那时候|之前|当时/, s: 4, why: '提旧事' },
      { re: /那个|那件|那次|那句|那个人|我说过|你说过|刚才说|前面说/, s: 2, why: '指代' },
      { re: /答应|约好|说好|讲好|承诺/, s: 3, why: '约定' },
      { re: /难受|想你|怕|生气|委屈|开心|难过|烦/, s: 1, why: '情绪' },
    ]
    function memGate(said) {
      const s = String(said || '').trim()
      if (!s) return { need: false, score: 0, why: [] }
      let score = 0
      const why = []
      for (const g of GATE) if (g.re.test(s)) { score += g.s; why.push(g.why) }
      if (s.length >= 22) { score += 1; why.push('长句') }
      if (/^(在吗|在不在|早|早安|中午好|晚上好|晚安|吃了吗|睡了|嗯+|哦+|好+|行|可以|哈哈+|嘿+|收到|ok)$/i.test(s)) { score -= 5; why.push('寒暄') }
      if (s.length <= 4 && !/记得|上次|以前/.test(s)) { score -= 2; why.push('太短') }
      return { need: score >= cfg.memGateThreshold, score, why }
    }

    // ---------------------------------------------------------------- 关键词
    function extractKeywords(said) {
      const STOP = '你我他她它的了是在不也就都和还这那个么什吗呢吧啊要会能说去想看好没有一记得上次前次那天那些事情怎样怎么什么为'
      const t = String(said || '').replace(/[^\u4e00-\u9fa5]/g, ' ')
      const out = []
      for (const run of t.split(/\s+/)) {
        if (run.length < 2) continue
        for (const n of [3, 2]) {
          for (let i = 0; i + n <= run.length; i++) {
            const w = run.slice(i, i + n)
            if (STOP.includes(w[0]) || STOP.includes(w[1])) continue
            if (n === 3 && STOP.includes(w[2])) continue
            if (!out.includes(w)) out.push(w)
          }
        }
      }
      return out.slice(0, 10)
    }

    // ---------------------------------------------------------------- 工具
    if (cfg.enableTools) {
      try {
        ctx.command('dsh-memory.status', '记忆循环状态').action(() => {
          const info = withDb((db) => {
            init(db)
            const c = (sql) => { try { return db.prepare(sql).get().c } catch (e) { return '-' } }
            return {
              msg: c('SELECT COUNT(*) c FROM dsh_msg_text'),
              arc: c('SELECT COUNT(*) c FROM dsh_archive'),
              mem2: c("SELECT COUNT(*) c FROM dsh_memory2 WHERE tier = 'long'"),
              tend: c("SELECT COUNT(*) c FROM dsh_tendency WHERE status = 'active'"),
              bound: c("SELECT COUNT(*) c FROM dsh_boundary WHERE status = 'active'"),
              people: c('SELECT COUNT(*) c FROM dsh_person'),
            }
          }, {})
          return '全文索引 ' + info.msg + ' / 档案 ' + info.arc + ' / 长期记忆 ' + info.mem2 + ' / 倾向 ' + info.tend + ' / 界限 ' + info.bound + ' / 认得的人 ' + info.people
        })
      } catch (e) {}
    }

    // ---------------------------------------------------------------- 注入
    if (cfg.enableInject) {
      ctx.on('chatluna/before-chat', async (conversation, messages, options) => {
        try {
          const said = String(globalThis.__dshLastSaid || '')
          if (!said) return
          const gate = memGate(said)
          const facts = []
          if (gate.need) {
            const r = withDb((db) => {
              init(db)
              const out = []
              for (const kw of extractKeywords(said).slice(0, 6)) {
                if (out.length >= 2) break
                for (const h of keywordSearch(db, kw, 2, globalThis.__dshIsGroup ? 'group' : 'private')) {
                  if (Date.now() - Number(h.createdAt || 0) < 2 * 3600 * 1000) continue
                  const d = new Date(Number(h.createdAt))
                  const when = d.getMonth() + 1 + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
                  out.push(when + ' ' + (h.role === 'human' ? '他说过' : '你说过') + '「' + String(h.text).slice(0, 44) + '」')
                  if (out.length >= 2) break
                }
              }
              for (const kw of extractKeywords(said).slice(0, 4)) {
                if (out.length >= 3) break
                for (const m of mem2Recall(db, kw, 1, globalThis.__dshIsGroup ? 'group' : 'private')) {
                  out.push('你记下过「' + String(m.content).slice(0, 34) + '」' + (m.meaning ? '（当时你写：它让你' + String(m.meaning).slice(0, 30) + '）' : ''))
                  mem2Hit(db, m.id)
                  break
                }
              }
              return out
            }, [])
            facts.push(...(r || []))
          }
          const { SystemMessage } = require('@langchain/core/messages')
          const pushSys = (t) => messages.push(new SystemMessage(t))
          if (facts.length) {
            pushSys('（旧事，不是他现在说的：' + facts.join('；') + '。要提就用自己的话提，别照念。）')
          }
          const extra = withDb((db) => {
            init(db)
            const out = []
            const t = tendList(db, 4)
            if (t.length) out.push('（这些不是设定，是你这些日子自己攒出来的：' + t.map((x) => x.text).join('') + '。它们可以不作数。）')
            const b = boundaryHit(db, said)
            if (b.length) out.push('（上次这类话他说过"过了"：' + b.map((x) => '「' + String(x.herText).slice(0, 24) + '」').join('、') + '。这次换不换说法，你自己定。）')
            return out
          }, [])
          for (const line of extra || []) pushSys(line)
        } catch (e) {}
      })
    }

    // ---------------------------------------------------------------- 定时
    if (cfg.enableTimers) {
      const t1 = setInterval(async () => {
        let db
        try {
          db = open()
          init(db)
          const r = await indexBatch(db, 200)
          if (r.text || r.archive) log("索引", JSON.stringify(r))
        } catch (e) { log("索引失败:", e && e.message) } finally { try { db && db.close() } catch (e) {} }
      }, cfg.indexIntervalMs)
      const t2 = setInterval(() => withDb((db) => { init(db); const n = buildArchive(db); if (n) log('档案 +' + n) }, null), cfg.archiveIntervalMs)
      const t3 = setInterval(() => withDb((db) => { init(db); const r = tendExtract(db); if (r.made || r.retired) log('倾向 +' + r.made + ' / -' + r.retired) }, null), cfg.tendencyIntervalMs)
      const t4 = setInterval(() => withDb((db) => { init(db); const n = boundaryDecay(db); if (n) log('界限淡出 ' + n) }, null), cfg.boundaryIntervalMs)
      const t5 = setInterval(() => withDb((db) => { init(db); const a = mem2Promote(db); const b = mem2Decay(db); if (a || b) log('晋级 ' + a + ' / 清理 ' + b) }, null), 60 * 60 * 1000)
      for (const t of [t1, t2, t3, t4, t5]) { try { t.unref && t.unref() } catch (e) {} }
    }

    // ---------------------------------------------------------------- 启动
    withDb((db) => { init(db); log('表已就绪（' + cfg.dbPath + '）') }, null)

    // 暴露给宿主用（可选）
    ctx.dshMemory = {
      init, indexText, indexBatch, keywordSearch, archiveSearch, buildArchive,
      mem2Add, mem2Recall, mem2Hit, mem2Promote, mem2Decay,
      tendExtract, tendList, boundaryNote, boundaryHit, boundaryDecay,
      personSeen, personById, personContext,
      memGate, extractKeywords, vecSearch, sceneOf, cleanSaid,
    }
  },
}
