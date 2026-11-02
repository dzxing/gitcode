import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { inflateRawSync } from 'node:zlib'

const destination = fileURLToPath(new URL('../public/fonts/', import.meta.url))
const base = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
const cascadiaRelease =
  'https://github.com/microsoft/cascadia-code/releases/download/v2407.24/CascadiaCode-2407.24.zip'
const fonts = [
  {
    family: 'Cascadia Mono',
    file: 'CascadiaMono.woff2',
    entry: 'woff2/CascadiaMono.woff2',
    license: 'cascadia-OFL.txt',
    style: 'normal',
    weight: '200 700',
    format: 'woff2',
  },
  {
    family: 'Cascadia Mono',
    file: 'CascadiaMonoItalic.woff2',
    entry: 'woff2/CascadiaMonoItalic.woff2',
    license: 'cascadia-OFL.txt',
    style: 'italic',
    weight: '200 700',
    format: 'woff2',
  },
  {
    family: 'Inter',
    directory: 'inter',
    source: 'Inter[opsz,wght].ttf',
    file: 'Inter-Variable.ttf',
    license: 'inter-OFL.txt',
    style: 'normal',
    weight: '100 900',
    format: 'truetype',
  },
  {
    family: 'Noto Sans SC',
    directory: 'notosanssc',
    source: 'NotoSansSC[wght].ttf',
    file: 'NotoSansSC-Variable.ttf',
    license: 'notosanssc-OFL.txt',
    style: 'normal',
    weight: '100 900',
    format: 'truetype',
  },
]
const staging = await mkdtemp(path.join(os.tmpdir(), 'gitcode-fonts-'))
const manifest = []
let previous = []
try {
  previous = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))
} catch {
  /* First install. */
}
let archivePromise
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

// Read only named entries; no archive paths are written to the filesystem.
function unzipEntry(archive, suffix) {
  let end = archive.length - 22
  const minimum = Math.max(0, archive.length - 65557)
  while (end >= minimum && archive.readUInt32LE(end) !== 0x06054b50) end--
  if (end < minimum) throw new Error('Cascadia 发布包缺少 ZIP 目录')
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Cascadia ZIP 目录损坏')
    const flags = archive.readUInt16LE(offset + 8),
      method = archive.readUInt16LE(offset + 10)
    const compressed = archive.readUInt32LE(offset + 20),
      expanded = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28),
      extraLength = archive.readUInt16LE(offset + 30),
      commentLength = archive.readUInt16LE(offset + 32)
    const local = archive.readUInt32LE(offset + 42)
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name === suffix || name.endsWith('/' + suffix)) {
      if (flags & 1 || expanded > 20 * 1024 * 1024) throw new Error('Cascadia ZIP 文件无效')
      if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Cascadia ZIP 文件头损坏')
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
      const bytes = archive.subarray(start, start + compressed)
      const result =
        method === 0
          ? bytes
          : method === 8
            ? inflateRawSync(bytes, { maxOutputLength: expanded })
            : null
      if (!result || result.length !== expanded) throw new Error('Cascadia ZIP 字体解压失败')
      return result
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`Cascadia 发布包中没有 ${suffix}`)
}

function cascadiaArchive() {
  archivePromise ||= process.env.GITCODE_CASCADIA_ARCHIVE
    ? readFile(process.env.GITCODE_CASCADIA_ARCHIVE)
    : download(cascadiaRelease)
  return archivePromise
}
try {
  for (const font of fonts) {
    const url = font.entry
      ? `${cascadiaRelease}#${font.entry}`
      : `${base}${font.directory}/${encodeURIComponent(font.source)}`
    let data, license
    const cached = previous.find((item) => item.file === font.file && item.source === url)
    if (cached) {
      try {
        const bytes = await readFile(path.join(destination, font.file))
        if (createHash('sha256').update(bytes).digest('hex') === cached.sha256) {
          data = bytes
          license = await readFile(path.join(destination, font.license))
        }
      } catch {
        /* Download missing resources. */
      }
    }
    if (!data || !license) {
      console.log(`下载 ${font.family} (${font.style})…`)
      if (font.entry) {
        const archive = await cascadiaArchive()
        data = unzipEntry(archive, font.entry)
        try {
          license = unzipEntry(archive, 'LICENSE')
        } catch {
          license = await download(
            'https://raw.githubusercontent.com/microsoft/cascadia-code/v2407.24/LICENSE',
          )
        }
      } else {
        data = await download(url)
        license = await download(`${base}${font.directory}/OFL.txt`)
      }
    } else console.log(`复用已校验的 ${font.family} (${font.style})`)
    const signature = font.format === 'woff2' ? 0x774f4632 : 0x00010000
    if (data.length < 10000 || data.readUInt32BE(0) !== signature)
      throw new Error(`${font.family} 不是有效的 ${font.format} 字体`)
    if (!license.toString('utf8').includes('SIL OPEN FONT LICENSE'))
      throw new Error(`${font.family} 缺少授权文件`)
    await writeFile(path.join(staging, font.file), data)
    await writeFile(path.join(staging, font.license), license)
    manifest.push({
      family: font.family,
      file: font.file,
      source: url,
      style: font.style,
      weight: font.weight,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
    })
  }
  await mkdir(destination, { recursive: true })
  for (const font of fonts) {
    for (const file of [font.file, font.license]) {
      // Write into the target directory, then rename on the same filesystem.
      const pending = path.join(destination, `${file}.pending`)
      await writeFile(pending, await readFile(path.join(staging, file)))
      await rename(pending, path.join(destination, file))
    }
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const css =
    fonts
      .map(
        (font) =>
          `@font-face {\n  font-family: '${font.family}';\n  src: url('./${font.file}') format('${font.format}');\n  font-style: ${font.style};\n  font-weight: ${font.weight};\n  font-display: swap;\n}`,
      )
      .join('\n\n') + '\n'
  // Activate only after every font and license is present.
  await writeFile(path.join(destination, 'ui-fonts.css.pending'), css)
  await rename(
    path.join(destination, 'ui-fonts.css.pending'),
    path.join(destination, 'ui-fonts.css'),
  )
  console.log(
    'Cascadia Mono、后备字体及 OFL 授权已保存到 public/fonts，可离线使用。微软雅黑优先调用系统字体。',
  )
} catch (error) {
  console.error(
    `字体安装失败：${error.message}。请在可联网的终端重新执行 bun run fonts:install。现有字体配置保持可用。`,
  )
  process.exitCode = 1
} finally {
  await rm(staging, { recursive: true, force: true })
}
