import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { api, ApiError } from './api';

export interface Domain { id: string; name: string; description: string; color: string; icon: string; sort: number }
export interface Category { id: string; name: string; count: number }
export interface ModelOption { ref: string; providerId: string; providerName: string; model: string; label: string }
export interface Models { configured: boolean; default: string | null; options: ModelOption[] }
export type Theme = 'auto' | 'light' | 'dark';

interface AppState {
  domains: Domain[];
  categories: Category[];
  models: Models;
  theme: Theme;
  setTheme: (t: Theme) => void;
  refresh: () => Promise<void>;
  domain: (id: string | null | undefined) => Domain | undefined;
  toast: (message: string, kind?: 'ok' | 'error') => void;
  /** 统一处理接口错误：弹出提示。返回 true 表示已处理。 */
  fail: (err: unknown) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
};

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151412' : '#f5f2ea');
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [models, setModels] = useState<Models>({ configured: false, default: null, options: [] });
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('remo-theme') as Theme) || 'auto');
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: 'ok' | 'error' }[]>([]);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const [d, c, m] = await Promise.all([api.get<Domain[]>('/domains'), api.get<Category[]>('/categories'), api.get<Models>('/ai/models')]);
    setDomains(d);
    setCategories(c);
    setModels(m);
  }, []);
  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'auto') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('auto');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem('remo-theme', t);
    setThemeState(t);
  }, []);

  const toast = useCallback((message: string, kind: 'ok' | 'error' = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 2600);
  }, []);

  const fail = useCallback((err: unknown) => {
    const message = err instanceof ApiError ? err.message : (err as Error)?.message || '操作失败';
    toast(message, 'error');
  }, [toast]);

  const value = useMemo<AppState>(() => ({
    domains, categories, models, theme, setTheme, refresh, toast, fail,
    domain: (id) => domains.find((d) => d.id === id),
  }), [domains, categories, models, theme, setTheme, refresh, toast, fail]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.kind === 'error' ? <AlertCircle /> : <Check />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** 轻量数据加载 hook：返回数据、加载状态、错误和重新加载函数。 */
export function useData<T>(fetcher: () => Promise<T>, deps: DependencyList = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const fn = useRef(fetcher);
  fn.current = fetcher;
  const token = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++token.current;
    try {
      const d = await fn.current();
      if (mine === token.current) { setData(d); setError(null); }
      return d;
    } catch (err) {
      if (mine === token.current) setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', (err as Error).message));
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, setData, error, loading, reload };
}

/** 包装一个异步操作：维护 busy 状态，失败时统一提示。 */
export function useAction() {
  const { fail } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      fail(err);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [fail]);
  return { busy, run };
}
