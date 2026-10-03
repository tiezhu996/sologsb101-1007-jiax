/** 库水位：与位移观测同日登记的库水位、干滩长度与安全超高 */

/** 记录来源：现场登记 / 水文站回传包对账确认（回传包只提供水位事实） */
export type PoolSource = '现场' | '回传包'

export interface Pool {
  id: string
  damId: string
  date: string
  /** 库水位（m） */
  waterLevelM: number
  /** 干滩长度（m）；回传包无此项时为 null，不参与达标校核 */
  beachLengthM: number | null
  /** 安全超高（m）；回传包无此项时为 null，不参与达标校核 */
  freeboardM: number | null
  source: PoolSource
  /** 对账确认来源回传包号（现场登记为空） */
  packetNo?: string
  createdAt: number
  updatedAt: number
}

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
  /** 是否缺现场干滩/超高数据（仅回传了水位事实） */
  incomplete: boolean
  text: string
}

/**
 * 校核干滩长度与安全超高是否达标。
 * 回传包仅提供水位事实时，干滩/超高为 null，不做达标判定（观测和处置先不动）。
 */
export function checkPool(pool: Pick<Pool, 'beachLengthM' | 'freeboardM'>): PoolCheck {
  const incomplete = pool.beachLengthM === null || pool.freeboardM === null
  if (incomplete) {
    return { beachOk: false, freeboardOk: false, incomplete: true, text: '仅回传水位，干滩/超高待现场补录' }
  }
  const beachOk = (pool.beachLengthM as number) >= MIN_BEACH_LENGTH_M
  const freeboardOk = (pool.freeboardM as number) >= MIN_FREEBOARD_M
  if (beachOk && freeboardOk) return { beachOk, freeboardOk, incomplete: false, text: '干滩与超高均达标' }
  if (!beachOk && !freeboardOk) return { beachOk, freeboardOk, incomplete: false, text: '干滩不足且超高不够' }
  return { beachOk, freeboardOk, incomplete: false, text: beachOk ? '安全超高不足' : '干滩长度不足' }
}
