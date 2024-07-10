const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');
const sharedSession = require('express-socket.io-session');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const sessionMiddleware = session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true,
});

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

io.use(sharedSession(sessionMiddleware, {
  autoSave: true,
}));

let isRecording = false;
let recordingSocketId = null;
let connectedUsers = {};

const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  res.redirect('/login');
};

app.get('/', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    if (!user) {
      return res.sendStatus(401); // Unauthorized
    }
    bcrypt.compare(password, user.password, (err, result) => {
      if (err) {
        console.error(err);
        return res.sendStatus(500);
      }
      if (result) {
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.save(() => {
          res.redirect('/');
        });
      } else {
        res.sendStatus(401); // Unauthorized
      }
    });
  });
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash], (err) => {
      if (err) {
        console.error(err);
        return res.sendStatus(500);
      }
      res.redirect('/login');
    });
  });
});

app.get('/recordings', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'recordings.html'));
});

app.get('/session', (req, res) => {
  if (req.session.userId) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

app.get('/users', isAuthenticated, (req, res) => {
  db.all('SELECT username FROM users', (err, rows) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    res.json(rows);
  });
});

app.get('/admin', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/users', isAuthenticated, (req, res) => {
  db.all('SELECT id, username FROM users', (err, rows) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    res.json(rows);
  });
});

app.post('/api/users', isAuthenticated, (req, res) => {
  const { username, password } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash], (err) => {
      if (err) {
        console.error(err);
        return res.sendStatus(500);
      }
      res.sendStatus(201);
    });
  });
});

app.put('/api/users/:id', isAuthenticated, (req, res) => {
  const { username, password } = req.body;
  const { id } = req.params;
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    db.run('UPDATE users SET username = ?, password = ? WHERE id = ?', [username, hash, id], (err) => {
      if (err) {
        console.error(err);
        return res.sendStatus(500);
      }
      res.sendStatus(200);
    });
  });
});

app.delete('/api/users/:id', isAuthenticated, (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
    if (err) {
      console.error(err);
      return res.sendStatus(500);
    }
    res.sendStatus(200);
  });
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

io.on('connection', (socket) => {
  const session = socket.handshake.session;
  if (!session.userId) {
    console.log('User not authenticated');
    socket.disconnect();
    return;
  }

  db.get('SELECT username FROM users WHERE id = ?', [session.userId], (err, user) => {
    if (err) {
      console.error(err);
      return;
    }
    socket.username = user.username;
    connectedUsers[socket.username] = true;
    io.emit('userConnected', socket.username);
    console.log('User connected:', socket.username);

    socket.on('disconnect', () => {
      delete connectedUsers[socket.username];
      io.emit('userDisconnected', socket.username);
      console.log('User disconnected:', socket.username);
    });

    socket.on('startRecording', () => {
      if (!isRecording) {
        isRecording = true;
        recordingSocketId = socket.id;
        socket.emit('recordingStatus', { canRecord: true });
        socket.broadcast.emit('recordingStatus', { canRecord: false });
      } else {
        socket.emit('recordingStatus', { canRecord: false });
      }
    });

    socket.on('stopRecording', () => {
      if (socket.id === recordingSocketId) {
        isRecording = false;
        recordingSocketId = null;
        socket.broadcast.emit('recordingStatus', { canRecord: true });
      }
    });

    socket.on('audio', (data) => {
      if (socket.id === recordingSocketId) {
        console.log('Audio data received from', socket.username);
        const fileName = `audio_${socket.username}_${Date.now()}.webm`;
        const filePath = path.join(__dirname, 'public', 'audios', fileName);
        const dateTime = new Date().toLocaleString();
        fs.writeFile(filePath, data, (err) => {
          if (err) {
            console.error('Error writing audio file', err);
            return;
          }
          console.log('Audio file saved:', fileName);
          io.emit('newAudio', { fileName, username: socket.username, dateTime });
        });
        socket.broadcast.emit('audio', data);
      }
    });

    socket.on('getRecordings', () => {
      const dirPath = path.join(__dirname, 'public', 'audios');
      fs.readdir(dirPath, (err, files) => {
        if (err) {
          console.error('Error reading audio directory', err);
          return;
        }
        const recordings = files.map(fileName => {
          const username = fileName.split('_')[1];
          const timestamp = fileName.split('_')[2].split('.')[0];
          const dateTime = new Date(parseInt(timestamp)).toLocaleString();
          return { fileName, username, dateTime };
        });
        socket.emit('recordingsList', recordings);
      });
    });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
