## Live Demo

- **Frontend (Vercel):** https://agent-console-rho.vercel.app/
- **Backend (Render, normal mode):** https://agent-console-s65e.onrender.com
  - Health: https://agent-console-s65e.onrender.com/health
  - Protocol log: https://agent-console-s65e.onrender.com/log
  - Reset session: https://agent-console-s65e.onrender.com/reset

> The backend runs on Render's free tier and sleeps after ~15 minutes of inactivity. Open the `/health` link first and wait for it to respond (can take up to a minute) before using the console. The server is single-session, so only one browser tab should be connected at a time.

---

## Architecture

The app is built around a strict three-layer separation: a pure TypeScript AgentProtocol class, a useReducer hook runs a typed state machine that translates protocol events into render state, and React components are purely read-only renderers.

```
AgentProtocol (class, zero React imports)
  — seq ordering buffer, deduplication, PING/PONG, TOOL_ACK, reconnect + backoff, token batching
      ↓ clean ordered deduplicated actions
useAgentReducer (useReducer)
  — phase transitions, segment list, context snapshot history
      ↓ render state only
React components
  — read-only render, no protocol logic
```

![WebSocket State Machine](docs/screenshots/state-machine.png)

---

## Running the App

### Prerequisites

- Node.js 18+
- Docker

### 1. Start the agent server

**Normal mode**

```bash
docker build -t agent-server ./agent-server
docker run -p 4747:4747 agent-server
```

**Chaos mode**

```bash
docker run -p 4747:4747 agent-server --mode chaos
```

Verify the server is up:

```bash
curl http://localhost:4747/health
```

### 2. Start the console

```bash
npm install
npm run build
npm run start
```

Open **http://localhost:3000**

No environment variables required locally. WebSocket URL defaults to `ws://localhost:4747/ws`.

For a deployed build, set `NEXT_PUBLIC_WS_URL` to the hosted agent server (e.g. `wss://agent-server.onrender.com/ws`). It is inlined at build time, so changing it requires a rebuild. The page is served over HTTPS, so the URL must use `wss://`.

---

## Screenshots in normal mode

### Full console — streaming chat, trace timeline, context panel

![Full console view showing streaming chat with tool cards on the left, trace timeline in the centre, and context inspector on the right](docs/screenshots/full-console.png)

### Trace timeline — grouped tokens, tool call pairs, PING/PONG rows

![Trace timeline showing a merged TOKEN group row, indented TOOL_CALL and TOOL_RESULT pairs linked by call_id, and PING/PONG rows at the bottom](docs/screenshots/trace-timeline.png)

### Context inspector — structural diff between two snapshots

![Context inspector showing snapshot 2 of 2 with green added badges for analysis_complete and flagged_issues, and an amber changed badge for the tables key](docs/screenshots/context-diff.png)
