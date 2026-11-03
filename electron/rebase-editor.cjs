'use strict'
// Git launches this helper as an editor, never with renderer-provided commands.
const fs = require('node:fs')
const path = require('node:path')
const [mode, file] = process.argv.slice(2)
const planPath = process.env.GITCODE_REBASE_PLAN
if (!file || !['sequence', 'message'].includes(mode)) process.exit(1)
const plan =
  planPath && fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : null
if (mode === 'sequence') {
  if (!Array.isArray(plan?.steps)) process.exit(1)
  fs.writeFileSync(file, plan.steps.map((step) => `${step.type} ${step.sha}\n`).join(''))
} else if (plan?.steps) {
  const done = path.join(path.dirname(planPath), 'rebase-merge', 'done')
  if (fs.existsSync(done)) {
    const last = fs.readFileSync(done, 'utf8').trim().split('\n').at(-1)?.split(/\s+/)
    if (last?.[0] === 'reword') {
      const step = plan.steps.find((item) => item.sha === last[1])
      if (!step?.message?.trim()) process.exit(1)
      fs.writeFileSync(file, step.message.trim() + '\n')
    }
  }
}
