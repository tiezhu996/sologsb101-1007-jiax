/**
 * 回传对账与橙色联合风险判定引擎（纯函数）
 *
 * 口径：
 * - 回传包仅提供水位事实；监测台管观测与处置；两边按坝体 + 测次时间对账。
 * - 单位只接受 m，不一致 / 同坝体同测次已有另一版本 → 留待确认，观测与处置先不动。
 * - 日涨幅 ≥ 0.5 m/d 且该坝体存在未处置（未闭环）浸润线预警 → 合并为橙色联合风险。
 * - 水位回落（最新水位低于触发水位）或出现新的正常浸润线观测 → 解除联合风险。
 */
import type { Alarm, AlarmState } from '@/types/alarm'
import type { JointRisk } from '@/types/jointRisk'
import type { Observation } from '@/types/observation'
import type { Point } from '@/types/point'
import type { Pool } from '@/types/pool'
import type { WaterLevelReadingDraft } from '@/types/waterPacket'
import { JOINT_RISE_LIMIT_M } from '@/types/jointRisk'
import { normalizeReadingTime, readingDateOf } from '@/types/waterPacket'
import { daysBetween, round } from '@/utils/threshold'

export type ReconcileIssueCode = 'DAM_NOT_FOUND' | 'UNIT_MISMATCH' | 'DUPLICATE_VERSION'

export interface ReadingValidation {
  ok: boolean
  code: ReconcileIssueCode | null
  detail: string
  packetDetail: string
}

/** 同一坝体同一测次时间（分钟粒度）视为同一测次 */
export function sameReadingKey(a: { damId: string; time: string }, b: { damId: string; time: string }): boolean {
  return a.damId === b.damId && normalizeReadingTime(a.time) === normalizeReadingTime(b.time)
}

/** 校验单条回传测次；ledger 为该坝体已确认的同测次台账水位（若有） */
export function validateReading(
  reading: WaterLevelReadingDraft,
  damExists: boolean,
  ledgerLevel: number | null
): ReadingValidation {
  const time = normalizeReadingTime(reading.time)
  const packetDetail = `回传 ${time} · ${reading.level} ${reading.unit}`
  if (!damExists) {
    return { ok: false, code: 'DAM_NOT_FOUND', detail: `台账无对应坝体（${reading.damId}）`, packetDetail }
  }
  if (reading.unit.trim() !== 'm') {
    return { ok: false, code: 'UNIT_MISMATCH', detail: `台账水位统一按 m 计，回传单位为 ${reading.unit}`, packetDetail }
  }
  if (!Number.isFinite(reading.level)) {
    return { ok: false, code: 'UNIT_MISMATCH', detail: '回传水位不是有效数值', packetDetail }
  }
  if (ledgerLevel !== null && round(ledgerLevel, 3) !== round(reading.level, 3)) {
    return {
      ok: false,
      code: 'DUPLICATE_VERSION',
      detail: `台账已确认 ${time} · ${ledgerLevel} m`,
      packetDetail
    }
  }
  return { ok: true, code: null, detail: '', packetDetail }
}

/* ============================ 水位序列与日涨幅 ============================ */

export interface LevelPoint {
  /** 分钟粒度时间戳，现场台账只到日的按 00:00 补齐 */
  time: string
  epoch: number
  level: number
  source: Pool['source']
}

export function toEpochMinute(time: string): number {
  const value = Date.parse(`${normalizeReadingTime(time).replace(' ', 'T')}:00`)
  return Number.isFinite(value) ? value : NaN
}

/** 某坝体的全部水位事实（现场台账按日 00:00 + 回传确认到小时），按时间升序 */
export function levelSeriesOf(damId: string, pools: Pool[]): LevelPoint[] {
  return pools
    .filter((pool) => pool.damId === damId)
    .map((pool) => ({
      time: pool.readingTime ?? `${pool.date} 00:00`,
      epoch: toEpochMinute(pool.readingTime ?? `${pool.date} 00:00`),
      level: pool.waterLevelM,
      source: pool.source ?? '人工录入'
    }))
    .filter((point) => Number.isFinite(point.epoch))
    .sort((a, b) => a.epoch - b.epoch)
}

/**
 * 最近一次日涨幅：取最新水位点与前一水位点，差值 ÷ 间隔天数（至少 1 天）。
 * 回传晚数小时的同日内两个测次，间隔不足一天也按 1 天计，避免放大涨幅。
 */
