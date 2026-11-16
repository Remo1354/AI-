const pad = (n: number) => String(n).padStart(2, '0');

/** 用户本地日期 YYYY-MM-DD。所有「今天」都以浏览器所在时区为准，并显式传给后端。 */
export function localDate(offsetDays = 0, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const parseDate = (date: string) => new Date(`${date}T00:00:00`);

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function longDate(date: string): string {
  const d = parseDate(date);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEK[d.getDay()]}`;
}

/** 日期的相对说法：今天 / 明天 / 3 天前 / 11 月 20 日 */
export function dayLabel(date: string | null | undefined): string {
  if (!date) return '';
  const diff = Math.round((parseDate(date).getTime() - parseDate(localDate()).getTime()) / 86400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff > 1 && diff < 7) return `${diff} 天后`;
  if (diff < -1 && diff > -7) return `${-diff} 天前`;
  const d = parseDate(date);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()} 年 `}${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 时间戳（ISO）的相对说法 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return dayLabel(localDate(0, new Date(t)));
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function minutes(m: number | null | undefined): string {
  const n = Math.round(m || 0);
  if (n < 60) return `${n} 分钟`;
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

export function hours(m: number | null | undefined): string {
  const h = (m || 0) / 60;
  return h >= 10 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, '');
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function chars(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export const percent = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);
