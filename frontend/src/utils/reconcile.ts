/**
 * 库水位回传包对账 + 橙色联合风险引擎（纯函数 + IndexedDB 事务）
 *
 * 口径：
 * - 回传包只提供库水位事实，监测台管观测和处置，两边按「坝体 + 测次时间」对账。
 * - 断点续传：对账中断后从最后确认的测次（lastConfirmedSeq）之后继续。
 * - 幂等：同一包号再送不重复开单；同一测次水位事实重复确认不改写。
 * - 单位不一致、同测次两个版本 → 留在待确认处，观测和处置先不动。
 * - 日涨幅 ≥ 0.5 m/d 且有未闭环浸润线预警 → 合并为橙色联合风险；
 *   水位回落 0.5 m 或该预警测点新观测恢复正常 → 解除（不改写原预警与观测）。
 */
import {
  createId,
  db,
  type AlarmRow,
  type JointRiskRow,
  type ObservationRow,
  type PointRow,
  type PoolRow,
  type WaterPacketRow
} from '@/utils/db'
import type { Dam } from '@/types/dam'
import type {
  WaterPacket,
  WaterPacketInput,
  WaterPacketItem,
  PacketItemStatus
} from '@/types/waterPacket'
import {
  JOINT_RECEDING_LIMIT_M,
  JOINT_RISE_LIMIT_M,
  JOINT_RISK_LEVEL,
  type MergedAlarmSnapshot
} from '@/types/jointRisk'
import { alarmLevelOf, cumulativeOf, daysBetween, round } from '@/utils/threshold'

