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
  const [currentPage, setCurrentPage] = useState('dashboard')
  
  // Transaction form
  const [showTxForm, setShowTxForm] = useState(false)
  const [txType, setTxType] = useState('expense')
  const [txAmount, setTxAmount] = useState('')
  const [txCategory, setTxCategory] = useState('')
  const [txAccount, setTxAccount] = useState('')
  const [txNote, setTxNote] = useState('')

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

  const formatMoney = (amount: number) => {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: 'CNY'
    }).format(amount / 100)
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('zh-CN')
  }

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
            <h2>💰 交易记录</h2>
            <button 
              className="btn btn-primary"
              onClick={() => setShowTxForm(true)}
            >
              + 记一笔
            </button>
            
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
            <h2>🏷️ 分类管理</h2>
            <p className="info">分类管理功能开发中...</p>
          </div>
        )}

        {currentPage === 'accounts' && (
          <div className="page">
            <h2>💳 账户管理</h2>
            <p className="info">账户管理功能开发中...</p>
          </div>
        )}

        {currentPage === 'settings' && (
          <div className="page">
            <h2>⚙️ 设置</h2>
            <div className="settings-section">
              <h3>账户信息</h3>
              <p>邮箱：{user.email}</p>
              <p>ID：{user.id}</p>
            </div>
            <div className="settings-section">
              <h3>数据同步</h3>
              <p>数据将自动与 APP 端同步</p>
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
                <input
                  type="text"
                  value={txCategory}
                  onChange={(e) => setTxCategory(e.target.value)}
                  placeholder="例如：餐饮、交通"
                />
              </div>
              
              <div className="form-group">
                <label>账户</label>
                <input
                  type="text"
                  value={txAccount}
                  onChange={(e) => setTxAccount(e.target.value)}
                  placeholder="例如：现金、银行卡"
                />
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
    </div>
  )
}

export default App
