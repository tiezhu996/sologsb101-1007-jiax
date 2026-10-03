/**
 * 对账异常：单位不一致或同测次两个版本时，测次留在待确认处，观测与处置先不动。
 */
import type { ReconcileIssueCode } from '@/utils/reconcile'

export type ReconcileIssueState = '待确认' | '已处理'

export interface ReconcileIssue {
  id: string
  packetId: string
  packetNo: string
  damId: string
  /** 异常测次时间 YYYY-MM-DD HH:mm */
  time: string
  code: ReconcileIssueCode
  /** 现场/台账侧版本 */
  detail: string
  /** 回传包侧版本 */
  packetDetail: string
  state: ReconcileIssueState
  createdAt: number
  updatedAt: number
}

export const RECONCILE_ISSUE_STATES: ReconcileIssueState[] = ['待确认', '已处理']

export const RECONCILE_ISSUE_TEXT: Record<ReconcileIssueCode, string> = {
  DAM_NOT_FOUND: '坝体不存在',
  UNIT_MISMATCH: '单位不一致',
  DUPLICATE_VERSION: '同测次两个版本'
}
