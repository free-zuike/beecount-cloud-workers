import { useState } from 'react'

interface SetupFormProps {
  onComplete: () => void
}

const TIMEZONE_OPTIONS = [
  { offset: -720, label: '-12:00' },
  { offset: -660, label: '-11:00' },
  { offset: -600, label: '-10:00' },
  { offset: -540, label: '-09:00' },
  { offset: -480, label: 'UTC+8 北京时间' },
  { offset: -420, label: '+07:00' },
  { offset: -360, label: '+06:00' },
  { offset: -300, label: '+05:00' },
  { offset: -240, label: '+04:00' },
  { offset: -180, label: '+03:00' },
  { offset: -120, label: '+02:00' },
  { offset: -60, label: '+01:00' },
  { offset: 0, label: 'UTC' },
]

export function SetupForm({ onComplete }: SetupFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [timezoneOffset, setTimezoneOffset] = useState(-480)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/v1/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_mode: 'manual',
          admin_email: email,
          admin_password: password,
          timezone_offset: Number(timezoneOffset),
        }),
      })

      const data = await res.json()

      if (data.success) {
        setSuccess('管理员账户已创建，即将跳转到登录页面...')
        setTimeout(onComplete, 2000)
      } else {
        setError(data.error || data.message || '创建失败')
      }
    } catch {
      setError('网络错误，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 bg-red-50 text-red-600 rounded text-sm">{error}</div>
      )}
      {success && (
        <div className="p-3 bg-green-50 text-green-600 rounded text-sm">{success}</div>
      )}
      <div>
        <label className="block text-sm font-medium mb-1">管理员邮箱</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
          required
          className="w-full px-3 py-2 border rounded-md"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少8位"
          required
          minLength={8}
          className="w-full px-3 py-2 border rounded-md"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">时区（备份调度按此时区执行）</label>
        <select
          value={timezoneOffset}
          onChange={(e) => setTimezoneOffset(Number(e.target.value))}
          className="w-full px-3 py-2 border rounded-md"
        >
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz.offset} value={tz.offset}>{tz.label}</option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={loading || !!success}
        className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? '创建中...' : '创建管理员'}
      </button>
    </form>
  )
}
