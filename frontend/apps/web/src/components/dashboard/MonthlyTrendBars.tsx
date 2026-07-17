import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle, useT } from '@beecount/ui'

interface SeriesItem {
  bucket: string
  expense: number
  income: number
  balance: number
}

interface Props {
  data: SeriesItem[]
}

const TREND_WINDOW = 12

export function MonthlyTrendBars({ data }: Props) {
  const t = useT()

  const slice = useMemo(() => {
    const tail = data.slice(-TREND_WINDOW)
    return tail.map((d) => ({
      ...d,
      balance: Number.isFinite(d.balance) ? d.balance : (d.income ?? 0) - (d.expense ?? 0),
    }))
  }, [data])

  const fmt = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })

  const xTickFormatter = (bucket: string): string => {
    const parts = bucket.split('-')
    if (parts.length >= 2) return parts.slice(1).join('-')
    return bucket
  }

  const wrapRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el || slice.length === 0) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setDims({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [slice.length])

  return (
    <Card className="bc-panel overflow-hidden">
      <CardHeader>
        <CardTitle className="text-base">{t('home.trendBars.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {slice.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
            {t('home.trendBars.empty')}
          </div>
        ) : (
          <div ref={wrapRef} className="h-56">
            {dims.w > 0 && dims.h > 0 && (
              <ComposedChart width={dims.w} height={dims.h} data={slice} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                  stroke="hsl(var(--border))"
                  tickFormatter={xTickFormatter}
                  interval={0}
                />
                <YAxis
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                  stroke="hsl(var(--border))"
                  tickFormatter={(v) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}${t('home.trendBars.10kUnit')}` : String(v))}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 6,
                    fontSize: 12
                  }}
                  cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                  formatter={((v: number, name: string) => {
                    const label =
                      name === 'income'
                        ? t('home.trendBars.income')
                        : name === 'expense'
                          ? t('home.trendBars.expense')
                          : name === 'balance'
                            ? t('home.trendBars.balance')
                            : name
                    return [fmt(v), label]
                  }) as unknown as never}
                />
                <Legend
                  iconType="circle"
                  wrapperStyle={{ fontSize: 11 }}
                  formatter={(v: string) =>
                    v === 'income'
                      ? t('home.trendBars.income')
                      : v === 'expense'
                        ? t('home.trendBars.expense')
                        : v === 'balance'
                          ? t('home.trendBars.balance')
                          : v
                  }
                />
                <Bar dataKey="income" fill="rgb(var(--income-rgb))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expense" fill="rgb(var(--expense-rgb))" radius={[4, 4, 0, 0]} />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ fill: 'hsl(var(--primary))', r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </ComposedChart>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
