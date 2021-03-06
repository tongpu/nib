var net          = require('net')
  , tls          = require('tls')
  , EventEmitter = require('events').EventEmitter
  , r            = require('./response')

module.exports = Client
function Client(props) {
  for (var i in props) {
    this[i] = props[i]
  }

  this._pong         = this._pong.bind(this)
  this._events       = new EventEmitter
  this._privmsgQueue = []
}

Client.prototype.on = function(event, listener) {
  this._events.on(event, listener)
}

Client.prototype.once = function(event, listener) {
  this._events.once(event, listener)
}

Client.prototype.write = function(text) {
  console.log(text)

  if (this._socket) {
    try {
      this._socket.write(text +'\n')
    }
    catch (e) {
      console.error(e)
      this._socket.destroy()
    }
  }
}

Client.prototype.connect = function(cb) {
  if (!this.port) this.port = 6667

  var self = this
    , s
    , reconnect = false
    , options   = { 'rejectUnauthorized': self.rejectUnauthorized }

  function connect() {
    if (self.ssl) {
      if (!s.authorized) {
        console.error('SSL authorization failed:', s.authorizationError)
      }
    }

    if (self.password) self.write('PASS '+ self.password)

    if (cb) cb.call(self, s)
  }

  if (self.ssl) {
    s = self._socket = tls.connect(self.port, self.host, options, connect)
  }
  else {
    s = self._socket = new net.Socket(options)

    s.connect(self.port, self.host, connect)
  }

  // Set default timeout to 10min
  s.setTimeout(self.timeout || 1000 * 60 * 10)

  s.on('connect', function() {
    console.log('connected to %s:%d', self.host, self.port)
  })

  var data = ''
  s.on('data', function(chunk) {
    var messages = (data + chunk.toString()).split('\r\n')

    data = messages.pop()

    messages.forEach(self.message, self)
  })

  self._events.on('ping', this._pong)

  s.on('error', function(err) {
    console.log('socket error:', err)
  })

  s.on('timeout', function() { reconnect = true; s.destroy() })

  s.on('close', function() {
    console.log('irc socket closed')

    var events = [ 'connect'
                 , 'data'
                 , 'timeout'
                 , 'close'
                 , 'error'
                 , 'end'
                 ]

    events.forEach(function(e) { s.removeAllListeners(e) })

    self._events.removeListener('ping', self._pong)

    if (reconnect) {
      reconnect = false
      console.log('reconnecting to %s:%d...', self.host, self.port)
      self.connect(cb)
    }
  })

  s.on('end', function() {
    console.log('irc socket ended')
  })
}

Client.prototype._pong = function(prefix, params) {
   try {
     this._socket.write('PONG '+ params.slice(1) +'\n')
   }
   catch (e) {
     console.error(e)
     this._socket.destroy()
   }
}

Client.prototype.message = function(message) {
  var matches

  console.log(message)

  if (matches = /^(?:\:(.*?) )?(.*?) (.*?)$/.exec(message)) {
    var prefix  = matches[1]
      , command = matches[2].toLowerCase()
      , params  = matches[3]

    if (command == 'privmsg') {
      return this.onprivmsg(prefix, params)
    }

    this._events.emit(command, prefix, params)
  }
}

Client.prototype.onprivmsg = function(prefix, params) {
  var from    = prefix.split('!')[0]
    , to      = params.split(' ')[0]
    , message = params.split(':')

  message.shift()

  this._events.emit('privmsg', from, to, message.join(':'), prefix)
}

Client.prototype.names = function(channels, cb) {
  var self  = this
    , names = {}

  // Create a copy of channels
  channels = channels.slice(0)

  ;(function getNames() {
    if (!channels.length) return cb && cb(names)

    var channel = channels.shift()

    self._names(channel, function(n) {
      names[channel] = n

      getNames()
    })
  })()
}

Client.prototype._names = function(channels, cb) {
  var self  = this
    , names = []

  self._events.on(r.RPL_NAMREPLY, namereply)

  self._events.once(r.RPL_ENDOFNAMES, function(prefix, params) {
    self._events.removeListener(r.RPL_NAMREPLY, namereply)

    if (cb) cb(names)
  })

  self.write('NAMES '+ channels)

  function namereply(prefix, params) {
    var matches

    if (matches = /(?:=|\*|@) (.*?) :(.*?)$/.exec(params)) {
      names = matches[2].match(/([^ @+]+)/g)
    }
  }
}

Client.prototype.notice = function(to, text) {
  if (!Array.isArray(to)) {
    to = [to]
  }

  to.forEach(function(to) {
    this.write('NOTICE '+ to +' :'+ text)
  }, this)
}

Client.prototype.privmsg = function(to, text) {
  var self  = this
    , queue = self._privmsgQueue
    , delay = 0

  if (!Array.isArray(to)) {
    to = [to]
  }

  to.forEach(function(to) {
    // Drop messages if queue grows over 20 messages
    if (queue.length >= 20) return console.log('Too much privmsg in queue, dropping...')

    queue.push([to, text])

    if (!queue.timer) {
      queue.timer = setTimeout(function privmsg() {
        queue.timer = null

        if (!queue.length) return

        var queued = queue.shift()

        self.write('PRIVMSG '+ queued[0] +' :'+ queued[1])

        if (queue.length) {
          queue.timer = setTimeout(privmsg, delay < 1000 ? delay += 50 : delay)
        }
      }, delay)
    }
  })
}

Client.prototype.quit = function() {
  var s = this._socket

  console.log('QUIT')

  if (s && s.writable) {
    s.write('QUIT\n')
    s.destroy()
  }
}

;['NICK', 'USER', 'JOIN'].forEach(function(c) {
  Client.prototype[c.toLowerCase()] = function(a) {
    this.write(c +' '+ a)
  }
})
