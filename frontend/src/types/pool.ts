/** 库水位：与位移观测同日登记的库水位、干滩长度与安全超高 */
export interface Pool {
  id: string
  damId: string
  date: string
  /** 库水位（m） */
  waterLevelM: number
  /** 干滩长度（m） */
  beachLengthM: number
  /** 安全超高（m） */
  freeboardM: number
  /** 来源：现场人工录入或回传包对账确认；回传侧仅提供水位事实，干滩/超高为空 */
  source?: PoolSource
  /** 来源回传包编号（source 为回传时记录） */
  packetNo?: string
  /** 回传测次时间 YYYY-MM-DD HH:mm（粒度细于按日台账） */
  readingTime?: string
  createdAt: number
  updatedAt: number
}

export type PoolSource = '人工录入' | '回传确认'

export const POOL_SOURCES: PoolSource[] = ['人工录入', '回传确认']

/** 干滩长度达标下限（m），简化按等别统一取值 */
export const MIN_BEACH_LENGTH_M = 100
/** 安全超高达标下限（m） */
export const MIN_FREEBOARD_M = 1.5

export interface PoolDraft {
  damId: string
  date: string
  waterLevelM: number
  beachLengthM: number
  freeboardM: number
}

export const EMPTY_POOL_DRAFT: PoolDraft = {
  damId: '',
  date: '',
  waterLevelM: 0,
  beachLengthM: 0,
  freeboardM: 0
}

export interface PoolCheck {
  beachOk: boolean
  freeboardOk: boolean
  /** 回传水位事实不含干滩/超高，不参与达标校核 */
  factOnly: boolean
  text: string
}

/** 校核干滩长度与安全超高是否达标（回传侧只有水位事实时标记为不参与校核） */
export function checkPool(pool: Pick<Pool, 'beachLengthM' | 'freeboardM' | 'source'>): PoolCheck {
  if (pool.source === '回传确认') {
    return { beachOk: true, freeboardOk: true, factOnly: true, text: '回传水位事实（干滩/超高待现场补录）' }
  }
  const beachOk = pool.beachLengthM >= MIN_BEACH_LENGTH_M
  const freeboardOk = pool.freeboardM >= MIN_FREEBOARD_M
  if (beachOk && freeboardOk) return { beachOk, freeboardOk, factOnly: false, text: '干滩与超高均达标' }
  if (!beachOk && !freeboardOk) return { beachOk, freeboardOk, factOnly: false, text: '干滩不足且超高不够' }
  return { beachOk, freeboardOk, factOnly: false, text: beachOk ? '安全超高不足' : '干滩长度不足' }
}
