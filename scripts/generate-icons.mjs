// Generates the code-native GitCode icon without external image tooling.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const out = new URL('../assets/', import.meta.url)
mkdirSync(out, { recursive: true })
const u32 = (value) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name, bytes) {
  const data = Buffer.concat([Buffer.from(name), bytes])
  return Buffer.concat([u32(bytes.length), data, u32(crc32(data))])
}
function segment(x, y, ax, ay, bx, by) {
  const t = Math.max(
    0,
    Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
  )
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))
}
function png(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = ((x + 0.5) / size) * 512,
        py = ((y + 0.5) / size) * 512
      const dx = Math.max(Math.abs(px - 256) - 150, 0),
        dy = Math.max(Math.abs(py - 256) - 150, 0)
      const alpha = Math.max(0, Math.min(1, ((82 - Math.hypot(dx, dy)) * size) / 512 + 0.5))
      const circles = [
        [177, 151],
        [177, 361],
        [335, 151],
      ]
      const ring = circles.some(([cx, cy]) => Math.abs(Math.hypot(px - cx, py - cy) - 29) < 10)
      const line =
        segment(px, py, 177, 181, 177, 332) < 10 ||
        segment(px, py, 335, 181, 335, 211) < 10 ||
        segment(px, py, 335, 211, 315, 244) < 10 ||
        segment(px, py, 315, 244, 278, 263) < 10 ||
        segment(px, py, 278, 263, 177, 263) < 10
      const idx = y * (size * 4 + 1) + 1 + x * 4
      rows.set(
        ring || line
          ? [86, 214, 187, Math.round(alpha * 255)]
          : [27, 35, 42, Math.round(alpha * 255)],
        idx,
      )
    }
  const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const small = png(256)
writeFileSync(new URL('icon.png', out), png(512))
const ico = Buffer.alloc(22)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(small.length, 14)
ico.writeUInt32LE(22, 18)
writeFileSync(new URL('icon.ico', out), Buffer.concat([ico, small]))
const icns = [
  chunkIcns('ic07', png(128)),
  chunkIcns('ic08', small),
  chunkIcns('ic09', png(512)),
  chunkIcns('ic10', png(1024)),
]
function chunkIcns(name, bytes) {
  return Buffer.concat([Buffer.from(name), u32(bytes.length + 8), bytes])
}
writeFileSync(
  new URL('icon.icns', out),
  Buffer.concat([
    Buffer.from('icns'),
    u32(8 + icns.reduce((sum, b) => sum + b.length, 0)),
    ...icns,
  ]),
)
console.log('Generated GitCode PNG / ICO / ICNS icons.')
