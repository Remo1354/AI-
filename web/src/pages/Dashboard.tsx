import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUp, Check, ChevronRight, FileText, Flame, Layers, MessageSquareText, Plus, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { dayLabel, greeting, hours, localDate, longDate, minutes, parseDate, percent, timeAgo } from '../lib/format';
import { useApp, useData } from '../lib/store';
import { AiNotice, Empty, Loading } from '../components/ui';
import { LogModal } from './Learning';

const RESEARCH_STATUS: Record<string, string> = { collecting: '收集资料', analyzing: '分析中', writing: '撰写中', done: '已完成' };

function heatLevel(m: number) {
  if (m <= 0) return 0;
  if (m < 30) return 1;
  if (m < 60) return 2;
  if (m < 120) return 3;
  return 4;
}

export function Dashboard() {
  const date = localDate();
  const { domain, models, fail } = useApp();
  const navigate = useNavigate();
  const { data, reload, loading } = useData(() => api.get(`/dashboard?date=${date}`), [date]);
  const [ask, setAsk] = useState('');
  const [logging, setLogging] = useState(false);

  const startChat = async () => {
    const text = ask.trim();
    try {
      const conv = await api.post('/conversations', {});
      navigate(`/assistant/${conv.id}`, { state: text ? { draft: text, send: models.configured } : undefined });
    } catch (err) { fail(err); }
  };

  const toggleTask = async (t: any) => {
    try {
      await api.patch(`/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done', date });
      reload();
    } catch (err) { fail(err); }
  };

  if (loading && !data) return <div className="page"><Loading /></div>;
  if (!data) return <div className="page"><Empty title="暂时无法加载总览">请确认服务正在运行后刷新页面。</Empty></div>;

  const { stats } = data;
  const open = data.tasks_today.filter((t: any) => t.status !== 'done');
  const doneToday = data.tasks_today.length - open.length;
  const activeDomains = stats.domains.filter((d: any) => d.tasks_total || d.minutes_total || d.active_plans);

  return (
    <div className="page">
      <section className="dash-hero">
        <div>
          <div className="eyebrow">{longDate(date)}</div>
          <h1>{greeting()}，Remo</h1>
          <div className="dash-stats">
            <div>
              <div className="stat-value">{stats.streak}<small>天</small></div>
              <div className="stat-label row" style={{ gap: 4 }}><Flame size={13} />连续学习</div>
            </div>
            <div>
              <div className="stat-value">{stats.minutes_today}<small>分钟</small></div>
              <div className="stat-label">今日已学</div>
            </div>
            <div>
              <div className="stat-value">{hours(stats.minutes_7d)}<small>小时</small></div>
              <div className="stat-label">近 7 天</div>
            </div>
            <div>
              <div className="stat-value">{data.knowledge.total}<small>条</small></div>
              <div className="stat-label">知识库{data.knowledge.added_7d ? ` · 本周 +${data.knowledge.added_7d}` : ''}</div>
            </div>
          </div>
        </div>
        <div className="stack sm">
          <div className="ask-box">
            <textarea
              rows={2} value={ask} placeholder="问问学习助手：解释一个概念、总结资料、制定计划…" aria-label="向 AI 助手提问"
              onChange={(e) => setAsk(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); startChat(); } }}
            />
            <div className="ask-foot">
              <span className="xs faint row" style={{ gap: 5 }}>
                <Sparkles size={13} />{models.configured ? data.ai.default?.label : '尚未配置模型'}
              </span>
              <button className="btn accent sm" onClick={startChat}>{ask.trim() ? '提问' : '打开助手'}<ArrowUp /></button>
            </div>
          </div>
          <AiNotice compact />
        </div>
      </section>

      <div className="dash-grid">
        <section className="card c7">
          <div className="card-head">
            <h2 className="card-title">今日任务 <span className="count">{open.length ? `${open.length} 项待完成` : doneToday ? '全部完成' : ''}</span></h2>
            <Link className="card-link" to="/learning">学习中心<ChevronRight /></Link>
          </div>
          <div className="card-body flush">
            {data.cards.due > 0 && (
              <Link to="/learning?tab=review" className="list-row" style={{ background: 'var(--accent-tint)', margin: '0 0 6px' }}>
                <Layers className="type-icon" style={{ color: 'var(--accent-ink)' }} />
                <span className="grow"><b>{data.cards.due}</b> 张卡片今天到期，花几分钟复习一下</span>
                <ChevronRight size={15} />
              </Link>
            )}
            {!data.tasks_today.length && (
              <Empty compact title="今天没有安排任务">
                在学习计划里给任务设定日期，它们会在当天出现在这里。<br />
                <Link className="btn sm" to="/learning"><Plus />安排学习</Link>
              </Empty>
            )}
            {data.tasks_today.slice(0, 8).map((t: any) => {
              const d = domain(t.effective_domain_id);
              const overdue = t.status !== 'done' && t.due_date && t.due_date < date;
              return (
                <div key={t.id} className="task-row">
                  <button className={`check ${t.status === 'done' ? 'done' : ''}`} onClick={() => toggleTask(t)} aria-label={t.status === 'done' ? '标记为未完成' : '标记为完成'}><Check /></button>
                  <div className="grow">
                    <div className={`task-title ${t.status === 'done' ? 'done' : ''}`}>{t.title}</div>
                    <div className="task-meta">
                      {d && <span className="row" style={{ gap: 5 }} data-color={d.color}><i className="dot" />{d.name}</span>}
                      {t.plan_title && <Link to={`/learning/plans/${t.plan_id}`} className="truncate">{t.plan_title}</Link>}
                      {t.estimate_min ? <span>约 {minutes(t.estimate_min)}</span> : null}
                      {overdue && <span className="overdue">逾期 · {dayLabel(t.due_date)}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {data.tasks_today.length > 8 && <Link className="list-row small muted" to="/learning">还有 {data.tasks_today.length - 8} 项…</Link>}
          </div>
        </section>

        <section className="card c5">
          <div className="card-head">
            <h2 className="card-title">学习节奏 <span className="count">近 28 天</span></h2>
            <button className="btn sm" onClick={() => setLogging(true)}><Plus />记录学习</button>
          </div>
          <div className="card-body stack">
            <div className="heat" role="img" aria-label={`近 28 天学习时长，共 ${minutes(stats.minutes_28d)}`}>
              {stats.days.map((d: any) => (
                <button
                  key={d.date} className={`heat-cell ${d.date === date ? 'today' : ''}`} data-level={heatLevel(d.minutes)} tabIndex={-1}
                  data-tip={`${parseDate(d.date).getMonth() + 1}/${parseDate(d.date).getDate()} · ${d.minutes ? minutes(d.minutes) : '未记录'}`}
                />
              ))}
            </div>
            <div className="row between">
              <span className="small muted">累计 {minutes(stats.minutes_28d)}</span>
              <span className="heat-legend">少{[0, 1, 2, 3, 4].map((l) => <i key={l} style={{ background: `var(--wash-${l})` }} />)}多</span>
            </div>
          </div>
        </section>

        <section className="card c7">
          <div className="card-head">
            <h2 className="card-title">当前学习项目</h2>
            <Link className="card-link" to="/learning?tab=plans">全部计划<ChevronRight /></Link>
          </div>
          <div className="card-body flush">
            {!data.plans.length && (
              <Empty compact title="还没有进行中的学习计划">
                可以自己建立，也可以让 AI 根据目标帮你拆出一条路线。<br />
                <Link className="btn sm" to="/learning?tab=plans&new=1"><Sparkles />制定学习计划</Link>
              </Empty>
            )}
            {data.plans.map((p: any) => {
              const d = domain(p.domain_id);
              return (
                <Link key={p.id} to={`/learning/plans/${p.id}`} className="list-row" data-color={d?.color}>
                  <div className="grow">
                    <div className="row between">
                      <span className="truncate" style={{ fontWeight: 600 }}>{p.title}</span>
                      <span className="xs faint num">{p.tasks_done}/{p.tasks_total} · {percent(p.tasks_done, p.tasks_total)}%</span>
                    </div>
                    <div className="progress" style={{ margin: '7px 0 5px' }}><span style={{ width: `${percent(p.tasks_done, p.tasks_total)}%` }} /></div>
                    <div className="xs faint truncate">{p.next_task ? `下一步：${p.next_task}` : '所有任务已完成'}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="card c5">
          <div className="card-head">
            <h2 className="card-title">各领域进度</h2>
            <span className="xs faint">任务完成度 · 近 7 天时长</span>
          </div>
          <div className="card-body flush">
            {stats.domains.map((d: any) => (
              <Link key={d.id} to={`/learning?tab=plans&domain=${d.id}`} className="domain-row" data-color={d.color} title={`${d.name}：完成 ${d.tasks_done}/${d.tasks_total} 项任务，累计学习 ${minutes(d.minutes_total)}`}>
                <span className="row" style={{ gap: 8 }}><i className="dot" /><span className="truncate">{d.name}</span></span>
                <div className="progress"><span style={{ width: `${percent(d.tasks_done, d.tasks_total)}%` }} /></div>
                <span className="meta">{d.tasks_total ? `${percent(d.tasks_done, d.tasks_total)}%` : '—'} · {d.minutes_7d ? `${hours(d.minutes_7d)}h` : '0h'}</span>
              </Link>
            ))}
            {!activeDomains.length && <p className="xs faint" style={{ padding: '4px 12px 8px' }}>建立学习计划或记录学习后，这里会显示每个方向的进展。</p>}
          </div>
        </section>

        <section className="card c4">
          <div className="card-head">
            <h2 className="card-title">最近学习记录</h2>
            <Link className="card-link" to="/learning?tab=logs">全部<ChevronRight /></Link>
          </div>
          <div className="card-body">
            {!data.recent_logs.length && <Empty compact title="还没有学习记录">学完之后花十秒记一笔，积累会看得见。</Empty>}
            {data.recent_logs.map((l: any) => (
              <div key={l.id} className="log-item" data-color={domain(l.domain_id)?.color}>
                <div className="xs faint">{dayLabel(l.date)}{l.minutes ? ` · ${minutes(l.minutes)}` : ''}{domain(l.domain_id) ? ` · ${domain(l.domain_id)!.name}` : ''}</div>
                <div className="small clamp-2">{l.content || l.plan_title || '（未填写内容）'}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="card c4">
          <div className="card-head">
            <h2 className="card-title">知识库新增</h2>
            <Link className="card-link" to="/knowledge">知识库<ChevronRight /></Link>
          </div>
          <div className="card-body flush">
            {!data.knowledge.recent.length && <Empty compact title="知识库还是空的">写一条笔记、上传一份资料，或把 AI 的回答存进来。</Empty>}
            {data.knowledge.recent.map((k: any) => (
              <Link key={k.id} to={`/knowledge/${k.id}`} className="list-row" data-color={domain(k.domain_id)?.color}>
                <i className="dot" />
                <div className="grow">
                  <div className="truncate">{k.title}</div>
                  <div className="xs faint">{timeAgo(k.created_at)}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="card c4">
          <div className="card-head">
            <h2 className="card-title">研究项目</h2>
            <Link className="card-link" to="/research">实验室<ChevronRight /></Link>
          </div>
          <div className="card-body flush">
            {!data.research.length && <Empty compact title="没有进行中的研究">想系统弄清一个问题时，在研究实验室里开一个项目。</Empty>}
            {data.research.map((r: any) => (
              <Link key={r.id} to={`/research/${r.id}`} className="list-row">
                <div className="grow">
                  <div className="truncate">{r.title}</div>
                  <div className="xs faint">{RESEARCH_STATUS[r.status]} · {r.source_count} 个来源 · {r.finding_count} 条发现{r.report_count ? ` · ${r.report_count} 份报告` : ''}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="card c6">
          <div className="card-head">
            <h2 className="card-title">最近使用的资料</h2>
            <Link className="card-link" to="/knowledge?type=document">全部资料<ChevronRight /></Link>
          </div>
          <div className="card-body flush">
            {!data.documents.length && <Empty compact title="还没有上传资料">支持 PDF、DOCX、TXT、Markdown。上传后可以让 AI 基于资料答疑。</Empty>}
            {data.documents.map((d: any) => (
              <Link key={d.id} to={`/knowledge?doc=${d.id}`} className="list-row">
                <FileText className="type-icon" />
                <div className="grow">
                  <div className="truncate">{d.title}</div>
                  <div className="xs faint">{d.ext.replace('.', '').toUpperCase()}{d.pages ? ` · ${d.pages} 页` : ''} · {timeAgo(d.last_used_at || d.created_at)}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="card c6">
          <div className="card-head">
            <h2 className="card-title">继续对话</h2>
            <Link className="card-link" to="/assistant">AI 助手<ChevronRight /></Link>
          </div>
          <div className="card-body flush">
            {!data.conversations.length && <Empty compact title="还没有对话">在上方输入问题，开始第一次对话。</Empty>}
            {data.conversations.map((c: any) => (
              <Link key={c.id} to={`/assistant/${c.id}`} className="list-row">
                <MessageSquareText className="type-icon" />
                <div className="grow truncate">{c.title}</div>
                <span className="xs faint">{timeAgo(c.updated_at)}</span>
              </Link>
            ))}
            {(data.studio.upcoming.length > 0 || data.studio.in_progress > 0) && (
              <Link to="/studio" className="list-row" style={{ borderTop: '1px solid var(--line)', borderRadius: 0, marginTop: 4 }}>
                <div className="grow small muted">
                  叠绘工作室：{data.studio.in_progress} 个选题制作中
                  {data.studio.upcoming[0] ? `，下一次发布「${data.studio.upcoming[0].title}」${dayLabel(data.studio.upcoming[0].publish_date)}` : ''}
                </div>
                <ArrowRight size={15} />
              </Link>
            )}
          </div>
        </section>
      </div>

      {logging && <LogModal onClose={() => setLogging(false)} onSaved={() => { setLogging(false); reload(); }} />}
    </div>
  );
}
