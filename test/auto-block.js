var test = require('tap').test
var torrents = require('../')
var fs = require('fs-extra')
var path = require('path')

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))
var tmpPath = path.join(__dirname, '..', 'torrents', 'test')
fs.removeSync(tmpPath)
fs.copySync(path.join(__dirname, 'data'), tmpPath)

var fixture = torrents(torrent, {
  path: tmpPath
})

fixture.listen(10000)

test('fixture can start up', function (t) {
  t.plan(1)
  fixture.on('ready', function () {
    t.ok(true, 'seed should be ready')
  })
})

test('cleanup', function (t) {
  t.plan(1)
  fixture.destroy(t.ok.bind(t, true, 'seed should be destroyed'))
})
