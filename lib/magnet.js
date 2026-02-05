var base32 = require('./base32')

module.exports = function (uri) {
  var m
  var result = {}
  var data = uri.split('magnet:?')[1]

  if (!data || data.length === 0) {
    return result
  }

  data.split('&').forEach(function (param) {
    var keyval = param.split('=')
    if (keyval.length === 2) {
      var key = keyval[0]
      var val = keyval[1]
      if (key === 'tr') {
        val = decodeURIComponent(val)
      }
      if (result[key]) {
        if (Array.isArray(result[key])) {
          result[key].push(val)
        } else {
          var old = result[key]
          result[key] = [old, val]
        }
      } else {
        result[key] = val
      }
    }
  })

  if (result.xt && (m = result.xt.match(/^urn:btih:(.{40})/))) {
    result.infoHash = Buffer.from(m[1], 'hex').toString('hex')
  } else if (result.xt && (m = result.xt.match(/^urn:btih:(.{32})/))) {
    var decodedStr = base32.decode(m[1])
    result.infoHash = Buffer.from(decodedStr, 'binary').toString('hex')
  }

  return result
}
