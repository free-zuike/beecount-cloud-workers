import { useState } from 'react'

interface SetupFormProps {
  onComplete: () => void
}

export function SetupForm({ onComplete }: SetupFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
          timezone_offset: -480,
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
