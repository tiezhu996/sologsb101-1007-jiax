/**
 * /reconcile 汛期库水位回传对账
 *
 * - 回传包提供水位事实，监测台管观测与处置，两边按坝体、测次时间对账；
 * - 中断重开从最后确认的测次继续；同一包再送（同 packetNo）不重复开单；
 * - 单位不一致 / 同测次两个版本 → 留在待确认处，观测与处置先不动；
 * - 日涨幅 ≥ 0.5 m/d 且有未处置浸润线预警 → 合并为橙色联合风险；
 *   水位回落或新观测正常后自动解除。
 */
import { useMemo, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Collapse,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Timeline,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useDamStore } from '@/stores/damStore'
import { usePointStore } from '@/stores/pointStore'
import {
  useReconcileStore,
  type ConfirmResult,
  type ReadingState
} from '@/stores/reconcileStore'
import { JOINT_RISE_LIMIT_M } from '@/types/jointRisk'
import { PACKET_STATUSES, type WaterLevelPacket, type WaterLevelPacketInput, type WaterLevelReadingDraft } from '@/types/waterPacket'
import { normalizeReadingTime } from '@/types/waterPacket'
import { RECONCILE_ISSUE_TEXT } from '@/types/reconcileIssue'
import { levelSeriesOf, latestRisePerDay } from '@/utils/reconcile'

/** 投递样例：覆盖 正常 / 单位不一致 / 同测次两版本 */
const SAMPLE_PACKETS: Array<{ key: string; label: string; payload: WaterLevelPacketInput }> = [
  {
    key: 'normal',
    label: '样例① 正常包（含日涨幅达标测次）',
    payload: {
      packetNo: 'PK-DEMO-NORMAL',
      source: '汛期水文站',
      readings: [
        { time: '2024-06-13 08:00', damId: 'dam-1', level: 711.9, unit: 'm' },
        { time: '2024-06-13 12:00', damId: 'dam-1', level: 712.4, unit: 'm' }
      ]
    }
  },
  {
    key: 'unit',
    label: '样例② 单位不一致（cm）',
    payload: {
      packetNo: 'PK-DEMO-UNIT',
      source: '汛期水文站',
      readings: [{ time: '2024-06-13 08:00', damId: 'dam-2', level: 64390, unit: 'cm' }]
    }
  },
  {
    key: 'dup',
    label: '样例③ 同测次两个版本',
    payload: {
      packetNo: 'PK-DEMO-DUP',
      source: '汛期水文站',
      readings: [
        { time: '2024-06-13 08:00', damId: 'dam-1', level: 711.5, unit: 'm' },
        { time: '2024-06-13 08:00', damId: 'dam-1', level: 711.7, unit: 'm' }
      ]
    }
  }
]

const PACKET_STATUS_COLOR: Record<WaterLevelPacket['status'], string> = {
  待对账: 'default',
  对账中: 'processing',
  已对账: 'success'
}

const READING_STATE_COLOR: Record<ReadingState, string> = {
  待对账: 'orange',
  已确认: 'green',
  待确认: 'red'
}

