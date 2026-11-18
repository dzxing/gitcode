'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createWriteStream } = require('node:fs')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const { sha256 } = require('./file-hash.cjs')
const release = require('./wsl-node.json')

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(Error(`WSL 运行时准备失败：${code}`)),
    )
  })
}
async function prepareRuntime(root, arch) {
  const asset = release.assets[arch]
  if (!asset) throw Error(`不支持的 WSL 运行时架构：${arch}`)
  const cache = path.join(root, '.gitcode-local/wsl-downloads')
  const parent = path.join(root, '.gitcode-local/wsl-runtime')
  await fs.mkdir(cache, { recursive: true })
  await fs.mkdir(parent, { recursive: true })
  const archive = path.join(cache, asset.name)
  const cached = await sha256(archive).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  if (cached !== asset.sha256) {
    const partial = archive + `.${process.pid}.partial`
    try {
      const url = release.source + asset.name
      if (process.platform === 'win32')
        await run('curl.exe', [
          '--fail',
          '--location',
          '--silent',
          '--show-error',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--retry',
          '2',
          '--connect-timeout',
          '20',
          '--max-time',
          '300',
          '--output',
          partial,
          url,
        ])
      else {
        const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
        if (!response.ok || !response.body)
          throw Error(`WSL 运行时下载失败：HTTP ${response.status}`)
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }))
      }
      if ((await sha256(partial)) !== asset.sha256)
        throw Error('WSL 运行时 SHA256 不匹配，停止打包。')
      await fs.rename(partial, archive)
    } finally {
      await fs.rm(partial, { force: true })
    }
  }
  const temporary = await fs.mkdtemp(path.join(parent, arch + '-'))
  try {
    const prefix = asset.name.replace(/\.tar\.gz$/, '')
    await run(process.platform === 'win32' ? 'tar.exe' : 'tar', [
      '-xzf',
      archive,
      '-C',
      temporary,
      '--strip-components',
      '1',
      `${prefix}/bin/node`,
      `${prefix}/LICENSE`,
    ])
    const binary = path.join(temporary, 'bin/node')
    const handle = await fs.open(binary, 'r')
    const header = Buffer.alloc(20)
    try {
      await handle.read(header, 0, header.length, 0)
    } finally {
      await handle.close()
    }
    if (
      header.subarray(0, 4).toString('hex') !== '7f454c46' ||
      header.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)
    )
      throw Error('WSL 运行时不是目标架构的 Linux ELF 文件。')
    await fs.chmod(binary, 0o755)
    await fs.writeFile(
      path.join(temporary, 'runtime.json'),
      JSON.stringify(
        {
          version: release.version,
          arch,
          archiveSha256: asset.sha256,
          nodeSha256: await sha256(binary),
        },
        null,
        2,
      ) + '\n',
    )
    const destination = path.join(parent, arch)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}
async function prepare(context) {
  if (context.electronPlatformName !== 'win32') return
  const arch =
    typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch]
  await prepareRuntime(context.packager.projectDir, arch)
}
module.exports = prepare
module.exports.prepareRuntime = prepareRuntime
