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

`LocalTransport` emits the exact same `system` / `chunk` / `done` messages with the same chunk size (18 characters) and cadence (80 ms) as the server, so the streaming UI runs unchanged.

Falling back is always reported, never silent. When no `WS_URL` is configured the pill reads **Demo mode**. When a `WS_URL` *is* configured but did not answer, the pill reads **Demo mode - server unreachable**, the transcript names the URL that failed, and a **Retry server** button stays on screen so the real server can be tried again — a stale or dead `WS_URL` can never leave the app looking alive when it is not.

If the WebSocket drops after it was established, the client reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s) for at most 5 attempts. After that it stops, shows **Server unavailable**, and offers **Retry server** instead of retrying forever.

A socket can also stay open while the server behind it stops answering — no close, no error, just silence. That wait is bounded as well: if a reply is silent for 20 seconds, before its first chunk or between two of them, the transcript says so, whatever text already arrived is kept, and the composer is released. Both transports chunk every 80 ms, so the deadline only ever fires on a server that has genuinely gone quiet.

### Sending before the transport is ready

The composer accepts a send at any time — Enter and the **Send** button behave identically — so every send has a defined outcome and message text is never dropped:

| Transport state | What happens to the text |
| --- | --- |
| `open` | Sent. It only joins the transcript once the transport has accepted it. |
| `connecting` / `reconnecting` | Queued — shown as a dimmed "Queued" bubble and flushed automatically on `open`. |
| `unavailable` | Refused. The text is handed back to the composer with a system line explaining why. |
| reply still streaming | Refused. The text stays in the composer until the current reply finishes. |

A queued message that never gets a connection — the retry budget runs out while it waits — is also handed back to the composer rather than left waiting forever.

**Send** is only greyed out in the two states its own label explains — `Waiting for reply...` and `Queued...`. It stays live while the app is connecting, reconnecting or unavailable, because a click there still has a defined outcome; disabling it in those states left pointer and touch users, who have no Enter key, with no way to reach the queue at all.

### Controls

Every control in the UI, and where it leads:

| Control | Action | Shown when | With nothing to show |
| --- | --- | --- | --- |
| Message composer (`textarea`) | Enter sends; Shift+Enter adds a newline; the box grows with the text up to 140px | Always | Empty box with a placeholder; an empty send is a no-op |
| **Send** | Same path as Enter: sends, queues, or refuses with a system line | Always | Disabled only while a reply streams or a message is queued, and labelled with the reason |
| **Retry server** | Re-runs the whole boot sequence against `WS_URL` | Only when a `WS_URL` is configured *and* is not currently carrying the chat (`unavailable`, or the in-browser fallback stood in for it) | Hidden — with no server configured there is nothing to retry |
| Status pill | Reports the live transport state: `Connecting...`, `Online`, `Demo mode`, `Demo mode - server unreachable`, `Offline (reconnecting...)`, `Server unavailable` | Always | Never empty; it always names a state |
| Transcript | Renders user turns, streamed replies and system lines | Always | Empty state explaining what to do and that replies are placeholder text |

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
│   ├── tests/                  # Vitest regression suite
│   ├── index.html
│   ├── style.css
│   ├── vite.config.ts
│   ├── vitest.config.ts
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

## Tests

```bash
npm test              # from the repo root, or from frontend/
```

The suite runs on [Vitest](https://vitest.dev/) in a jsdom environment. It boots the real
`app.ts` against the real `index.html` markup, with fake timers and a scripted WebSocket
stand-in, so no network, no server and no wall-clock waiting are involved.

It is a regression suite rather than a coverage exercise, and covers the three failure modes
that are easy to reintroduce:

| Area | What is pinned |
| --- | --- |
| Chunk protocol | One `requestId` per stream, chunks before the single `done`, 18-character framing, exact reassembly, interleaved streams kept apart, a stale `done` not releasing the composer |
| Transport fallback | An unreachable `WS_URL` gives up within the 3s deadline, names the failed server in the transcript, shows **Demo mode - server unreachable** and keeps **Retry server** live; with no `WS_URL` nothing is dialled and no failure is claimed |
| Sending before ready | Enter while connecting queues and flushes on `open`; an exhausted retry budget hands the text back to the composer; `unavailable` and mid-reply sends are refused without losing a character |

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

The frontend is a static bundle with no runtime dependency on the backend: if the configured server is unreachable it falls back to the in-browser transport, so a deployed build never lands on a dead connection. The fallback is announced in the UI — pill, transcript and a **Retry server** button — so a `WS_URL` left pointing at a decommissioned host is visible rather than mistaken for a deliberate demo.

## License

MIT
