var stream = require('stream')
var util = require('util')
var Bagpipe = require('bagpipe')

var FileStream = function (engine, file, opts) {
  if (!(this instanceof FileStream)) return new FileStream(engine, file, opts)
  stream.Readable.call(this)

  opts = opts || {}
  opts.start = opts.start || 0
  if (!opts.end && typeof opts.end !== 'number') {
    opts.end = file.length - 1
  }

  var offset = opts.start + file.offset
  var pieceLength = engine.torrent.pieceLength

  this.length = opts.end - opts.start + 1
  this.startPiece = (offset / pieceLength) | 0
  this.endPiece = ((opts.end + file.offset) / pieceLength) | 0
  this.bufferPieces = engine.buffer ? (engine.buffer / pieceLength) | 0 : null
  this._destroyed = false
  this._engine = engine
  this._piece = this.startPiece
  this._missing = this.length
  this._critical = Math.min(1048576 / pieceLength, 4) | 0
  this._readpipe = new Bagpipe(2)
  this._offset = offset - this.startPiece * pieceLength

  this.selection = engine.select(
    this.startPiece,
    this.endPiece,
    !opts.hasOwnProperty('priority') || opts.priority,
    this.notify.bind(this)
  )

  if (this.bufferPieces) {
    this.selection.selectTo = Math.min(
      this.endPiece,
      this._piece + this.bufferPieces
    )
    this.selection.readFrom = this._piece
  }
}

util.inherits(FileStream, stream.Readable)

FileStream.prototype.notify = function () {
  this.emit('notify')
}

FileStream.prototype._read = function () {
  var self = this

  if (this._missing) {
    if (!this._engine.bitfield.get(this._piece)) {
      if (
        !this._engine.selection.some(function (sel) {
          return self._piece <= sel.to && sel.from + sel.offset <= self._piece
        })
      ) {
        this._engine.select(
          this._piece,
          this.selection.to,
          true,
          this.notify.bind(this)
        )
      }
      this.once('notify', self._read)
      this._engine.critical(this._piece, this._critical)
      this._engine.refresh()
      return
    }

    var pieceToGet = this._piece
    this._engine.lockedPieces.push(pieceToGet)

    this._readpipe.push(
      this._engine.store.read,
      this._piece++,
      function (err, buffer) {
        var idx = self._engine.lockedPieces.indexOf(pieceToGet)
        self._engine.lockedPieces.splice(idx, 1)

        if (err) {
          self._engine.emit('error', err)
        }

        if (!self._destroyed && buffer) {
          if (err) {
            return self.destroy(err)
          }
          if (self._offset) {
            buffer = buffer.slice(self._offset)
            self._offset = 0
          }
          if (self._missing < buffer.length) {
            buffer = buffer.slice(0, self._missing)
          }
          self._missing -= buffer.length
          if (!self._missing) {
            self.push(buffer)
            self.push(null)
            return
          }
          self.push(buffer)
        }
      }
    )

    if (this.bufferPieces) {
      this.selection.selectTo = Math.min(
        this.endPiece,
        this._piece + this.bufferPieces
      )
      this.selection.readFrom = this._piece
      this._engine.refresh()
    }
  }
}

FileStream.prototype.destroy = function () {
  if (!this._destroyed) {
    this._destroyed = true
    this.emit('close')
  }
}

module.exports = FileStream
