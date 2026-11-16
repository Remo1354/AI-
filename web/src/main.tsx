import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
// 标题用的思源宋体随应用打包（按 unicode-range 切片，浏览器只下载用到的部分），不依赖外部字体服务
import '@fontsource/noto-serif-sc/600.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/pages.css';
import { api, setUnauthorizedHandler } from './lib/api';
import { AppProvider } from './lib/store';
import { BrandMark, Shell } from './components/Shell';
import { Loading } from './components/ui';
import { Dashboard } from './pages/Dashboard';
import { Assistant } from './pages/Assistant';
import { Knowledge, KnowledgeDetail } from './pages/Knowledge';
import { Learning, PlanDetail } from './pages/Learning';
import { Research, ResearchDetail } from './pages/Research';
import { Studio, TopicDetail } from './pages/Studio';
import { Settings } from './pages/Settings';

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', { password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card stack lg" onSubmit={submit}>
        <div className="row"><BrandMark /><h1 style={{ fontSize: 22 }}>Remo 学习平台</h1></div>
        <label className="field">
          <span className="label">访问密码</span>
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {error && <span className="hint" style={{ color: 'var(--danger)' }}>{error}</span>}
        </label>
        <button className="btn primary block" disabled={busy || !password}>进入</button>
      </form>
    </div>
  );
}

/** 只有设置了 APP_PASSWORD 时才会出现登录页。 */
function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'login' | 'ok' | 'offline'>('checking');
  const check = () =>
    api.get('/auth/status')
      .then((s) => setState(s.authenticated ? 'ok' : 'login'))
      .catch(() => setState('offline'));
  useEffect(() => {
    setUnauthorizedHandler(() => setState('login'));
    check();
  }, []);
  if (state === 'checking') return <Loading label="正在连接…" />;
  if (state === 'offline') {
    return (
      <div className="login">
        <div className="card stack" style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 20 }}>连接不到服务</h1>
          <p className="muted small">请确认平台正在运行（scripts/start），然后重试。</p>
          <button className="btn" onClick={() => { setState('checking'); check(); }}>重试</button>
        </div>
      </div>
    );
  }
  if (state === 'login') return <Login onDone={() => setState('ok')} />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <AppProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="assistant/:id?" element={<Assistant />} />
              <Route path="knowledge" element={<Knowledge />} />
              <Route path="knowledge/:id" element={<KnowledgeDetail />} />
              <Route path="learning" element={<Learning />} />
              <Route path="learning/plans/:id" element={<PlanDetail />} />
              <Route path="research" element={<Research />} />
              <Route path="research/:id" element={<ResearchDetail />} />
              <Route path="studio" element={<Studio />} />
              <Route path="studio/:id" element={<TopicDetail />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </AppProvider>
      </AuthGate>
    </BrowserRouter>
  </StrictMode>,
);
