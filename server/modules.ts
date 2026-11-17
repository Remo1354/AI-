/**
 * 工作区模块注册表 —— Remo AI Workspace 的后端扩展点。
 *
 * 每个模块是一组挂在 /api 下的路由。新增模块（例如本地文件管理、Agent 自动化）的步骤：
 *   1. 在 server/db/migrations/ 新增一个按编号递增的 .sql 文件（只增不改已有迁移）；
 *   2. 在 server/routes/ 写路由文件，需要 AI 时调用 server/ai/service.ts 的 complete / streamChat；
 *   3. 在下面登记一项；
 *   4. 前端在 web/src/modules.tsx 登记页面。
 * 模块之间通过数据库中的外键和 server/lib 里的服务函数协作，不互相引用路由文件。
 */
import type { Hono } from 'hono';
import { systemRoutes } from './routes/system';
import { aiRoutes } from './routes/ai';
import { chatRoutes } from './routes/chat';
import { documentRoutes } from './routes/documents';
import { knowledgeRoutes } from './routes/knowledge';
import { learningRoutes } from './routes/learning';
import { cardRoutes } from './routes/cards';
import { researchRoutes } from './routes/research';
import { studioRoutes } from './routes/studio';

export interface ServerModule {
  id: string;
  name: string;
  routes: Hono;
}

export const MODULES: ServerModule[] = [
  { id: 'system', name: '总览与数据备份', routes: systemRoutes },
  { id: 'ai', name: '模型接入与调用记录', routes: aiRoutes },
  { id: 'assistant', name: 'AI 助手', routes: chatRoutes },
  { id: 'documents', name: '资料与文件', routes: documentRoutes },
  { id: 'knowledge', name: '知识库与搜索', routes: knowledgeRoutes },
  { id: 'learning', name: '学习中心', routes: learningRoutes },
  { id: 'cards', name: '复习卡片', routes: cardRoutes },
  { id: 'research', name: '研究实验室', routes: researchRoutes },
  { id: 'studio', name: '内容创作中心', routes: studioRoutes },
];
