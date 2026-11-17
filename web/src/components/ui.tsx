import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, X } from 'lucide-react';
import { useApp } from '../lib/store';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide, className = '' }: {
  title?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // 只在打开时聚焦一次、关闭时把焦点还回去；不随父组件重渲染反复抢焦点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=file]):not([hidden]), textarea, select, button');
    first?.focus();
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="btn ghost icon sm" onClick={onClose} aria-label="关闭"><X /></button>
          </div>
        )}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      {label && <span className="label">{label}</span>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Empty({ title, children, compact }: { title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export const Loading = ({ label = '加载中…' }: { label?: string }) => (
  <div className="loading"><span className="spinner" />{label}</div>
);

export const Spinner = () => <span className="spinner" />;

export function Tabs<T extends string>({ items, value, onChange }: {
  items: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.id} role="tab" aria-selected={value === it.id} className={`tab ${value === it.id ? 'active' : ''}`} onClick={() => onChange(it.id)}>
          {it.label}
          {it.count !== undefined && <span className="count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function DomainTag({ id }: { id: string | null | undefined }) {
  const { domain } = useApp();
  const d = domain(id);
  if (!d) return null;
  return <span className="tag" data-color={d.color}><i className="dot" />{d.name}</span>;
}

export function DomainSelect({ value, onChange, empty = '不指定方向' }: { value: string | null | undefined; onChange: (v: string) => void; empty?: string }) {
  const { domains } = useApp();
  return (
    <select className="select" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
}

/** 搜索结果摘要：后端用 \u0001 / \u0002 标出命中位置，这里安全地渲染成 <mark>。 */
export function Snippet({ text }: { text?: string | null }) {
  if (!text) return null;
  const parts = text.split(/[\u0001\u0002]/);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

/** AI 尚未配置时的统一提示。放在任何依赖 AI 的功能旁边。 */
export function AiNotice({ compact }: { compact?: boolean }) {
  const { models } = useApp();
  if (models.configured) return null;
  return (
    <div className="banner warn">
      <AlertTriangle />
      <div>
        {compact ? 'AI 功能需要先配置模型。' : '还没有配置 AI 模型，对话、总结、规划等 AI 功能暂时不可用（其余功能不受影响）。'}{' '}
        <Link className="link" to="/settings">去设置 → 模型</Link>
      </div>
    </div>
  );
}

export function PageHead({ eyebrow, title, desc, actions, back }: {
  eyebrow: string; title: ReactNode; desc?: ReactNode; actions?: ReactNode; back?: { to: string; label: string };
}) {
  return (
    <header className="page-head">
      <div className="grow">
        {back && <Link className="back-link" to={back.to}>← {back.label}</Link>}
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function confirmDelete(what: string) {
  return window.confirm(`确定删除${what}吗？此操作无法撤销。`);
}
