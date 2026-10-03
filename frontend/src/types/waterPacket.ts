/**
 * 库水位回传包：水文站晚几小时回传的水位事实集合
 * 监测台按坝体、测次时间与现场观测/处置对账，回传包只提供水位事实，不直接改观测与处置。
 */

/** 回传包整体状态 */
export type PacketStatus = '待对账' | '对账中' | '已对账'

/** 包内单个测次（水位事实）的对账状态 */
export type ReadingStatus = '待对账' | '已确认' | '待确认'

/** 水位值允许的单位：回传包要求以米为单位，cm / mm 等一律留待确认，不做静默换算 */
export const WATER_LEVEL_UNITS = ['m'] as const
export type WaterLevelUnit = (typeof WATER_LEVEL_UNITS)[number]

export interface WaterLevelReadingDraft {
  /** 测次时间：YYYY-MM-DD HH:mm（水文站回传粒度到小时） */
  time: string
  damId: string
  /** 库水位高程 */
  level: number
  /** 回传单位，仅接受 'm' */
  unit: string
}

/** 外部投递的回传包原文 */
export interface WaterLevelPacketInput {
  /** 回传包唯一编号：同一包再送按该编号去重，不重复开单 */
  packetNo: string
  source?: string
  readings: WaterLevelReadingDraft[]
}

export interface WaterLevelPacket {
  id: string
  packetNo: string
  source: string
  status: PacketStatus
  /** 最后确认的测次时间；对账中断重开后从该测次的下一条继续 */
  lastConfirmedTime: string
  readings: WaterLevelReadingDraft[]
  createdAt: number
  updatedAt: number
}

export const PACKET_STATUSES: PacketStatus[] = ['待对账', '对账中', '已对账']
export const READING_STATUSES: ReadingStatus[] = ['待对账', '已确认', '待确认']

/** 测次时间格式 YYYY-MM-DD HH:mm */
export const READING_TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/

export function normalizeReadingTime(time: string): string {
  return time.trim().replace('T', ' ')
}

/** 取测次对应的台账日期 YYYY-MM-DD（与 Pool / Observation 按日对账） */
export function readingDateOf(time: string): string {
  return normalizeReadingTime(time).slice(0, 10)
}