/** 库水位唯一允许的报送单位 */
export const WATER_LEVEL_UNIT = 'm'
const UNIT_ALIASES = new Set(['m', '米', 'M'])

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 当前时间，格式 YYYY-MM-DD HH:mm */
export function formatNowMinute(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
    date.getMinutes()
  )}`
}

/** 归一化测次时间为 YYYY-MM-DD；无法解析返回 null */
export function normalizeMeasureTime(raw: string): string | null {
  const text = String(raw ?? '').trim().replace(/[./]\s*/g, '-')
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!match) return null
  const date = `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`
  if (!Number.isFinite(Date.parse(`${date}T00:00:00`))) return null
  return date
}

export interface ParsedWaterPacket {
  packetNo: string
  damId: string
  receivedAt: string
  items: WaterPacketItem[]
}

/**
 * 解析并校验回传包报文：
 * 单位不一致 / 同测次多个版本在入库后标记（parse 只负责结构与归一化）。
 */
export function parseWaterPacket(input: WaterPacketInput, dams: Dam[]): ParsedWaterPacket {
  if (!input || typeof input !== 'object') throw new Error('报文格式不是 JSON 对象')
  const packetNo = String(input.packetNo ?? '').trim()
  if (!packetNo) throw new Error('缺少回传包号 packetNo')

  let damId = String(input.damId ?? '').trim()
  if (!damId) {
    const damName = String(input.damName ?? '').trim()
    const matched = dams.find((dam) => dam.name === damName)
    if (!matched) throw new Error(`无法按坝体名称「${damName}」匹配坝体，请补充 damId`)
    damId = matched.id
  } else if (!dams.some((dam) => dam.id === damId)) {
    throw new Error(`坝体 id「${damId}」不存在`)
  }

  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('回传包内没有任何测次 items')

  const normalized = input.items
    .map((item) => {
      const measureTime = normalizeMeasureTime(String(item?.measureTime ?? ''))
      const waterLevelM = Number(item?.waterLevelM)
      return {
        measureTime,
        waterLevelM: Number.isFinite(waterLevelM) ? waterLevelM : Number.NaN,
        unit: String(item?.unit ?? WATER_LEVEL_UNIT).trim() || WATER_LEVEL_UNIT,
        version: item?.version === undefined || item.version === null ? '' : String(item.version).trim()
      }
    })
    .sort((a, b) => {
      if (a.measureTime === b.measureTime) return 0
      if (a.measureTime === null) return 1
      if (b.measureTime === null) return -1
      return a.measureTime.localeCompare(b.measureTime)
    })

  const badTimeIndex = normalized.findIndex((item) => item.measureTime === null)
  if (badTimeIndex >= 0) throw new Error(`第 ${badTimeIndex + 1} 条测次时间无法解析`)
  const badLevelIndex = normalized.findIndex((item) => !Number.isFinite(item.waterLevelM))
  if (badLevelIndex >= 0) throw new Error(`第 ${badLevelIndex + 1} 条库水位读数不是数值`)

  const items: WaterPacketItem[] = normalized.map((item, index) => ({
    seq: index + 1,
    measureTime: item.measureTime as string,
    waterLevelM: round(item.waterLevelM, 3),
    unit: item.unit,
    version: item.version
  }))

  const receivedAt = String(input.receivedAt ?? '').trim() || formatNowMinute()
  return { packetNo, damId, receivedAt, items }
}

/** 初始测级状态：单位不一致留待确认；同测次多版本留待确认，完全重复去重作废 */
function initialItemStates(items: WaterPacketItem[]): { status: PacketItemStatus[]; issues: string[] } {
  const status: PacketItemStatus[] = items.map(() => '待对账')
  const issues: string[] = items.map(() => '')

  // 同测次分组
  const groups = new Map<string, number[]>()
  items.forEach((item, index) => {
    const list = groups.get(item.measureTime) ?? []
    list.push(index)
    groups.set(item.measureTime, list)
  })

  items.forEach((item, index) => {
    if (!UNIT_ALIASES.has(item.unit)) {
      status[index] = '待确认'
      issues[index] = `单位不一致（${item.unit}），库水位应以 ${WATER_LEVEL_UNIT} 报送`
    }
  })

  groups.forEach((indexes) => {
    if (indexes.length < 2) return
    const sameFact = indexes.every((i) => {
      const first = items[indexes[0]]
      const other = items[i]
      return other.waterLevelM === first.waterLevelM && other.unit === first.unit && other.version === first.version
    })
    if (sameFact) {
      // 完全重复：保留首条，其余作废（不阻断续传）
      indexes.slice(1).forEach((i) => {
        status[i] = '已作废'
        issues[i] = '同测次重复回传，去重保留首条'
      })
      return
    }
    const detail = indexes
      .map((i) => `${items[i].version || '未标注版本'}=${items[i].waterLevelM.toFixed(2)} ${items[i].unit}`)
      .join(' / ')
    indexes.forEach((i) => {
      status[i] = '待确认'
      issues[i] = `同测次两个版本：${detail}`
    })
  })

  return { status, issues }
}

export interface IngestResult {
  packet: WaterPacketRow
  /** true 表示包号已存在，本次未重复开单 */
  resent: boolean
}

/**
 * 接收回传包：按包号幂等。新包做初始校验后立即尝试对账；
 * 已存在的包只触发一次断点续传，不重复开单。
 */
export async function ingestWaterPacket(input: WaterPacketInput, dams: Dam[]): Promise<IngestResult> {
  const parsed = parseWaterPacket(input, dams)
  const existing = await db.waterpackets.where('packetNo').equals(parsed.packetNo).first()
  if (existing) {
    await runReconcile(existing.id)
    return { packet: existing, resent: true }
  }

  const { status, issues } = initialItemStates(parsed.items)
  const now = Date.now()
  const row: WaterPacketRow = {
    id: createId('wp'),
    packetNo: parsed.packetNo,
    damId: parsed.damId,
    receivedAt: parsed.receivedAt,
    status: '待对账',
    lastConfirmedSeq: 0,
    items: parsed.items,
    itemStatus: status,
    itemIssues: issues,
    createdAt: now,
    updatedAt: now,
    revision: 3
  }
  await db.waterpackets.put(row)
  await runReconcile(row.id)
  return { packet: (await db.waterpackets.get(row.id)) as WaterPacketRow, resent: false }
}

function derivePacketStatus(packet: WaterPacket): WaterPacket['status'] {
  const settled = packet.itemStatus.every((state) => state === '已确认' || state === '已作废')
  if (settled) return '已完成'
  if (packet.itemStatus.some((state) => state === '已确认' || state === '待确认')) return '对账中'
  return '待对账'
}

/** 已确认/已作废构成的连续前缀末尾序号（作废不阻断连续性） */
function contiguousConfirmedSeq(packet: WaterPacket): number {
  let last = 0
  for (let i = 0; i < packet.items.length; i += 1) {
    const state = packet.itemStatus[i]
    if (state === '已确认') last = packet.items[i].seq
    else if (state === '已作废') continue
    else break
  }
  return last
}

/**
 * 把一条确认过的水位事实合并进 pools：
 * 同日无记录则新建仅含水位的回传事实；同日已有回传事实则更新水位（人工改判）。
 */
async function mergePoolFact(damId: string, packetNo: string, item: WaterPacketItem): Promise<void> {
  const sameDay = await db.pools
    .where('damId')
    .equals(damId)
    .toArray()
    .then((rows) => rows.filter((row) => row.date === item.measureTime))
  const existing = sameDay[0]
  if (existing) {
    await db.pools.update(existing.id, {
      waterLevelM: item.waterLevelM,
      source: '回传包',
      packetNo,
      updatedAt: Date.now()
    })
    return
  }
  const now = Date.now()
  const poolRow: PoolRow = {
    id: createId('pl'),
    damId,
    date: item.measureTime,
    waterLevelM: item.waterLevelM,
    beachLengthM: null,
    freeboardM: null,
    source: '回传包',
    packetNo,
    createdAt: now,
    updatedAt: now,
    revision: 3
  }
  await db.pools.put(poolRow)
}

/**
 * 断点续传对账：从最后确认测次之后继续，遇到待确认测次即停住。
 * 只把确认过的水位事实合并进 pools；任何异常都不触碰观测与处置。
 */
export async function runReconcile(packetId: string): Promise<WaterPacketRow> {
  const packet = await db.waterpackets.get(packetId)
  if (!packet) throw new Error('回传包不存在')

  await db.transaction('rw', [db.waterpackets, db.pools], async () => {
    let touched = false
    for (let i = 0; i < packet.items.length; i += 1) {
      const state = packet.itemStatus[i]
      if (state === '已确认' || state === '已作废') continue
      if (state === '待确认') break

      const item = packet.items[i]
      const sameDay = await db.pools
        .where('damId')
        .equals(packet.damId)
        .toArray()
        .then((rows) => rows.filter((row) => row.date === item.measureTime))

      if (sameDay.length > 0) {
        const previous = sameDay[0]
        if (previous.source === '回传包' && previous.packetNo === packet.packetNo) {
          // 本包已写入过：幂等确认
          packet.itemStatus[i] = '已确认'
          packet.itemIssues[i] = ''
          touched = true
          continue
        }
        if (previous.waterLevelM !== item.waterLevelM) {
          // 与现场记录或别的回传包在同一测次上有两个版本：留待确认
          packet.itemStatus[i] = '待确认'
          packet.itemIssues[i] =
            `与${previous.source === '回传包' ? `回传包 ${previous.packetNo ?? ''}` : '现场登记'}同测次水位不一致：` +
            `既有 ${previous.waterLevelM.toFixed(2)} m / 本报 ${item.waterLevelM.toFixed(2)} m`
          touched = true
          break
        }
        // 两边水位事实一致：确认但不改写既有记录
        packet.itemStatus[i] = '已确认'
        packet.itemIssues[i] = ''
        touched = true
        continue
      }

      await mergePoolFact(packet.damId, packet.packetNo, item)
      packet.itemStatus[i] = '已确认'
      packet.itemIssues[i] = ''
      touched = true
    }

    if (touched) {
      packet.lastConfirmedSeq = contiguousConfirmedSeq(packet)
      packet.status = derivePacketStatus(packet)
      packet.updatedAt = Date.now()
      await db.waterpackets.put(packet)
    }
  })

  const next = (await db.waterpackets.get(packetId)) as WaterPacketRow
  await evaluateJointRisks()
  return next
}

export type AdjudicateDecision = 'confirm' | 'discard'

/**
 * 人工裁决待确认测次：
 * - confirm 需同时给出采用的库水位与单位（默认本报值、单位 m）；随后从断点继续。
 * - discard 作废该测次，不写入水位事实；随后从断点继续。
 */
export async function adjudicatePacketItem(
  packetId: string,
  seq: number,
  decision: AdjudicateDecision,
  adopted?: { waterLevelM: number; unit: string }
): Promise<WaterPacketRow> {
  const packet = await db.waterpackets.get(packetId)
  if (!packet) throw new Error('回传包不存在')
  const index = packet.items.findIndex((item) => item.seq === seq)
  if (index < 0) throw new Error('测次不存在')
  if (packet.itemStatus[index] !== '待确认') throw new Error('该测次不是待确认状态')

  if (decision === 'confirm') {
    const waterLevelM = Number(adopted?.waterLevelM)
    if (!Number.isFinite(waterLevelM)) throw new Error('请填写采用的库水位读数')
    if (String(adopted?.unit ?? '').trim() !== WATER_LEVEL_UNIT) {
      throw new Error(`单位须先统一为 ${WATER_LEVEL_UNIT} 后才能确认`)
    }
    const adoptedItem: WaterPacketItem = { ...packet.items[index], waterLevelM: round(waterLevelM, 3), unit: WATER_LEVEL_UNIT }
    packet.items[index] = adoptedItem
    packet.itemStatus[index] = '已确认'
    packet.itemIssues[index] = ''

    // 人工确认即视为该测次水位事实被采纳：合并进 pools（与正常对账同一口径）
    await db.transaction('rw', [db.waterpackets, db.pools], async () => {
      await db.waterpackets.put(packet)
      await mergePoolFact(packet.damId, packet.packetNo, adoptedItem)
    })
  } else {
    packet.itemStatus[index] = '已作废'
    packet.itemIssues[index] = `${packet.itemIssues[index] || '测次异常'}；人工作废，不入水位事实`
  }

  packet.lastConfirmedSeq = contiguousConfirmedSeq(packet)
  packet.status = derivePacketStatus(packet)
  packet.updatedAt = Date.now()
  await db.waterpackets.put(packet)
  return runReconcile(packetId)
}

/** 计算某日相对上一水位事实的日涨幅（m/d）；无前序事实返回 0 */
export function dailyRiseAt(facts: Array<{ date: string; waterLevelM: number }>, index: number): number {
  if (index <= 0) return 0
  const current = facts[index]
  const previous = facts[index - 1]
  return round((current.waterLevelM - previous.waterLevelM) / daysBetween(previous.date, current.date), 3)
}

export function buildRiskKey(damId: string, triggerDate: string): string {
  return `${damId}@${triggerDate}`
}

export interface JointRiskEvaluation {
  created: JointRiskRow[]
  released: JointRiskRow[]
}

/**
 * 全量复算橙色联合风险（幂等）：
 * - 任一测次日涨幅 ≥ 0.5 m/d 且该坝存在未闭环浸润线预警 → 按 damId@date 开单；
 * - 已生效风险：最新库水位较触发水位回落 ≥ 0.5 m，或被合并预警测点
 *   在预警触发日之后有恢复正常的新观测 → 解除。
 */
export async function evaluateJointRisks(): Promise<JointRiskEvaluation> {
  const [dams, pools, alarms, points, observations, packets, risks] = await Promise.all([
    db.dams.toArray(),
    db.pools.toArray(),
    db.alarms.toArray(),
    db.points.toArray(),
    db.observations.toArray(),
    db.waterpackets.toArray(),
    db.jointrisks.toArray()
  ])

  const pointById = new Map(points.map((point) => [point.id, point]))
  const creates: JointRiskRow[] = []
  const releases: Array<{ id: string; reason: '水位回落' | '新观测正常'; date: string }> = []

  for (const dam of dams) {
    const facts = pools
      .filter((pool) => pool.damId === dam.id)
      .sort((a, b) => a.date.localeCompare(b.date))
    const latest = facts.length > 0 ? facts[facts.length - 1] : null
    const openSeepageAlarms = alarms.filter(
      (alarm) => alarm.damId === dam.id && alarm.state !== '已闭环' && pointById.get(alarm.pointId)?.type === '浸润线'
    )
    const damRisks = risks.filter((risk) => risk.damId === dam.id)

    // 解除判定
    for (const risk of damRisks.filter((item) => item.state === '生效中')) {
      if (latest && latest.waterLevelM <= risk.triggerWaterLevelM - JOINT_RECEDING_LIMIT_M) {
        releases.push({ id: risk.id, reason: '水位回落', date: latest.date })
        continue
      }
      const allNormal = risk.mergedAlarms.every((snapshot) =>
        hasNormalObservationAfter(snapshot.pointId, snapshot.triggerDate, observations, pointById)
      )
      if (allNormal && risk.mergedAlarms.length > 0) {
        releases.push({ id: risk.id, reason: '新观测正常', date: latest?.date ?? risk.triggerDate })
      }
    }

    // 触发判定（同一坝体同一触发日只开一张；已解除的旧单也不重开）
    facts.forEach((fact, index) => {
      const rise = dailyRiseAt(facts, index)
      if (rise < JOINT_RISE_LIMIT_M) return
      const riskKey = buildRiskKey(dam.id, fact.date)
      if (damRisks.some((risk) => risk.riskKey === riskKey)) return
      if (openSeepageAlarms.length === 0) return
      const source = findPacketSource(packets, dam.id, fact.date, fact.waterLevelM)
      const now = Date.now()
      creates.push({
        id: createId('jr'),
        damId: dam.id,
        riskKey,
        triggerDate: fact.date,
        level: JOINT_RISK_LEVEL,
        dailyRise: rise,
        triggerWaterLevelM: fact.waterLevelM,
        mergedAlarms: openSeepageAlarms.map((alarm) => buildSnapshot(alarm, pointById.get(alarm.pointId))),
        sourcePacketNo: source.packetNo,
        sourceSeq: source.seq,
        state: '生效中',
        releaseReason: '',
        releaseDate: '',
        handler: '',
        measure: '',
        createdAt: now,
        updatedAt: now,
        revision: 3
      })
      // 同一次评估里新开出的单也要占键，避免同日多条事实重复
      damRisks.push(creates[creates.length - 1])
    })
  }

  if (creates.length === 0 && releases.length === 0) return { created: [], released: [] }

  await db.transaction('rw', db.jointrisks, async () => {
    if (creates.length > 0) await db.jointrisks.bulkPut(creates)
    for (const release of releases) {
      await db.jointrisks.update(release.id, {
        state: '已解除',
        releaseReason: release.reason,
        releaseDate: release.date,
        updatedAt: Date.now()
      })
    }
  })
  const releasedRows = releases
    .map((release) => risks.find((risk) => risk.id === release.id))
    .filter((risk): risk is JointRiskRow => Boolean(risk))
  return { created: creates, released: releasedRows }
}

function buildSnapshot(alarm: AlarmRow, point?: PointRow): MergedAlarmSnapshot {
  return {
    alarmId: alarm.id,
    pointId: alarm.pointId,
    pointCode: point ? point.code : '测点已删除',
    triggerDate: alarm.triggerDate,
    level: alarm.level,
    measure: alarm.measure
  }
}

/** 找到确认该水位事实的回传包与测次序号（现场登记则为空） */
function findPacketSource(
  packets: WaterPacketRow[],
  damId: string,
  date: string,
  waterLevelM: number
): { packetNo: string; seq: number } {
  for (const packet of packets) {
    if (packet.damId !== damId) continue
    const index = packet.items.findIndex(
      (item, i) => item.measureTime === date && item.waterLevelM === waterLevelM && packet.itemStatus[i] === '已确认'
    )
    if (index >= 0) return { packetNo: packet.packetNo, seq: packet.items[index].seq }
  }
  return { packetNo: '', seq: 0 }
}

/** 预警触发日之后是否存在恢复正常（低于蓝级）的新观测 */
function hasNormalObservationAfter(
  pointId: string,
  triggerDate: string,
  observations: ObservationRow[],
  pointById: Map<string, PointRow>
): boolean {
  const point = pointById.get(pointId)
  if (!point) return false
  const later = observations
    .filter((observation) => observation.pointId === pointId && observation.date > triggerDate)
    .sort((a, b) => b.date.localeCompare(a.date))
  if (later.length === 0) return false
  const latest = later[0]
  return alarmLevelOf(cumulativeOf(latest.reading, point.initialValue), point.threshold) === null
}

/** 人工解除橙色联合风险（不改动被合并的预警单） */
export async function releaseJointRiskManually(
  riskId: string,
  handler: string,
  measure: string,
  releaseDate: string
): Promise<void> {
  await db.jointrisks.update(riskId, {
    state: '已解除',
    releaseReason: '人工解除',
    releaseDate,
    handler: handler.trim() || '未署名',
    measure: measure.trim() || '现场研判后人工解除',
    updatedAt: Date.now()
  })
}

/** 记录联合风险处置动作（保持风险生效中，直至满足自动解除口径） */
export async function recordJointRiskHandling(riskId: string, handler: string, measure: string): Promise<void> {
  await db.jointrisks.update(riskId, {
    handler: handler.trim(),
    measure: measure.trim(),
    updatedAt: Date.now()
  })
}
