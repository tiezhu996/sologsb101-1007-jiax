/**
 * 回传对账状态（Zustand）
 *
 * 职责边界：
 * - 回传包只提供水位事实；确认后按确定性 id 写入 pools（source=回传确认），不改观测、不改处置。
 * - 同一 packetNo 再送直接拒收（不重复开单）。
 * - 单位不一致 / 同测次两个版本 → 记 ReconcileIssue，测次留在待确认处，确认流程跳过它。
 * - 对账中断重开从 packet.lastConfirmedTime 的下一测次继续。
 * - 确认后若日涨幅 ≥ 0.5 m/d 且有未处置浸润线预警，合并开橙色联合风险；
 *   订阅回流中按水位回落 / 新观测正常自动解除。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createId,
  db,
  packetFactId,
  type JointRiskRow,
  type PoolRow,
  type ReconcileIssueRow,
  type WaterPacketRow
} from '@/utils/db'
import type { WaterLevelPacket, WaterLevelPacketInput, WaterLevelReadingDraft } from '@/types/waterPacket'
import { normalizeReadingTime } from '@/types/waterPacket'
import type { ReconcileIssue } from '@/types/reconcileIssue'
import type { JointRisk } from '@/types/jointRisk'
import type { Alarm } from '@/types/alarm'
import type { Point } from '@/types/point'
import type { Observation } from '@/types/observation'
import type { Pool } from '@/types/pool'
import {
  evaluateJointRisk,
  latestRisePerDay,
  levelSeriesOf,
  openPhreaticAlarms,
  sameReadingKey,
  shouldOpenJointRisk,
  validateReading,
  type ReconcileIssueCode
} from '@/utils/reconcile'

/** 已登记坝体 id 缓存：投递 / 确认时校验回传坝体是否存在 */
let damIds = new Set<string>()
liveQuery(async () => (await db.dams.toArray()).map((dam) => dam.id)).subscribe({
  next: (ids) => {
    damIds = new Set(ids)
  }
})

export type ReadingState = '待对账' | '已确认' | '待确认'

export interface IngestResult {
  outcome: 'accepted' | 'duplicate' | 'invalid'
  packetId?: string
  errors: string[]
  blocked: number
}

export type ConfirmOutcome = 'confirmed' | 'blocked' | 'finished' | 'missing'

export interface ConfirmResult {
  outcome: ConfirmOutcome
  time?: string
  issueCode?: ReconcileIssueCode
  riskOpened?: boolean
  packetFinished?: boolean
}

interface ReconcileState {
  packets: WaterLevelPacket[]
  issues: ReconcileIssue[]
  risks: JointRisk[]
  pools: Pool[]
  points: Point[]
  observations: Observation[]
  alarms: Alarm[]
  ready: boolean
  ingestPacket: (input: WaterLevelPacketInput) => Promise<IngestResult>
  readingState: (packet: WaterLevelPacket, reading: WaterLevelReadingDraft) => ReadingState
  nextReading: (packet: WaterLevelPacket) => WaterLevelReadingDraft | null
  confirmReading: (packetId: string, time: string) => Promise<ConfirmResult>
  confirmNext: (packetId: string) => Promise<ConfirmResult>
  confirmAllAvailable: (packetId: string) => Promise<ConfirmResult[]>
  resolveIssue: (issueId: string) => Promise<void>
  releaseRisk: (riskId: string, reason: JointRisk['releaseReason']) => Promise<void>
  removePacket: (packetId: string) => Promise<void>
  openRiskCount: () => number
  pendingIssueCount: () => number
}

function sortReadings(readings: WaterLevelReadingDraft[]): WaterLevelReadingDraft[] {
  return [...readings].sort((a, b) => normalizeReadingTime(a.time).localeCompare(normalizeReadingTime(b.time)))
}

/** 该测次是否已被异常登记（不论是否已处理：错误版本不允许再进确认流） */
function issueExists(issues: ReconcileIssue[], packetId: string, reading: WaterLevelReadingDraft): boolean {
  return issues.some(
    (issue) => issue.packetId === packetId && sameReadingKey(issue, reading)
  )
}