export default function ReconcileBoard() {
  const { message, modal } = AntdApp.useApp()
  const damStore = useDamStore()
  const pointStore = usePointStore()
  const reconcile = useReconcileStore()

  const [keyword, setKeyword] = useState('')
  const [damId, setDamId] = useState('')
  const [packetStatus, setPacketStatus] = useState<string[]>([])
  const [ingestOpen, setIngestOpen] = useState(false)
  const [packetJson, setPacketJson] = useState('')

  const damName = (id: string): string => damStore.dams.find((dam) => dam.id === id)?.name ?? `未知坝体(${id})`

  const filterSelects = useMemo(
    () => [
      {
        key: 'damId',
        label: '坝体',
        multiple: false,
        options: damStore.dams.map((dam) => ({ label: dam.name, value: dam.id }))
      },
      { key: 'packetStatus', label: '回传包状态', options: PACKET_STATUSES.map((item) => ({ label: item, value: item })) }
    ],
    [damStore.dams]
  )

  const model: FilterModel = { keyword, damId, packetStatus }
  const onModelChange = (next: FilterModel): void => {
    setKeyword(String(next.keyword ?? ''))
    setDamId(typeof next.damId === 'string' ? next.damId : '')
    setPacketStatus(Array.isArray(next.packetStatus) ? next.packetStatus.map(String) : [])
  }

  const packets = reconcile.packets.filter((packet) => {
    if (packetStatus.length > 0 && !packetStatus.includes(packet.status)) return false
    const touchesDam = !damId || packet.readings.some((reading) => reading.damId === damId)
    if (!touchesDam) return false
    const text = keyword.trim().toLowerCase()
    if (text.length === 0) return true
    return packet.packetNo.toLowerCase().includes(text) || packet.source.toLowerCase().includes(text)
  })

  const visibleIssues = reconcile.issues.filter((issue) => {
    if (damId && issue.damId !== damId) return false
    const text = keyword.trim().toLowerCase()
    if (text.length === 0) return true
    return issue.packetNo.toLowerCase().includes(text) || RECONCILE_ISSUE_TEXT[issue.code].includes(text)
  })

  const announceConfirm = (result: ConfirmResult): void => {
    if (result.outcome === 'confirmed') {
      message.success(`测次 ${result.time} 已确认，水位事实入账`)
      if (result.riskOpened) {
        modal.warning({
          title: '已合并生成橙色联合风险',
          content: `该坝体日涨幅达到 ${JOINT_RISE_LIMIT_M} m，且存在未处置浸润线预警，已合并为橙色联合风险单。`
        })
      }
      if (result.packetFinished) message.info('该回传包全部测次已对账完成')
    } else if (result.outcome === 'blocked') {
      message.error(`测次 ${result.time} 留在待确认处（${result.issueCode ? RECONCILE_ISSUE_TEXT[result.issueCode] : '异常'}），观测与处置先不动`)
    } else if (result.outcome === 'finished') {
      message.info('该包已没有可确认的测次')
    } else {
      message.warning('未找到该回传包')
    }
  }

  const onConfirmNext = async (packet: WaterLevelPacket): Promise<void> => {
    announceConfirm(await reconcile.confirmNext(packet.id))
  }

  const onConfirmAll = async (packet: WaterLevelPacket): Promise<void> => {
    const results = await reconcile.confirmAllAvailable(packet.id)
    const confirmed = results.filter((result) => result.outcome === 'confirmed').length
    const blocked = results.filter((result) => result.outcome === 'blocked').length
    const opened = results.some((result) => result.riskOpened)
    message.success(`批量对账完成：确认 ${confirmed} 条，待确认 ${blocked} 条${opened ? '，已生成橙色联合风险' : ''}`)
  }

  const openIngest = (): void => {
    setPacketJson('')
    setIngestOpen(true)
  }

  const submitIngest = async (): Promise<void> => {
    let parsed: WaterLevelPacketInput
    try {
      parsed = JSON.parse(packetJson) as WaterLevelPacketInput
    } catch {
      message.error('JSON 解析失败，请检查回传包格式')
      return
    }
    const result = await reconcile.ingestPacket(parsed)
    if (result.outcome === 'invalid') {
      message.error(result.errors.join('；'))
      return
    }
    if (result.outcome === 'duplicate') {
      message.warning(result.errors[0])
      return
    }
    setIngestOpen(false)
    message.success(`回传包 ${parsed.packetNo} 已接收${result.blocked > 0 ? `，${result.blocked} 个测次单位/版本异常留在待确认处` : ''}`)
  }

  const resolveIssue = async (issueId: string): Promise<void> => {
    await reconcile.resolveIssue(issueId)
    message.success('异常已标记为人工处理，测次仍保留在待确认处，观测与处置未改动')
  }

  const releaseRisk = async (riskId: string): Promise<void> => {
    await reconcile.releaseRisk(riskId, '手动解除')
    message.success('联合风险已手动解除')
  }

  const removePacket = async (packet: WaterLevelPacket): Promise<void> => {
    await reconcile.removePacket(packet.id)
    message.success(`回传包 ${packet.packetNo} 已删除（已入账水位事实保留在库水位台账）`)
  }

  const readingColumns = (packet: WaterLevelPacket): TableColumnsType<WaterLevelReadingDraft> => [
    {
      title: '测次时间',
      dataIndex: 'time',
      width: 160,
      render: (value: string) => normalizeReadingTime(value)
    },
    { title: '坝体', width: 160, render: (_v, record) => damName(record.damId) },
    {
      title: '回传水位',
      width: 120,
      render: (_v, record) => `${Number(record.level).toFixed(2)} ${record.unit}`
    },
    {
      title: '状态',
      width: 110,
      render: (_v, record) => {
        const state = reconcile.readingState(packet, record)
        return <Tag color={READING_STATE_COLOR[state]}>{state}</Tag>
      }
    },
    {
      title: '异常',
      render: (_v, record) => {
        const issue = reconcile.issues.find(
          (item) => item.packetId === packet.id && item.damId === record.damId && item.time === normalizeReadingTime(record.time)
        )
        if (!issue) return <span className="muted">—</span>
        return (
          <Space direction="vertical" size={0}>
            <Tag color={issue.state === '待确认' ? 'red' : 'default'}>{RECONCILE_ISSUE_TEXT[issue.code]}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {issue.detail}
            </Typography.Text>
          </Space>
        )
      }
    },
    {
      title: '操作',
      width: 110,
      render: (_v, record) => {
        const state = reconcile.readingState(packet, record)
        if (state !== '待对账') return null
        const next = reconcile.nextReading(packet)
        const isNext = next !== null && next.time === normalizeReadingTime(record.time)
        return (
          <Button
            type="link"
            size="small"
            disabled={!isNext}
            onClick={() => void reconcile.confirmReading(packet.id, normalizeReadingTime(record.time)).then(announceConfirm)}
          >
            {isNext ? '确认' : '等待前序测次'}
          </Button>
        )
      }
    }
  ]

  const packetItems = packets.map((packet) => {
    const sorted = [...packet.readings].sort((a, b) => normalizeReadingTime(a.time).localeCompare(normalizeReadingTime(b.time)))
    const confirmedCount = sorted.filter((reading) => reconcile.readingState(packet, reading) === '已确认').length
    const blockedCount = sorted.filter((reading) => reconcile.readingState(packet, reading) === '待确认').length
    const next = reconcile.nextReading(packet)
    return {
      key: packet.id,
      label: (
        <Space wrap>
          <Typography.Text strong>{packet.packetNo}</Typography.Text>
          <Tag color={PACKET_STATUS_COLOR[packet.status]}>{packet.status}</Tag>
          <span className="muted">{packet.source}</span>
          <span className="muted">
            测次 {sorted.length}（已确认 {confirmedCount} / 待确认 {blockedCount}）
          </span>
          {packet.lastConfirmedTime ? <Tag>断点：{packet.lastConfirmedTime}</Tag> : null}
        </Space>
      ),
      children: (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {packet.status === '对账中' ? (
            <Alert
              type="info"
              message={`对账上次中断于 ${packet.lastConfirmedTime || '—'}，重开后${next ? `从 ${normalizeReadingTime(next.time)} 继续` : '已无可确认测次'}`}
              showIcon
            />
          ) : null}
          <Space>
            <Button type="primary" disabled={!next} onClick={() => void onConfirmNext(packet)}>
              {next ? `继续对账（${normalizeReadingTime(next.time)}）` : '没有待确认测次'}
            </Button>
            <Button disabled={!next} onClick={() => void onConfirmAll(packet)}>
              一键确认全部可对账测次
            </Button>
            <Popconfirm title="删除该回传包？已入账的水位事实保留在库水位台账。" onConfirm={() => void removePacket(packet)}>
              <Button danger type="link" size="small">
                删除回传包
              </Button>
            </Popconfirm>
          </Space>
          <Table<WaterLevelReadingDraft>
            rowKey={(record) => `${record.damId}-${record.time}`}
            size="small"
            bordered
            pagination={false}
            dataSource={sorted}
            columns={readingColumns(packet)}
          />
        </Space>
      )
    }
  })

  const issueRows = visibleIssues.filter((issue) => issue.state === '待确认')

  const riskRows = reconcile.risks.filter((risk) => !damId || risk.damId === damId)

  const riskColumns: TableColumnsType<(typeof reconcile.risks)[number]> = [
    { title: '坝体', width: 160, render: (_v, record) => damName(record.damId) },
    { title: '触发测次', dataIndex: 'triggerTime', width: 160 },
    {
      title: '日涨幅',
      dataIndex: 'risePerDay',
      width: 110,
      render: (value: number) => <Typography.Text strong style={{ color: '#e07b00' }}>{value.toFixed(2)} m/d</Typography.Text>
    },
    { title: '触发水位', width: 110, render: (_v, record) => `${record.triggerLevelM.toFixed(2)} m` },
    {
      title: '合并的浸润线预警',
      render: (_v, record) => (
        <Space size={4} wrap>
          {record.alarmIds.map((alarmId) => {
            const alarm = reconcile.alarms.find((item) => item.id === alarmId)
            const point = alarm ? pointStore.points.find((item) => item.id === alarm.pointId) : null
            return <Tag key={alarmId} color="orange">{point ? point.code : alarmId} · {alarm?.state ?? '预警已删'}</Tag>
          })}
        </Space>
      )
    },
    {
      title: '状态',
      width: 170,
      render: (_v, record) =>
        record.state === '生效中' ? (
          <Tag color="orange">橙色联合风险 · 生效中</Tag>
        ) : (
          <Tag color="green">已解除 · {record.releaseReason}</Tag>
        )
    },
    {
      title: '操作',
      width: 100,
      render: (_v, record) =>
        record.state === '生效中' ? (
          <Popconfirm title="确认手动解除该联合风险？" onConfirm={() => void releaseRisk(record.id)}>
            <Button type="link" size="small">
              手动解除
            </Button>
          </Popconfirm>
        ) : (
          <span className="muted">—</span>
        )
    }
  ]

  const damRisePanels = damStore.dams.map((dam) => {
    const series = levelSeriesOf(dam.id, reconcile.pools)
    const { rise } = latestRisePerDay(series)
    const hit = rise >= JOINT_RISE_LIMIT_M
    return {
      key: dam.id,
      label: (
        <Space>
          <Typography.Text strong>{dam.name}</Typography.Text>
          <Tag color={hit ? 'orange' : 'default'}>最新日涨幅 {rise.toFixed(2)} m/d</Tag>
        </Space>
      ),
      children: (
        <Timeline
          items={series.map((point) => ({
            color: point.source === '回传确认' ? 'blue' : 'gray',
            children: (
              <Space size={8}>
                <span>{point.time}</span>
                <Typography.Text strong>{point.level.toFixed(2)} m</Typography.Text>
                <Tag>{point.source}</Tag>
              </Space>
            )
          }))}
        />
      )
    }
  })

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">汛期库水位回传对账</h2>
          <p className="page-head__desc">
            回传包提供水位事实，监测台管观测与处置，按坝体、测次时间对账；日涨幅 ≥ {JOINT_RISE_LIMIT_M} m 且有未处置浸润线预警时合并橙色联合风险，水位回落或新观测正常后解除。
          </p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={openIngest}>
            接收回传包
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="回传包" value={reconcile.packets.length} suffix="个" tone="primary" />
        <StatBadge
          label="对账中"
          value={reconcile.packets.filter((packet) => packet.status === '对账中').length}
          suffix="个"
          tone="info"
        />
        <StatBadge label="待确认测次" value={reconcile.pendingIssueCount()} suffix="条" tone="danger" />
        <StatBadge label="生效中联合风险" value={reconcile.openRiskCount()} suffix="张" tone="warning" />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索回传包编号 / 来源 / 异常类型"
        onModelChange={onModelChange}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            橙色联合风险（{riskRows.filter((risk) => risk.state === '生效中').length} 张生效中 / {riskRows.length} 张总计）
          </h3>
          <span className="muted">未处置浸润线预警 = 待处置 / 处置中；已闭环不计入合并</span>
        </div>
        {riskRows.length === 0 ? (
          <EmptyPanel
            compact
            title="暂无联合风险"
            description="对账确认的水位日涨幅达到 0.5 m 且存在未处置浸润线预警时，自动合并生成橙色联合风险。"
          />
        ) : (
          <Table rowKey="id" size="small" bordered pagination={false} dataSource={riskRows} columns={riskColumns} />
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            回传包对账（{packets.length}）
          </h3>
          <span className="muted">中断重开从最后确认的测次继续；同包再送按 packetNo 拒收</span>
        </div>
        {packets.length === 0 ? (
          <EmptyPanel
            compact
            title="还没有回传包"
            description="接收水文站回传包后按测次逐条对账，异常测次留在待确认处。"
            actionText="接收回传包"
            onAction={openIngest}
          />
        ) : (
          <Collapse items={packetItems} style={{ background: '#fff' }} />
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            待确认处（{issueRows.length}）
          </h3>
          <span className="muted">单位不一致或同测次两个版本：观测与处置先不动，由人工核实</span>
        </div>
        {issueRows.length === 0 ? (
          <EmptyPanel compact title="待确认处为空" description="没有单位或版本冲突的测次。" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            bordered
            pagination={false}
            dataSource={issueRows}
            columns={[
              { title: '回传包', dataIndex: 'packetNo', width: 160 },
              { title: '坝体', width: 160, render: (_v, record) => damName(record.damId) },
              { title: '测次时间', dataIndex: 'time', width: 160 },
              { title: '异常类型', width: 150, render: (_v, record) => <Tag color="red">{RECONCILE_ISSUE_TEXT[record.code]}</Tag> },
              { title: '台账侧版本', dataIndex: 'detail' },
              { title: '回传侧版本', dataIndex: 'packetDetail' },
              {
                title: '操作',
                width: 120,
                render: (_v, record) => (
                  <Button type="link" size="small" onClick={() => void resolveIssue(record.id)}>
                    人工核实处理
                  </Button>
                )
              }
            ]}
          />
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            各坝水位时序（日涨幅核对）
          </h3>
          <span className="muted">蓝点为回传确认事实，灰点为现场人工台账</span>
        </div>
        <Collapse items={damRisePanels} style={{ background: '#fff' }} />
      </div>

      <Modal
        open={ingestOpen}
        title="接收入库水位回传包"
        onCancel={() => setIngestOpen(false)}
        onOk={() => void submitIngest()}
        okText="接收"
        cancelText="取消"
        width={720}
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="同一 packetNo 再送将被拒收；单位非 m 或同测次两个版本的测次进入待确认处，不动观测与处置。"
          />
          <Space wrap>
            {SAMPLE_PACKETS.map((sample) => (
              <Button
                key={sample.key}
                size="small"
                onClick={() => setPacketJson(JSON.stringify(sample.payload, null, 2))}
              >
                {sample.label}
              </Button>
            ))}
          </Space>
          <Input.TextArea
            rows={14}
            value={packetJson}
            onChange={(event) => setPacketJson(event.target.value)}
            placeholder='{"packetNo":"PK-...","source":"汛期水文站","readings":[{"time":"2024-06-13 08:00","damId":"dam-1","level":711.9,"unit":"m"}]}'
            style={{ fontFamily: 'monospace' }}
          />
        </Space>
      </Modal>
    </div>
  )
}
