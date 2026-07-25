# WebSocket Chat - ChatGPT/Cursor-like Streaming Chat

<img width="1167" height="668" alt="image" src="https://github.com/user-attachments/assets/057b4749-7f76-4c56-81b3-f110356d7fd0" />

A real-time chat application with streaming responses, similar to ChatGPT or Cursor. Built with TypeScript, Node.js WebSocket server, and a modern frontend.

Answers are **placeholder text, not model output** — the point of the project is the streaming transport and the chunk-reassembly UI, not the content of the replies.

## Features

- 🚀 **Streaming Responses**: Messages are delivered in chunks, creating a smooth streaming experience
- 💬 **Real-time Communication**: WebSocket-based bidirectional communication
- 🔌 **Pluggable Transport**: The same JSON protocol runs over a WebSocket server or entirely in the browser
- 🎨 **Modern UI**: Clean, ChatGPT/Cursor-inspired interface
- 🔧 **TypeScript**: Fully typed codebase for better developer experience
- 🌐 **CORS Enabled**: Ready for cross-origin deployments
- ⚙️ **Environment Configuration**: Easy configuration via `.env` files

## Tech Stack

- **Backend**: Node.js, TypeScript, WebSocket (ws), Faker.js
- **Frontend**: TypeScript, Vite, Vanilla JavaScript
- **Protocol**: WebSocket with JSON message format

## Transports

The frontend talks to a `ChatTransport` (`frontend/src/types.ts`), so the UI never touches a socket directly. Two implementations ship with the project:

| Transport | File | Used when |
| --- | --- | --- |
| `WebSocketTransport` | `frontend/src/ws-transport.ts` | `WS_URL` is configured and the server accepts the connection within 3s |
| `LocalTransport` | `frontend/src/local-transport.ts` | No `WS_URL` is configured, or the configured server does not answer |

`LocalTransport` emits the exact same `system` / `chunk` / `done` messages with the same chunk size (18 characters) and cadence (80 ms) as the server, so the streaming UI runs unchanged. The status pill reads **Demo mode** while it is active, and a system message in the chat says so.

If the WebSocket drops after it was established, the client reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s) for at most 5 attempts. After that it stops, shows **Server unavailable**, and offers a **Retry** button instead of retrying forever.

## Project Structure

```
├── backend/
│   ├── src/
│   │   ├── server.ts      # WebSocket server
│   │   └── types.ts       # TypeScript types
│   ├── tsconfig.json
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── app.ts              # UI and streaming state machine
│   │   ├── ws-transport.ts     # WebSocket transport + reconnect policy
│   │   ├── local-transport.ts  # In-browser transport (demo mode)
│   │   ├── reply-generator.ts  # Placeholder answer text for demo mode
│   │   ├── types.ts            # Protocol and transport types
│   │   └── generate-env.ts     # Environment generator
│   ├── index.html
│   ├── style.css
│   ├── vite.config.ts
│   └── package.json
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Backend Setup

1. Navigate to the backend directory:

```bash
cd backend
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file (optional):

```env
PORT=3001
```

4. Build TypeScript:

```bash
npm run build
```

5. Start the server:

```bash
npm start
```

The WebSocket server will run on `ws://localhost:3001` by default.

### Frontend Setup

1. Navigate to the frontend directory:

```bash
cd frontend
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file (copy `.env.example`):

```env
WS_URL=ws://localhost:3001
```

Leave `WS_URL` empty to skip the server entirely and run against the in-browser transport.

4. Generate environment configuration:

```bash
npm run build:env
```

5. Start the development server:

```bash
npm run dev
```

Or build for production:

```bash
npm run build
npm run preview
```

## WebSocket Protocol

### Client → Server

Send a message:

```json
{
  "type": "message",
  "content": "Hello, bot!"
}
```

### Server → Client

**Chunk** (streaming response):

```json
{
  "type": "chunk",
  "requestId": "uuid",
  "content": "Partial text..."
}
```

**Done** (streaming complete):

```json
{
  "type": "done",
  "requestId": "uuid"
}
```

**System** (connection message):

```json
{
  "type": "system",
  "content": "WebSocket connected..."
}
```

**Error**:

```json
{
  "type": "error",
  "error": "Error message"
}
```

## Deployment

### Backend (Render, Railway, etc.)

1. Set environment variables in your hosting platform
2. Build command: `npm run build`
3. Start command: `npm start`

### Frontend (Vercel, Netlify, etc.)

1. Set `WS_URL` environment variable to your backend WebSocket URL, or leave it unset to deploy in demo mode
2. Build command: `npm run build`
3. Output directory: `dist`

The frontend is a static bundle with no runtime dependency on the backend: if the configured server is unreachable it falls back to the in-browser transport, so a deployed build never lands on a dead connection.

## License

MIT
