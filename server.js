'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ23456789';
const REACTIONS = ['😂', '😱', '🤔', '👏', '🔥', '🙄'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));
app.get('/sala/:code', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const rooms = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function broadcast(room) {
  io.to(room.code).emit('state', room.publicState());
}

function validPlayerId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

io.on('connection', socket => {
  socket.data = { code: null, playerId: null, lastReaction: 0 };

  function leaveCurrent() {
    const { code, playerId } = socket.data;
    if (!code) return;
    const room = rooms.get(code);
    socket.leave(code);
    socket.data.code = null;
    if (room) {
      room.leave(playerId, socket.id);
      if (room.players.size === 0) { room.clearTimer(); rooms.delete(code); }
    }
  }

  function enter(room, data, ack) {
    const playerId = validPlayerId(data.playerId);
    if (!playerId) return ack({ error: 'Identificador inválido. Recarregue a página.' });
    if (socket.data.code && socket.data.code !== room.code) leaveCurrent();
    socket.join(room.code);
    const res = room.join(playerId, data.name, socket.id);
    if (res.error) {
      socket.leave(room.code);
      if (room.players.size === 0) rooms.delete(room.code);
      return ack(res);
    }
    socket.data.code = room.code;
    socket.data.playerId = playerId;
    ack({ ok: true, code: room.code });
    socket.emit('state', room.publicState());
  }

  socket.on('create', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const code = newCode();
    const room = new Room(code, broadcast);
    rooms.set(code, room);
    enter(room, data || {}, ack);
  });

  socket.on('join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    data = data || {};
    const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) return ack({ error: 'Sala não encontrada. Confira o código ou crie uma nova sala.' });
    enter(room, data, ack);
  });

  // Ações dentro de uma sala
  const inRoom = handler => (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = socket.data.code && rooms.get(socket.data.code);
    if (!room) return ack({ error: 'Você não está em uma sala. Recarregue a página.' });
    try {
      ack(handler(room, socket.data.playerId, data || {}) || { ok: true });
    } catch (err) {
      console.error(err);
      ack({ error: 'Algo deu errado no servidor. Tente de novo.' });
    }
  };

  socket.on('settings', inRoom((room, pid, data) => room.updateSettings(pid, data)));
  socket.on('start', inRoom((room, pid) => room.start(pid)));
  socket.on('submit', inRoom((room, pid, data) => room.submit(pid, data.word)));
  socket.on('contest', inRoom((room, pid) => room.contest(pid)));
  socket.on('vote', inRoom((room, pid, data) => room.vote(pid, data.accept)));
  socket.on('playAgain', inRoom((room, pid) => room.playAgain(pid)));
  socket.on('react', inRoom((room, pid, data) => {
    const now = Date.now();
    if (now - socket.data.lastReaction < 500 || !REACTIONS.includes(data.emoji)) return { ok: false };
    socket.data.lastReaction = now;
    io.to(room.code).emit('reaction', { by: pid, emoji: data.emoji });
    return { ok: true };
  }));

  socket.on('disconnect', leaveCurrent);
});

// Limpa salas abandonadas (ninguém conectado há 30 minutos)
setInterval(() => {
  const limit = Date.now() - 30 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.connected().length === 0 && room.lastActivity < limit) {
      room.clearTimer();
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Stop de Palavras rodando em http://localhost:${PORT}`);
});
