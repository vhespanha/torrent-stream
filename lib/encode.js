var bncode = require('bncode')
var crypto = require('crypto')

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

module.exports = function (torrent) {
  var encoded = false

  if (torrent.info) {
    encoded = bncode.encode(torrent.info)
    if (sha1(encoded) === torrent.infoHash) {
      return encoded
    }
  }

  var info = {
    name: torrent.name || ''
  }

  if (torrent.private) {
    info.private = 1
  }

  info.files = torrent.files.map(function (file) {
    return {
      length: file.length,
      path: (file.path.indexOf(info.name) === 0
        ? file.path.slice(info.name.length)
        : file.path
      )
        .slice(1)
        .split(/\\|\//)
    }
  })

  info['piece length'] = torrent.pieceLength
  info.pieces = Buffer.concat(
    torrent.pieces.map(function (buf) {
      return Buffer.from(buf, 'hex')
    })
  )

  encoded = bncode.encode(info)
  if (sha1(encoded) === torrent.infoHash) {
    return encoded
  } else if (torrent.files.length) {
    delete info.files
    info.length = torrent.files[0].length
    encoded = bncode.encode(info)
    if (sha1(encoded) === torrent.infoHash) {
      return encoded
    } else {
      return null
    }
  } else {
    return null
  }
}
