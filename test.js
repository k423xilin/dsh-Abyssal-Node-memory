// Minimal smoke test — uses a throwaway database, no real data, no network.
// Run: node test.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const plugin = require('./index.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-'))
const dbPath = path.join(dir, 'test.db')
const db = new DatabaseSync(dbPath)
db.exec("CREATE TABLE IF NOT EXISTS chatluna_message (rowid INTEGER PRIMARY KEY, conversationId TEXT, role TEXT, text TEXT, content BLOB, createdAt INTEGER)")
db.exec("CREATE TABLE IF NOT EXISTS chatluna_conversation (id TEXT PRIMARY KEY, bindingKey TEXT)")
db.exec("CREATE TABLE IF NOT EXISTS living_memory_entry (id INTEGER PRIMARY KEY, content TEXT, summary TEXT, status TEXT, createdAt INTEGER)")
db.exec("INSERT INTO chatluna_conversation VALUES ('c1', 'personal:onebot:10000:direct:20000')")
db.exec("INSERT INTO chatluna_conversation VALUES ('c2', 'shared:onebot:10000:33333333')")
db.exec("INSERT INTO chatluna_message VALUES (1, 'c1', 'human', '上次说的那个码头，你还记得吗', NULL, 1)")
db.exec("INSERT INTO chatluna_message VALUES (2, 'c1', 'ai', '记得，傍晚的码头，你站在我旁边。', NULL, 2)")
db.exec("INSERT INTO chatluna_message VALUES (3, 'c2', 'human', '群里问一句，Assistant在吗', NULL, 3)")
db.close()

const ctx = { command: () => ({ action: () => {} }), on: () => {} }
plugin.apply(ctx, { dbPath, ownerQQ: '20000', enableTimers: false, enableInject: false })
const api = ctx.dshMemory

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

check('ctx.dshMemory exposed', !!api && typeof api.memGate === 'function')

const gate1 = api.memGate('在吗')
const gate2 = api.memGate('你还记得上次说的码头吗')
check('gate blocks small talk', gate1.need === false, 'score ' + gate1.score)
check('gate opens on past reference', gate2.need === true, 'score ' + gate2.score)

check('keywords extracted', api.extractKeywords('你还记得上次说的码头吗').length > 0)

const w = new DatabaseSync(dbPath)
const n = api.indexText(w, 100)
check('indexed messages', n >= 2, n + ' rows')

const hits = api.keywordSearch(w, '码头', 5, 'private')
check('private search finds private row', hits.length > 0, hits.length + ' hits')
const groupHits = api.keywordSearch(w, 'Assistant', 5, 'group')
check('group search finds group row', groupHits.length > 0, groupHits.length + ' hits')
const cross = api.keywordSearch(w, '码头', 5, 'group')
check('group search does not leak private row', cross.every((r) => String(r.text).includes('码头') === false) || cross.length === 0)

const add = api.mem2Add(w, '测试记忆：一起去过码头', '让我觉得有人陪', 4.5, '', 'private')
check('memory written', add.id > 0 && add.tier === 'long', 'tier ' + add.tier)
const recalled = api.mem2Recall(w, '码头', 3, 'private')
check('memory recalled in same scene', recalled.length > 0)
const recalledGroup = api.mem2Recall(w, '码头', 3, 'group')
check('memory hidden from other scene', recalledGroup.length === 0)

const p = api.personSeen(w, '20000', 'OwnerNick', true, '', 'hi')
check('owner recognised by QQ', p.relation === '主人' && p.isOwner === true)
const line = api.personContext(w, '20000', 'OwnerNick', true, '')
check('owner context mentions QQ', line.includes('20000'))
const strangerLine = api.personContext(w, '99999', 'FakeOwner', false, '33333333')
check('stranger flagged as not owner', strangerLine.includes('不是你') || strangerLine.includes('not'), strangerLine.slice(0, 40))

const b1 = api.boundaryNote(w, '那我以后不问了', '过了')
check('boundary recorded', b1.hits === 1 && b1.kind === 'soft')

w.close()
fs.rmSync(dir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(failed.length === 0 ? '  ALL PASS (' + results.length + ' checks)' : '  ' + failed.length + ' FAILED of ' + results.length)
process.exit(failed.length === 0 ? 0 : 1)
