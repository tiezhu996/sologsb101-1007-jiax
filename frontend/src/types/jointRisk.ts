/**
 * 橙色联合风险
 * 库水位日涨幅 ≥ 0.5 m 且存在未处置的浸润线预警时，把水位事实与预警
 * 合并成一张橙色联合风险单；水位回落或新观测正常后解除。
 * 联合风险单独立于原预警单，解除不改写任何观测与处置。
 */
import type { AlarmLevel } from '@/types/alarm'

export type JointRiskState = '生效中' | '已解除'

/** 解除原因 */
export type JointRiskReleaseReason = '水位回落' | '新观测正常' | '人工解除' | ''

export interface MergedAlarmSnapshot {
  alarmId: string
  pointId: string
  pointCode: string
  triggerDate: string
  level: AlarmLevel
  measure: string
}

export interface JointRisk {
  id: string
  damId: string
  /** 幂等键：damId@triggerDate，同一坝体同一触发日只开一张 */
  riskKey: string
  /** 触发日期（水位测次日） */
  triggerDate: string
  level: AlarmLevel
  /** 触发时日涨幅（m/d） */
  dailyRise: number
  /** 触发时库水位（m） */
  triggerWaterLevelM: number
  /** 合并进来的未处置浸润线预警快照 */
  mergedAlarms: MergedAlarmSnapshot[]
  /** 造成本次合并的水位来源：回传包号 + 测次序号 */
  sourcePacketNo: string
  sourceSeq: number
  state: JointRiskState
  releaseReason: JointRiskReleaseReason
  releaseDate: string
  /** 处置记录（监测台记录处置动作） */
  handler: string
  measure: string
  createdAt: number
  updatedAt: number
}

export const JOINT_RISK_LEVEL: AlarmLevel = '橙'

export const JOINT_RISK_STATES: JointRiskState[] = ['生效中', '已解除']

/** 日涨幅触发阈值（m/d） */
export const JOINT_RISE_LIMIT_M = 0.5

/** 解除口径：相对触发水位回落幅度（m） */
export const JOINT_RECEDING_LIMIT_M = JOINT_RISE_LIMIT_M

export const JOINT_RISK_STATE_COLOR: Record<JointRiskState, string> = {
  生效中: 'orange',
  已解除: 'default'
}

export interface JointRiskDraft {
  damId: string
  handler: string
  measure: string
}

export const EMPTY_JOINT_RISK_DRAFT: JointRiskDraft = {
  damId: '',
  handler: '',
  measure: ''
}