export function latestRisePerDay(series: LevelPoint[]): { rise: number; from: LevelPoint | null; to: LevelPoint | null } {
  if (series.length < 2) return { rise: 0, from: null, to: series[0] ?? null }
  const to = series[series.length - 1]
  const from = series[series.length - 2]
  const days = daysBetween(from.time.slice(0, 10), to.time.slice(0, 10))
  return { rise: round((to.level - from.level) / days, 3), from, to }
}

/* ============================ 浸润线预警与观测 ============================ */

/** 未处置浸润线预警：状态未闭环（待处置 / 处置中）即视为未处置 */
export function openPhreaticAlarms(damId: string, points: Point[], alarms: Alarm[]): Alarm[] {
  const pointIds = new Set(points.filter((point) => point.damId === damId && point.type === '浸润线').map((point) => point.id))
  const openStates: AlarmState[] = ['待处置', '处置中']
  return alarms.filter((alarm) => pointIds.has(alarm.pointId) && openStates.includes(alarm.state))
}

/**
 * 是否出现新的正常浸润线观测：
 * 触发日之后，该坝体任一浸润线测点有读数，且按单点阈值不再越限、当日无对应未闭环预警。
 */
export function hasNormalPhreaticObservation(
  damId: string,
  afterDate: string,
  points: Point[],
  observations: Observation[],
  alarms: Alarm[]
): boolean {
  const phreaticPoints = points.filter((point) => point.damId === damId && point.type === '浸润线')
  const pointMap = new Map(phreaticPoints.map((point) => [point.id, point]))
  const openAlarmByPointDate = new Set(
    alarms
      .filter((alarm) => alarm.state !== '已闭环')
      .map((alarm) => `${alarm.pointId}@${alarm.triggerDate}`)
  )
  return observations.some((observation) => {
    const point = pointMap.get(observation.pointId)
    if (!point || observation.date <= afterDate) return false
    if (openAlarmByPointDate.has(`${observation.pointId}@${observation.date}`)) return false
    return Math.abs(observation.cumulative) < point.threshold
  })
}

/* ============================ 联合风险维持 / 解除 ============================ */

export type JointRiskUpdate = Pick<JointRisk, 'id' | 'state' | 'releaseReason' | 'releasedAt'>

/**
 * 依据当前水位序列、浸润线预警与新观测，计算生效中联合风险的目标状态。
 * 返回 null 表示维持不变（用于订阅回流时避免重复写入）。
 */
export function evaluateJointRisk(
  risk: JointRisk,
  context: { pools: Pool[]; points: Point[]; observations: Observation[]; alarms: Alarm[]; now: number }
): JointRiskUpdate | null {
  if (risk.state !== '生效中') return null
  const series = levelSeriesOf(risk.damId, context.pools)
  const latest = series[series.length - 1]
  if (latest && round(latest.level, 3) < round(risk.triggerLevelM, 3)) {
    return { id: risk.id, state: '已解除', releaseReason: '水位回落', releasedAt: context.now }
  }
  if (hasNormalPhreaticObservation(risk.damId, readingDateOf(risk.triggerTime), context.points, context.observations, context.alarms)) {
    return { id: risk.id, state: '已解除', releaseReason: '新观测正常', releasedAt: context.now }
  }
  // 日涨幅仍达标但浸润线预警已全部闭环：风险事实消失，按新观测正常解除
  if (openPhreaticAlarms(risk.damId, context.points, context.alarms).length === 0) {
    return { id: risk.id, state: '已解除', releaseReason: '新观测正常', releasedAt: context.now }
  }
  return null
}

/** 是否具备发起橙色联合风险的条件：日涨幅达标且有未处置浸润线预警，且当前无生效单 */
export function shouldOpenJointRisk(params: {
  damId: string
  pools: Pool[]
  points: Point[]
  alarms: Alarm[]
  activeRisks: JointRisk[]
}): { open: boolean; rise: number; time: string; level: number; merged: Alarm[] } {
  const series = levelSeriesOf(params.damId, params.pools)
  const { rise, to } = latestRisePerDay(series)
  const merged = openPhreaticAlarms(params.damId, params.points, params.alarms)
  const alreadyActive = params.activeRisks.some((risk) => risk.damId === params.damId && risk.state === '生效中')
  return {
    open: rise >= JOINT_RISE_LIMIT_M && merged.length > 0 && !alreadyActive,
    rise,
    time: to ? to.time : '',
    level: to ? to.level : 0,
    merged
  }
}
