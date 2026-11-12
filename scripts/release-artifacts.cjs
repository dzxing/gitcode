'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')

async function archiveReleaseArtifacts(root, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version))
    throw Error('无效的发布版本号。')
  const output = path.join(root, 'release', version)
  const entries = await fs.readdir(output, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const artifacts = entries.filter(
    (entry) =>
      entry.isFile() &&
      /\.(?:exe|msi|dmg|zip|appimage|deb|rpm|yml|yaml|blockmap)$/i.test(entry.name),
  )
  if (!artifacts.length) return null
  const history = path.join(output, 'history')
  await fs.mkdir(history, { recursive: true })
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const archive = await fs.mkdtemp(path.join(history, stamp + '-'))
  for (const artifact of artifacts)
    await fs.copyFile(path.join(output, artifact.name), path.join(archive, artifact.name))
  await fs.writeFile(
    path.join(archive, 'archive.json'),
    JSON.stringify(
      {
        version,
        archivedAt: new Date().toISOString(),
        files: artifacts.map((entry) => entry.name),
      },
      null,
      2,
    ) + '\n',
  )
  return archive
}
module.exports = { archiveReleaseArtifacts }
