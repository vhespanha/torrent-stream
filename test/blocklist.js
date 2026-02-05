var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')
var rimraf = require('rimraf')

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))
var tmpPath = path.join(__dirname, '..', 'torrents', 'test')
rimraf.sync(tmpPath)

var seed

test('seed should initialize', function (t) {
  t.plan(1)
  seed = torrents(torrent, {
    path: path.join(__dirname, 'data')
  })
  seed.listen(6882)
  seed.once('ready', t.ok.bind(t, true, 'should be ready'))
})

test('cleanup', function (t) {
  t.plan(1)
  seed.destroy(t.ok.bind(t, true, 'seed should be destroyed'))
})
