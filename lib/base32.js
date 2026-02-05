var byteTable = [
  255, 255, 26, 27, 28, 29, 30, 31, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 255, 255, 255, 255, 255, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 255, 255, 255,
  255, 255
]

exports.encode = function (plain) {
  var buff
  var quintets
  var i = 0
  var j = 0
  var shiftIndex = 0
  var digit = 0

  buff = plain
  quintets = Math.floor(buff.length / 5)
  var encodedLen = (buff.length % 5 === 0 ? quintets : quintets + 1) * 8

  var encoded = Buffer.alloc(encodedLen)

  if (!Buffer.isBuffer(plain)) {
    plain = Buffer.from(plain)
  }

  for (; i < plain.length; ) {
    var current = plain[i]
    if (shiftIndex > 3) {
      digit = current & (255 >> shiftIndex)
      shiftIndex = (shiftIndex + 5) % 8
      digit =
        (digit << shiftIndex) |
        ((i + 1 < plain.length ? plain[i + 1] : 0) >> (8 - shiftIndex))
      i++
    } else {
      digit = (current >> (8 - (shiftIndex + 5))) & 31
      shiftIndex = (shiftIndex + 5) % 8
      if (shiftIndex === 0) {
        i++
      }
    }
    encoded[j] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.charCodeAt(digit)
    j++
  }

  for (i = j; i < encoded.length; i++) {
    encoded[i] = 61
  }

  return encoded
}

exports.decode = function (encoded) {
  var plainChar
  var shiftIndex = 0
  var plainDigit = 0
  var plainPos = 0

  if (!Buffer.isBuffer(encoded)) {
    encoded = Buffer.from(encoded)
  }

  var decoded = Buffer.alloc(Math.ceil((encoded.length * 5) / 8))

  for (var i = 0; i < encoded.length && encoded[i] !== 61; i++) {
    var encodedByte = encoded[i] - 48
    if (!(encodedByte < byteTable.length)) {
      throw new Error('Invalid input - it is not base32 encoded string')
    }
    plainDigit = byteTable[encodedByte]
    if (shiftIndex <= 3) {
      shiftIndex = (shiftIndex + 5) % 8
      if (shiftIndex === 0) {
        plainChar |= plainDigit
        decoded[plainPos] = plainChar
        plainPos++
        plainChar = 0
      } else {
        plainChar |= (plainDigit << (8 - shiftIndex)) & 255
      }
    } else {
      shiftIndex = (shiftIndex + 5) % 8
      plainChar |= (plainDigit >>> shiftIndex) & 255
      decoded[plainPos] = plainChar
      plainPos++
      plainChar = (plainDigit << (8 - shiftIndex)) & 255
    }
  }

  return decoded.slice(0, plainPos)
}
