var fs = require('fs')
var path = require('path')
var async = require('async')
var Bagpipe = require('bagpipe')
var crypto = require('crypto')

function noop() {}

module.exports = function (dir, torrent, opts, engine) {
  var that = {}
  opts = Object.assign(
    {
      storageMemoryCache: false
    },
    opts
  )

  var files = torrent.files.map(function (file, index) {
    var fd
    var destPath = path.join(dir, index + '')

    function openFile() {
      if (dests[index] && destPath !== dests[index]) {
        if (fd) {
          fs.close(fd, function () {})
        }
        fd = null
        destPath = dests[index]
      }
      fd = fd || fs.openSync(destPath, fs.existsSync(destPath) ? 'r+' : 'w+')
    }

    return {
      byteStart: file.offset,
      byteEnd: file.offset + file.length,
      read: function (offset, len, cb) {
        if (!fd && !fs.existsSync(destPath)) {
          return cb(new Error('File does not exist: ' + destPath))
        }
        openFile()
        fs.read(fd, Buffer.alloc(len), 0, len, offset, function (err, _, buf) {
          cb(err, buf)
        })
      },
      write: function (buf, bufOffset, bufLen, offset, cb) {
        openFile()
        if (bufOffset + bufLen > buf.length) {
          return cb(
            new Error(
              'bufOffset+bufLen > buf.length: ' +
                bufOffset +
                ' ' +
                bufLen +
                ' / ' +
                buf.length
            )
          )
        }
        fs.write(fd, buf, bufOffset, bufLen, offset, cb)
      },
      close: function (cb) {
        if (fd === undefined || fd === null) {
          return process.nextTick(cb)
        }
        fs.close(fd, cb)
        fd = null
      }
    }
  })

  var writequeue = (that.writequeue = new Bagpipe(1))
  var pieceLength = torrent.pieceLength
  var lastFile = torrent.files[torrent.files.length - 1]

  that.read = function (index, cb) {
    if (memHas(index)) {
      return cb(null, memGet(index))
    }
    var len = pieceLength
    if (index === torrent.pieces.length - 1) {
      len = Math.min(len, (lastFile.length + lastFile.offset) % pieceLength)
    }
    var byteStart = index * pieceLength
    var byteEnd = byteStart + len
    var result = null

    async.each(
      files,
      function (dest, innerCb) {
        var start = Math.max(byteStart, dest.byteStart)
        var end = Math.min(byteEnd, dest.byteEnd)
        if (start >= end) {
          return innerCb()
        }
        var readStart = Math.max(0, byteStart - dest.byteStart)
        var readLen = end - start
        if (readLen === 0) {
          return innerCb()
        }
        dest.read(readStart, readLen, function (err, buf) {
          if (buf) {
            if (buf.length === len && files.length === 1) {
              result = buf
              return innerCb()
            }
            result = result || Buffer.alloc(len)
            buf.copy(result, Math.max(0, dest.byteStart - byteStart))
          }
          innerCb(err)
        })
      },
      function (err) {
        cb(err, result)
      }
    )
  }

  that.write = function (index, buffer) {
    var i
    var buf
    buf = buffer
    i = index
    if (!memBumpLru(i)) {
      lru.push(i)
    }
    mem[i] = buf

    // Use filter to avoid modifying array while iterating
    if (
      opts.storageMemoryCache &&
      lru.length > opts.storageMemoryCache / pieceLength
    ) {
      lru = lru.filter(function (idx) {
        if (!isNaN(idx) && mem[idx] && mem[idx].free) {
          mem[idx] = null
          return false
        }
        return true
      })
    }
  }

  that.commit = function (start, end, cb) {
    cb = cb || noop
    var pieces = []
    for (var i = start; i <= end; i++) {
      pieces.push(i)
    }
    async.each(
      pieces,
      function (i) {
        var byteStart = i * pieceLength
        var byteEnd = byteStart + pieceLength
        async.each(
          files,
          function (dest, innerCb) {
            var start = Math.max(byteStart, dest.byteStart)
            var end = Math.min(byteEnd, dest.byteEnd)
            if (start >= end) {
              return innerCb()
            }
            writequeue.push(
              dest.write,
              memGet(i),
              Math.max(start - byteStart, 0),
              Math.min(end - start, pieceLength),
              Math.max(0, byteStart - dest.byteStart),
              innerCb
            )
          },
          function (err) {
            if (err) {
              return cb(err)
            }
            ;(function (i) {
              if (opts.storageMemoryCache) {
                if (mem[i]) {
                  mem[i].free = true
                }
              } else {
                mem[i] = null
              }
            })(i)
            cb()
          }
        )
      },
      cb
    )
  }

  that.verify = function (index, map) {
    var ratio = torrent.verificationLen
      ? torrent.verificationLen / torrent.pieceLength
      : 1
    var real = Math.floor(index / ratio)
    var start = real * ratio
    var end = Math.min(torrent.pieces.length, (real + 1) * ratio)

    for (var i = start; i !== end; i++) {
      if (!memHas(i) || !engine.bitfield.get(i)) {
        return null
      }
    }

    var hash = crypto.createHash('sha1')
    for (i = start; i !== end; i++) {
      hash.update(memGet(i))
    }

    return {
      success: hash.digest('hex') === map[real],
      start: start,
      end: end
    }
  }

  that.close = function (cb) {
    cb = cb || noop
    writequeue.push(function (cb) {
      async.eachSeries(
        files,
        function (file, next) {
          file.close(next)
        },
        cb
      )
    }, cb)
  }

  var dests = []
  that.setDest = function (i, path) {
    dests[i] = path
  }

  that.getDest = function (i) {
    return dests[i] || path.join(dir, i + '')
  }

  that.memoryBufSize = function () {
    var len = 0
    mem.forEach(function (x) {
      if (x) {
        len += torrent.pieceLength
      }
    })
    return len
  }

  var mem = []
  var lru = []

  function memBumpLru(i) {
    var idx = lru.indexOf(i)
    if (idx > -1) {
      lru.splice(idx, 1)
      lru.push(i)
      return true
    }
  }

  function memHas(i) {
    return !!mem[i]
  }

  function memGet(i) {
    memBumpLru(i)
    return mem[i]
  }

  return that
}