function ledgerLevelAt(pools: Pool[], damId: string, time: string): number | null {
  const target = normalizeReadingTime(time)
  const hit = pools.find((pool) => pool.damId === damId && (pool.readingTime ?? `${pool.date} 00:00`) === target)
  return hit ? hit.waterLevelM : null
}

export const useReconcileStore = create<ReconcileState>((_set, get) => ({
  packets: [],
  issues: [],
  risks: [],
  pools: [],
  points: [],
  observations: [],
  alarms: [],
  ready: false,

  async ingestPacket(input) {
    const packetNo = String(input.packetNo ?? '').trim()
    const rawReadings = Array.isArray(input.readings) ? input.readings : []
    const errors: string[] = []
    if (!packetNo) errors.push('回传包缺少 packetNo 编号')
    if (rawReadings.length === 0) errors.push('回传包内没有任何测次')
    if (errors.length > 0) return { outcome: 'invalid', errors, blocked: 0 }

    // 同一包再送：按 packetNo 去重，不重复开单
    if (await db.waterPackets.where('packetNo').equals(packetNo).first()) {
      return { outcome: 'duplicate', errors: [`回传包 ${packetNo} 已接收，请勿重复投递`], blocked: 0 }
    }

    const readings = rawReadings.map((reading) => ({
      time: normalizeReadingTime(String(reading.time ?? '')),
      damId: String(reading.damId ?? ''),
      level: Number(reading.level),
      unit: String(reading.unit ?? '').trim()
    }))

    const badTime = readings.find((reading) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(reading.time))
    if (badTime) {
      return {
        outcome: 'invalid',
        errors: [`测次时间格式应为 YYYY-MM-DD HH:mm：${badTime.time || '（空）'}`],
        blocked: 0
      }
    }

    const now = Date.now()
    const packetId = createId('wp')
    const newIssues: ReconcileIssueRow[] = []
    const seenKeys = new Set<string>()
    let blocked = 0

    readings.forEach((reading) => {
      const key = `${reading.damId}@${reading.time}`
      const withinPacketDuplicate = seenKeys.has(key)
      seenKeys.add(key)
      const validation = withinPacketDuplicate
        ? {
            ok: false as const,
            code: 'DUPLICATE_VERSION' as const,
            detail: '同一回传包内出现两个同坝体同测次版本',
            packetDetail: `回传 ${reading.time} · ${reading.level} ${reading.unit}`
          }
        : validateReading(reading, damIds.has(reading.damId), ledgerLevelAt(get().pools, reading.damId, reading.time))
      if (!validation.ok && validation.code) {
        blocked += 1
        newIssues.push({
          id: createId('ri'),
          packetId,
          packetNo,
          damId: reading.damId,
          time: reading.time,
          code: validation.code,
          detail: validation.detail,
          packetDetail: validation.packetDetail,
          state: '待确认',
          createdAt: now,
          updatedAt: now,
          revision: 3
        })
      }
    })

    const packet: WaterPacketRow = {
      id: packetId,
      packetNo,
      source: String(input.source ?? '汛期水文站').trim() || '汛期水文站',
      status: '待对账',
      lastConfirmedTime: '',
      readings,
      createdAt: now,
      updatedAt: now,
      revision: 3
    }

    await db.transaction('rw', [db.waterPackets, db.reconcileIssues], async () => {
      await db.waterPackets.put(packet)
      if (newIssues.length > 0) await db.reconcileIssues.bulkPut(newIssues)
    })

    return { outcome: 'accepted', packetId, errors, blocked }
  },

  readingState(packet, reading) {
    const time = normalizeReadingTime(reading.time)
    if (packet.lastConfirmedTime && time <= packet.lastConfirmedTime) return '已确认'
    if (issueExists(get().issues, packet.id, reading)) return '待确认'
    return '待对账'
  },

  nextReading(packet) {
    return (
      sortReadings(packet.readings).find((reading) => get().readingState(packet, reading) === '待对账') ?? null
    )
  },

  async confirmReading(packetId, time) {
    const state = get()
    const packet = state.packets.find((item) => item.id === packetId)
    if (!packet) return { outcome: 'missing' }
    const target = normalizeReadingTime(time)
    const reading = packet.readings.find((item) => normalizeReadingTime(item.time) === target)
    if (!reading) return { outcome: 'missing' }
    if (issueExists(get().issues, packetId, reading)) {
      const known = get().issues.find((issue) => issue.packetId === packetId && sameReadingKey(issue, reading))
      return { outcome: 'blocked', time: target, issueCode: known?.code }
    }
    if (packet.lastConfirmedTime && target <= packet.lastConfirmedTime) return { outcome: 'confirmed', time: target }

    // 确认前再校验一次（台账可能已被别的包或人工录入改动）
    const validation = validateReading(reading, damIds.has(reading.damId), ledgerLevelAt(get().pools, reading.damId, target))
    if (!validation.ok && validation.code) {
      const now = Date.now()
      await db.reconcileIssues.put({
        id: createId('ri'),
        packetId,
        packetNo: packet.packetNo,
        damId: reading.damId,
        time: target,
        code: validation.code,
        detail: validation.detail,
        packetDetail: validation.packetDetail,
        state: '待确认',
        createdAt: now,
        updatedAt: now,
        revision: 3
      })
      return { outcome: 'blocked', time: target, issueCode: validation.code }
    }

    const now = Date.now()
    let riskOpened = false

    await db.transaction(
      'rw',
      [db.pools, db.waterPackets, db.jointRisks],
      async () => {
        // 确定性 id：同包同测次重放只覆盖同一行，不重复开单
        await db.pools.put({
          id: packetFactId(packet.packetNo, reading.damId, target),
          damId: reading.damId,
          date: target.slice(0, 10),
          waterLevelM: reading.level,
          beachLengthM: 0,
          freeboardM: 0,
          source: '回传确认',
          packetNo: packet.packetNo,
          readingTime: target,
          createdAt: now,
          updatedAt: now,
          revision: 3
        } satisfies PoolRow)

        const confirmedSoFar = sortReadings(packet.readings).filter((item) => normalizeReadingTime(item.time) <= target)
        const lastConfirmedTime = confirmedSoFar[confirmedSoFar.length - 1]
          ? normalizeReadingTime(confirmedSoFar[confirmedSoFar.length - 1].time)
          : target

        // 事务内重读，拿到包含本条事实在内的水位序列再判联合风险
        const [poolsNow, pointsNow, alarmsNow, risksNow] = await Promise.all([
          db.pools.toArray(),
          db.points.toArray(),
          db.alarms.toArray(),
          db.jointRisks.toArray()
        ])
        const decision = shouldOpenJointRisk({
          damId: reading.damId,
          pools: poolsNow,
          points: pointsNow,
          alarms: alarmsNow,
          activeRisks: risksNow
        })
        if (decision.open) {
          riskOpened = true
          await db.jointRisks.put({
            id: createId('jr'),
            damId: reading.damId,
            risePerDay: decision.rise,
            triggerTime: decision.time,
            triggerLevelM: decision.level,
            alarmIds: decision.merged.map((alarm) => alarm.id),
            state: '生效中',
            releasedAt: null,
            releaseReason: null,
            createdAt: now,
            updatedAt: now,
            revision: 3
          } satisfies JointRiskRow)
        }

        const refreshedIssues = await db.reconcileIssues.where('packetId').equals(packetId).toArray()
        const remaining = sortReadings(packet.readings).filter((item) => {
          const itemTime = normalizeReadingTime(item.time)
          if (itemTime <= lastConfirmedTime) return false
          return !refreshedIssues.some((issue) => sameReadingKey(issue, item))
        })
        await db.waterPackets.update(packetId, {
          lastConfirmedTime,
          status: remaining.length === 0 ? '已对账' : '对账中',
          updatedAt: now
        })
      }
    )

    const refreshedPacket = await db.waterPackets.get(packetId)
    return { outcome: 'confirmed', time: target, riskOpened, packetFinished: refreshedPacket?.status === '已对账' }
  },

  async confirmNext(packetId) {
    const packet = get().packets.find((item) => item.id === packetId)
    if (!packet) return { outcome: 'missing' }
    const next = get().nextReading(packet)
    if (!next) return { outcome: 'finished' }
    return get().confirmReading(packetId, next.time)
  },

  async confirmAllAvailable(packetId) {
    const results: ConfirmResult[] = []
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const result = await get().confirmNext(packetId)
      if (result.outcome === 'confirmed') {
        results.push(result)
        continue
      }
      if (result.outcome === 'blocked') {
        // 异常测次跳过，继续找后面的可确认测次
        results.push(result)
        const packet = get().packets.find((item) => item.id === packetId)
        if (!packet || !get().nextReading(packet)) break
        continue
      }
      break
    }
    return results
  },

  async resolveIssue(issueId) {
    await db.reconcileIssues.update(issueId, { state: '已处理', updatedAt: Date.now() })
  },

  async releaseRisk(riskId, reason) {
    await db.jointRisks.update(riskId, {
      state: '已解除',
      releaseReason: reason,
      releasedAt: Date.now(),
      updatedAt: Date.now()
    })
  },

  async removePacket(packetId) {
    await db.transaction('rw', [db.waterPackets, db.reconcileIssues], async () => {
      await db.reconcileIssues.where('packetId').equals(packetId).delete()
      await db.waterPackets.delete(packetId)
    })
  },

  openRiskCount() {
    return get().risks.filter((risk) => risk.state === '生效中').length
  },
  pendingIssueCount() {
    return get().issues.filter((issue) => issue.state === '待确认').length
  }
}))

