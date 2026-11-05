# Chess School 🏫♟️

A 3D multiplayer chess platform where you can learn chess by playing. Features a beautiful Three.js 3D board, computer opponents at multiple difficulty levels, local two-player mode, and **online multiplayer** with real-time synchronization.

## Features

- 🎮 **3D Chess Board** - Immersive Three.js battlefield with animated pieces, fire effects, and dynamic lighting
- 🤖 **Computer Opponents** - Three levels: Beginner (careless), Medium (2-ply search), Expert (3-ply search)
- 👥 **Local Two-Player** - Play on the same screen with auto-turn view rotation
- 🌐 **Online Multiplayer** - Create/join rooms with 6-character codes, real-time Socket.io sync
- 🔐 **Authentication** - Register/login with secure bcrypt password hashing
- 📊 **Statistics** - Track wins, draws, losses, and game history
- ⏱️ **Time Controls** - Multiple clock options (bullet, blitz, rapid, classical)
- 💡 **Learning Hints** - Guided mode with move dots, danger warnings, and hint button
- ♿ **Accessibility** - Full keyboard navigation, screen reader support, reduced motion
- 📱 **Responsive** - Works on desktop and mobile

## Tech Stack

- **Backend**: Node.js, Express, Socket.io, better-sqlite3, bcryptjs
- **Frontend**: Vanilla JS, Three.js (r128), Web Workers for AI
- **Database**: SQLite (file-based, zero-config)
- **Deployment**: Render-ready with environment configuration

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start development server (with auto-reload)
npm run dev

# Or start production server
npm start
```

Open http://localhost:3000

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment mode |
| `DATABASE_PATH` | `./data/chess.db` | SQLite database file path |
| `CORS_ORIGIN` | `*` | CORS allowed origin |

Create a `.env` file for local overrides:
```env
PORT=3000
NODE_ENV=development
DATABASE_PATH=./data/chess.db
CORS_ORIGIN=http://localhost:3000
```

## Deployment on Render

1. **Create a new Web Service** on Render
2. **Connect your GitHub repository**
3. **Configure:**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: Node
4. **Add Environment Variables:**
   - `NODE_ENV` = `production`
   - `CORS_ORIGIN` = `https://your-app-name.onrender.com` (your Render URL)
   - `DATABASE_PATH` = `/var/data/chess.db` (Render persistent disk path)
5. **Add a Persistent Disk:**
   - Name: `chess-data`
   - Mount Path: `/var/data`
   - Size: 1 GB (plenty for SQLite)
6. **Deploy!**

The app will be available at your Render URL.

## Project Structure

```
chess-school/
├── server.js          # Express + Socket.io server
├── database.js        # SQLite database operations
├── chess-engine.js    # Shared chess logic (client & server)
├── package.json       # Dependencies and scripts
├── public/
│   └── index.html     # Complete frontend (HTML/CSS/JS)
├── data/              # SQLite database (created at runtime)
├── .gitignore
└── README.md
```

## Game Controls

### Mouse/Touch
- **Click/Tap** piece to select, click destination to move
- **Drag** to rotate view
- **Scroll/Pinch** to zoom
- **Right-drag / Two-finger drag** to pan

### Keyboard (Tab to focus board)
- **Arrow keys** - Move cursor
- **Enter/Space** - Select piece / Make move
- **Escape** - Cancel selection
- **Shift + Arrows** - Rotate view
- **+/-** - Zoom in/out

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/stats/:userId` - Get user stats
- `GET /api/auth/history/:userId` - Get game history

### Rooms
- `POST /api/rooms/create` - Create multiplayer room
- `POST /api/rooms/join` - Join room by code
- `GET /api/rooms/:roomId` - Get room details
- `GET /api/rooms` - List waiting rooms

### Health
- `GET /health` - Health check

## Socket.io Events

### Client → Server
- `auth` - Authenticate socket
- `room:join` - Join game room
- `game:move` - Make a move
- `game:promote` - Choose promotion piece
- `game:resign` - Resign game
- `game:draw-offer` - Offer draw
- `game:draw-accept` - Accept draw
- `game:draw-decline` - Decline draw
- `game:rematch` - Request rematch
- `game:sync` - Request state sync

### Server → Client
- `auth:ok` / `auth:error` - Auth result
- `room:state` - Current game state
- `room:player-joined` - Opponent joined
- `room:player-left` - Opponent left
- `game:move` - Move played
- `game:promotion` - Promotion required
- `game:over` - Game ended
- `game:draw-offer` - Draw offered
- `game:draw-decline` - Draw declined
- `game:rematch` - Rematch started
- `room:error` / `game:error` - Errors

## License

MIT License - Feel free to use for learning or personal projects!

---

**Made by Avantika** ❤️