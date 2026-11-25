export interface CommitDraft {
  message: string
  description: string
}

function key(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return `gitcode.commitDraft.v1:${/^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized}`
}

export function readCommitDraft(path: string): CommitDraft {
  try {
    const raw = localStorage.getItem(key(path))
    if (raw && raw.length <= 1_000_000) {
      const saved: unknown = JSON.parse(raw)
      if (
        saved &&
        typeof saved === 'object' &&
        'message' in saved &&
        typeof saved.message === 'string' &&
        'description' in saved &&
        typeof saved.description === 'string'
      )
        return { message: saved.message, description: saved.description }
    }
  } catch {
    // A damaged or inaccessible draft must not prevent opening a repository.
  }
  return { message: '', description: '' }
}

export function writeCommitDraft(path: string, draft: CommitDraft) {
  localStorage.setItem(key(path), JSON.stringify(draft))
  // Chromium batches DOMStorage disk writes. Request a flush after the
  // renderer update so a desktop crash can recover recent keystrokes too.
  return Promise.resolve(
    typeof window !== 'undefined' ? window.gitcodeApp?.flushDraftStorage?.() : undefined,
  )
}
