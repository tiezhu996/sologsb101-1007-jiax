/**
 * /reconcile 库水位回传包对账
 * 水文站回传包提供库水位事实，监测台按「坝体 + 测次时间」对账：
 * - 日涨幅 ≥ 0.5 m/d 且存在未闭环浸润线预警 → 合并橙色联合风险；
 * - 水位回落 0.5 m 或新观测恢复正常 → 自动解除；
 * - 对账中断后从最后确认测次继续，同包再送幂等；
 * - 单位不一致 / 同测次两个版本留在待确认处，观测和处置先不动。
 * 消费 WaterPacket、JointRisk、Pool、Dam；复用 FilterBar / StatBadge / EmptyPanel / JointRiskTag。
 */
import { useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Collapse,
  DatePicker,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag
} from 'antd'
import type { TableColumnsType } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import JointRiskTag from '@/components/common/JointRiskTag'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { useReconcileStore } from '@/stores/reconcileStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type PoolRow, type WaterPacketRow } from '@/utils/db'
import { JOINT_RECEDING_LIMIT_M, JOINT_RISE_LIMIT_M, type JointRisk } from '@/types/jointRisk'
import {
  PACKET_ITEM_STATUS_COLOR,
  PACKET_STATUS_COLOR,
  WATER_PACKET_STATUSES,
  type PacketItemStatus,
  type WaterPacketInput,
  type WaterPacketItem
} from '@/types/waterPacket'
import { WATER_LEVEL_UNIT, dailyRiseAt } from '@/utils/reconcile'

interface AdjudicateTarget {
  packetId: string
  packetNo: string
  item: WaterPacketItem
  issue: string
}

interface PacketTableRow extends WaterPacketRow {
  pendingCount: number
  confirmedCount: number
  invalidCount: number
}

/** 示例报文：日涨幅触发（对 A 坝 2024-06-10 之后继续上涨） */
const SAMPLE_RISING: WaterPacketInput = {
  packetNo: `wp-demo-rise-${dayjs().format('MMDDHHmm')}`,
  damId: 'dam-1',
  receivedAt: '',
  items: [
    { measureTime: '2024-06-13', waterLevelM: 711.7, unit: 'm', version: 'v1' },
    { measureTime: '2024-06-14', waterLevelM: 712.1, unit: 'm', version: 'v1' },
    { measureTime: '2024-06-15', waterLevelM: 712.62, unit: 'm', version: 'v1' }
  ]
}

/** 示例报文：单位不一致 + 同测次两个版本（B 坝，异常留待确认） */
const SAMPLE_DIRTY: WaterPacketInput = {
  packetNo: `wp-demo-dirty-${dayjs().format('MMDDHHmm')}`,
  damId: 'dam-2',
  receivedAt: '',
  items: [
    { measureTime: '2024-06-12', waterLevelM: 644.0, unit: 'm', version: 'v1' },
    { measureTime: '2024-06-13', waterLevelM: 644.3, unit: 'cm', version: 'v1' },
    { measureTime: '2024-06-14', waterLevelM: 644.6, unit: 'm', version: 'v1' },
    { measureTime: '2024-06-14', waterLevelM: 644.9, unit: 'm', version: 'v2' }
  ]
}

