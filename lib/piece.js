var BLOCK_SIZE = 16384

function PieceBuffer(length) {
  if (!(this instanceof PieceBuffer)) {
    return new PieceBuffer(length)
  }
  this.parts = Math.ceil(length / BLOCK_SIZE)
  this.remainder = length % BLOCK_SIZE || BLOCK_SIZE
  this.length = length
  this.missing = length
  this.buffered = 0
  this.buffer = null
  this.cancellations = null
  this.reservations = 0
  this.flushed = false
}

PieceBuffer.BLOCK_SIZE = BLOCK_SIZE

PieceBuffer.prototype.size = function (i) {
  if (i === this.parts - 1) {
    return this.remainder
  } else {
    return BLOCK_SIZE
  }
}

PieceBuffer.prototype.offset = function (i) {
  return i * BLOCK_SIZE
}

PieceBuffer.prototype.reserve = function () {
  if (this.init()) {
    if (this.cancellations.length) {
      return this.cancellations.pop()
    } else if (this.reservations < this.parts) {
      return this.reservations++
    } else {
      return -1
    }
  } else {
    return -1
  }
}

PieceBuffer.prototype.cancel = function (i) {
  if (this.init()) {
    this.cancellations.push(i)
  }
}

PieceBuffer.prototype.get = function (i) {
  if (this.init()) {
    return this.buffer[i]
  } else {
    return null
  }
}

PieceBuffer.prototype.set = function (i, data) {
  if (!this.init()) {
    return false
  }

  if (!this.buffer[i]) {
    this.buffered++
    this.buffer[i] = data
    this.missing -= data.length
  }

  return this.buffered === this.parts
}

PieceBuffer.prototype.flush = function () {
  if (!this.buffer || this.parts !== this.buffered) {
    return null
  }
  var buffer = Buffer.concat(this.buffer, this.length)
  this.buffer = null
  this.cancellations = null
  this.flushed = true
  return buffer
}

PieceBuffer.prototype.init = function () {
  return (
    !this.flushed &&
    (this.buffer ||
      ((this.buffer = new Array(this.parts)), (this.cancellations = [])),
    true)
  )
}

module.exports = PieceBuffer
