var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')

var fixture = torrents(
  fs.readFileSync(path.join(__dirname, 'data', 'star.torrent'))
)

fixture.listen(10000)

test('fixture should be ready', function (t) {
  t.plan(1)
  fixture.on('ready', t.ok.bind(t, true, 'should be ready'))
})

test('destroy fixture and all content', function (t) {
  t.plan(1)
  fixture.destroy(function () {
    fixture.remove(function () {
      t.ok(!fs.existsSync(fixture.path))
    })
  })
})
