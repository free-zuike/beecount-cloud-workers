import { useState, useEffect } from 'react'
import './App.css'

interface User {
  id: string
  email: string
}

interface Ledger {
  id: string
  name: string
  currency: string
}

interface Transaction {
  id: string
  amount: number
  tx_type: string
  category_name: string
  account_name: string
  note: string
  happened_at: string
}

interface Category {
  id: string
  name: string
  parent_id: string | null
  icon: string
  tx_type: string
}

interface Account {
  id: string
  name: string
  type: string
  balance: number
}

interface S3Config {
  endpoint: string
  region: string
  access_key_id: string
  secret_access_key: string
  bucket_name: string
  path_style: boolean
  cdn_domain: string
}

interface TwoFAStatus {
  enabled: boolean
  recovery_codes?: string[]
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState<string | null>(null)
  
  // Auth state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  
  // App state
  const [ledgers, setLedgers] = useState<Ledger[]>([])
  const [currentLedger, setCurrentLedger] = useState<Ledger | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [currentPage, setCurrentPage] = useState('dashboard')
  
  // Transaction form
  const [showTxForm, setShowTxForm] = useState(false)
  const [txType, setTxType] = useState('expense')
  const [txAmount, setTxAmount] = useState('')
  const [txCategory, setTxCategory] = useState('')
  const [txAccount, setTxAccount] = useState('')
  const [txNote, setTxNote] = useState('')
  
  // Category form
  const [showCategoryForm, setShowCategoryForm] = useState(false)
  const [newCategory, setNewCategory] = useState({ name: '', icon: '🏷️', tx_type: 'expense', parent_id: null as string | null })
  
  // Account form
  const [showAccountForm, setShowAccountForm] = useState(false)
  const [newAccount, setNewAccount] = useState({ name: '', type: 'cash', balance: 0 })
  
  // Ledger form
  const [showLedgerForm, setShowLedgerForm] = useState(false)
  const [newLedger, setNewLedger] = useState({ name: '', currency: 'CNY' })
  
  // Settings
  const [twoFAStatus, setTwoFAStatus] = useState<TwoFAStatus>({ enabled: false })
  const [s3Config, setS3Config] = useState<S3Config>({
    endpoint: '',
    region: '',
    access_key_id: '',
    secret_access_key: '',
    bucket_name: '',
    path_style: false,
    cdn_domain: ''
  })

  useEffect(() => {
    const savedToken = localStorage.getItem('token')
    if (savedToken) {
      setToken(savedToken)
      fetchUser(savedToken)
    } else {
      setLoading(false)
    }
  }, [])

