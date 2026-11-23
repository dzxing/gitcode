'use strict'
// Git launches this helper as an editor, never with renderer-provided commands.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const [mode, file] = process.argv.slice(2)
const planPath = process.env.GITCODE_REBASE_PLAN
if (!file || !['sequence', 'message'].includes(mode)) process.exit(1)
const plan =
  planPath && fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : null
if (mode === 'sequence') {
  if (!Array.isArray(plan?.steps)) process.exit(1)
  fs.writeFileSync(file, plan.steps.map((step) => `${step.type} ${step.sha}\n`).join(''))
} else {
  // Git's editor templates contain comment/status lines. Build the message
  // from the actual replayed commits (and our explicit reword input), then use
  // whitespace cleanup so user-authored # lines are never mistaken for them.
  const git = (...args) => {
    const result = spawnSync(
      process.env.GITCODE_REBASE_GIT,
      ['--no-pager', '-c', 'color.ui=false', ...args],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    )
    if (result.error || result.status !== 0) throw Error('无法读取重放提交的说明。')
    return result.stdout.trim()
  }
  try {
    const done = git('rev-parse', '--git-path', 'rebase-merge/done')
    const entries = fs
      .readFileSync(path.resolve(done), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const fields = line.trim().split(/\s+/)
        const sha = fields.find(
          (field, i) => i > 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(field),
        )
        return { type: fields[0], sha, replace: fields[1] === '-c' || fields[1] === '-C' }
      })
      .filter((entry) => entry.type !== 'drop')
    const last = entries.at(-1)
    if (!last?.sha || !['pick', 'reword', 'squash', 'fixup'].includes(last.type))
      throw Error('当前重放步骤不能安全生成提交说明，请在终端核对后继续。')
    let start = entries.length - 1
    while (start > 0 && ['squash', 'fixup'].includes(entries[start].type)) start--
    let messages = []
    for (const entry of entries.slice(start)) {
      if (!entry.sha) throw Error('重放提交记录不完整。')
      if (entry.type === 'fixup' && !entry.replace) continue
      const step = plan?.steps?.find((item) => item.sha === entry.sha)
      const message =
        entry.type === 'reword' && step?.type === 'reword'
          ? step.message.trim()
          : git(
              'show',
              '--no-patch',
              '--no-notes',
              '--no-show-signature',
              '--format=%B',
              entry.sha,
              '--',
            )
      if (entry.replace) messages = []
      messages.push(message)
    }
    const message = messages.join('\n\n').trim()
    if (!message) throw Error('提交说明为空，请核对后继续；不能据此跳过补丁。')
    fs.writeFileSync(file, message + '\n')
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
