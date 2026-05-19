import React, { useState, useEffect } from 'react';
import './App.css';

interface User {
  id: string;
  email: string;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      fetch('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => {
        if (data.user) {
          setUser(data.user);
        }
      })
      .catch(() => {
        localStorage.removeItem('token');
      })
      .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        localStorage.setItem('token', data.access_token);
        setUser(data.user);
      } else {
        setError(data.error || '登录失败');
      }
    } catch (err) {
      setError('网络错误');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  if (loading) {
    return <div className="loading">加载中...</div>;
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
            {error && <div className="error">{error}</div>}
            <button type="submit" className="btn">登录</button>
          </form>
          <p className="register-link">
            还没有账户？<a href="#" onClick={(e) => { e.preventDefault(); alert('注册功能开发中'); }}>立即注册</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="header">
        <h1>🐝 BeeCount Cloud</h1>
        <div className="user-info">
          <span>{user.email}</span>
          <button onClick={handleLogout} className="btn btn-secondary">退出登录</button>
        </div>
      </header>
      
      <nav className="nav">
        <button className="nav-btn active">账本</button>
        <button className="nav-btn">分类</button>
        <button className="nav-btn">账户</button>
        <button className="nav-btn">设置</button>
      </nav>
      
      <main className="main">
        <div className="welcome">
          <h2>欢迎回来！</h2>
          <p>这是一个基于 React + Vite 的全新前端界面</p>
        </div>
      </main>
    </div>
  );
}

export default App;
