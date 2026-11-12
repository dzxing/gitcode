'use strict'

async function repositoryLocation(git, shell, clipboard, repo, action) {
  if (!['copy-path', 'show-folder'].includes(action)) throw Error('不支持的仓库位置操作。')
  const root = await git.job((signal) => git.repository(repo, signal))
  if (action === 'copy-path') clipboard.writeText(root)
  else shell.showItemInFolder(root)
}

module.exports = { repositoryLocation }