/** dams 表通过模块级 liveQuery 缓存（damIds），避免 store 再维护一份坝体列表 */

/* ---------------- 数据回流：包 / 异常 / 风险 / 对账上下文 ---------------- */

liveQuery(() => db.waterPackets.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ packets: rows.sort((a, b) => b.updatedAt - a.updatedAt) })
})

liveQuery(() => db.reconcileIssues.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ issues: rows.sort((a, b) => b.updatedAt - a.updatedAt) })
})

liveQuery(() => db.jointRisks.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ risks: rows.sort((a, b) => b.updatedAt - a.updatedAt) })
})

liveQuery(() => db.pools.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ pools: rows })
})

liveQuery(() => db.points.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ points: rows })
})

liveQuery(() => db.observations.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ observations: rows })
})

liveQuery(() => db.alarms.toArray()).subscribe({
  next: (rows) => useReconcileStore.setState({ alarms: rows })
})

// 首屏 ready 标记
liveQuery(() => db.waterPackets.count()).subscribe({
  next: () => useReconcileStore.setState({ ready: true }),
  error: () => useReconcileStore.setState({ ready: true })
})

/**
 * 联合风险自动维护：
 * - 生效单在水位回落或新观测正常后解除；
 * - 新出现的未处置浸润线预警并入既有生效单。
 * 仅在确有变化时写入，订阅回流收敛后不再重复写。
 */
