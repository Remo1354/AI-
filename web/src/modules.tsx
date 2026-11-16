/**
 * 工作区模块注册表 —— Remo AI Workspace 的前端扩展点。
 *
 * 新增一个模块（例如「文件」「自动化」）只需要：
 *   1. 在 pages/ 下写页面组件；
 *   2. 在这里登记一项（导航名称、图标、路由）；
 *   3. 后端在 server/modules.ts 登记对应的路由文件，并按需新增数据库迁移。
 * 导航栏、手机底栏和路由表都由这份列表生成，不需要改动外壳代码。
 */
import type { ReactNode } from 'react';
import { BookOpen, FlaskConical, GraduationCap, LayoutDashboard, Layers, MessageSquareText, type LucideIcon } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Assistant } from './pages/Assistant';
import { Knowledge, KnowledgeDetail } from './pages/Knowledge';
import { Learning, PlanDetail } from './pages/Learning';
import { Research, ResearchDetail } from './pages/Research';
import { Studio, TopicDetail } from './pages/Studio';

export interface WorkspaceModule {
  id: string;
  label: string;
  /** 手机底栏使用的短名称 */
  short?: string;
  icon: LucideIcon;
  /** 导航入口路径 */
  path: string;
  /** 侧栏分组标题，显示在这一项的上方 */
  section?: string;
  /** 使用独立视觉分区的模块（目前只有内容创作的「叠绘工作室」） */
  zone?: 'studio';
  routes: { path: string; element: ReactNode }[];
}

export const MODULES: WorkspaceModule[] = [
  {
    id: 'dashboard', label: '总览', icon: LayoutDashboard, path: '/',
    routes: [{ path: '/', element: <Dashboard /> }],
  },
  {
    id: 'assistant', label: 'AI 助手', short: '助手', icon: MessageSquareText, path: '/assistant', section: '学习',
    routes: [{ path: '/assistant/:id?', element: <Assistant /> }],
  },
  {
    id: 'knowledge', label: '知识库', icon: BookOpen, path: '/knowledge',
    routes: [{ path: '/knowledge', element: <Knowledge /> }, { path: '/knowledge/:id', element: <KnowledgeDetail /> }],
  },
  {
    id: 'learning', label: '学习中心', short: '学习', icon: GraduationCap, path: '/learning',
    routes: [{ path: '/learning', element: <Learning /> }, { path: '/learning/plans/:id', element: <PlanDetail /> }],
  },
  {
    id: 'research', label: '研究实验室', short: '研究', icon: FlaskConical, path: '/research', section: '研究与创作',
    routes: [{ path: '/research', element: <Research /> }, { path: '/research/:id', element: <ResearchDetail /> }],
  },
  {
    id: 'studio', label: '内容创作', short: '创作', icon: Layers, path: '/studio', zone: 'studio',
    routes: [{ path: '/studio', element: <Studio /> }, { path: '/studio/:id', element: <TopicDetail /> }],
  },
];

/** 手机底栏直接展示的模块数量，其余收进「更多」。 */
export const MOBILE_PRIMARY = 4;

export const isActive = (m: WorkspaceModule, pathname: string) =>
  m.path === '/' ? pathname === '/' : pathname === m.path || pathname.startsWith(`${m.path}/`);
