import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { FileText, FlaskConical, Globe, Layers, ListChecks, MessageSquareText, MoreHorizontal, NotebookPen, Search, Settings as SettingsIcon } from 'lucide-react';
import { api } from '../lib/api';
import { MOBILE_PRIMARY, MODULES, isActive } from '../modules';
import { Loading, Modal, Snippet, Spinner } from './ui';

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  // 「叠绘」：三层半透明色块错位相叠
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="3" width="16" height="16" rx="4" fill="var(--accent)" opacity="0.92" />
      <rect x="8.5" y="8.5" width="16" height="16" rx="4" fill="var(--pg-azurite)" opacity="0.78" />
      <rect x="13.5" y="13" width="15" height="15" rx="4" fill="var(--pg-gamboge)" opacity="0.8" />
    </svg>
  );
}

const Brand = () => (
  <Link to="/" className="brand" aria-label="Remo AI Workspace 首页">
    <BrandMark />
    <div className="brand-text">
      <div className="brand-name">Remo</div>
      <div className="brand-sub">AI Workspace</div>
    </div>
  </Link>
);


const KIND: Record<string, { label: string; icon: typeof FileText }> = {
  knowledge: { label: '知识', icon: NotebookPen },
  document: { label: '资料', icon: FileText },
  message: { label: '对话', icon: MessageSquareText },
  research: { label: '研究', icon: FlaskConical },
  source: { label: '来源', icon: Globe },
  topic: { label: '选题', icon: Layers },
  plan: { label: '计划', icon: ListChecks },
};

/** 全站搜索：Ctrl/⌘ + K 打开，覆盖知识、资料正文、对话、研究、选题和计划。 */
function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ kind: string; title: string; snippet: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const token = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); return; }
    const mine = ++token.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api.get(`/search?q=${encodeURIComponent(term)}`);
        if (mine === token.current) { setResults(r.results); setSel(0); }
      } catch { /* 忽略：输入过程中的失败不打断用户 */ } finally {
        if (mine === token.current) setBusy(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [q]);

  const go = (url: string) => { onClose(); navigate(url); };
  return (
    <Modal onClose={onClose} className="palette">
      <div className="search-box">
        <Search />
        <input
          className="input" autoFocus placeholder="搜索知识、资料、对话、研究、选题…" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter' && results[sel]) go(results[sel].url);
          }}
        />
      </div>
      <div className="palette-results">
        {!q.trim() && <div className="empty compact">输入关键词开始搜索。支持中文，多个词用空格分开。</div>}
        {q.trim() && busy && !results.length && <div className="loading"><Spinner />搜索中…</div>}
        {q.trim() && !busy && !results.length && <div className="empty compact">没有找到与「{q.trim()}」相关的内容</div>}
        {results.map((r, i) => {
          const k = KIND[r.kind] || KIND.knowledge;
          return (
            <button key={r.url + i} className={`list-row ${i === sel ? 'selected' : ''}`} onClick={() => go(r.url)} onMouseEnter={() => setSel(i)}>
              <k.icon className="type-icon" style={{ marginTop: 4 }} />
              <div className="grow">
                <div className="truncate" style={{ fontWeight: 600 }}>{r.title || '（无标题）'}</div>
                <div className="small muted clamp-2"><Snippet text={r.snippet} /></div>
              </div>
              <span className="tag">{k.label}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

export function Shell() {
  const [searching, setSearching] = useState(false);
  const [more, setMore] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const closeSearch = useCallback(() => setSearching(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching((s) => !s); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { mainRef.current?.scrollTo(0, 0); setMore(false); }, [location.pathname]);

  const zone = MODULES.find((m) => m.zone && isActive(m, location.pathname))?.zone;
  const secondary = MODULES.slice(MOBILE_PRIMARY);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <button className="btn ghost icon" onClick={() => setSearching(true)} aria-label="搜索"><Search /></button>
      </header>

      <aside className="sidebar">
        <Brand />
        <nav aria-label="主导航">
          {MODULES.map((m) => (
            <div key={m.id}>
              {m.section && <div className="nav-section">{m.section}</div>}
              <Link to={m.path} className={`nav-item ${isActive(m, location.pathname) ? 'active' : ''}`} title={m.label} aria-current={isActive(m, location.pathname) ? 'page' : undefined}>
                <m.icon /><span>{m.label}</span>
              </Link>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="nav-item" onClick={() => setSearching(true)} title="搜索">
            <Search /><span>搜索</span><span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
          </button>
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title="设置">
            <SettingsIcon /><span>设置</span>
          </NavLink>
        </div>
      </aside>

      <main className={`main ${zone ? `${zone}-zone` : ''}`} ref={mainRef}>
        <Suspense fallback={<div className="page"><Loading /></div>}>
          <Outlet />
        </Suspense>
      </main>

      <nav className="mobile-nav" aria-label="主导航">
        {MODULES.slice(0, MOBILE_PRIMARY).map((m) => (
          <Link key={m.id} to={m.path} className={isActive(m, location.pathname) ? 'active' : ''}>
            <m.icon /><span>{m.short || m.label}</span>
          </Link>
        ))}
        <button onClick={() => setMore(true)} className={secondary.some((m) => isActive(m, location.pathname)) || location.pathname.startsWith('/settings') ? 'active' : ''}>
          <MoreHorizontal /><span>更多</span>
        </button>
      </nav>

      {more && (
        <Modal title="更多" onClose={() => setMore(false)}>
          <div className="modal-body" style={{ paddingBottom: 20 }}>
            <div className="list">
              {[...secondary, { id: 'settings', path: '/settings', label: '设置', icon: SettingsIcon }].map((m) => (
                <Link key={m.id} to={m.path} className="list-row"><m.icon className="type-icon" /><span>{m.label}</span></Link>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {searching && <SearchPalette onClose={closeSearch} />}
    </div>
  );
}