export default function ReconcileBoard() {
  const { message } = AntdApp.useApp()
  const damStore = useDamStore()
  const reconcileStore = useReconcileStore()
  const poolTable = useIdbTable<PoolRow>(db.pools, { sortByUpdatedAt: false })

  const [ingestOpen, setIngestOpen] = useState(false)
  const [ingestText, setIngestText] = useState('')
  const [ingestPacketNo, setIngestPacketNo] = useState('')
  const [ingestDamId, setIngestDamId] = useState('')
  const [ingestReceiving, setIngestReceiving] = useState(false)

  const [target, setTarget] = useState<AdjudicateTarget | null>(null)
  const [decision, setDecision] = useState<'confirm' | 'discard'>('confirm')
  const [adoptedLevel, setAdoptedLevel] = useState<number>(0)
  const [adoptedUnit, setAdoptedUnit] = useState<string>(WATER_LEVEL_UNIT)

  const [releaseTarget, setReleaseTarget] = useState<JointRisk | null>(null)
  const [releaseDate, setReleaseDate] = useState<Dayjs | null>(dayjs())
  const [releaseHandler, setReleaseHandler] = useState('')
  const [releaseMeasure, setReleaseMeasure] = useState('')

  const [keyword, setKeyword] = useState('')
  const [damId, setDamId] = useState('')

  const damName = (id: string): string => damStore.dams.find((dam) => dam.id === id)?.name ?? '—'

  const filterSelects = useMemo(
    () => [
      {
        key: 'damId',
        label: '坝体',
        multiple: false as const,
        options: damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))
      },
      {
        key: 'statuses',
        label: '对账状态',
        options: WATER_PACKET_STATUSES.map((item) => ({ label: item, value: item }))
      }
    ],
    [damStore.dams]
  )
  const [statuses, setStatuses] = useState<string[]>([])
  const model: FilterModel = { keyword, damId, statuses }
  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    setDamId(typeof next.damId === 'string' ? next.damId : '')
    setStatuses(Array.isArray(next.statuses) ? next.statuses.map(String) : [])
  }

  const packetRows: PacketTableRow[] = reconcileStore.packets
    .map((packet) => ({
      ...packet,
      pendingCount: packet.itemStatus.filter((state) => state === '待确认').length,
      confirmedCount: packet.itemStatus.filter((state) => state === '已确认').length,
      invalidCount: packet.itemStatus.filter((state) => state === '已作废').length
    }))
    .filter((packet) => {
      if (damId && packet.damId !== damId) return false
      if (statuses.length > 0 && !statuses.includes(packet.status)) return false
      const text = keyword.trim().toLowerCase()
      if (text.length === 0) return true
      return packet.packetNo.toLowerCase().includes(text) || damName(packet.damId).toLowerCase().includes(text)
    })

  const activeRisks = reconcileStore.risks.filter((risk) => risk.state === '生效中')
  const releasedRisks = reconcileStore.risks.filter((risk) => risk.state === '已解除')
  const pendingPackets = reconcileStore.packets.filter((packet) => packet.status !== '已完成').length
  const pendingItems = reconcileStore.packets.reduce(
    (sum, packet) => sum + packet.itemStatus.filter((state) => state === '待确认').length,
    0
  )

  const openIngest = (sample?: WaterPacketInput): void => {
    setIngestDamId(damId || damStore.dams[0]?.id || '')
    if (sample) {
      const filled = { ...sample, packetNo: sample.packetNo, damId: sample.damId || ingestDamId || damStore.dams[0]?.id }
      setIngestPacketNo(filled.packetNo)
      setIngestDamId(filled.damId)
      setIngestText(JSON.stringify(filled, null, 2))
    } else {
      setIngestPacketNo('')
      setIngestText('')
    }
    setIngestOpen(true)
  }

  const submitIngest = async (): Promise<void> => {
    let parsed: WaterPacketInput
    try {
      parsed = JSON.parse(ingestText) as WaterPacketInput
    } catch {
      message.error('报文不是合法 JSON，请检查后重送')
      return
    }
    if (ingestPacketNo.trim()) parsed.packetNo = ingestPacketNo.trim()
    if (ingestDamId) parsed.damId = ingestDamId
    setIngestReceiving(true)
    try {
      const result = await reconcileStore.ingest(parsed, damStore.dams)
      if (result.resent) {
        message.warning(`回传包 ${result.packet.packetNo} 已存在，未重复开单；已从最后确认测次续对`)
      } else {
        message.success(
          `回传包 ${result.packet.packetNo} 已接收并对账：确认 ${result.packet.itemStatus.filter((s) => s === '已确认').length} 测次，待确认 ${result.packet.itemStatus.filter((s) => s === '待确认').length} 测次`
        )
      }
      setIngestOpen(false)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '回传包接收失败')
    } finally {
      setIngestReceiving(false)
    }
  }

  const resume = async (packet: WaterPacketRow): Promise<void> => {
    const next = await reconcileStore.resume(packet.id)
    message.success(
      next.status === '已完成'
        ? `包 ${next.packetNo} 已对账完成`
        : `已从第 ${next.lastConfirmedSeq} 测次之后续对，当前停在待确认处`
    )
  }

  const openAdjudicate = (packetId: string, packetNo: string, index: number): void => {
    const packet = reconcileStore.packets.find((item) => item.id === packetId)
    if (!packet) return
    setTarget({ packetId, packetNo, item: packet.items[index], issue: packet.itemIssues[index] ?? '' })
    setDecision('confirm')
    setAdoptedLevel(packet.items[index].waterLevelM)
    setAdoptedUnit(packet.items[index].unit || WATER_LEVEL_UNIT)
  }

  const submitAdjudicate = async (): Promise<void> => {
    if (!target) return
    try {
      const next = await reconcileStore.adjudicate(
        target.packetId,
        target.item.seq,
        decision,
        decision === 'confirm' ? { waterLevelM: adoptedLevel, unit: adoptedUnit.trim() } : undefined
      )
      message.success(decision === 'confirm' ? '测次已按采用值确认，并从断点继续对账' : '测次已作废，对账从断点继续')
      setTarget(null)
      if (next.status === '已完成') message.success(`包 ${next.packetNo} 已对账完成`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '裁决失败')
    }
  }

  const submitRelease = async (): Promise<void> => {
    if (!releaseTarget || !releaseDate) return
    await reconcileStore.releaseManually(
      releaseTarget.id,
      releaseHandler,
      releaseMeasure,
      releaseDate.format('YYYY-MM-DD')
    )
    message.success('橙色联合风险已人工解除（原浸润线预警单未改动）')
    setReleaseTarget(null)
    setReleaseHandler('')
    setReleaseMeasure('')
  }

  const dailyRiseMap = useMemo(() => {
    const map = new Map<string, { date: string; rise: number }[]>()
    damStore.dams.forEach((dam) => {
      const facts = poolTable.rows
        .filter((pool) => pool.damId === dam.id)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((pool) => ({ date: pool.date, waterLevelM: pool.waterLevelM }))
      map.set(
        dam.id,
        facts.map((fact, index) => ({ date: fact.date, rise: dailyRiseAt(facts, index) }))
      )
    })
    return map
  }, [damStore.dams, poolTable.rows])

  const packetColumns: TableColumnsType<PacketTableRow> = [
    { title: '回传包号', dataIndex: 'packetNo', width: 170 },
    { title: '坝体', width: 150, render: (_v, record) => damName(record.damId) },
    { title: '回传时间', dataIndex: 'receivedAt', width: 150 },
    {
      title: '对账状态',
      dataIndex: 'status',
      width: 110,
      render: (value: string) => <Tag color={PACKET_STATUS_COLOR[value as keyof typeof PACKET_STATUS_COLOR]}>{value}</Tag>
    },
    {
      title: '测次进度',
      width: 210,
      render: (_v, record) => (
        <Space size={4} wrap>
          <Tag color="green">确认 {record.confirmedCount}</Tag>
          <Tag color="orange">待确认 {record.pendingCount}</Tag>
          <Tag>作废 {record.invalidCount}</Tag>
          <span className="muted">断点 seq={record.lastConfirmedSeq}</span>
        </Space>
      )
    },
    {
      title: '操作',
      width: 150,
      render: (_v, record) => (
        <Space size={4}>
          <Button type="link" size="small" disabled={record.status === '已完成'} onClick={() => resume(record)}>
            从断点续对
          </Button>
          <Popconfirm title="重放该包不会重复开单，确认？" onConfirm={() => resume(record)}>
            <Button type="link" size="small">
              重放
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const itemColumns = (packet: WaterPacketRow): TableColumnsType<WaterPacketItem> => [
    { title: '测次', dataIndex: 'seq', width: 60 },
    { title: '测次时间', dataIndex: 'measureTime', width: 120 },
    {
      title: '库水位',
      width: 150,
      render: (_v, record) => `${record.waterLevelM.toFixed(2)} ${record.unit || WATER_LEVEL_UNIT}`
    },
    { title: '版本', dataIndex: 'version', width: 80, render: (value?: string) => value || '—' },
    {
      title: '状态',
      width: 100,
      render: (_v, _record, index) => {
        const state = packet.itemStatus[index] as PacketItemStatus
        return <Tag color={PACKET_ITEM_STATUS_COLOR[state]}>{state}</Tag>
      }
    },
    {
      title: '说明',
      render: (_v, _record, index) => {
        const issue = packet.itemIssues[index]
        const rise = (dailyRiseMap.get(packet.damId) ?? []).find((item) => item.date === packet.items[index].measureTime)
        return (
          <Space direction="vertical" size={2}>
            {issue ? <span style={{ color: '#b03a2e' }}>{issue}</span> : <span className="muted">水位事实正常</span>}
            {rise ? (
              <span className="muted">
                日涨幅 {rise.rise.toFixed(2)} m/d
                {rise.rise >= JOINT_RISE_LIMIT_M ? <Tag color="orange" style={{ marginLeft: 6 }}>≥ {JOINT_RISE_LIMIT_M} 触发联合风险</Tag> : null}
              </span>
            ) : null}
          </Space>
        )
      }
    },
    {
      title: '裁决',
      width: 110,
      render: (_v, _record, index) =>
        packet.itemStatus[index] === '待确认' ? (
          <Button type="link" size="small" onClick={() => openAdjudicate(packet.id, packet.packetNo, index)}>
            去确认
          </Button>
        ) : (
          <span className="muted">—</span>
        )
    }
  ]

  const riskColumns: TableColumnsType<JointRisk> = [
    { title: '坝体', width: 150, render: (_v, record) => damName(record.damId) },
    { title: '触发日期', dataIndex: 'triggerDate', width: 110 },
    {
      title: '状态',
      width: 170,
      render: (_v, record) => <JointRiskTag state={record.state} size="small" />
    },
    {
      title: '日涨幅 / 触发水位',
      width: 180,
      render: (_v, record) => `${record.dailyRise.toFixed(2)} m/d · ${record.triggerWaterLevelM.toFixed(2)} m`
    },
    {
      title: '合并的未处置浸润线预警',
      render: (_v, record) => (
        <Space direction="vertical" size={2}>
          {record.mergedAlarms.map((snapshot) => (
            <span key={snapshot.alarmId}>
              <Tag color="orange">{snapshot.level}色</Tag>
              {snapshot.pointCode}（{snapshot.triggerDate}）
              {snapshot.measure ? <span className="muted"> · {snapshot.measure}</span> : null}
            </span>
          ))}
        </Space>
      )
    },
    { title: '来源包', dataIndex: 'sourcePacketNo', width: 160, render: (value: string, record) => value || `现场水位 ${record.triggerDate}` },
    {
      title: '解除',
      width: 220,
      render: (_v, record) =>
        record.state === '生效中' ? (
          <Space direction="vertical" size={2}>
            <span className="muted">
              自动解除：回落 ≥ {JOINT_RECEDING_LIMIT_M} m 或新观测正常
            </span>
            <Button type="link" size="small" onClick={() => { setReleaseTarget(record); setReleaseDate(dayjs()) }}>
              人工解除
            </Button>
          </Space>
        ) : (
          <span className="muted">
            {record.releaseReason}
            {record.releaseDate ? ` · ${record.releaseDate}` : ''}
          </span>
        )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">库水位回传包对账与联合风险</h2>
          <p className="page-head__desc">
            回传包只提供水位事实，监测台按坝体与测次时间对账。日涨幅 ≥ {JOINT_RISE_LIMIT_M} m 且浸润线预警未处置时合并橙色联合风险；
            水位回落 {JOINT_RECEDING_LIMIT_M} m 或新观测正常后自动解除。对账中断从最后确认测次续对，同包再送不重复开单。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={() => openIngest(SAMPLE_DIRTY)}>载入异常示例包</Button>
          <Button onClick={() => openIngest(SAMPLE_RISING)}>载入涨水示例包</Button>
          <Button type="primary" onClick={() => openIngest()}>
            接收回传包
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="回传包" value={reconcileStore.packets.length} suffix="个" tone="primary" />
        <StatBadge label="未对完" value={pendingPackets} suffix="个" tone="info" />
        <StatBadge label="待确认测次" value={pendingItems} suffix="条" tone="warning" />
        <StatBadge label="生效中联合风险" value={activeRisks.length} suffix="张" tone="danger" hint={`已解除 ${releasedRisks.length} 张`} />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            橙色联合风险（生效 {activeRisks.length} / 已解除 {releasedRisks.length}）
          </h3>
        </div>
        {reconcileStore.risks.length === 0 ? (
          <EmptyPanel
            title="暂无联合风险"
            description={`库水位日涨幅未达 ${JOINT_RISE_LIMIT_M} m 或不存在未处置的浸润线预警。`}
            compact
          />
        ) : (
          <Table<JointRisk>
            rowKey="id"
            size="small"
            bordered
            dataSource={reconcileStore.risks}
            columns={riskColumns}
            pagination={false}
            scroll={{ x: 1100 }}
          />
        )}
      </div>

      <FilterBar model={model} selects={filterSelects} keywordPlaceholder="搜索包号 / 坝体" onModelChange={onModelChange} />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            回传包对账（{packetRows.length} / {reconcileStore.packets.length}）
          </h3>
          <span className="muted">单位不一致或同测次两个版本的测次停在待确认处，观测与处置不改动</span>
        </div>
        {reconcileStore.packets.length === 0 ? (
          <EmptyPanel
            title="还没有回传包"
            description="接收水文站晚到的库水位回传包，系统按坝体与测次时间自动对账。"
            actionText="接收回传包"
            onAction={() => openIngest()}
            compact
          />
        ) : (
          <Table<PacketTableRow>
            rowKey="id"
            size="small"
            bordered
            dataSource={packetRows}
            columns={packetColumns}
            pagination={false}
            expandable={{
              expandedRowRender: (record) => (
                <Table<WaterPacketItem>
                  rowKey="seq"
                  size="small"
                  columns={itemColumns(record)}
                  dataSource={record.items}
                  pagination={false}
                />
              )
            }}
          />
        )}
      </div>

      <Modal
        open={ingestOpen}
        title="接收库水位回传包"
        onCancel={() => setIngestOpen(false)}
        onOk={submitIngest}
        confirmLoading={ingestReceiving}
        okText="接收并对账"
        cancelText="取消"
        width={720}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space wrap size={12}>
            <div>
              <span style={{ fontSize: 13, color: '#6b7a8d' }}>坝体　</span>
              <Select
                style={{ width: 200 }}
                value={ingestDamId || undefined}
                placeholder="选择坝体"
                options={damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))}
                onChange={(value: string) => setIngestDamId(value)}
              />
            </div>
            <div>
              <span style={{ fontSize: 13, color: '#6b7a8d' }}>包号覆盖　</span>
              <Input
                style={{ width: 220 }}
                placeholder="留空则使用报文 packetNo"
                value={ingestPacketNo}
                onChange={(event) => setIngestPacketNo(event.target.value)}
              />
            </div>
          </Space>
          <Input.TextArea
            rows={13}
            placeholder='粘贴回传报文 JSON，如 {"packetNo":"wp-...","damId":"dam-1","items":[{"measureTime":"2024-06-14","waterLevelM":712.62,"unit":"m","version":"v1"}]}'
            value={ingestText}
            onChange={(event) => setIngestText(event.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Collapse
            ghost
            items={[
              {
                key: 'rule',
                label: '对账口径',
                children: (
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="幂等">同一 packetNo 再送不重复开单，只从最后确认测次续对</Descriptions.Item>
                    <Descriptions.Item label="断点续传">中断重开后从 lastConfirmedSeq 之后继续</Descriptions.Item>
                    <Descriptions.Item label="待确认">单位非 m、或同测次两个版本 → 停住，不改观测和处置</Descriptions.Item>
                    <Descriptions.Item label="联合风险">日涨幅 ≥ {JOINT_RISE_LIMIT_M} m/d 且浸润线预警未闭环 → 橙色单</Descriptions.Item>
                  </Descriptions>
                )
              }
            ]}
          />
        </Space>
      </Modal>

      <Modal
        open={Boolean(target)}
        title={target ? `测次裁决：${target.packetNo} #${target.item.seq}` : ''}
        onCancel={() => setTarget(null)}
        onOk={submitAdjudicate}
        okText="提交裁决并续对"
        cancelText="取消"
        destroyOnClose
      >
        {target ? (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="测次时间">{target.item.measureTime}</Descriptions.Item>
              <Descriptions.Item label="报文读数">
                {target.item.waterLevelM.toFixed(2)} {target.item.unit || WATER_LEVEL_UNIT}
              </Descriptions.Item>
              <Descriptions.Item label="版本">{target.item.version || '未标注'}</Descriptions.Item>
              <Descriptions.Item label="待确认原因">
                <span style={{ color: '#b03a2e' }}>{target.issue}</span>
              </Descriptions.Item>
            </Descriptions>
            <Select
              style={{ width: '100%' }}
              value={decision}
              onChange={(value: 'confirm' | 'discard') => setDecision(value)}
              options={[
                { label: '确认采用（统一单位为 m 后入水位事实，并从断点继续）', value: 'confirm' },
                { label: '作废该测次（不写入水位事实，并从断点继续）', value: 'discard' }
              ]}
            />
            {decision === 'confirm' ? (
              <Space size={8}>
                <span style={{ fontSize: 13, color: '#6b7a8d' }}>采用库水位</span>
                <InputNumber
                  step={0.01}
                  value={adoptedLevel}
                  onChange={(value) => setAdoptedLevel(Number(value))}
                />
                <span style={{ fontSize: 13, color: '#6b7a8d' }}>单位</span>
                <Input
                  style={{ width: 80 }}
                  value={adoptedUnit}
                  onChange={(event) => setAdoptedUnit(event.target.value)}
                  status={adoptedUnit.trim() !== WATER_LEVEL_UNIT ? 'error' : undefined}
                />
                {adoptedUnit.trim() !== WATER_LEVEL_UNIT ? (
                  <span style={{ color: '#b03a2e', fontSize: 12 }}>须改为 {WATER_LEVEL_UNIT} 才能确认</span>
                ) : null}
              </Space>
            ) : null}
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(releaseTarget)}
        title="人工解除橙色联合风险"
        onCancel={() => setReleaseTarget(null)}
        onOk={submitRelease}
        okText="确认解除"
        cancelText="取消"
        destroyOnClose
      >
        {releaseTarget ? (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <p className="muted" style={{ margin: 0 }}>
              解除只作用于联合风险单，被合并的浸润线预警（{releaseTarget.mergedAlarms.map((item) => item.pointCode).join('、')}）
              与其观测、处置记录保持不动。
            </p>
            <Space size={8}>
              <span style={{ fontSize: 13, color: '#6b7a8d' }}>解除日期</span>
              <DatePicker value={releaseDate} onChange={(value) => setReleaseDate(value)} allowClear={false} />
            </Space>
            <Input placeholder="处置人，如 王丽" value={releaseHandler} onChange={(event) => setReleaseHandler(event.target.value)} />
            <Input.TextArea
              rows={3}
              placeholder="解除依据 / 现场研判结论"
              value={releaseMeasure}
              onChange={(event) => setReleaseMeasure(event.target.value)}
            />
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}