liveQuery(async () => {
  const [risks, pools, points, observations, alarms] = await Promise.all([
    db.jointRisks.toArray(),
    db.pools.toArray(),
    db.points.toArray(),
    db.observations.toArray(),
    db.alarms.toArray()
  ])
  const now = Date.now()
  const patches: Array<{ id: string; changes: Partial<JointRiskRow> }> = []
  risks.forEach((risk) => {
    const update = evaluateJointRisk(risk, { pools, points, observations, alarms, now })
    if (update) {
      patches.push({ id: risk.id, changes: { ...update, updatedAt: now } })
    } else if (risk.state === '生效中') {
      const merged = openPhreaticAlarms(risk.damId, points, alarms)
      const nextIds = merged.map((alarm) => alarm.id).sort()
      const prevIds = [...risk.alarmIds].sort()
      const joined = nextIds.filter((id) => !prevIds.includes(id))
      if (joined.length > 0) {
        patches.push({ id: risk.id, changes: { alarmIds: nextIds, updatedAt: now } })
      }
    }
  })
  for (const patch of patches) {
    // eslint-disable-next-line no-await-in-loop
    await db.jointRisks.update(patch.id, patch.changes)
  }
}).subscribe({ error: (error) => console.warn('联合风险维护失败', error) })

// 方便单测/页面查看最新涨幅（页面也可直接调纯函数）
export { latestRisePerDay, levelSeriesOf }
