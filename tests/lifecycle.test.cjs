const test = require('node:test')
const assert = require('node:assert/strict')
const { OperationLog } = require('../electron/operation-log.cjs')
const { ApplicationLifecycle } = require('../electron/lifecycle.cjs')

test('startup diagnostics measure actual stages, preserve partial attempts, and reject unknown phases', () => {
  let now = 1000
  const log = new OperationLog({ now: () => now })
  const lifecycle = new ApplicationLifecycle(log, () => now)
  lifecycle.stage('renderer-start')
  now += 40
  lifecycle.stage('core-ready')
  now += 250
  lifecycle.stage('restore-start')
  now += 300
  lifecycle.stage('failed')
  assert.equal(log.records[0].state, 'partial')
  assert.match(log.records[0].output, /阶段 40ms/)
  assert.match(log.records[0].output, /累计 590ms/)
  lifecycle.stage('renderer-start')
  now += 60
  lifecycle.stage('ready')
  assert.equal(log.records.length, 2)
  assert.equal(log.records[1].state, 'succeeded')
  assert.equal(log.records[1].duration, 60)
  assert.throws(() => lifecycle.stage('git push'), /无效的启动阶段/)
  assert.throws(() => lifecycle.stage({ phase: 'ready' }), /无效的启动阶段/)
})
