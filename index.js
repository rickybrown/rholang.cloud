const fs = require('fs')
const path = require('path')
const bodyParser = require('body-parser')
const express = require('express')
const app = express()
const server = require('http').createServer(app)
const io = require('socket.io')(server)

// Local libs
const DockerManager = require('./lib/DockerManager')
const FileReader = require('./lib/FileReader')

// Middleware
app.use(express.static(path.join(__dirname, 'public')))
app.use(bodyParser.urlencoded({extended: true}))
app.use(bodyParser.json())

// Ensure /tmp/rnode exists
try {
  fs.mkdirSync('/tmp/rnode')
} catch (e) {}
try {
  fs.unlinkSync('/tmp/rnode/rspace/data.mdb')
  fs.unlinkSync('/tmp/rnode/rspace/lock.mdb')
} catch (e) {}

// Start running container
DockerManager.startContainers('rchain/rnode')

// Load static resources
const indexHTML = fs.readFileSync(path.join(__dirname, 'views', 'index.html'), 'utf8')
const example = fs.readFileSync(path.join(__dirname, 'public', 'examples', 'hello-world.rho'), 'utf8')
const files = FileReader.readFiles()

// Set up queue
const queue = new (require('better-queue'))(function (input, cb) {
  console.log('running queue', input.data)
  DockerManager.runWithInput(input, cb)
}, {maxTimeout: 10000})

// HTTP Routes
app.get('/', function (req, res) {
  const config = {autorun: false, version: 'latest'}
  const content = indexHTML
    .replace('{{ content }}', example)
    .replace('{{ config }}', JSON.stringify(config))
    .replace('{{ exampleFiles }}', JSON.stringify(files))

  res.send(content)
})

app.post('/', function (req, res) {
  const config = {autorun: true, version: 'latest'}
  const content = indexHTML
    .replace('{{ content }}', req.body.content || req.body.body || example)
    .replace('{{ config }}', JSON.stringify(config))

  res.send(content)
})

app.post("/eval", function (req, res) {
  setTimeout(() => {
    const mockReturn = {
      evaluating: 'new x0, x1, x2 in { new x3 in { x3!("Hello, world!") | for( x4 <= x3 ) { x1!(*x4) } } }',
      output: '@{"Hello, world!"}\n@{"Hello, world!"}',
      storage_contents: '@{Unforgeable(0x43d68cb247bd8c32e5d30c07405b9e29a192c6f30f1223821a62da6fafaab6b3)}!(Unforgeable(0x582d234b6ae5d92ff66fb423068f70ce723124f09bb7dffe19d210989a858458)) | @{Unforgeable(0xd7526d3f667d12b641293f9ffeabd5bad17e1cd69143b11b9af43f1cd02e4fa3)}!(Unforgeable(0xcf90d2435e92047cd6548697614726f0b9bdb22cffea99f3429eb150d9a79729)) | @{Unforgeable(0x16912479aefc02968c8fa7c532fdbd896c4afb0dc7c294a9ef166f46c0c31076)}!("2 medium pies")'
    }
    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify(mockReturn))
  }, 2000)
})

app.get('/v1/versions', function (req, res) {
  res.json(['latest'])
})

// Used by load balancer to check application health
app.get('/health', function (req, res) {
  const container = DockerManager.getCurrentContainer()
  if (!container) {
    DockerManager.startContainers('rchain/rnode')
    res.status(500)
    res.send('No container started yet')
    return
  }

  container.inspect((err, data) => {
    if (err) {
      res.status(500)
      res.send('Cannot get container status')
      DockerManager.reset('rchain/rnode')
      return
    }
    if (!data.State.Running || data.State.ExitCode !== 0) {
      res.status(500)
      res.send('Container is not running')
      DockerManager.reset('rchain/rnode')
      return
    }

    res.send('OK')
  })
})

var exec = require('child_process').exec, child;

app.post("/server/eval", function (request, response) {
    console.log("Request data: " + request.body)
    setTimeout(
        DockerManager.runWithInputWithoutSocket(request.body.value)
        , 10000);
    response.send("Just test")
})

app.post("/error",  function (req, res) {
    throw new Error("Error!");
})

function errorHandler (err, req, res, next) {
    if (res.headersSent) {
        return next(err)
    }
    res.status(500)
    res.render('error', { error: err })
}

 child = exec('docker exec -it goofy_albattani /bin/bash -c \'echo $PWD\'' , function (error, stdout, stderr) {
   console.log('stdout: ' + stdout);
   console.log('stderr: ' + stderr);
   if (error !== null) {
     console.log('exec error: ' + error);
   }
 });


// Socket.io logic
io.on('connection', function (socket) {
  console.log('a user connected')

  socket.on('run', function (data) {
    // ask client to clean output
    socket.emit('output.clean')
    if (queue.length) {
      let output = 'Added as item ' + (queue.length + 1) + ' to the queue...'
      if (queue.length > 5) {
        output += '\n(this might take a few seconds)'
      }
      socket.emit('output.append', [output, 'queued'])
    }

    console.log('queue.length: ' + queue.length)

    queue.push({
      data: data,
      socket: socket
    })
  })
})

const port = process.env.PORT || 80
server.listen(port)
console.log('server started on port', port)
