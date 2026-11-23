import type { Commit, Snapshot } from '../../src/types'

const hash = (n: number) =>
  `${n.toString(16).padStart(7, '0')}8c2de74a91be65f03480c12d6a93f0e24b`
    .slice(0, 40)
    .padEnd(40, '0')
const entries: [string, string, number[], string[]?][] = [
  ['feat: 优化仓库工作台的交互体验', 'Alex Chen', [2], ['HEAD -> main', 'origin/main']],
  ["Merge branch 'feature/commit-graph' into main", 'Alex Chen', [4, 3]],
  ['feat(graph): 支持分支合并曲线与提交节点', 'Lin Wang', [5], ['feature/commit-graph']],
  ['fix: 修复切换仓库后文件列表未刷新的问题', 'Alex Chen', [6]],
  ['feat(graph): 添加提交关系图与分支配色', 'Lin Wang', [6]],
  ["Merge branch 'develop' into main", 'Alex Chen', [9, 7], ['tag: v0.2.0']],
  ['feat: 新增文件差异预览面板', 'Yuki', [8], ['develop', 'origin/develop']],
  ['feat: 支持文件暂存与取消暂存', 'Yuki', [10]],
  ['docs: 更新本地开发与运行指南', 'Alex Chen', [10]],
  ["Merge branch 'feature/workspace' into develop", 'Yuki', [12, 11]],
  ['feat: 添加可拖动的三栏工作区布局', 'Lin Wang', [13], ['feature/workspace']],
  ['style: 统一暗色主题与状态颜色', 'Yuki', [14]],
  ['feat: 实现分支树和仓库切换器', 'Lin Wang', [14]],
  ['feat: 读取 Git 日志和本地分支', 'Alex Chen', [15]],
  ['chore: 配置 TypeScript 与 Vite', 'Alex Chen', [16]],
  ['Initial commit', 'Alex Chen', []],
]
const commits: Commit[] = entries.map(([subject, author, parents, refs], i) => ({
  hash: hash(i + 1),
  parents: parents.map(hash),
  subject,
  author,
  email: `${author.split(' ')[0]?.toLowerCase()}@example.com`,
  date: new Date(Date.now() - (i * 73 + 18) * 60_000).toISOString(),
  refs: refs || [],
}))

export const repositoryFixture: Snapshot = {
  remotes: ['origin'],
  name: 'GitCode',
  path: '~/Projects/GitCode',
  branch: 'main',
  head: hash(1),
  commits,
  total: commits.length,
  branches: [
    {
      name: 'main',
      hash: hash(1),
      current: true,
      upstream: 'origin/main',
      track: '',
      kind: 'local',
    },
    {
      name: 'develop',
      hash: hash(7),
      current: false,
      upstream: 'origin/develop',
      track: '[ahead 2]',
      kind: 'local',
    },
    {
      name: 'feature/commit-graph',
      hash: hash(3),
      current: false,
      upstream: '',
      track: '',
      kind: 'local',
    },
    {
      name: 'feature/workspace',
      hash: hash(11),
      current: false,
      upstream: '',
      track: '',
      kind: 'local',
    },
    { name: 'origin/main', hash: hash(1), current: false, upstream: '', track: '', kind: 'remote' },
    {
      name: 'origin/develop',
      hash: hash(7),
      current: false,
      upstream: '',
      track: '',
      kind: 'remote',
    },
    { name: 'v0.2.0', hash: hash(6), current: false, upstream: '', track: '', kind: 'tag' },
  ],
  unstaged: [
    { path: 'src/components/CommitGraph.vue', status: 'M' },
    { path: 'src/components/Sidebar.vue', status: 'M' },
    { path: 'src/stores/repository.ts', status: 'M' },
    { path: 'src/styles/tokens.css', status: 'M' },
    { path: 'src/composables/useKeyboard.ts', status: '?' },
  ],
  staged: [
    { path: 'README.md', status: 'M' },
    { path: 'src/types/git.ts', status: 'A' },
  ],
}
