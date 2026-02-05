var magnet = require('./lib/magnet')
var hat = require('hat')
var pws = require('peer-wire-swarm')
var bncode = require('bncode')
var bitfield = require('bitfield')
var parseTorrent = require('parse-torrent')
var mkdirp = require('mkdirp')
var rimraf = require('rimraf')
var events = require('events')
var path = require('path')
var fs = require('fs')
var os = require('os')
var eos = require('end-of-stream')
var Bagpipe = require('bagpipe')
var debounce = require('lodash.debounce')

var blocklist = require('ip-set')
var encode = require('./lib/encode')
var exchangeMetadata = require('./lib/exchange-metadata')
var storage = require('./lib/storage')
var storageCircular = require('./lib/storage-circular')
var fileStream = require('./lib/file-stream')
var piece = require('./lib/piece')

var SPEED_THRESHOLD = piece.BLOCK_SIZE * 3
var TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()

function noop() {}

function thruthy() {
  return true
}

function falsy() {
  return false
}

function toNumber(val) {
  if (val === true) {
    return 1
  } else {
    return val || 0
  }
}

module.exports = function (link, opts) {
  // Parse the link
  if (typeof link === 'string') {
    link = magnet(link)
  } else if (Buffer.isBuffer(link)) {
    link = parseTorrent(link)
  }

  if (!link || !link.infoHash) {
    throw new Error('You must pass a valid torrent or magnet link')
  }

  var infoHash = link.infoHash
  var metadata

  opts = opts || {}
  opts.id = opts.id || '-TS0008-' + hat(48)
  opts.path =
    opts.path ||
    path.join(opts.tmp || TMP, opts.name || 'torrent-stream', infoHash)
  opts.flood = opts.flood || 0
  opts.pulse = opts.pulse || Number.MAX_SAFE_INTEGER

  var verificationLen
  var verificationsCount
  var engine = new events.EventEmitter()
  var swarm = pws(infoHash, opts.id, {
    size: opts.connections || opts.size,
    handshakeTimeout: opts.handshakeTimeout,
    utp: false
  })

  blocklist(opts.blocklist)
  var torrentPath = path.join(opts.path, 'cache')
  var wires = swarm.wires
  var critical = []
  var refresh = noop
  var verifications = null

  engine.infoHash = infoHash
  var rechokeIntervalId
  var rechokeSlots =
    opts.uploads === false || opts.uploads === 0 ? 0 : +opts.uploads || 5
  var rechokeOptimistic = null
  var rechokeOptimisticTime = 0

  engine.path = opts.path
  engine.files = []
  engine.selection = []
  engine.lockedPieces = []
  engine.torrent = null
  engine.bitfield = null
  engine.amInterested = false
  engine.store = null
  engine.swarm = swarm
  engine._flood = opts.flood
  engine.pulse = opts.pulse
  engine.buffer = opts.buffer

  engine.ready = function (cb) {
    if (engine.torrent) {
      process.nextTick(cb)
    } else {
      engine.once('ready', cb)
    }
  }

  function ontorrent(torrent) {
    var lastFile = torrent.files[torrent.files.length - 1]
    verifications = torrent.pieces
    verificationLen = torrent.pieceLength
    verificationsCount = Math.ceil(
      (lastFile.offset + lastFile.length) / verificationLen
    )

    engine.verified = bitfield(
      verificationsCount,
      opts.circularBuffer ? null : path.join(opts.path, 'bitfield')
    )

    if (opts.virtual) {
      var virtualPieceLength =
        torrent.pieceLength > 524288 && torrent.pieceLength % 524288 === 0
          ? 524288
          : torrent.pieceLength
      var pieceCount = Math.ceil(
        (lastFile.offset + lastFile.length) / virtualPieceLength
      )
      torrent.pieceLength = virtualPieceLength
      torrent.verificationLen = verificationLen
      torrent.pieces = []
      for (var i = 0; i !== pieceCount; i++) {
        torrent.pieces.push(0)
      }
    }

    function mapPiece(index) {
      if (opts.virtual) {
        return Math.floor((index * torrent.pieceLength) / verificationLen)
      } else {
        return index
      }
    }

    if (opts.circularBuffer && !opts.buffer) {
      throw new Error('circularBuffer can only be used with buffer')
    }

    engine.store = opts.circularBuffer
      ? storageCircular(opts.path, torrent, opts.circularBuffer, engine)
      : storage(opts.path, torrent, opts, engine)

    engine.torrent = torrent
    engine.bitfield = bitfield(torrent.pieces.length)

    var pieceLength = torrent.pieceLength
    var pieceRemainder = torrent.length % pieceLength || pieceLength

    function getPieceLen(i) {
      if (i === torrent.pieces.length - 1) {
        return pieceRemainder
      } else {
        return pieceLength
      }
    }

    var pieces = (engine.pieces = torrent.pieces.map(function (hash, i) {
      return piece(getPieceLen(i))
    }))

    var reservations = (engine.reservations = torrent.pieces.map(function () {
      return []
    }))

    // Restore state for non-circular buffer
    if (!opts.circularBuffer) {
      for (i = 0; i !== torrent.files.length; i++) {
        if (!fs.existsSync(path.join(opts.path, i + ''))) {
          var file = torrent.files[i]
          var startPiece = (file.offset / verificationLen) | 0
          var endPiece = ((file.offset + file.length - 1) / verificationLen) | 0
          for (var j = startPiece; j <= endPiece; j++) {
            engine.verified.set(j, false)
          }
        }
      }
      for (i = 0; i !== verificationsCount; i++) {
        if (engine.verified.get(i)) {
          var start = Math.floor((i * verificationLen) / torrent.pieceLength)
          var end = Math.floor(
            ((i + 1) * verificationLen) / torrent.pieceLength
          )
          for (j = start; j !== end; j++) {
            pieces[j] = null
            engine.bitfield.set(j, true)
            engine.emit('verify', j)
          }
        }
      }
    }

    torrent.files.forEach(function (f) {
      var sel
      var file = Object.assign({}, f)
      var offsetPiece =
        Math.floor(file.offset / verificationLen) *
        (verificationLen / torrent.pieceLength)
      var endPiece =
        Math.ceil((file.offset + file.length - 1) / verificationLen) *
        (verificationLen / torrent.pieceLength)

      file.deselect = function () {
        engine.deselect(sel)
      }

      file.select = function () {
        sel = engine.select(offsetPiece, endPiece, false)
      }

      file.createReadStream = function (opts) {
        var stream = fileStream(engine, file, opts)
        eos(stream, function () {
          engine.deselect(stream.selection)
        })
        return stream
      }

      engine.files.push(file)
    })

    function oninterestchange() {
      var prev = engine.amInterested
      engine.amInterested = !!engine.selection.length

      wires.forEach(function (wire) {
        if (engine.amInterested) {
          wire.interested()
        } else {
          wire.uninterested()
        }
      })

      if (prev !== engine.amInterested) {
        if (engine.amInterested) {
          engine.emit('interested')
        } else {
          engine.emit('uninterested')
        }
      }
    }

    function gc() {
      for (var i = 0; i < engine.selection.length; i++) {
        var s = engine.selection[i]
        var oldOffset = s.offset

        while (!pieces[s.from + s.offset] && s.from + s.offset < s.to) {
          s.offset++
        }

        if (oldOffset !== s.offset) {
          s.notify()
        }

        if (s.to === s.from + s.offset) {
          if (!pieces[s.from + s.offset]) {
            engine.selection.splice(i, 1)
            i--
            s.notify()
            oninterestchange()
          }
        }
      }

      if (!engine.selection.length) {
        engine.emit('idle')
      }
    }

    var resetpiece = (engine.resetPiece = function (idx) {
      engine.bitfield.set(idx, false)
      critical[idx] = null
      reservations[idx] = []
      pieces[idx] = piece(getPieceLen(idx))
    })

    var onhotswap =
      opts.hotswap === false
        ? falsy
        : function (wire, index) {
            var speed = wire.downloadSpeed()
            if (speed < piece.BLOCK_SIZE) return false
            if (!reservations[index] || !pieces[index]) return false

            var r = reservations[index]
            var minSpeed = Infinity
            var min

            for (var i = 0; i < r.length; i++) {
              var other = r[i]
              if (other && other !== wire) {
                var otherSpeed = other.downloadSpeed()
                if (
                  otherSpeed < SPEED_THRESHOLD &&
                  otherSpeed * 2 <= speed &&
                  otherSpeed <= minSpeed
                ) {
                  min = other
                  minSpeed = otherSpeed
                }
              }
            }

            if (!min) {
              return false
            }

            for (i = 0; i < r.length; i++) {
              if (r[i] === min) {
                r[i] = null
              }
            }

            var requests = min.requests
            var reqs = opts.virtual
              ? requests.map(function (req) {
                  var pos = req.piece * verificationLen + req.offset
                  return {
                    piece: Math.floor(pos / torrent.pieceLength),
                    offset: pos % torrent.pieceLength,
                    callback: req.callback,
                    timeout: req.timeout,
                    length: req.length
                  }
                })
              : requests

            for (i = 0; i < reqs.length; i++) {
              var req = reqs[i]
              if (req.piece === index) {
                pieces[index].cancel((req.offset / piece.BLOCK_SIZE) | 0)
              }
            }

            engine.emit('hotswap', min, wire, index)
            return true
          }

    function onupdatetick() {
      engine.emit('update')
      if (
        swarm.downloaded >= engine._flood &&
        swarm.downloadSpeed() > engine.pulse
      ) {
        return delayupdatetick()
      }
      process.nextTick(onupdate)
    }

    var delayupdatetick = debounce(onupdatetick, 500)

    function onrequest(wire, index, hotswap) {
      if (!pieces[index]) {
        return false
      }

      var p = pieces[index]
      var reservation = p.reserve()

      if (reservation === -1 && hotswap && onhotswap(wire, index)) {
        reservation = p.reserve()
      }
      if (reservation === -1) {
        return false
      }

      var r = reservations[index] || []
      var offset = p.offset(reservation)
      var size = p.size(reservation)

      var i = r.indexOf(null)
      if (i === -1) {
        i = r.length
      }
      r[i] = wire
      ;(function (peer, index, offset, size, cb) {
        if (!opts.virtual) {
          return peer.request(index, offset, size, cb)
        }
        var pos = index * torrent.pieceLength + offset
        index = Math.floor(pos / verificationLen)
        offset = pos % verificationLen
        peer.request(index, offset, size, cb)
      })(wire, index, offset, size, function (err, block) {
        if (r[i] === wire) {
          r[i] = null
        }

        if (p !== pieces[index]) {
          return onupdatetick()
        }

        if (err) {
          p.cancel(reservation)
          return onupdatetick()
        }

        var ready = !p.set(reservation, block)
        engine.emit('piece-progress', index, p.buffered / p.parts)

        if (ready) {
          return onupdatetick()
        }

        var buffer = p.flush()

        ;(function (index, buffer) {
          if (pieces[index]) {
            try {
              engine.store.write(index, buffer)
            } catch (e) {
              engine.emit('error', e)
              return
            }

            engine.bitfield.set(index, true)
            var ver = engine.store.verify(index, verifications)

            if (ver && ver.success) {
              engine.store.commit(
                ver.start,
                ver.end - 1,
                function (err, noNotifyHave) {
                  if (err) {
                    return engine.emit('error', err)
                  }
                  for (var j = ver.start; j !== ver.end; j++) {
                    engine.emit('verify', j)
                  }
                  if (!noNotifyHave) {
                    var idx = mapPiece(index)
                    engine.verified.set(idx, true)
                    for (var k = 0; k < wires.length; k++) {
                      wires[k].have(idx)
                    }
                  }
                }
              )
            }

            if (!ver || ver.success) {
              pieces[index] = null
              reservations[index] = null
              engine.emit('download', index, buffer)
              gc()
            } else {
              for (var j = ver.start; j !== ver.end; j++) {
                engine.emit('invalid-piece', j)
                resetpiece(j)
              }
            }
          }
        })(index, buffer)

        onupdatetick()
      })

      return true
    }

    function getRequestsNumber() {
      var unchoked = wires.filter(function (peer) {
        return !peer.peerChoking
      }).length
      var normalRange = 1 - Math.max(0, Math.min(1, (unchoked - 1) / 29))
      return Math.round(Math.pow(normalRange, 4) * 45 + 5)
    }

    function shufflePriority(i) {
      var last = i
      for (
        var j = i;
        j < engine.selection.length && engine.selection[j].priority;
        j++
      ) {
        last = j
      }
      engine.selection.splice(last, 0, engine.selection.splice(i, 1)[0])
    }

    function select(wire, hotswap) {
      var maxRequests = getRequestsNumber()
      if (wire.requests.length >= maxRequests) {
        return true
      }

      var rank = (function (wire) {
        var speed = wire.downloadSpeed() || 1
        if (speed > SPEED_THRESHOLD) {
          return thruthy
        }

        var secs = (getRequestsNumber() * piece.BLOCK_SIZE) / speed
        var tries = 10
        var ptr = 0

        return function (index) {
          if (!tries || !pieces[index]) {
            return true
          }
          var missing = pieces[index].missing
          for (; ptr < wires.length; ptr++) {
            var other = wires[ptr]
            var otherSpeed = other.downloadSpeed()
            if (
              otherSpeed >= SPEED_THRESHOLD &&
              otherSpeed > speed &&
              other.peerPieces[mapPiece(index)] &&
              (missing -= otherSpeed * secs) <= 0
            ) {
              tries--
              return false
            }
          }
          return true
        }
      })(wire)

      for (var i = 0; i < engine.selection.length; i++) {
        var next = engine.selection[i]
        for (
          var j = next.from + next.offset;
          j <= (next.selectTo || next.to);
          j++
        ) {
          if (wire.peerPieces[mapPiece(j)] && rank(j)) {
            while (
              wire.requests.length < maxRequests &&
              onrequest(wire, j, critical[j] || hotswap)
            ) {}
            if (wire.requests.length >= maxRequests) {
              if (next.priority) {
                shufflePriority(i)
              }
              return true
            }
          }
        }
      }

      return false
    }

    function onupdatewire(wire) {
      if (!wire.peerChoking) {
        if (wire.downloaded) {
          if (!select(wire, false)) {
            select(wire, true)
          }
        } else {
          ;(function (wire) {
            if (!wire.requests.length) {
              for (var i = engine.selection.length - 1; i >= 0; i--) {
                var next = engine.selection[i]
                for (
                  var j = next.selectTo || next.to;
                  j >= next.from + next.offset;
                  j--
                ) {
                  if (
                    wire.peerPieces[mapPiece(j)] &&
                    onrequest(wire, j, false)
                  ) {
                    return
                  }
                }
              }
            }
          })(wire)
        }
      }
    }

    function onupdate() {
      wires.forEach(onupdatewire)
    }

    function onwire(wire) {
      wire.setTimeout(opts.timeout || 30000, function () {
        engine.emit('timeout', wire)
        wire.destroy()
      })

      if (engine.selection.length) {
        wire.interested()
      }

      var id

      function onchoketimeout() {
        if (
          swarm.queued > (swarm.size - swarm.wires.length) * 2 &&
          wire.amInterested
        ) {
          return wire.destroy()
        }
        id = setTimeout(onchoketimeout, 5000)
      }

      wire.on('close', function () {
        clearTimeout(id)
      })

      wire.on('choke', function () {
        clearTimeout(id)
        id = setTimeout(onchoketimeout, 5000)
      })

      wire.on('unchoke', function () {
        clearTimeout(id)
      })

      var uploadPipe = new Bagpipe(4)

      wire.on('request', function (index, offset, length, cb) {
        var pos = index * verificationLen + offset
        index = Math.floor(pos / torrent.pieceLength)
        offset = pos % torrent.pieceLength

        if (!engine.bitfield.get(index)) {
          return engine.emit('invalid-request', index)
        }

        uploadPipe.push(engine.store.read, index, function (err, buffer) {
          if (err) {
            return cb(err)
          } else if (buffer) {
            engine.emit('upload', index, offset, length)
            cb(null, buffer.slice(offset, offset + length))
          } else {
            return cb(new Error('Empty buffer returned'))
          }
        })
      })

      wire.on('unchoke', onupdatetick)
      wire.on('bitfield', onupdatetick)
      wire.on('have', onupdatetick)

      wire.isSeeder = false

      var idx = 0
      function checkseeder() {
        if (wire.peerPieces.length === torrent.pieces.length) {
          for (; idx < torrent.pieces.length; ++idx) {
            if (!wire.peerPieces[idx]) {
              return
            }
          }
          wire.isSeeder = true
        }
      }

      wire.on('bitfield', checkseeder)
      wire.on('have', checkseeder)
      checkseeder()

      id = setTimeout(onchoketimeout, 5000)
    }

    function rechokeSort(a, b) {
      if (a.downSpeed !== b.downSpeed) {
        return a.downSpeed > b.downSpeed ? -1 : 1
      } else if (a.upSpeed !== b.upSpeed) {
        return a.upSpeed > b.upSpeed ? -1 : 1
      } else if (a.wasChoked !== b.wasChoked) {
        return a.wasChoked ? 1 : -1
      } else {
        return a.salt - b.salt
      }
    }

    swarm.on('wire', onwire)
    swarm.wires.forEach(onwire)

    refresh = function () {
      process.nextTick(gc)
      oninterestchange()
      onupdatetick()
    }

    rechokeIntervalId = setInterval(function () {
      if (rechokeOptimisticTime > 0) {
        --rechokeOptimisticTime
      } else {
        rechokeOptimistic = null
      }

      var peers = []
      wires.forEach(function (wire) {
        if (wire.isSeeder) {
          if (!wire.amChoking) {
            wire.choke()
          }
        } else if (wire !== rechokeOptimistic) {
          peers.push({
            wire: wire,
            downSpeed: wire.downloadSpeed(),
            upSpeed: wire.uploadSpeed(),
            salt: Math.random(),
            interested: wire.peerInterested,
            wasChoked: wire.amChoking,
            isChoked: true
          })
        }
      })

      peers.sort(rechokeSort)

      var i = 0
      var unchokeInterested = 0
      for (; i < peers.length && unchokeInterested < rechokeSlots; ++i) {
        peers[i].isChoked = false
        if (peers[i].interested) {
          ++unchokeInterested
        }
      }

      if (!rechokeOptimistic && i < peers.length && rechokeSlots) {
        var candidates = peers.slice(i).filter(function (peer) {
          return peer.interested
        })
        var optimistic = candidates[(Math.random() * candidates.length) | 0]

        if (optimistic) {
          optimistic.isChoked = false
          rechokeOptimistic = optimistic.wire
          rechokeOptimisticTime = 2
        }
      }

      peers.forEach(function (peer) {
        if (peer.wasChoked !== peer.isChoked) {
          if (peer.isChoked) {
            peer.wire.choke()
          } else {
            peer.wire.unchoke()
          }
        }
      })
    }, 10000)

    engine.emit('ready')
    refresh()
  }

  var exchange = exchangeMetadata(engine, function (metadata) {
    var result = {}
    try {
      result.info = bncode.decode(metadata)
    } catch (e) {
      return
    }
    result['announce-list'] = []
    var buf = bncode.encode(result)
    var tor = parseTorrent(buf)

    verifications = verifications || tor.pieces

    if (!engine.torrent) {
      ontorrent(tor)
    }

    fs.writeFile(torrentPath, buf, function (err) {
      if (err) {
        engine.emit('error', err)
      }
    })
  })

  swarm.on('wire', function (wire) {
    engine.emit('wire', wire)
    exchange(wire)
    if (engine.verified) {
      wire.bitfield(engine.verified)
    } else if (engine.bitfield) {
      wire.bitfield(engine.bitfield)
    }
  })

  swarm.pause()
  ;(function (next) {
    if (opts.circularBuffer) {
      return next()
    }
    mkdirp(opts.path, function (err) {
      if (err) {
        return next(err)
      }
      fs.readFile(torrentPath, function (_, buf) {
        try {
          if (buf) {
            link = parseTorrent(buf)
          }
        } catch (e) {}
        next()
      })
    })
  })(function (err) {
    if (err) {
      return engine.emit('error', err)
    } else if (link.files && link.pieces) {
      metadata = encode(link)
      swarm.resume()
      if (metadata) {
        ontorrent(link)
      }
    }
  })

  engine.critical = function (piece, width) {
    for (var i = 0; i < (width || 1); i++) {
      critical[piece + i] = true
    }
  }

  engine.isCritical = function (piece) {
    return critical[piece]
  }

  engine.select = function (from, to, priority, notify) {
    var sel = {
      from: from,
      to: to,
      offset: 0,
      priority: toNumber(priority),
      notify: notify || noop
    }
    engine.selection.push(sel)
    engine.selection.sort(function (a, b) {
      return b.priority - a.priority
    })
    refresh()
    return sel
  }

  engine.deselect = function (sel) {
    var idx = engine.selection.indexOf(sel)
    if (idx > -1) {
      engine.selection.splice(idx, 1)
      refresh()
    }
  }

  engine.refresh = function () {
    refresh()
  }

  engine.setPulse = function (bps) {
    engine.pulse = bps
  }

  engine.setFlood = function (b) {
    engine._flood = b + swarm.downloaded
  }

  engine.setFloodedPulse = function (b, bps) {
    engine.setFlood(b)
    engine.setPulse(bps)
  }

  engine.flood = function () {
    engine._flood = 0
    engine.pulse = Number.MAX_SAFE_INTEGER
  }

  engine.connect = function (addr) {
    swarm.add(addr)
  }

  engine.disconnect = function (addr) {
    swarm.remove(addr)
  }

  engine.remove = function (cb) {
    rimraf(engine.path, cb || noop)
  }

  engine.destroy = function (cb) {
    engine.removeAllListeners()
    swarm.destroy()
    clearInterval(rechokeIntervalId)
    if (engine.store) {
      engine.store.close(cb)
    } else if (cb) {
      process.nextTick(cb)
    }
  }

  engine.listen = function (port, cb) {
    if (typeof port === 'function') {
      return engine.listen(0, port)
    }
    engine.port = port || 6881
    swarm.listen(engine.port, cb)
  }

  return engine
}
