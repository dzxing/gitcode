// Renderer session and notification models; never sent as Git commands.
export interface Notice {
  logId?: string
  details?: string
  expanded?: boolean
  id: number
  text: string
  error: boolean
}
