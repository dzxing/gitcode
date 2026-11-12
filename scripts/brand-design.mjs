// Optical small-size version of the supplied GitCode G + branch identity.
// The detailed desktop artwork is assets/brand/logo-master.png.
export const palette = {
  graphiteTop: [17, 35, 64],
  graphiteBottom: [9, 18, 36],
  ivory: [240, 247, 255],
  cyan: [0, 226, 235],
  blue: [0, 109, 255],
  violet: [142, 65, 247],
}
export const glyphScale = 1
export const outline = [
  ['M', 45.5, 22],
  ['L', 34, 14.5],
  ['C', 32.7, 13.6, 31.3, 13.6, 30, 14.5],
  ['L', 17, 23],
  ['C', 15.7, 23.9, 15, 25.2, 15, 27],
  ['L', 15, 40],
  ['C', 15, 41.7, 15.7, 42.9, 17, 43.8],
  ['L', 30, 52],
  ['C', 31.3, 52.9, 32.7, 52.9, 34, 52],
  ['L', 47.5, 43.5],
  ['C', 48.9, 42.6, 49, 41.4, 49, 39.5],
  ['L', 49, 35],
  ['L', 39, 35],
]
export const routes = [
  [
    ['M', 27, 33],
    ['L', 35, 26.7],
  ],
  [
    ['M', 27, 33],
    ['L', 35, 39.3],
  ],
]
export const junction = { x: 27, y: 33, radius: 2.7 }
export const endpoints = [
  { x: 35, y: 26.7 },
  { x: 35, y: 39.3 },
]
export const pathData = (commands) =>
  commands.map(([command, ...values]) => command + values.join(' ')).join(' ')
export function flatten(commands, steps = 32) {
  const points = []
  let x = 0,
    y = 0
  for (const [command, ...v] of commands) {
    if (command === 'M' || command === 'L') {
      ;[x, y] = v
      points.push([x, y])
    }
    if (command === 'C') {
      const ax = x,
        ay = y
      for (let i = 1; i <= steps; i++) {
        const t = i / steps,
          u = 1 - t
        points.push([
          u * u * u * ax + 3 * u * u * t * v[0] + 3 * u * t * t * v[2] + t * t * t * v[4],
          u * u * u * ay + 3 * u * u * t * v[1] + 3 * u * t * t * v[3] + t * t * t * v[5],
        ])
      }
      x = v[4]
      y = v[5]
    }
  }
  return points
}
export function circle(cx, cy, r, steps = 96) {
  return Array.from({ length: steps }, (_, i) => [
    cx + Math.cos((i / steps) * Math.PI * 2) * r,
    cy + Math.sin((i / steps) * Math.PI * 2) * r,
  ])
}
export function roundedTile() {
  return [
    [48, 16],
    [48, 48],
    [16, 48],
    [16, 16],
  ].flatMap(([x, y], corner) =>
    Array.from({ length: 65 }, (_, i) => {
      const angle = -Math.PI / 2 + (corner * Math.PI) / 2 + ((i / 64) * Math.PI) / 2
      return [x + 14 * Math.cos(angle), y + 14 * Math.sin(angle)]
    }),
  )
}
export const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="tile" x2="0" y2="1"><stop stop-color="#112340"/><stop offset="1" stop-color="#091224"/></linearGradient><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="6" x2="54" y2="50"><stop stop-color="#00e2eb"/><stop offset=".52" stop-color="#006dff"/><stop offset="1" stop-color="#8e41f7"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#tile)"/><path d="${pathData(outline)}" stroke="url(#g)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><g stroke="#f0f7ff" stroke-width="2.6" stroke-linecap="round">${routes.map((route) => `<path d="${pathData(route)}"/>`).join('')}</g><circle cx="27" cy="33" r="2.7" fill="#f0f7ff"/>${endpoints.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.8" stroke="#f0f7ff" stroke-width="1.8" fill="#0d1b32"/>`).join('')}</svg>\n`
