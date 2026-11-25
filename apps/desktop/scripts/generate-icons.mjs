// Deterministic PNG/ICO/ICNS from the approved transparent tile, using Node builtins.
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const out = new URL('../assets/', import.meta.url)
const web = new URL('../public/brand/', import.meta.url)
mkdirSync(out, { recursive: true })
mkdirSync(web, { recursive: true })
const u32 = (value) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name, bytes) {
  const data = Buffer.concat([Buffer.from(name), bytes])
  return Buffer.concat([u32(bytes.length), data, u32(crc32(data))])
}
const rasterRows = new Map()
function encodePng(size, rows) {
  rasterRows.set(size, rows)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
// Decode the checked-in production PNG with standard PNG row filters.
// No external tools, browser or image library is needed when rebuilding icons.
function decodeMaster() {
  const bytes = readFileSync(new URL(import.meta.resolve('@gitcode/brand/assets/logo-master.png')))
  let width, height, channels
  const parts = []
  for (let p = 8; p < bytes.length;) {
    const n = bytes.readUInt32BE(p),
      kind = bytes.toString('ascii', p + 4, p + 8),
      data = bytes.subarray(p + 8, p + 8 + n)
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[12] !== 0)
        throw Error('Master must be a non-interlaced RGB/RGBA 8-bit PNG')
      channels = data[9] === 6 ? 4 : 3
    }
    if (kind === 'IDAT') parts.push(data)
    p += n + 12
  }
  if (width !== height) throw Error('Logo master must be square')
  const raw = inflateSync(Buffer.concat(parts)),
    stride = width * channels,
    pixels = Buffer.alloc(width * height * 4)
  let prior = Buffer.alloc(stride)
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    if (filter > 4) throw Error('Invalid PNG filter')
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0,
        b = prior[x],
        c = x >= channels ? prior[x - channels] : 0
      row[x] = (row[x] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        j = x * channels
      pixels[i] = row[j]
      pixels[i + 1] = row[j + 1]
      pixels[i + 2] = row[j + 2]
      pixels[i + 3] = channels === 4 ? row[j + 3] : 255
    }
    prior = row
  }
  return { width, pixels }
}
function detailedPng(size, master) {
  const rows = Buffer.alloc(size * (size * 4 + 1)),
    ratio = master.width / size
  // Area resampling in premultiplied alpha avoids dark fringes.
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0],
        x0 = x * ratio,
        x1 = (x + 1) * ratio,
        y0 = y * ratio,
        y1 = (y + 1) * ratio
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const weight =
            (Math.min(sx + 1, x1) - Math.max(sx, x0)) * (Math.min(sy + 1, y1) - Math.max(sy, y0))
          const i =
              (Math.min(master.width - 1, sy) * master.width + Math.min(master.width - 1, sx)) * 4,
            a = master.pixels[i + 3] * weight
          for (let c = 0; c < 3; c++) sum[c] += master.pixels[i + c] * a
          sum[3] += a
        }
      const i = y * (size * 4 + 1) + 1 + x * 4
      for (let c = 0; c < 3; c++) rows[i + c] = sum[3] ? Math.round(sum[c] / sum[3]) : 0
      rows[i + 3] = Math.round(sum[3] / (ratio * ratio))
    }
  return encodePng(size, rows)
}
const master = decodeMaster()
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
const images = new Map(sizes.map((size) => [size, detailedPng(size, master)]))
writeFileSync(new URL('icon.png', out), images.get(512))
for (const size of sizes) writeFileSync(new URL(`icon-${size}.png`, web), images.get(size))
// Explicit 32-bit DIB entries retain alpha and support native Win32 readers
// and older small-icon decoders without PNG-in-ICO assumptions.
function iconBitmap(size) {
  const maskStride = Math.ceil(size / 32) * 4
  const xorLength = size * size * 4
  const data = Buffer.alloc(40 + xorLength + maskStride * size)
  data.writeUInt32LE(40, 0)
  data.writeInt32LE(size, 4)
  data.writeInt32LE(size * 2, 8)
  data.writeUInt16LE(1, 12)
  data.writeUInt16LE(32, 14)
  data.writeUInt32LE(xorLength + maskStride * size, 20)
  const rows = rasterRows.get(size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const from = y * (size * 4 + 1) + 1 + x * 4
      const to = 40 + ((size - 1 - y) * size + x) * 4
      data[to] = rows[from + 2]
      data[to + 1] = rows[from + 1]
      data[to + 2] = rows[from]
      data[to + 3] = rows[from + 3]
      if (!rows[from + 3])
        data[40 + xorLength + (size - 1 - y) * maskStride + (x >> 3)] |= 1 << (7 - (x % 8))
    }
  return data
}
const icoSizes = sizes.filter((size) => size <= 256)
const iconEntries = icoSizes.map((size) => iconBitmap(size))
const header = Buffer.alloc(6 + icoSizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)
let offset = header.length
for (const [index, size] of icoSizes.entries()) {
  const i = 6 + index * 16,
    entry = iconEntries[index]
  header[i] = header[i + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, i + 4)
  header.writeUInt16LE(32, i + 6)
  header.writeUInt32LE(entry.length, i + 8)
  header.writeUInt32LE(offset, i + 12)
  offset += entry.length
}
const ico = Buffer.concat([header, ...iconEntries])
writeFileSync(new URL('icon.ico', out), ico)
writeFileSync(new URL('favicon.ico', web), ico)
const types = [
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]
const entries = types.map(([type, size]) =>
  Buffer.concat([Buffer.from(type), u32(images.get(size).length + 8), images.get(size)]),
)
writeFileSync(
  new URL('icon.icns', out),
  Buffer.concat([
    Buffer.from('icns'),
    u32(8 + entries.reduce((sum, b) => sum + b.length, 0)),
    ...entries,
  ]),
)
console.log(`Generated GitCode ${icoSizes.length}-resolution ICO, PNG 16–1024 and ICNS.`)
