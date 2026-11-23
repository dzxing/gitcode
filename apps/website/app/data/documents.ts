import quickstart from '../../content/quickstart.md?raw'
import gitflow from '../../content/gitflow.md?raw'
import faq from '../../content/faq.md?raw'

export const documents: Record<string, { title: string; description: string; markdown: string }> = {
  quickstart: {
    title: '快速开始',
    description: '安装 GitCode 并打开第一个仓库。',
    markdown: quickstart,
  },
  gitflow: { title: 'GitFlow', description: '配置基础分支，管理功能与发布。', markdown: gitflow },
  faq: { title: '常见问题', description: 'Git 环境、仓库访问与平台支持。', markdown: faq },
}
