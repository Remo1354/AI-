import { get, insert, now } from './index';

/** 六个学习方向。颜色取自传统矿物颜料，对应前端设计系统里的 pigment 色板。 */
const DOMAINS = [
  { id: 'english', name: '英语学习', color: 'indigo', icon: 'languages', description: '词汇、阅读、听说与写作' },
  { id: 'art-history', name: '艺术理论与艺术史', color: 'ochre', icon: 'landmark', description: '流派、作品与观看方法' },
  { id: 'digital-art', name: '数字绘画与视觉设计', color: 'carmine', icon: 'palette', description: '造型、色彩、构成与软件技法' },
  { id: 'ai-cs', name: 'AI 与计算机技术', color: 'azurite', icon: 'cpu', description: '模型原理、工具与前沿动态' },
  { id: 'programming', name: '编程与软件开发', color: 'malachite', icon: 'code', description: '语言、工程实践与项目' },
  { id: 'creator', name: '自媒体与内容创作', color: 'gamboge', icon: 'megaphone', description: '选题、表达、运营与复盘' },
];

const CATEGORIES = ['概念与原理', '方法与技巧', '案例与作品', '资料与摘录', '灵感与想法'];

export function seed() {
  const hasDomain = get('SELECT id FROM domains LIMIT 1');
  if (!hasDomain) {
    DOMAINS.forEach((d, i) => insert('domains', { ...d, sort: i, created_at: now() }));
  }
  const hasCategory = get('SELECT id FROM categories LIMIT 1');
  if (!hasCategory) {
    CATEGORIES.forEach((name, i) =>
      insert('categories', { id: `cat${i + 1}`, name, sort: i, created_at: now() }),
    );
  }
}
