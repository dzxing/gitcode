'use strict'

const labels = {
  'Counting objects': '统计对象',
  'Compressing objects': '压缩对象',
  'Receiving objects': '接收对象',
  'Resolving deltas': '解析增量',
  'Updating files': '更新工作文件',
  'Writing objects': '发送对象',
  'Checking out files': '检出工作文件',
}

// Report Git's percentage for the named phase, never an invented total percent.
function progressParser(update) {
  let tail = ''
  return (chunk) => {
    tail = (tail + chunk.toString('utf8')).slice(-8192)
    const expression =
      /(?:^|[\r\n])(?:remote: )?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Writing objects|Checking out files):\s+(\d{1,3})%/g
    let match
    while ((match = expression.exec(tail))) {
      const percent = Number(match[2])
      if (percent <= 100) update({ phase: labels[match[1]], percent })
    }
    const boundary = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('\r'))
    if (boundary >= 0) tail = tail.slice(boundary)
  }
}

module.exports = { progressParser }
