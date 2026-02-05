var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))

var fixture = torrents(torrent, {
  path: path.join(__dirname, 'data')
})

test('fixture can initialize the torrent', function (t) {
  t.plan(1)
  fixture.once('ready', function () {
    t.ok(true, 'should be ready')
  })
})

test('cleanup', function (t) {
  t.plan(1)
  fixture.destroy(t.ok.bind(t, true, 'should be destroyed'))
})
