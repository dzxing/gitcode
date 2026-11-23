'use strict'
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
module.exports = { sha256 }
