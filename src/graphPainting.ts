import type { buildHistoryGraph, GraphNavigationArrow } from './graph'

export interface GraphViewport {
  ratio: number
  scaleX: number
  scaleY: number
  phaseX: number
  phaseY: number
}
export const defaultGraphViewport: GraphViewport = {
  ratio: 1,
  scaleX: 1,
  scaleY: 1,
  phaseX: 0,
  phaseY: 0,
}

// SVG and reference guides share a single physical-pixel grid. A one-device-
// pixel stroke needs a half-pixel center; an even stroke needs an integer center.
export function graphPaint(viewport: GraphViewport = defaultGraphViewport) {
  const sx = Math.max(0.1, viewport.ratio * viewport.scaleX)
  const sy = Math.max(0.1, viewport.ratio * viewport.scaleY)
  const pixels = Math.max(1, Math.round(1.75 * sx))
  const parity = (pixels % 2) / 2
  const rounded = (value: number) => Math.round(value * 10000) / 10000
  const x = (value: number) =>
    rounded((Math.round(value * sx + viewport.phaseX - parity) + parity - viewport.phaseX) / sx)
  const y = (value: number) =>
    rounded((Math.round(value * sy + viewport.phaseY - parity) + parity - viewport.phaseY) / sy)
  const radius = (value: number) => rounded(Math.round(value * sx) / sx)
  return {
    x,
    y,
    lineWidth: rounded(pixels / sx),
    arrowWidth: rounded(Math.max(1, Math.round(sx)) / sx),
    radius: radius(4.5),
    // Leave visible breathing room around a merge ring instead of joining
    // its outline into a heavy double border when the row is selected.
    selectionRadius: radius(8.5),
    selectionWidth: rounded(Math.max(1, Math.round(sx)) / sx),
  }
}

export function paintHistoryGraph(
  graph: ReturnType<typeof buildHistoryGraph>,
  viewport: GraphViewport,
) {
  const paint = graphPaint(viewport)
  const point = <T extends { x: number; y: number }>(node: T): T => ({
    ...node,
    x: paint.x(node.x),
    y: paint.y(node.y),
  })
  const path = (d: string) =>
    d
      .replace(/([MLV])([^MLV]*)/g, (_, command: string, raw: string) => {
        const values = raw.trim().split(/[ ,]+/).map(Number)
        return command === 'V'
          ? `V${paint.y(values[0])} `
          : `${command}${paint.x(values[0])} ${paint.y(values[1])} `
      })
      .trim()
  return {
    ...graph,
    nodes: graph.nodes.map(point),
    worktree: point(graph.worktree),
    stashNodes: graph.stashNodes.map(point),
    edges: graph.edges.map((edge) => ({ ...edge, d: path(edge.d) })),
    stashEdges: graph.stashEdges.map((edge) => ({ ...edge, d: path(edge.d) })),
    arrows: graph.arrows.map((arrow) => ({
      ...point(arrow),
      fromX: paint.x(arrow.fromX),
      fromY: paint.y(arrow.fromY),
      otherX: paint.x(arrow.otherX),
      otherY: paint.y(arrow.otherY),
    })),
  }
}

// As in IDEA's painter, the arrowhead follows the visible edge direction.
export function graphArrowPath(arrow: Pick<GraphNavigationArrow, 'x' | 'y' | 'fromX' | 'fromY'>) {
  const distance = Math.hypot(arrow.x - arrow.fromX, arrow.y - arrow.fromY) || 1
  const dx = (arrow.x - arrow.fromX) / distance,
    dy = (arrow.y - arrow.fromY) / distance
  // Keep the arrow ornament at IDEA's compact 22px reference scale while
  // the product's row height, lines and nodes retain their chosen weight.
  const length = 0.3 * 22
  const backX = arrow.x - dx * Math.sqrt(0.7) * length,
    backY = arrow.y - dy * Math.sqrt(0.7) * length
  const wing = Math.sqrt(0.3) * length
  const number = (value: number) => Math.round(value * 10000) / 10000
  return `M${number(backX - dy * wing)} ${number(backY + dx * wing)} L${arrow.x} ${arrow.y} L${number(backX + dy * wing)} ${number(backY - dx * wing)}`
}

// This ellipse is equivalent to IDEA isOverEdge's sum-of-distances test.
export function graphArrowHit(arrow: GraphNavigationArrow, thickness: number) {
  const dx = arrow.otherX - arrow.fromX,
    dy = arrow.otherY - arrow.fromY
  const distance = Math.hypot(dx, dy)
  return {
    cx: (arrow.fromX + arrow.otherX) / 2,
    cy: (arrow.fromY + arrow.otherY) / 2,
    rx: (distance + thickness) / 2,
    ry: Math.sqrt(2 * distance * thickness + thickness * thickness) / 2,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  }
}
