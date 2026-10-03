/**
 * 水文站库水位回传包
 * 汛期库水位晚于现场浸润线观测数小时回传；回传包只提供水位事实，
 * 监测台按「坝体 + 测次时间」与现场观测对账。
 */

/** 包内单条测次（一条水位事实） */
export interface WaterPacketItem {
  /** 测次序号：按测次时间升序编号，是断点续传的对账顺序 */
  seq: number
  /** 测次时间，归一化为 YYYY-MM-DD（与库水位台账按日对账） */
  measureTime: string
  /** 库水位读数（m） */
  waterLevelM: number
  /** 单位：正常应为 m；不一致的测次留待确认 */
  unit: string
  /** 报文版本号；同测次两个版本时留待确认 */
  version?: string
}

/** 回传包整体状态 */
export type WaterPacketStatus = '待对账' | '对账中' | '已完成'

/** 单条测次的对账状态 */
export type PacketItemStatus = '待对账' | '已确认' | '待确认' | '已作废'

export interface WaterPacket {
  id: string
  /** 回传包号（幂等键）：同一包号再送不重复开单 */
  packetNo: string
  damId: string
  /** 水文站回传时间 YYYY-MM-DD HH:mm */
  receivedAt: string
  status: WaterPacketStatus
  /** 最后确认的测次序号：对账中断后从该测次之后继续 */
  lastConfirmedSeq: number
  /** 测次明细（按 measureTime 升序） */
  items: WaterPacketItem[]
  /** 与 items 同序的对账状态 */
  itemStatus: PacketItemStatus[]
  /** 与 items 同序的待确认 / 作废原因 */
  itemIssues: string[]
  createdAt: number
  updatedAt: number
}

export const WATER_PACKET_STATUSES: WaterPacketStatus[] = ['待对账', '对账中', '已完成']
export const PACKET_ITEM_STATUSES: PacketItemStatus[] = ['待对账', '已确认', '待确认', '已作废']

/** 接收回传包的入参（粘贴的报文 JSON 结构） */
export interface WaterPacketInput {
  packetNo: string
  damId?: string
  /** 无 damId 时按坝体名称匹配 */
  damName?: string
  receivedAt?: string
  items: Array<{
    seq?: number
    measureTime: string
    waterLevelM: number
    unit?: string
    version?: string
  }>
}

export interface WaterPacketDraft {
  packetNo: string
  damId: string
  receivedAt: string
  rawText: string
}

export const EMPTY_WATER_PACKET_DRAFT: WaterPacketDraft = {
  packetNo: '',
  damId: '',
  receivedAt: '',
  rawText: ''
}

/** 回传包状态对应的标签颜色 */
export const PACKET_STATUS_COLOR: Record<WaterPacketStatus, string> = {
  待对账: 'default',
  对账中: 'blue',
  已完成: 'green'
}

export const PACKET_ITEM_STATUS_COLOR: Record<PacketItemStatus, string> = {
  待对账: 'blue',
  已确认: 'green',
  待确认: 'orange',
  已作废: 'default'
}