  const fetchUser = async (t: string) => {
    try {
      const res = await fetch('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.user) {
        setUser(data.user)
        fetchLedgers(t)
        fetchTwoFAStatus(t)
        fetchS3Config(t)
      } else {
        localStorage.removeItem('token')
        setToken(null)
      }
    } catch (err) {
      localStorage.removeItem('token')
      setToken(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchLedgers = async (t: string) => {
    try {
      const res = await fetch('/api/v1/sync/ledgers', {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.ledgers) {
        setLedgers(data.ledgers)
        if (data.ledgers.length > 0) {
          setCurrentLedger(data.ledgers[0])
          fetchTransactions(t, data.ledgers[0].id)
          fetchCategories(t, data.ledgers[0].id)
          fetchAccounts(t, data.ledgers[0].id)
        }
      }
    } catch (err) {
      console.error('Failed to fetch ledgers:', err)
    }
  }

  const fetchTransactions = async (t: string, ledgerId: string) => {
    try {
      const res = await fetch(`/api/v1/sync/full?ledger_id=${ledgerId}`, {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.transactions) {
        setTransactions(data.transactions)
      }
    } catch (err) {
      console.error('Failed to fetch transactions:', err)
    }
  }

  const fetchCategories = async (t: string, ledgerId: string) => {
    try {
      const res = await fetch(`/api/v1/read/ledgers/${ledgerId}/categories`, {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.categories) {
        setCategories(data.categories)
      }
    } catch (err) {
      console.error('Failed to fetch categories:', err)
    }
  }

  const fetchAccounts = async (t: string, ledgerId: string) => {
    try {
      const res = await fetch(`/api/v1/read/ledgers/${ledgerId}/accounts`, {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.accounts) {
        setAccounts(data.accounts)
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err)
    }
  }

  const fetchTwoFAStatus = async (t: string) => {
    try {
      const res = await fetch('/api/v1/2fa/status', {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.enabled !== undefined) {
        setTwoFAStatus(data)
      }
    } catch (err) {
      console.error('Failed to fetch 2FA status:', err)
    }
  }

  const fetchS3Config = async (t: string) => {
    try {
      const res = await fetch('/api/v1/sys-config/get', {
        headers: { Authorization: `Bearer ${t}` }
      })
      const data = await res.json()
      if (data.s3) {
        setS3Config({
          endpoint: data.s3.endpoint || '',
          region: data.s3.region || '',
          access_key_id: data.s3.access_key_id || '',
          secret_access_key: data.s3.secret_access_key || '',
          bucket_name: data.s3.bucket_name || '',
          path_style: data.s3.path_style || false,
          cdn_domain: data.s3.cdn_domain || ''
        })
      }
    } catch (err) {
      console.error('Failed to fetch S3 config:', err)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      
      const data = await res.json()
      
      if (res.ok) {
        localStorage.setItem('token', data.access_token)
        setToken(data.access_token)
        setUser(data.user)
        fetchLedgers(data.access_token)
        fetchTwoFAStatus(data.access_token)
        fetchS3Config(data.access_token)
      } else {
        setAuthError(data.error || '登录失败')
      }
    } catch (err) {
      setAuthError('网络错误')
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
    setLedgers([])
    setTransactions([])
    setCategories([])
    setAccounts([])
  }

  const handleCreateTransaction = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || !currentLedger) return
    
    try {
      const res = await fetch('/api/v1/write/transactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          ledger_id: currentLedger.id,
          tx_type: txType,
          amount: parseInt(txAmount) * 100,
          category_name: txCategory || null,
          account_name: txAccount || null,
          note: txNote || null,
          happened_at: new Date().toISOString()
        })
      })
      
      if (res.ok) {
        setShowTxForm(false)
        setTxAmount('')
        setTxCategory('')
        setTxAccount('')
        setTxNote('')
        fetchTransactions(token, currentLedger.id)
        alert('记账成功！')
      } else {
        const data = await res.json()
        alert(data.error || '记账失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || !currentLedger) return
    
    try {
      const res = await fetch('/api/v1/write/categories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          ledger_id: currentLedger.id,
          name: newCategory.name,
          icon: newCategory.icon,
          tx_type: newCategory.tx_type,
          parent_id: newCategory.parent_id
        })
      })
      
      if (res.ok) {
        setShowCategoryForm(false)
        setNewCategory({ name: '', icon: '🏷️', tx_type: 'expense', parent_id: null })
        fetchCategories(token, currentLedger.id)
        alert('分类创建成功！')
      } else {
        const data = await res.json()
        alert(data.error || '创建失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || !currentLedger) return
    
    try {
      const res = await fetch('/api/v1/write/accounts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          ledger_id: currentLedger.id,
          name: newAccount.name,
          type: newAccount.type,
          balance: newAccount.balance * 100
        })
      })
      
      if (res.ok) {
        setShowAccountForm(false)
        setNewAccount({ name: '', type: 'cash', balance: 0 })
        fetchAccounts(token, currentLedger.id)
        alert('账户创建成功！')
      } else {
        const data = await res.json()
        alert(data.error || '创建失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleCreateLedger = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    
    try {
      const res = await fetch('/api/v1/write/ledgers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          name: newLedger.name,
          currency: newLedger.currency
        })
      })
      
      if (res.ok) {
        setShowLedgerForm(false)
        setNewLedger({ name: '', currency: 'CNY' })
        fetchLedgers(token)
        alert('账本创建成功！')
      } else {
        const data = await res.json()
        alert(data.error || '创建失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleSaveS3Config = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) return
    
    try {
      const res = await fetch('/api/v1/sys-config/set', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          s3: s3Config
        })
      })
      
      if (res.ok) {
        alert('S3 配置保存成功！')
      } else {
        const data = await res.json()
        alert(data.error || '保存失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleClearData = async () => {
    if (!token) return
    if (!confirm('确定要清空所有数据吗？此操作将保留账户信息，但会删除所有交易、分类和附件！')) return
    
    try {
      const res = await fetch('/api/v1/write/clear-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      })
      
      if (res.ok) {
        fetchTransactions(token, currentLedger?.id || '')
        fetchCategories(token, currentLedger?.id || '')
        alert('数据清空成功！')
      } else {
        const data = await res.json()
        alert(data.error || '清空失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleEnable2FA = async () => {
    if (!token) return
    
    try {
      const res = await fetch('/api/v1/2fa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      
      const data = await res.json()
      if (res.ok && data.qr_code_uri) {
        if (confirm(`请使用 Authenticator 应用扫描二维码，然后点击确定继续验证。\n\n二维码链接：${data.qr_code_uri}`)) {
          const code = prompt('请输入 Authenticator 应用中的验证码：')
          if (code) {
            const confirmRes = await fetch('/api/v1/2fa/confirm', {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({ code })
            })
            
            if (confirmRes.ok) {
              const confirmData = await confirmRes.json()
              alert('2FA 已成功启用！\n\n恢复码（请保存）：\n' + confirmData.recovery_codes?.join('\n'))
              fetchTwoFAStatus(token)
            } else {
              const confirmData = await confirmRes.json()
              alert(confirmData.error || '验证失败')
            }
          }
        }
      } else {
        alert(data.error || '设置失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleDisable2FA = async () => {
    if (!token) return
    if (!confirm('确定要关闭 2FA 吗？')) return
    
    const code = prompt('请输入 Authenticator 应用中的验证码：')
    if (!code) return
    
    try {
      const res = await fetch('/api/v1/2fa/disable', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ code })
      })
      
      if (res.ok) {
        alert('2FA 已关闭！')
        fetchTwoFAStatus(token)
      } else {
        const data = await res.json()
        alert(data.error || '关闭失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const handleRegenerateRecoveryCodes = async () => {
    if (!token) return
    if (!confirm('确定要重新生成恢复码吗？旧的恢复码将失效！')) return
    
    const code = prompt('请输入 Authenticator 应用中的验证码：')
    if (!code) return
    
    try {
      const res = await fetch('/api/v1/2fa/recovery-codes/regenerate', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ code })
      })
      
      if (res.ok) {
        const data = await res.json()
        alert(`新的恢复码：\n${data.recovery_codes?.join('\n')}\n\n请妥善保存！`)
        fetchTwoFAStatus(token)
      } else {
        const data = await res.json()
        alert(data.error || '生成失败')
      }
    } catch (err) {
      alert('网络错误')
    }
  }

  const formatMoney = (amount: number) => {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: 'CNY'
    }).format(amount / 100)
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getParentCategories = () => {
    return categories.filter(c => !c.parent_id)
  }

  const getChildCategories = (parentId: string) => {
    return categories.filter(c => c.parent_id === parentId)
  }

  const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0)

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  if (!user) {
    return (
      <div className="login-container">
        <div className="login-form">
          <h1>🐝 BeeCount Cloud</h1>
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label>邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="请输入邮箱"
                required
              />
            </div>
            <div className="form-group">
              <label>密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                required
              />
            </div>
            {authError && <div className="error">{authError}</div>}
            <button type="submit" className="btn btn-primary">登录</button>
          </form>
        </div>
      </div>
    )
  }

  const totalExpense = transactions
    .filter(t => t.tx_type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0)
  
  const totalIncome = transactions
    .filter(t => t.tx_type === 'income')
    .reduce((sum, t) => sum + t.amount, 0)

  return (
    <div className="app-container">
      <header className="header">
        <div className="header-left">
          <h1>🐝 BeeCount</h1>
        </div>
        <div className="header-right">
          <span>{user.email}</span>
          <button onClick={handleLogout} className="btn btn-secondary">退出</button>
        </div>
      </header>

      <nav className="nav">
        <button 
          className={`nav-btn ${currentPage === 'dashboard' ? 'active' : ''}`}
          onClick={() => setCurrentPage('dashboard')}
        >
          📊 概览
        </button>
        <button 
          className={`nav-btn ${currentPage === 'transactions' ? 'active' : ''}`}
          onClick={() => setCurrentPage('transactions')}
        >
          💰 交易
        </button>
        <button 
          className={`nav-btn ${currentPage === 'categories' ? 'active' : ''}`}
          onClick={() => setCurrentPage('categories')}
        >
          🏷️ 分类
        </button>
        <button 
          className={`nav-btn ${currentPage === 'accounts' ? 'active' : ''}`}
          onClick={() => setCurrentPage('accounts')}
        >
          💳 账户
        </button>
        <button 
          className={`nav-btn ${currentPage === 'ledgers' ? 'active' : ''}`}
          onClick={() => setCurrentPage('ledgers')}
        >
          📒 账本
        </button>
        <button 
          className={`nav-btn ${currentPage === 'settings' ? 'active' : ''}`}
          onClick={() => setCurrentPage('settings')}
        >
          ⚙️ 设置
        </button>
      </nav>

      <main className="main-content">
        {currentPage === 'dashboard' && (
          <div className="dashboard">
            <div className="stats-grid">
              <div className="stat-card expense">
                <h3>总支出</h3>
                <p className="amount">{formatMoney(totalExpense)}</p>
              </div>
              <div className="stat-card income">
                <h3>总收入</h3>
                <p className="amount">{formatMoney(totalIncome)}</p>
              </div>
              <div className="stat-card balance">
                <h3>结余</h3>
                <p className="amount">{formatMoney(totalIncome - totalExpense)}</p>
              </div>
              <div className="stat-card assets">
                <h3>总资产</h3>
                <p className="amount">{formatMoney(totalBalance)}</p>
              </div>
            </div>

            <div className="ledger-selector">
              <label>选择账本：</label>
              <select 
                value={currentLedger?.id || ''}
                onChange={(e) => {
                  const ledger = ledgers.find(l => l.id === e.target.value)
                  setCurrentLedger(ledger || null)
                  if (ledger && token) {
                    fetchTransactions(token, ledger.id)
                    fetchCategories(token, ledger.id)
                    fetchAccounts(token, ledger.id)
                  }
                }}
              >
                {ledgers.map(ledger => (
                  <option key={ledger.id} value={ledger.id}>
                    {ledger.name} ({ledger.currency})
                  </option>
                ))}
              </select>
            </div>

            <div className="recent-transactions">
              <h2>最近交易</h2>
              <button 
                className="btn btn-primary"
                onClick={() => setShowTxForm(true)}
              >
                + 记一笔
              </button>
              
              <div className="transaction-list">
                {transactions.slice(0, 10).map(tx => (
                  <div key={tx.id} className="transaction-item">
                    <div className="tx-icon">
                      {tx.tx_type === 'expense' ? '📉' : '📈'}
                    </div>
                    <div className="tx-info">
                      <div className="tx-category">{tx.category_name || '未分类'}</div>
                      <div className="tx-date">{formatDate(tx.happened_at)}</div>
                    </div>
                    <div className={`tx-amount ${tx.tx_type}`}>
                      {tx.tx_type === 'expense' ? '-' : '+'}{formatMoney(tx.amount)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {currentPage === 'transactions' && (
          <div className="page">
            <div className="page-header">
              <h2>💰 交易记录</h2>
              <button 
                className="btn btn-primary"
                onClick={() => setShowTxForm(true)}
              >
                + 记一笔
              </button>
            </div>
            
            <div className="transaction-list full">
              {transactions.map(tx => (
                <div key={tx.id} className="transaction-item">
                  <div className="tx-icon">
                    {tx.tx_type === 'expense' ? '📉' : '📈'}
                  </div>
                  <div className="tx-info">
                    <div className="tx-category">{tx.category_name || '未分类'}</div>
                    {tx.note && <div className="tx-note">{tx.note}</div>}
                    <div className="tx-date">{formatDate(tx.happened_at)}</div>
                  </div>
                  <div className={`tx-amount ${tx.tx_type}`}>
                    {tx.tx_type === 'expense' ? '-' : '+'}{formatMoney(tx.amount)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentPage === 'categories' && (
          <div className="page">
            <div className="page-header">
              <h2>🏷️ 分类管理</h2>
              <button 
                className="btn btn-primary"
                onClick={() => setShowCategoryForm(true)}
              >
                + 新建分类
              </button>
            </div>
            
            <div className="category-tree">
              <h3>支出分类</h3>
              <div className="category-list">
                {getParentCategories().filter(c => c.tx_type === 'expense').map(parent => (
                  <div key={parent.id} className="category-item parent">
                    <span className="category-icon">{parent.icon}</span>
                    <span className="category-name">{parent.name}</span>
                    <div className="category-children">
                      {getChildCategories(parent.id).map(child => (
                        <div key={child.id} className="category-item child">
                          <span className="category-icon">{child.icon}</span>
                          <span className="category-name">{child.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              
              <h3 style={{ marginTop: '24px' }}>收入分类</h3>
              <div className="category-list">
                {getParentCategories().filter(c => c.tx_type === 'income').map(parent => (
                  <div key={parent.id} className="category-item parent">
                    <span className="category-icon">{parent.icon}</span>
                    <span className="category-name">{parent.name}</span>
                    <div className="category-children">
                      {getChildCategories(parent.id).map(child => (
                        <div key={child.id} className="category-item child">
                          <span className="category-icon">{child.icon}</span>
                          <span className="category-name">{child.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {currentPage === 'accounts' && (
          <div className="page">
            <div className="page-header">
              <h2>💳 账户管理</h2>
              <button 
                className="btn btn-primary"
                onClick={() => setShowAccountForm(true)}
              >
                + 新建账户
              </button>
            </div>
            
            <div className="account-list">
              {accounts.map(account => (
                <div key={account.id} className="account-item">
                  <div className="account-icon">
                    {account.type === 'cash' ? '💵' : 
                     account.type === 'card' ? '💳' : 
                     account.type === 'alipay' ? '📱' : 
                     account.type === 'wechat' ? '💬' : '🏦'}
                  </div>
                  <div className="account-info">
                    <div className="account-name">{account.name}</div>
                    <div className="account-type">
                      {account.type === 'cash' ? '现金' : 
                       account.type === 'card' ? '银行卡' : 
                       account.type === 'alipay' ? '支付宝' : 
                       account.type === 'wechat' ? '微信' : '其他'}
                    </div>
                  </div>
                  <div className="account-balance">
                    {formatMoney(account.balance)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentPage === 'ledgers' && (
          <div className="page">
            <div className="page-header">
              <h2>📒 账本管理</h2>
              <button 
                className="btn btn-primary"
                onClick={() => setShowLedgerForm(true)}
              >
                + 新建账本
              </button>
            </div>
            
            <div className="ledger-list">
              {ledgers.map(ledger => (
                <div 
                  key={ledger.id} 
                  className={`ledger-item ${currentLedger?.id === ledger.id ? 'active' : ''}`}
                  onClick={() => {
                    setCurrentLedger(ledger)
                    if (token) {
                      fetchTransactions(token, ledger.id)
                      fetchCategories(token, ledger.id)
                      fetchAccounts(token, ledger.id)
                    }
                  }}
                >
                  <div className="ledger-name">{ledger.name}</div>
                  <div className="ledger-currency">{ledger.currency}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentPage === 'settings' && (
          <div className="page settings-page">
            <h2>⚙️ 设置</h2>
            
            <div className="settings-section">
              <h3>👤 账户信息</h3>
              <div className="setting-row">
                <span className="setting-label">邮箱</span>
                <span className="setting-value">{user.email}</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">用户ID</span>
                <span className="setting-value">{user.id}</span>
              </div>
            </div>

            <div className="settings-section">
              <h3>🔐 双重认证 (2FA)</h3>
              <div className="setting-row">
                <span className="setting-label">状态</span>
                <span className={`setting-value ${twoFAStatus.enabled ? 'enabled' : 'disabled'}`}>
                  {twoFAStatus.enabled ? '已启用' : '未启用'}
                </span>
              </div>
              <div className="setting-actions">
                {!twoFAStatus.enabled ? (
                  <button className="btn btn-primary" onClick={handleEnable2FA}>
                    启用 2FA
                  </button>
                ) : (
                  <>
                    <button className="btn btn-warning" onClick={handleDisable2FA}>
                      关闭 2FA
                    </button>
                    <button className="btn btn-secondary" onClick={handleRegenerateRecoveryCodes}>
                      重新生成恢复码
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="settings-section">
              <h3>☁️ S3 存储配置</h3>
              <form onSubmit={handleSaveS3Config} className="s3-form">
                <div className="form-row">
                  <div className="form-group">
                    <label>Endpoint</label>
                    <input
                      type="text"
                      value={s3Config.endpoint}
                      onChange={(e) => setS3Config({...s3Config, endpoint: e.target.value})}
                      placeholder="例如: https://s3.amazonaws.com"
                    />
                  </div>
                  <div className="form-group">
                    <label>Region</label>
                    <input
                      type="text"
                      value={s3Config.region}
                      onChange={(e) => setS3Config({...s3Config, region: e.target.value})}
                      placeholder="例如: us-east-1"
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Access Key ID</label>
                    <input
                      type="text"
                      value={s3Config.access_key_id}
                      onChange={(e) => setS3Config({...s3Config, access_key_id: e.target.value})}
                    />
                  </div>
                  <div className="form-group">
                    <label>Secret Access Key</label>
                    <input
                      type="password"
                      value={s3Config.secret_access_key}
                      onChange={(e) => setS3Config({...s3Config, secret_access_key: e.target.value})}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Bucket Name</label>
                    <input
                      type="text"
                      value={s3Config.bucket_name}
                      onChange={(e) => setS3Config({...s3Config, bucket_name: e.target.value})}
                    />
                  </div>
                  <div className="form-group">
                    <label>CDN Domain</label>
                    <input
                      type="text"
                      value={s3Config.cdn_domain}
                      onChange={(e) => setS3Config({...s3Config, cdn_domain: e.target.value})}
                      placeholder="可选"
                    />
                  </div>
                </div>
                <div className="form-group checkbox">
                  <label>
                    <input
                      type="checkbox"
                      checked={s3Config.path_style}
                      onChange={(e) => setS3Config({...s3Config, path_style: e.target.checked})}
                    />
                    Path Style
                  </label>
                </div>
                <button type="submit" className="btn btn-primary">保存配置</button>
              </form>
            </div>

            <div className="settings-section danger">
              <h3>🗑️ 危险操作</h3>
              <button className="btn btn-danger" onClick={handleClearData}>
                清空所有数据（保留账户）
              </button>
              <p className="danger-note">此操作将删除所有交易、分类、标签和附件，但保留账户信息。操作不可撤销！</p>
            </div>
          </div>
        )}
      </main>

      {showTxForm && (
        <div className="modal-overlay" onClick={() => setShowTxForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>记一笔</h3>
              <button className="modal-close" onClick={() => setShowTxForm(false)}>×</button>
            </div>
            <form onSubmit={handleCreateTransaction}>
              <div className="type-selector">
                <button
                  type="button"
                  className={`type-btn ${txType === 'expense' ? 'active expense' : ''}`}
                  onClick={() => setTxType('expense')}
                >
                  📉 支出
                </button>
                <button
                  type="button"
                  className={`type-btn ${txType === 'income' ? 'active income' : ''}`}
                  onClick={() => setTxType('income')}
                >
                  📈 收入
                </button>
              </div>
              
              <div className="form-group">
                <label>金额（元）</label>
                <input
                  type="number"
                  value={txAmount}
                  onChange={(e) => setTxAmount(e.target.value)}
                  placeholder="请输入金额"
                  required
                  min="0.01"
                  step="0.01"
                />
              </div>
              
              <div className="form-group">
                <label>分类</label>
                <select
                  value={txCategory}
                  onChange={(e) => setTxCategory(e.target.value)}
                >
                  <option value="">选择分类</option>
                  {categories.filter(c => c.tx_type === txType).map(cat => (
                    <option key={cat.id} value={cat.name}>{cat.icon} {cat.name}</option>
                  ))}
                </select>
              </div>
              
              <div className="form-group">
                <label>账户</label>
                <select
                  value={txAccount}
                  onChange={(e) => setTxAccount(e.target.value)}
                >
                  <option value="">选择账户</option>
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.name}>{acc.name}</option>
                  ))}
                </select>
              </div>
              
              <div className="form-group">
                <label>备注</label>
                <input
                  type="text"
                  value={txNote}
                  onChange={(e) => setTxNote(e.target.value)}
                  placeholder="可选"
                />
              </div>
              
              <button type="submit" className="btn btn-primary btn-block">保存</button>
            </form>
          </div>
        </div>
      )}

      {showCategoryForm && (
        <div className="modal-overlay" onClick={() => setShowCategoryForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建分类</h3>
              <button className="modal-close" onClick={() => setShowCategoryForm(false)}>×</button>
            </div>
            <form onSubmit={handleCreateCategory}>
              <div className="type-selector">
                <button
                  type="button"
                  className={`type-btn ${newCategory.tx_type === 'expense' ? 'active expense' : ''}`}
                  onClick={() => setNewCategory({...newCategory, tx_type: 'expense'})}
                >
                  📉 支出
                </button>
                <button
                  type="button"
                  className={`type-btn ${newCategory.tx_type === 'income' ? 'active income' : ''}`}
                  onClick={() => setNewCategory({...newCategory, tx_type: 'income'})}
                >
                  📈 收入
                </button>
              </div>
              
              <div className="form-group">
                <label>分类名称</label>
                <input
                  type="text"
                  value={newCategory.name}
                  onChange={(e) => setNewCategory({...newCategory, name: e.target.value})}
                  placeholder="请输入分类名称"
                  required
                />
              </div>
              
              <div className="form-group">
                <label>图标</label>
                <input
                  type="text"
                  value={newCategory.icon}
                  onChange={(e) => setNewCategory({...newCategory, icon: e.target.value})}
                  placeholder="输入 emoji 图标"
                />
              </div>
              
              <div className="form-group">
                <label>上级分类（可选）</label>
                <select
                  value={newCategory.parent_id || ''}
                  onChange={(e) => setNewCategory({...newCategory, parent_id: e.target.value || null})}
                >
                  <option value="">无（一级分类）</option>
                  {getParentCategories().filter(c => c.tx_type === newCategory.tx_type).map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>
                  ))}
                </select>
              </div>
              
              <button type="submit" className="btn btn-primary btn-block">创建</button>
            </form>
          </div>
        </div>
      )}

      {showAccountForm && (
        <div className="modal-overlay" onClick={() => setShowAccountForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建账户</h3>
              <button className="modal-close" onClick={() => setShowAccountForm(false)}>×</button>
            </div>
            <form onSubmit={handleCreateAccount}>
              <div className="form-group">
                <label>账户名称</label>
                <input
                  type="text"
                  value={newAccount.name}
                  onChange={(e) => setNewAccount({...newAccount, name: e.target.value})}
                  placeholder="请输入账户名称"
                  required
                />
              </div>
              
              <div className="form-group">
                <label>账户类型</label>
                <select
                  value={newAccount.type}
                  onChange={(e) => setNewAccount({...newAccount, type: e.target.value})}
                >
                  <option value="cash">💵 现金</option>
                  <option value="card">💳 银行卡</option>
                  <option value="alipay">📱 支付宝</option>
                  <option value="wechat">💬 微信</option>
                  <option value="other">🏦 其他</option>
                </select>
              </div>
              
              <div className="form-group">
                <label>初始余额（元）</label>
                <input
                  type="number"
                  value={newAccount.balance}
                  onChange={(e) => setNewAccount({...newAccount, balance: parseFloat(e.target.value) || 0})}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                />
              </div>
              
              <button type="submit" className="btn btn-primary btn-block">创建</button>
            </form>
          </div>
        </div>
      )}

      {showLedgerForm && (
        <div className="modal-overlay" onClick={() => setShowLedgerForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建账本</h3>
              <button className="modal-close" onClick={() => setShowLedgerForm(false)}>×</button>
            </div>
            <form onSubmit={handleCreateLedger}>
              <div className="form-group">
                <label>账本名称</label>
                <input
                  type="text"
                  value={newLedger.name}
                  onChange={(e) => setNewLedger({...newLedger, name: e.target.value})}
                  placeholder="请输入账本名称"
                  required
                />
              </div>
              
              <div className="form-group">
                <label>货币类型</label>
                <select
                  value={newLedger.currency}
                  onChange={(e) => setNewLedger({...newLedger, currency: e.target.value})}
                >
                  <option value="CNY">CNY - 人民币</option>
                  <option value="USD">USD - 美元</option>
                  <option value="EUR">EUR - 欧元</option>
                  <option value="JPY">JPY - 日元</option>
                </select>
              </div>
              
              <button type="submit" className="btn btn-primary btn-block">创建</button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
