var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')
var rimraf = require('rimraf')

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))
var tmpPath = path.join(__dirname, '..', 'torrents', 'test')
rimraf.sync(tmpPath)

var fixture

test('seed should initialize', function (t) {
  t.plan(1)
  fixture = torrents(torrent, {
    path: path.join(__dirname, 'data')
  })
  fixture.listen(6882)
  fixture.once('ready', t.ok.bind(t, true, 'should be ready'))
})

test('peer should connect using .torrent file', function (t) {
  t.plan(2)
  var engine = torrents(torrent)
  engine.once('ready', function () {
    t.ok(true, 'should be ready')
    engine.destroy(function () {
      engine.remove(t.ok.bind(t, true, 'should be destroyed'))
    })
  })
})

test('cleanup', function (t) {
  t.plan(1)
  fixture.destroy(t.ok.bind(t, true, 'should be destroyed'))
})
