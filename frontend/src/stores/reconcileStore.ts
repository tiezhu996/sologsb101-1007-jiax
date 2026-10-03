/**
 * 回传包对账与橙色联合风险状态（Zustand）
 * - 订阅 waterpackets / jointrisks 回流；
 * - pools / observations / alarms 变化后防抖复算联合风险
 *   （新观测正常自动解除），计算幂等、无变化不写库，不产生循环。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, type JointRiskRow, type WaterPacketRow } from '@/utils/db'
import {
  adjudicatePacketItem,
  evaluateJointRisks,
  ingestWaterPacket,
  recordJointRiskHandling,
  releaseJointRiskManually,
  runReconcile,
  type AdjudicateDecision,
  type IngestResult
} from '@/utils/reconcile'
import type { WaterPacketInput } from '@/types/waterPacket'
import type { Dam } from '@/types/dam'

interface ReconcileState {
  packets: WaterPacketRow[]
  risks: JointRiskRow[]
  ready: boolean
  /** 立即复算（对账、裁决后调用） */
  reevaluateNow: () => Promise<void>
  /** 防抖复算（订阅数据变化时调用） */
  reevaluate: () => void
  ingest: (input: WaterPacketInput, dams: Dam[]) => Promise<IngestResult>
  resume: (packetId: string) => Promise<WaterPacketRow>
  adjudicate: (
    packetId: string,
    seq: number,
    decision: AdjudicateDecision,
    adopted?: { waterLevelM: number; unit: string }
  ) => Promise<WaterPacketRow>
  releaseManually: (riskId: string, handler: string, measure: string, releaseDate: string) => Promise<void>
  recordHandling: (riskId: string, handler: string, measure: string) => Promise<void>
  activeRisksOfDam: (damId: string) => JointRiskRow[]
}

let reevaluateTimer: ReturnType<typeof setTimeout> | null = null
let reevaluateRunning = false
/** 本次会话是否已做过「重开自动续对」（只跑一次） */
let autoResumeDone = false

async function safeEvaluate(): Promise<void> {
  if (reevaluateRunning) return
  reevaluateRunning = true
  try {
    await evaluateJointRisks()
  } catch (error) {
    console.error('联合风险复算失败', error)
  } finally {
    reevaluateRunning = false
  }
}

export const useReconcileStore = create<ReconcileState>((_set, get) => ({
  packets: [],
  risks: [],
  ready: false,

  async reevaluateNow() {
    await safeEvaluate()
  },

  reevaluate() {
    if (reevaluateTimer) clearTimeout(reevaluateTimer)
    reevaluateTimer = setTimeout(() => {
      void safeEvaluate()
    }, 300)
  },

  async ingest(input, dams) {
    return ingestWaterPacket(input, dams)
  },

  async resume(packetId) {
    return runReconcile(packetId)
  },

  async adjudicate(packetId, seq, decision, adopted) {
    return adjudicatePacketItem(packetId, seq, decision, adopted)
  },

  async releaseManually(riskId, handler, measure, releaseDate) {
    await releaseJointRiskManually(riskId, handler, measure, releaseDate)
  },

  async recordHandling(riskId, handler, measure) {
    await recordJointRiskHandling(riskId, handler, measure)
  },

  activeRisksOfDam(damId) {
    return get().risks.filter((risk) => risk.damId === damId && risk.state === '生效中')
  }
}))

liveQuery(async () =>
  (await db.waterpackets.toArray()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
).subscribe({
  next: (rows) => {
    useReconcileStore.setState({ packets: rows, ready: true })
    // 重开页面：未完成包自动从最后确认测次续对一次（幂等；遇到待确认仍停住）
    if (autoResumeDone) return
    autoResumeDone = true
    const unfinished = rows.filter((packet) => packet.status !== '已完成')
    if (unfinished.length === 0) return
    void (async () => {
      for (const packet of unfinished) {
        try {
          await runReconcile(packet.id)
        } catch (error) {
          console.error(`回传包 ${packet.packetNo} 自动续对失败`, error)
        }
      }
    })()
  },
  error: () => useReconcileStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.jointrisks.toArray()).sort((a, b) => {
    if (a.state !== b.state) return a.state === '生效中' ? -1 : 1
    return b.triggerDate.localeCompare(a.triggerDate)
  })
).subscribe({
  next: (rows) => useReconcileStore.setState({ risks: rows })
})

// 水位事实 / 现场观测 / 预警处置变化后，防抖复算联合风险（解除口径之一：新观测正常）
;[db.pools, db.observations, db.alarms].forEach((table) => {
  liveQuery(() => table.toCollection().primaryKeys()).subscribe({
    next: () => useReconcileStore.getState().reevaluate()
  })
})
