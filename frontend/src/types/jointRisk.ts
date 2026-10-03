/**
 * 橙色联合风险
 * 日涨幅达到 0.5 m 且存在未处置（未闭环）浸润线预警时，把预警合并成一张橙色联合风险单；
 * 水位回落或该坝体出现新的正常浸润线观测后自动解除。
 */

export type JointRiskState = '生效中' | '已解除'

/** 解除原因 */
export type JointRiskReason = '水位回落' | '新观测正常' | '手动解除'

export interface JointRisk {
  id: string
  damId: string
  /** 触发时的日涨幅（m/d） */
  risePerDay: number
  /** 触发测次时间 */
  triggerTime: string
  /** 触发时水位（m） */
  triggerLevelM: number
  /** 合并进来的未处置浸润线预警 id */
  alarmIds: string[]
  state: JointRiskState
  releasedAt: number | null
  releaseReason: JointRiskReason | null
  createdAt: number
  updatedAt: number
}

export const JOINT_RISK_STATES: JointRiskState[] = ['生效中', '已解除']

/** 日涨幅阈值：≥ 0.5 m/d 即具备水位侧条件 */
export const JOINT_RISE_LIMIT_M = 0.5
