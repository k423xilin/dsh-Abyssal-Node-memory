import { Context, Schema } from 'koishi'

declare module 'koishi' {
  interface Context {
    dshMemory: DshMemoryApi
  }
}

/** Everything the plugin exposes to the host on `ctx.dshMemory`. */
export interface DshMemoryApi {
  init(db: any): void
  indexText(db: any, limit?: number): number
  indexBatch(db: any, limit?: number): Promise<{ text: number; archive: number; mem: number }>
  keywordSearch(db: any, q: string, limit?: number, scene?: 'private' | 'group'): any[]
  archiveSearch(db: any, q: string, limit?: number, scene?: 'private' | 'group'): any[]
  buildArchive(db: any): number
  mem2Add(db: any, content: string, meaning: string, importance: number, sourceKey?: string, scene?: string): { id: number; tier: string; scene: string }
  mem2Recall(db: any, q: string, limit?: number, scene?: 'private' | 'group'): any[]
  mem2Hit(db: any, id: number): void
  mem2Promote(db: any): number
  mem2Decay(db: any): number
  tendExtract(db: any): { made: number; retired: number; types: number }
  tendList(db: any, n?: number): any[]
  boundaryNote(db: any, herText: string, hisText: string): { id: number; hits: number; kind: string }
  boundaryHit(db: any, text: string): any[]
  boundaryDecay(db: any): number
  personSeen(db: any, qq: string, name: string, isDirect: boolean, groupId?: string, lastMsg?: string): any
  personById(db: any, qq: string): any
  personContext(db: any, qq: string, name: string, isDirect: boolean, groupId?: string): string
  memGate(said: string): { need: boolean; score: number; why: string[] }
  extractKeywords(said: string): string[]
  vecSearch(db: any, kind: 'msg' | 'mem', query: string, topK?: number, scene?: string): Promise<any[]>
  sceneOf(raw: string, bindingKey?: string): 'private' | 'group' | 'unknown'
  cleanSaid(raw: string): string
}

export declare const name: 'dsh-abyssal-node-memory'

export interface Config {
  /** Path to the SQLite database (shared with Koishi). Default: data/koishi.db */
  dbPath?: string
  /** Owner's QQ number. Required — used to tell the owner apart from everyone else. */
  ownerQQ: string
  /** What the owner is called in injected lines. Default: owner */
  ownerName?: string
  /** Ollama embedding model. Default: bge-m3:latest */
  embedModel?: string
  /** Ollama base URL. Default: http://127.0.0.1:11434 */
  ollamaUrl?: string
  enableTools?: boolean
  enableInject?: boolean
  enableTimers?: boolean
  memGateThreshold?: number
  memMinImportance?: number
  indexIntervalMs?: number
  archiveIntervalMs?: number
  tendencyIntervalMs?: number
  boundaryIntervalMs?: number
  tendencyMinHits?: number
  tendencyMinRatio?: number
  boundaryPromoteAt?: number
  boundaryFadeDays?: number
  keepVectorDays?: number
  maxTextLen?: number
}

export declare const Config: Schema<Config>

export declare function apply(ctx: Context, config: Config): void
