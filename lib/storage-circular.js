var fs = require('fs')
var path = require('path')
var mkdirp = require('mkdirp')
var crypto = require('crypto')

function noop() {}

var SENTINEL_BUFFER_FS = Buffer.from('fs')

module.exports = function (dir, torrent, opts, engine) {
  var that = {}
  var piecesFolder = path.join(dir, 'pieces')

  function piecePath(idx) {
    return path.join(piecesFolder, idx + '')
  }

  opts = Object.assign(
    {
      type: 'memory',
      size: 31457280
    },
    opts
  )

  if (opts.type !== 'memory' && opts.type !== 'fs') {
    throw new Error('storage-circular: only memory and fs type supported')
  }

  function writePieceToFS(p) {
    fs.writeFile(piecePath(p.idx), p.buf, function (err) {
      if (!err) {
        p.buf = SENTINEL_BUFFER_FS
      }
    })
  }

  if (opts.type === 'fs') {
    if (!fs.existsSync(piecesFolder)) {
      mkdirp.sync(piecesFolder)
    }
  }

  that.read = function (index, cb) {
    var p = find(index)
    if (p) {
      p.atime = new Date()
      if (p.buf === SENTINEL_BUFFER_FS) {
        fs.readFile(piecePath(p.idx), cb)
      } else {
        cb(null, p.buf)
      }
    } else {
      cb(new Error('piece not found in circular buf'))
    }
  }

  that.write = function (index, buffer) {
    if (pieces.length) {
      var idx
      var oldest
      var p =
        find(index) ||
        pieces.find(function (p) {
          return !p.buf
        })

      if (!p) {
        oldest = null
        pieces.forEach(function (p) {
          if (p.buf && p.committed) {
            if (
              !isPieceSelected(p.idx) &&
              !(function (pIdx) {
                return engine.lockedPieces.indexOf(pIdx) > -1
              })(p.idx)
            ) {
              if (!oldest || oldest.atime.getTime() > p.atime.getTime()) {
                oldest = p
              }
            }
          }
        })

        p = oldest
        if (!p) {
          throw new Error(
            'circular buf is full, unable to free; unfreeable pieces: ' +
              pieces
                .filter(function (p) {
                  return !p.committed || isPieceSelected(p.idx)
                })
                .map(function (p) {
                  return p.idx + (p.committed ? '' : ' (uncommitted)')
                })
                .join(', ')
          )
        }

        if (p.buf === SENTINEL_BUFFER_FS) {
          idx = p.idx
          fs.unlink(piecePath(idx), function () {})
        }
        engine.resetPiece(p.idx)
      }

      p.buf = buffer
      p.idx = index
      p.atime = new Date()
    }
  }

  that.commit = function (start, end, cb) {
    cb = cb || noop
    for (var i = start; i <= end; i++) {
      var p = find(i)
      if (p) {
        p.committed = true
        if (opts.type === 'fs') {
          writePieceToFS(p)
        }
      }
    }
    cb(null, true)
  }

  that.verify = function (index, map) {
    var ratio = torrent.verificationLen
      ? torrent.verificationLen / torrent.pieceLength
      : 1
    var real = Math.floor(index / ratio)
    var start = real * ratio
    var end = Math.min(torrent.pieces.length, (real + 1) * ratio)
    var hash = crypto.createHash('sha1')

    for (var i = start; i !== end; i++) {
      if (!engine.bitfield.get(i)) {
        return null
      }
      var p = find(i)
      if (!p) {
        return null
      }
      hash.update(p.buf)
    }

    return {
      success: hash.digest('hex') === map[real],
      start: start,
      end: end
    }
  }

  that.close = function (cb) {
    cb = cb || noop
    pieces = []
    cb()
  }

  var pieces = []
  for (var i = 0; i !== Math.floor(opts.size / torrent.pieceLength); i++) {
    pieces.push(new Piece())
  }

  function Piece() {
    this.idx = undefined
    this.buf = undefined
    this.committed = new Date(0)
    this.atime = undefined
  }

  function find(idx) {
    return pieces.find(function (p) {
      return p.idx === idx
    })
  }

  function isPieceSelected(p) {
    for (var i = 0; i < engine.selection.length; i++) {
      var sel = engine.selection[i]
      if (
        sel.hasOwnProperty('selectTo') &&
        p >= sel.readFrom &&
        p <= sel.selectTo
      ) {
        return true
      }
    }
    return false
  }

  return that
}
