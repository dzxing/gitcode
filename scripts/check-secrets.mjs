import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const version = '8.30.1'
const root = fileURLToPath(new URL('../', import.meta.url))
const releases = {
  'linux-x64': [
    'linux_x64.tar.gz',
    '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  ],
  'linux-arm64': [
    'linux_arm64.tar.gz',
    'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  ],
  'darwin-x64': [
    'darwin_x64.tar.gz',
    'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  ],
  'darwin-arm64': [
    'darwin_arm64.tar.gz',
    'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  ],
  'win32-x64': [
    'windows_x64.zip',
    'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
  ],
  'win32-arm64': [
    'windows_arm64.zip',
    'b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f',
  ],
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return result
}

export function scanArguments(mode, repo, config, ignoreFile) {
  if (!['staged', 'history'].includes(mode)) throw new Error('Use staged or history scan mode.')
  return [
    'git',
    repo,
    ...(mode === 'staged' ? ['--pre-commit', '--staged'] : ['--log-opts=--all']),
    '--config',
    config,
    '--gitleaks-ignore-path',
    ignoreFile,
    '--ignore-gitleaks-allow',
    '--redact=100',
    '--no-banner',
    '--no-color',
    '--exit-code=10',
    '--timeout=300',
  ]
}

export async function ensureScanner() {
  const release = releases[`${process.platform}-${process.arch}`]
  if (!release) throw new Error(`Unsupported scanner platform: ${process.platform}/${process.arch}`)
  const directory = path.join(
    root,
    '.gitcode-local',
    'tools',
    'gitleaks',
    version,
    `${process.platform}-${process.arch}`,
  )
  const executableName = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'
  const executable = path.join(directory, executableName)
  try {
    const result = run(executable, ['version'])
    if (result.status === 0 && result.stdout.trim() === version) return executable
  } catch {
    // The first scan installs the pinned official binary, never an arbitrary PATH binary.
  }
  await mkdir(directory, { recursive: true })
  const temporary = await mkdtemp(path.join(directory, '.install-'))
  try {
    const [suffix, expected] = release
    const asset = `gitleaks_${version}_${suffix}`
    console.log(`Installing Gitleaks ${version}; official archive SHA256 will be verified.`)
    const response = await fetch(
      `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}`,
      {
        signal: AbortSignal.timeout(120_000),
      },
    )
    if (!response.ok) throw new Error(`Scanner download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error('Scanner archive checksum mismatch; refusing to execute it.')
    const archive = path.join(temporary, asset)
    await writeFile(archive, bytes)
    const extracted = run('tar', ['-xf', archive, '-C', temporary, executableName])
    if (extracted.status !== 0) throw new Error('Cannot extract scanner; tar is required.')
    const candidate = path.join(temporary, executableName)
    await chmod(candidate, 0o755)
    const result = run(candidate, ['version'])
    if (result.status !== 0 || result.stdout.trim() !== version)
      throw new Error('Downloaded scanner version did not match the pinned version.')
    await rename(candidate, executable)
    return executable
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function scan(mode, repo = root, config = path.join(root, '.gitleaks.toml')) {
  // Missing config/tool/network is an error, never a successful empty scan.
  await readFile(config)
  const scanner = await ensureScanner()
  const ignoreFile = path.join(path.dirname(scanner), 'empty.gitleaksignore')
  await writeFile(ignoreFile, '')
  const result = run(
    scanner,
    scanArguments(mode, path.resolve(repo), path.resolve(config), ignoreFile),
    {
      cwd: repo,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  )
  if (result.status !== 0)
    throw new Error(
      result.status === 10
        ? 'Sensitive data detected. Remove it before committing; rotate real credentials if exposed.'
        : 'Secret scan could not complete. Resolve the scanner error before committing.',
    )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = 'history', repo = root, config = path.join(root, '.gitleaks.toml')] =
      process.argv.slice(2)
    if (mode === 'install') await ensureScanner()
    else await scan(mode, repo, config)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
