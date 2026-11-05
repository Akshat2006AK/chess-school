/**
 * Chess School Server - Multiplayer backend with Socket.io
 * Handles authentication, rooms, and real-time game synchronization
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const { db, userOps, statsOps, gameOps, roomOps, tournamentOps, announcementOps, adminStatsOps, generateRoomCode, hashPassword, verifyPassword } = require('./database');
const { START, legalMoves, make, chk, capSq, enough, fmt, checkDraw, best } = require('./chess-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for the game
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session storage (in-memory for active connections)
const sessions = new Map(); // socketId -> { userId, username, roomId, color }
const roomStates = new Map(); // roomId -> game state

// Helper: Get user from socket
function getSession(socketId) {
  return sessions.get(socketId);
}

// Helper: Broadcast to room except sender
function broadcastToRoom(roomId, event, data, excludeSocketId) {
  io.to(roomId).except(excludeSocketId).emit(event, data);
}

// Helper: Save game to database
async function saveGame(roomId, gameState, result) {
  const room = roomOps.getById.get(roomId);
  if (!room) return;

  const moves = gameState.history.map(h => h.move);
  gameOps.updateResult.run(result, JSON.stringify(moves), Math.floor(Date.now() / 1000), roomId);
}

// Helper: Update user stats
function updateStats(userId, result) {
  if (!userId || userId === 'guest') return;
  if (result === 'white') statsOps.incrementWin.run(userId);
  else if (result === 'black') statsOps.incrementLoss.run(userId);
  else if (result === 'draw') statsOps.incrementDraw.run(userId);
}

// Authentication endpoints
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (!/^[A-Za-z0-9_ ]{3,16}$/.test(username)) {
      return res.status(400).json({ error: 'Username: 3-16 chars, letters/numbers/spaces/underscores' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = userOps.getByUsername.get(username.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const passwordHash = await hashPassword(password, salt);
    const userId = require('uuid').v4();

    userOps.create.run(userId, username, passwordHash, salt);
    statsOps.upsert.run(userId);

    res.json({ success: true, userId, username, pending: true, message: 'Registration submitted. Awaiting admin approval.' });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = userOps.getByUsername.get(username.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.registration_status === 'pending') {
      return res.status(403).json({ error: 'Your account is pending admin approval' });
    }
    if (user.registration_status === 'rejected') {
      return res.status(403).json({ error: 'Your registration has been rejected' });
    }

    const valid = await verifyPassword(password, user.salt, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    userOps.updateLastLogin.run(Math.floor(Date.now() / 1000), user.id);

    res.json({
      success: true,
      userId: user.id,
      username: user.username
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/stats/:userId', (req, res) => {
  const stats = statsOps.get.get(req.params.userId);
  if (!stats) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(stats);
});

app.get('/api/auth/history/:userId', (req, res) => {
  const games = gameOps.getByUser.all(req.params.userId, req.params.userId);
  res.json(games.map(g => ({
    ...g,
    moves: JSON.parse(g.moves || '[]')
  })));
});

// Admin middleware
function requireAdmin(req, res, next) {
  const { userId } = req.body;
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const user = userOps.getById.get(userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.adminUser = user;
  next();
}

// Admin API endpoints

// Dashboard stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const stats = adminStatsOps.getOverview.get();
    res.json(stats);
  } catch (e) {
    console.error('Admin stats error:', e);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// User management
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = userOps.getAll.all();
    res.json(users);
  } catch (e) {
    console.error('Get users error:', e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/users/pending', requireAdmin, (req, res) => {
  try {
    const users = userOps.getPending.all();
    res.json(users);
  } catch (e) {
    console.error('Get pending users error:', e);
    res.status(500).json({ error: 'Failed to fetch pending users' });
  }
});

app.put('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  try {
    userOps.updateStatus.run('approved', req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Approve user error:', e);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

app.put('/api/admin/users/:id/reject', requireAdmin, (req, res) => {
  try {
    userOps.updateStatus.run('rejected', req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Reject user error:', e);
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

app.put('/api/admin/users/:id/admin', requireAdmin, (req, res) => {
  try {
    const { isAdmin } = req.body;
    userOps.setAdmin.run(isAdmin ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Set admin error:', e);
    res.status(500).json({ error: 'Failed to update admin status' });
  }
});

// Room management (admin view)
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  try {
    const rooms = roomOps.getWithPlayers.all();
    res.json(rooms.map(r => ({
      ...r,
      game_state: r.game_state ? JSON.parse(r.game_state) : null
    })));
  } catch (e) {
    console.error('Get rooms error:', e);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// Game management (admin view)
app.get('/api/admin/games', requireAdmin, (req, res) => {
  try {
    const games = gameOps.getAll.all();
    res.json(games.map(g => ({
      ...g,
      moves: JSON.parse(g.moves || '[]')
    })));
  } catch (e) {
    console.error('Get games error:', e);
    res.status(500).json({ error: 'Failed to fetch games' });
  }
});

// Tournament management
app.get('/api/admin/tournaments', requireAdmin, (req, res) => {
  try {
    const tournaments = tournamentOps.getAll.all();
    res.json(tournaments);
  } catch (e) {
    console.error('Get tournaments error:', e);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

app.post('/api/admin/tournaments', requireAdmin, (req, res) => {
  try {
    const { name, description, startTime, endTime, timeControl, maxPlayers } = req.body;
    if (!name || !startTime || !timeControl) {
      return res.status(400).json({ error: 'Name, start time, and time control required' });
    }
    const id = require('uuid').v4();
    tournamentOps.create.run(id, name, description || '', startTime, endTime || null, timeControl, maxPlayers || 64, req.adminUser.id);
    res.json({ success: true, id });
  } catch (e) {
    console.error('Create tournament error:', e);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

app.put('/api/admin/tournaments/:id', requireAdmin, (req, res) => {
  try {
    const { name, description, startTime, endTime, timeControl, maxPlayers, status } = req.body;
    tournamentOps.update.run(name, description || '', startTime, endTime || null, timeControl, maxPlayers || 64, status || 'upcoming', req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Update tournament error:', e);
    res.status(500).json({ error: 'Failed to update tournament' });
  }
});

app.put('/api/admin/tournaments/:id/status', requireAdmin, (req, res) => {
  try {
    const { status } = req.body;
    tournamentOps.updateStatus.run(status, req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Update tournament status error:', e);
    res.status(500).json({ error: 'Failed to update tournament status' });
  }
});

app.delete('/api/admin/tournaments/:id', requireAdmin, (req, res) => {
  try {
    tournamentOps.delete.run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete tournament error:', e);
    res.status(500).json({ error: 'Failed to delete tournament' });
  }
});

app.get('/api/admin/tournaments/:id/registrations', requireAdmin, (req, res) => {
  try {
    const registrations = tournamentOps.getRegistrations.all(req.params.id);
    res.json(registrations);
  } catch (e) {
    console.error('Get tournament registrations error:', e);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// Announcement management
app.get('/api/admin/announcements', requireAdmin, (req, res) => {
  try {
    const announcements = announcementOps.getAll.all();
    res.json(announcements);
  } catch (e) {
    console.error('Get announcements error:', e);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  try {
    const { title, content, type, targetAudience, expiresAt } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content required' });
    }
    const id = require('uuid').v4();
    announcementOps.create.run(id, title, content, type || 'info', targetAudience || 'all', req.adminUser.id, expiresAt || null);
    res.json({ success: true, id });
  } catch (e) {
    console.error('Create announcement error:', e);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

app.put('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  try {
    const { title, content, type, targetAudience, expiresAt, isActive } = req.body;
    announcementOps.update.run(title, content, type || 'info', targetAudience || 'all', expiresAt || null, isActive ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Update announcement error:', e);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

app.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  try {
    announcementOps.delete.run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete announcement error:', e);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// Public endpoints for announcements and tournaments (for frontend)
app.get('/api/announcements', (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const announcements = announcementOps.getActive.all(now);
    res.json(announcements);
  } catch (e) {
    console.error('Get public announcements error:', e);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

app.get('/api/tournaments', (req, res) => {
  try {
    const tournaments = tournamentOps.getByStatus.all('upcoming');
    res.json(tournaments);
  } catch (e) {
    console.error('Get public tournaments error:', e);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

app.get('/api/tournaments/:id', (req, res) => {
  try {
    const tournament = tournamentOps.getById.get(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }
    res.json(tournament);
  } catch (e) {
    console.error('Get tournament error:', e);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

// Room endpoints
app.post('/api/rooms/create', (req, res) => {
  try {
    const { userId, username, timeControl } = req.body;
    if (!userId || !username) {
      return res.status(400).json({ error: 'User ID and username required' });
    }

    let code;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
    } while (roomOps.getByCode.get(code) && attempts < 10);

    if (attempts >= 10) {
      return res.status(500).json({ error: 'Could not generate room code' });
    }

    const roomId = require('uuid').v4();
    const gameState = {
      board: START.slice(),
      turn: 'w',
      history: [],
      clocks: { w: 0, b: 0 },
      clockSide: null,
      started: false,
      over: false,
      result: null,
      lastMove: null,
      hm: 0, // halfmove clock
      keys: []
    };

    // Parse time control (e.g., "600+0" -> 600000ms base, 0ms increment)
    const [base, inc] = (timeControl || '600+0').split('+').map(Number);
    gameState.clocks = { w: base * 1000, b: base * 1000 };
    gameState.timeControl = { base: base * 1000, inc: inc * 1000 };

    roomOps.create.run(roomId, code, userId, username, 'multiplayer', timeControl || '600+0', JSON.stringify(gameState));
    roomStates.set(roomId, gameState);

    res.json({ success: true, roomId, code, gameState });
  } catch (e) {
    console.error('Create room error:', e);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.post('/api/rooms/join', (req, res) => {
  try {
    const { code, userId, username } = req.body;
    if (!code || !userId || !username) {
      return res.status(400).json({ error: 'Code, user ID, and username required' });
    }

    const room = roomOps.getByCode.get(code.toUpperCase());
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (room.status !== 'waiting') {
      return res.status(400).json({ error: 'Room is not accepting players' });
    }
    if (room.guest_id) {
      return res.status(400).json({ error: 'Room is full' });
    }
    if (room.host_id === userId) {
      return res.status(400).json({ error: 'You are already the host' });
    }

    const now = Math.floor(Date.now() / 1000);
    roomOps.updateGuest.run(userId, username, now, room.id);
    roomOps.updateStatus.run('playing', now, room.id);

    const gameState = roomStates.get(room.id) || JSON.parse(room.game_state);
    roomStates.set(room.id, gameState);

    res.json({ success: true, roomId: room.id, gameState, color: 'b' });
  } catch (e) {
    console.error('Join room error:', e);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = roomOps.getById.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json(room);
});

app.get('/api/rooms', (req, res) => {
  const rooms = roomOps.getWaiting.all();
  res.json(rooms.map(r => ({
    id: r.id,
    code: r.code,
    hostName: r.host_name,
    timeControl: r.time_control,
    createdAt: r.created_at
  })));
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Authenticate socket
  socket.on('auth', (data) => {
    const { userId, username, roomId } = data;
    if (!userId || !username) {
      socket.emit('auth:error', { error: 'Invalid auth data' });
      return;
    }

    sessions.set(socket.id, { userId, username, roomId: null, color: null });
    socket.emit('auth:ok', { userId, username });
  });

  // Join room
  socket.on('room:join', (data) => {
    const session = getSession(socket.id);
    if (!session) {
      socket.emit('room:error', { error: 'Not authenticated' });
      return;
    }

    const { roomId } = data;
    const room = roomOps.getById.get(roomId);
    if (!room) {
      socket.emit('room:error', { error: 'Room not found' });
      return;
    }

    // Determine color
    let color;
    if (room.host_id === session.userId) color = 'w';
    else if (room.guest_id === session.userId) color = 'b';
    else {
      socket.emit('room:error', { error: 'Not a participant in this room' });
      return;
    }

    session.roomId = roomId;
    session.color = color;
    socket.join(roomId);

    const gameState = roomStates.get(roomId) || JSON.parse(room.game_state);
    roomStates.set(roomId, gameState);

    // Send current game state
    socket.emit('room:state', {
      gameState,
      color,
      opponent: color === 'w' ? room.guest_name : room.host_name,
      you: session.username
    });

    // Notify opponent
    broadcastToRoom(roomId, 'room:player-joined', { color }, socket.id);
  });

  // Make move
  socket.on('game:move', (data) => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) {
      socket.emit('game:error', { error: 'Not in a room' });
      return;
    }

    const { move } = data; // [from, to, promotion?]
    const roomId = session.roomId;
    const gameState = roomStates.get(roomId);

    if (!gameState || gameState.over) {
      socket.emit('game:error', { error: 'Game not active' });
      return;
    }

    // Verify it's player's turn
    if (gameState.turn !== session.color) {
      socket.emit('game:error', { error: 'Not your turn' });
      return;
    }

    // Validate move
    const legal = legalMoves(gameState.board, gameState.turn);
    const moveMatch = legal.find(m => m[0] === move[0] && m[1] === move[1] && (m[2] === move[2] || (!m[2] && !move[2])));

    if (!moveMatch) {
      socket.emit('game:error', { error: 'Illegal move' });
      return;
    }

    // Handle promotion choice if needed
    if (moveMatch[2] && !move[2]) {
      socket.emit('game:promotion', { move: moveMatch, legal });
      return;
    }

    // Apply move
    const capturedSquare = capSq(gameState.board, moveMatch);
    const captured = capturedSquare >= 0 ? gameState.board[capturedSquare] : null;
    const wasCheck = chk(gameState.board, gameState.turn === 'w' ? 'b' : 'w');

    gameState.board = make(gameState.board, moveMatch);
    gameState.history.push({
      move: moveMatch,
      captured,
      capturedSquare,
      check: wasCheck,
      timestamp: Date.now()
    });
    gameState.lastMove = moveMatch;
    gameState.hm = (moveMatch[2] || captured) ? 0 : gameState.hm + 1;

    // Update clock
    if (gameState.started && gameState.timeControl) {
      gameState.clocks[session.color] += gameState.timeControl.inc;
    }
    gameState.started = true;
    gameState.clockSide = gameState.turn === 'w' ? 'b' : 'w';
    gameState.turn = gameState.clockSide;

    // Check for game end
    const nextLegal = legalMoves(gameState.board, gameState.turn);
    if (!nextLegal.length) {
      gameState.over = true;
      gameState.clockSide = null;
      if (chk(gameState.board, gameState.turn)) {
        gameState.result = gameState.turn === 'w' ? 'b' : 'w';
      } else {
        gameState.result = 'draw';
      }
    } else {
      // Check draw conditions
      const drawCheck = checkDraw(gameState.board, gameState.turn, gameState.hm, gameState.keys);
      if (drawCheck.draw) {
        gameState.over = true;
        gameState.clockSide = null;
        gameState.result = 'draw';
        gameState.drawReason = drawCheck.reason;
      }
      gameState.keys = drawCheck.keys;
    }

    // Save state
    roomStates.set(roomId, gameState);
    roomOps.updateState.run(JSON.stringify(gameState), Math.floor(Date.now() / 1000), roomId);

    // Broadcast move
    io.to(roomId).emit('game:move', {
      move: moveMatch,
      gameState: {
        board: gameState.board,
        turn: gameState.turn,
        clocks: gameState.clocks,
        clockSide: gameState.clockSide,
        over: gameState.over,
        result: gameState.result,
        lastMove: gameState.lastMove,
        drawReason: gameState.drawReason
      }
    });

    // If game over, save and notify
    if (gameState.over) {
      const result = gameState.result;
      saveGame(roomId, gameState, result);
      updateStats(roomOps.getById.get(roomId).host_id, result === 'w' ? 'white' : result === 'b' ? 'black' : 'draw');
      updateStats(roomOps.getById.get(roomId).guest_id, result === 'b' ? 'white' : result === 'w' ? 'black' : 'draw');
      roomOps.updateStatus.run('finished', Math.floor(Date.now() / 1000), roomId);

      io.to(roomId).emit('game:over', { result, drawReason: gameState.drawReason });
    }
  });

  // Promotion choice
  socket.on('game:promote', (data) => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    const { move, promotion } = data;
    const roomId = session.roomId;
    const gameState = roomStates.get(roomId);

    if (!gameState || gameState.turn !== session.color) return;

    const fullMove = [move[0], move[1], promotion];
    const legal = legalMoves(gameState.board, gameState.turn);
    const valid = legal.find(m => m[0] === fullMove[0] && m[1] === fullMove[1] && m[2] === promotion);

    if (!valid) return;

    // Re-emit as a move
    socket.emit('game:move', { move: fullMove });
  });

  // Resign
  socket.on('game:resign', () => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    const roomId = session.roomId;
    const gameState = roomStates.get(roomId);
    if (!gameState || gameState.over) return;

    gameState.over = true;
    gameState.clockSide = null;
    gameState.result = session.color === 'w' ? 'b' : 'w';

    roomStates.set(roomId, gameState);
    roomOps.updateState.run(JSON.stringify(gameState), Math.floor(Date.now() / 1000), roomId);
    saveGame(roomId, gameState, gameState.result);

    const room = roomOps.getById.get(roomId);
    updateStats(room.host_id, gameState.result === 'w' ? 'white' : 'black');
    updateStats(room.guest_id, gameState.result === 'b' ? 'white' : 'black');
    roomOps.updateStatus.run('finished', Math.floor(Date.now() / 1000), roomId);

    io.to(roomId).emit('game:over', { result: gameState.result, resigned: true, by: session.color });
  });

  // Draw offer
  socket.on('game:draw-offer', () => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    broadcastToRoom(session.roomId, 'game:draw-offer', { from: session.color }, socket.id);
  });

  socket.on('game:draw-accept', () => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    const roomId = session.roomId;
    const gameState = roomStates.get(roomId);
    if (!gameState || gameState.over) return;

    gameState.over = true;
    gameState.clockSide = null;
    gameState.result = 'draw';
    gameState.drawReason = 'agreed draw';

    roomStates.set(roomId, gameState);
    roomOps.updateState.run(JSON.stringify(gameState), Math.floor(Date.now() / 1000), roomId);
    saveGame(roomId, gameState, 'draw');

    const room = roomOps.getById.get(roomId);
    updateStats(room.host_id, 'draw');
    updateStats(room.guest_id, 'draw');
    roomOps.updateStatus.run('finished', Math.floor(Date.now() / 1000), roomId);

    io.to(roomId).emit('game:over', { result: 'draw', drawReason: 'agreed draw' });
  });

  socket.on('game:draw-decline', () => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    broadcastToRoom(session.roomId, 'game:draw-decline', { from: session.color }, socket.id);
  });

  // Rematch
  socket.on('game:rematch', () => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    const roomId = session.roomId;
    const room = roomOps.getById.get(roomId);
    if (!room) return;

    // Reset game state
    const gameState = {
      board: START.slice(),
      turn: 'w',
      history: [],
      clocks: { w: 0, b: 0 },
      clockSide: null,
      started: false,
      over: false,
      result: null,
      lastMove: null,
      hm: 0,
      keys: []
    };

    const [base, inc] = (room.time_control || '600+0').split('+').map(Number);
    gameState.clocks = { w: base * 1000, b: base * 1000 };
    gameState.timeControl = { base: base * 1000, inc: inc * 1000 };

    roomStates.set(roomId, gameState);
    roomOps.updateState.run(JSON.stringify(gameState), Math.floor(Date.now() / 1000), roomId);
    roomOps.updateStatus.run('playing', Math.floor(Date.now() / 1000), roomId);

    io.to(roomId).emit('game:rematch', { gameState });
  });

  // Sync request (for reconnection)
  socket.on('game:sync', () => {
    const session = getSession(socket.id);
    if (!session || !session.roomId) return;

    const gameState = roomStates.get(session.roomId);
    if (gameState) {
      socket.emit('room:state', {
        gameState,
        color: session.color,
        opponent: session.color === 'w' ? 'Black' : 'White',
        you: session.username
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const session = getSession(socket.id);
    if (session && session.roomId) {
      broadcastToRoom(session.roomId, 'room:player-left', { color: session.color }, socket.id);
    }
    sessions.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

// Clock synchronization (server-authoritative)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, gameState] of roomStates.entries()) {
    if (gameState.over || !gameState.started || !gameState.clockSide || !gameState.timeControl) continue;

    // Note: In production, you'd want more precise timing
    // This is a simple approximation - clients also track time locally
  }
}, 1000);

// Cleanup old room states from memory periodically
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
  for (const [roomId, state] of roomStates.entries()) {
    const room = roomOps.getById.get(roomId);
    if (!room || (room.status === 'finished' && room.updated_at * 1000 < cutoff)) {
      roomStates.delete(roomId);
    }
  }
}, 60 * 60 * 1000); // Every hour

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Serve the main HTML file for all non-API routes (SPA support)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) return;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chess School server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});