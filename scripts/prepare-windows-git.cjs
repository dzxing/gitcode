'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const { spawn } = require('node:child_process')
const release = require('./windows-git.json')

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(file, asset) {
  try {
    if ((await sha256(file)) === asset.sha256) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const url = `https://github.com/git-for-windows/git/releases/download/v${release.version}/${asset.name}`
  console.log(`Downloading verified Git for Windows ${release.version}…`)
  const partial = `${file}.${process.pid}.partial`
  try {
    if (process.platform === 'win32') {
      // Windows curl uses the OS certificate store and honors HTTPS_PROXY;
      // Node fetch does not consistently inherit proxy settings across versions.
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
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
      if (!response.ok || !response.body) throw new Error(`Git 下载失败：HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }))
    }
    if ((await sha256(partial)) !== asset.sha256)
      throw new Error('Git 下载文件的 SHA256 不匹配，停止打包。')
    await fs.rename(partial, file)
  } finally {
    await fs.rm(partial, { force: true })
  }
}

async function run(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', shell: false, windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Git 运行时准备失败：${code}`)),
    )
  })
}

async function prepare(context) {
  if (context.electronPlatformName !== 'win32') return
  if (process.platform !== 'win32')
    throw new Error('内置 Windows Git 的安装包需要在 Windows 或 Windows CI 上构建。')
  const arch =
    typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch]
  const asset = release.assets[arch]
  if (!asset) throw new Error(`没有经过验证的 Windows Git 架构：${context.arch}`)
  const root = context.packager.projectDir
  const cache = path.join(root, '.gitcode-local', 'git-downloads')
  const parent = path.join(root, '.gitcode-local', 'bundled-git')
  await fs.mkdir(cache, { recursive: true })
  await fs.mkdir(parent, { recursive: true })
  const archive = path.join(cache, asset.name)
  await download(archive, asset)
  const temporary = await fs.mkdtemp(path.join(parent, `${arch}-`))
  try {
    await run(archive, ['-y', `-o${temporary}`])
    for (const file of [
      'cmd/git.exe',
      'bin/bash.exe',
      'usr/bin/ssh.exe',
      'usr/bin/sh.exe',
      'LICENSE.txt',
    ])
      await fs.access(path.join(temporary, file))
    let toolchain
    for (const directory of ['ucrt64', 'mingw64', 'clangarm64']) {
      try {
        await fs.access(path.join(temporary, directory, 'libexec/git-core/git-remote-https.exe'))
        toolchain = directory
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    if (!toolchain) throw new Error('PortableGit 缺少 HTTPS 运行工具，停止打包。')
    // Keep the complete upstream distribution, including licenses, certificates,
    // configuration, helpers, shell and credential manager. Never copy only git.exe.
    await fs.writeFile(
      path.join(temporary, 'gitcode-bundle.json'),
      JSON.stringify(
        { ...release, arch, toolchain, archive: asset.name, sha256: asset.sha256 },
        null,
        2,
      ),
    )
    await fs.writeFile(
      path.join(temporary, 'GITCODE-NOTICE.txt'),
      `Git for Windows ${release.version}\nUnmodified PortableGit distribution.\n` +
        `Release and source distribution information: ${release.release}\n` +
        `Git source: ${release.source}\n` +
        'See LICENSE.txt and the included component license notices for licensing and source information.\n',
    )
    const destination = path.join(parent, arch)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(temporary, destination)
    console.log(`Bundled Git ${release.version} (${arch}) with complete runtime and licenses.`)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

module.exports = prepare
module.exports.sha256 = sha256
