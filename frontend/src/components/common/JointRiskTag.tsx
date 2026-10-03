/**
 * <JointRiskTag> 橙色联合风险标记
 * 库水位日涨幅 ≥ 0.5 m 且浸润线预警未闭环时，由对账页与导航徽标消费。
 */
import type { CSSProperties } from 'react'
import type { JointRiskState } from '@/types/jointRisk'

export interface JointRiskTagProps {
  state?: JointRiskState
  size?: 'small' | 'default'
}

const COLOR = {
  active: { border: '#e07b00', bg: '#fdf0e3', text: '#e07b00' },
  released: { border: '#c7d0db', bg: '#f4f6f9', text: '#6b7a8d' }
} as const

const SIZE_STYLE: Record<'small' | 'default', CSSProperties> = {
  small: { padding: '0 8px', fontSize: 12, lineHeight: '18px' },
  default: { padding: '2px 12px', fontSize: 13, lineHeight: '22px' }
}

export function JointRiskTag({ state = '生效中', size = 'default' }: JointRiskTagProps) {
  const color = state === '生效中' ? COLOR.active : COLOR.released
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        borderRadius: 999,
        border: `1px solid ${color.border}`,
        backgroundColor: color.bg,
        color: color.text,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...SIZE_STYLE[size]
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: color.text }} aria-hidden />
      <span>橙色联合风险</span>
      <span style={{ fontWeight: 400, opacity: 0.9 }}>· {state}</span>
    </span>
  )
}

export default JointRiskTag
