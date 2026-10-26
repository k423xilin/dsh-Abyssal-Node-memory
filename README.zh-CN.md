# dsh-Abyssal Node-memory · 记忆循环系统

给 [Koishi](https://koishi.chat) 机器人用的**长期记忆层**。

一个文件、一个 SQLite 数据库、不依赖云服务。只有向量化会调本机 Ollama，其余全是 SQL。

```
全文索引 · 会话档案 · 两层记忆 · 倾向 · 界限 · 按 QQ 号认人 · 记忆门
```

---

## 它解决什么问题

大模型本身不记事。所谓「机器人记得」，其实是两件事做对了：

1. **写**：会话还活着的时候，值得留的东西落到了磁盘；
2. **读**：下一次被重新拼进提示词的时候，那条东西递到了正确的位置。

这个插件只做这两件事，外加**不让它们互相污染**。它是从一个长期在跑的机器人身上抽出来的，
里面每一条设计决定都是踩过坑之后才定下的。

---

## 八层结构

| 层 | 表 | 作用 |
|---|---|---|
| 全文索引 | `dsh_msg_text` + `dsh_msg_fts` | 按词找原话（FTS5 trigram，中文可搜） |
| 会话档案 | `dsh_archive` | 一次谈话一条：标题 / 要点 / 消息数 |
| 两层记忆 | `dsh_memory2` | 短期池 + 长期库，带「意义」与重要度 |
| 倾向 | `dsh_tendency` | 同类事件够多 → 一条「它会怎么做」 |
| 界限 | `dsh_boundary` | 用户划过的线，第 3 次升级，14 天不犯淡出 |
| 认人 | `dsh_person` / `_name` / `_group` | **按 QQ 号认人**，昵称只是标签 |
| 记忆门 | 无表 | 一句话打分，够分才翻记忆 |
| 向量 | `dsh_vec` + Ollama `bge-m3` | 按意思召回（异步、可关） |

**私聊 / 群聊隔离**：`dsh_msg_text.scene`（`private` / `group` / `legacy`），
召回时只翻当前场景 —— 私聊里不会冒出群里的闲话，反之亦然。

---

## 装上

```bash
npm install koishi-plugin-dsh-abyssal-node-memory
```

```yaml
plugins:
  dsh-memory:
    dbPath: data/koishi.db
    ownerQQ: '你的QQ号'
```

**不用 npm 也行** —— 把 `index.js` 放进本地插件目录：

```js
app.plugin(require('./dsh-memory'), {
  dbPath: 'data/koishi.db',
  ownerQQ: '你的QQ号',
})
```

**要求**：Node 22+（用内置的 `node:sqlite`）、Koishi 4.18+。

向量可选：

```bash
ollama pull bge-m3
```

**没有 Ollama 也能用** —— 全文索引、档案、两层记忆、倾向、界限、认人全都走 SQLite。

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `data/koishi.db` | 数据库路径（与 Koishi 共用一个） |
| `ownerQQ` | — | **必填**，主人 QQ |
| `ownerName` | `owner` | 注入文案里怎么称呼他 |
| `embedModel` | `bge-m3:latest` | Ollama 嵌入模型 |
| `ollamaUrl` | `http://127.0.0.1:11434` | |
| `enableTools` | `true` | 注册 `dsh-memory.status` |
| `enableInject` | `true` | 每轮注入旧事 / 倾向 / 界限 / 认人 |
| `enableTimers` | `true` | 索引 / 档案 / 衰减 定时器 |
| `memGateThreshold` | `3` | 记忆门门槛，越大越少翻 |
| `memMinImportance` | `0.35` | 召回的最低重要度 |
| `indexIntervalMs` | `600000` | 索引补齐 |
| `archiveIntervalMs` | `86400000` | 会话归档 |
| `tendencyIntervalMs` | `86400000` | 倾向提取 |
| `boundaryIntervalMs` | `86400000` | 界限淡出 |
| `tendencyMinHits` | `3` | 同类事件最少次数 |
| `tendencyMinRatio` | `0.66` | 主导反应占比 |
| `boundaryPromoteAt` | `3` | 第几次升级成硬界限 |
| `boundaryFadeDays` | `14` | 多少天不犯就淡出 |
| `keepVectorDays` | `90` | 向量保留天数 |
| `maxTextLen` | `1200` | 单条入库上限 |

---

## 给宿主用的 API

全部挂在 `ctx.dshMemory`：

```js
ctx.dshMemory.memGate(文本)                       // { need, score, why }
ctx.dshMemory.extractKeywords(文本)
ctx.dshMemory.keywordSearch(db, '码头', 3, 'private')
ctx.dshMemory.archiveSearch(db, '画', 2, 'group')
ctx.dshMemory.mem2Add(db, 内容, 意义, 4.5)         // 4 分以上直接进长期
ctx.dshMemory.mem2Recall(db, '看海', 2, 'private')
ctx.dshMemory.tendList(db, 4)
ctx.dshMemory.boundaryNote(db, 它说的, 他说的)      // 记一次「过了」
ctx.dshMemory.boundaryHit(db, 他这句话)
ctx.dshMemory.personSeen(db, qq, 昵称, 是否私聊, 群号, 最后一句)
ctx.dshMemory.personById(db, qq)                  // 含昵称历史
ctx.dshMemory.personContext(db, qq, 昵称, 是否私聊, 群号)
ctx.dshMemory.vecSearch(db, 'msg', '关键词', 8, 'private')
ctx.dshMemory.indexBatch(db, 200)
```

**宿主只需要做三件事：**

```
① 每条消息：personSeen(...)，并把原文放到插件能读到的地方
② 每次调模型前：memGate() 判断要不要翻，然后 keywordSearch / mem2Recall
③ 每 10 分钟：indexBatch() 补索引
```

---

## 五个设计决定

**认人只看 QQ 号。** 昵称会改，也会有人冒充。有人把昵称改成主人的名字，照样认得出来。

**私聊和群聊不混。** `scene` 在入库时按会话标识判定；判不出来的标 `legacy`，
**不参与召回** —— 宁可少记，不许串台。

**简单的话不翻记忆。** 「在吗」「早」「晚安」直接回；「你还记得上次…」才翻。
打分：提旧事 +4、约定 +3、指代 +2、寒暄 −5。

**倾向不是设定。** 同类事件满 3 次、且某种反应占 66% 才成立；之后 3 次反向自动退休。

**界限要三次。** 前两次只记一笔，第三次才升级，14 天不犯淡出。

---

## 验证

```
dsh-memory.status
→ 索引 4878 / 档案 147 / 记忆 4 / 倾向 0 / 界限 2 / 认得的人 20
```

```
[记忆] 表已就绪（data/koishi.db）
[记忆] 索引 {"text":18,"archive":1,"mem":0}
```

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 检索返回 0 | 关键词只有 1 个字 | 至少 2 字；2 字走 LIKE，3 字以上走 FTS |
| 向量搜不到 | Ollama 没跑 | `ollama serve`，确认 11434 在听 |
| 记忆不增长 | `text_cursor` 卡住 | 删 `dsh_meta` 里那行，重建索引 |
| 私聊翻不到群聊旧事 | 这是设计 | 想放开就改调用处的场景判断 |
| 老库缺列 | 结构没升级 | `init()` 里有 `ALTER TABLE ADD COLUMN`，跑一次即可 |

---

## 许可

MIT。随便用、随便改、随便卖。**唯一的要求：别把 `boundary` 表（用户划过的线）当训练数据。**

---

[English README](README.md)
