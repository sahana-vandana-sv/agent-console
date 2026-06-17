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

<details>
<summary>State diagram — inline SVG (for environments without Mermaid)</summary>

<svg viewBox="0 0 820 620" width="100%" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>WebSocket State Machine</title>
  <desc>State diagram showing transitions between IDLE, CONNECTING, STREAMING, TOOL_PENDING, BUFFERING, RECONNECTING, RESUMING, and STREAM_END</desc>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#94a3b8"/></marker>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#f87171"/></marker>
    <marker id="ag" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#4ade80"/></marker>
    <marker id="ap" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#a78bfa"/></marker>
  </defs>
  <!-- States -->
  <rect x="360" y="20" width="100" height="36" rx="18" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="410" y="43" text-anchor="middle" font-size="12" font-weight="600" fill="#334155" font-family="sans-serif">IDLE</text>
  <rect x="348" y="100" width="124" height="36" rx="18" fill="#e0f2fe" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="410" y="123" text-anchor="middle" font-size="12" font-weight="600" fill="#0369a1" font-family="sans-serif">CONNECTING</text>
  <rect x="345" y="200" width="130" height="36" rx="18" fill="#dcfce7" stroke="#4ade80" stroke-width="1.5"/>
  <text x="410" y="223" text-anchor="middle" font-size="12" font-weight="600" fill="#166534" font-family="sans-serif">STREAMING</text>
  <rect x="560" y="200" width="130" height="36" rx="18" fill="#fef9c3" stroke="#facc15" stroke-width="1.5"/>
  <text x="625" y="218" text-anchor="middle" font-size="11" font-weight="600" fill="#854d0e" font-family="sans-serif">TOOL_</text>
  <text x="625" y="231" text-anchor="middle" font-size="11" font-weight="600" fill="#854d0e" font-family="sans-serif">PENDING</text>
  <rect x="120" y="200" width="110" height="36" rx="18" fill="#fce7f3" stroke="#f472b6" stroke-width="1.5"/>
  <text x="175" y="223" text-anchor="middle" font-size="12" font-weight="600" fill="#9d174d" font-family="sans-serif">BUFFERING</text>
  <rect x="338" y="340" width="144" height="36" rx="18" fill="#fee2e2" stroke="#f87171" stroke-width="1.5"/>
  <text x="410" y="363" text-anchor="middle" font-size="12" font-weight="600" fill="#991b1b" font-family="sans-serif">RECONNECTING</text>
  <rect x="348" y="440" width="124" height="36" rx="18" fill="#ede9fe" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="410" y="463" text-anchor="middle" font-size="12" font-weight="600" fill="#5b21b6" font-family="sans-serif">RESUMING</text>
  <rect x="348" y="540" width="124" height="36" rx="18" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="410" y="563" text-anchor="middle" font-size="12" font-weight="600" fill="#334155" font-family="sans-serif">STREAM_END</text>
  <!-- Transitions -->
  <line x1="410" y1="0" x2="410" y2="18" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="410" y1="56" x2="410" y2="98" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="415" y="82" font-size="9.5" fill="#64748b" font-family="sans-serif">USER_MESSAGE_SENT</text>
  <line x1="410" y1="136" x2="410" y2="198" stroke="#4ade80" stroke-width="1.5" marker-end="url(#ag)"/>
  <text x="415" y="172" font-size="9.5" fill="#166534" font-family="sans-serif">ws.onopen</text>
  <path d="M475,210 Q517,196 558,210" fill="none" stroke="#facc15" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="492" y="196" font-size="9" fill="#854d0e" font-family="sans-serif">TOOL_CALL</text>
  <path d="M558,226 Q517,242 475,226" fill="none" stroke="#4ade80" stroke-width="1.5" marker-end="url(#ag)"/>
  <text x="492" y="248" font-size="9" fill="#166534" font-family="sans-serif">TOOL_RESULT</text>
  <path d="M345,210 Q260,196 232,210" fill="none" stroke="#f472b6" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="256" y="196" font-size="9" fill="#9d174d" font-family="sans-serif">seq gap</text>
  <path d="M232,226 Q260,242 345,226" fill="none" stroke="#4ade80" stroke-width="1.5" marker-end="url(#ag)"/>
  <text x="248" y="248" font-size="9" fill="#166534" font-family="sans-serif">gap filled / 3s</text>
  <path d="M390,236 L390,338" fill="none" stroke="#f87171" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
  <text x="322" y="295" font-size="9" fill="#991b1b" font-family="sans-serif">ws.onerror/onclose</text>
  <path d="M620,236 Q620,310 484,340" fill="none" stroke="#f87171" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
  <text x="584" y="296" font-size="9" fill="#991b1b" font-family="sans-serif">ws.drop</text>
  <path d="M175,236 Q175,310 338,350" fill="none" stroke="#f87171" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar)"/>
  <text x="158" y="296" font-size="9" fill="#991b1b" font-family="sans-serif">ws.drop</text>
  <line x1="410" y1="376" x2="410" y2="438" stroke="#a78bfa" stroke-width="1.5" marker-end="url(#ap)"/>
  <text x="415" y="398" font-size="9" fill="#5b21b6" font-family="sans-serif">ws.onopen · RESUME first</text>
  <text x="415" y="409" font-size="9" fill="#5b21b6" font-family="sans-serif">trimAfter(lastSeq)</text>
  <path d="M348,458 Q260,440 260,218 Q260,200 343,218" fill="none" stroke="#4ade80" stroke-width="1.5" marker-end="url(#ag)"/>
  <text x="170" y="360" font-size="9" fill="#166534" font-family="sans-serif">replay complete</text>
  <text x="170" y="371" font-size="9" fill="#166534" font-family="sans-serif">(STREAM_END or 9.5s)</text>
  <path d="M430,236 Q430,480 430,538" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="434" y="400" font-size="9" fill="#475569" font-family="sans-serif">STREAM_END</text>
  <path d="M660,236 Q700,400 480,545" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="680" y="380" font-size="9" fill="#475569" font-family="sans-serif">STREAM_END</text>
  <path d="M472,550 Q760,550 760,38 Q760,20 462,20" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="3,3" marker-end="url(#a)"/>
  <text x="700" y="290" font-size="9" fill="#64748b" font-family="sans-serif" transform="rotate(90,700,290)">next USER_MESSAGE</text>
</svg>

**Legend:** green = normal flow · red dashed = connection drop · purple = reconnect/replay · yellow = tool call · pink = chaos buffering

</details>

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

No environment variables required. WebSocket URL defaults to `ws://localhost:4747/ws`.

---

## Screenshots in normal mode

### Full console — streaming chat, trace timeline, context panel

![Full console view showing streaming chat with tool cards on the left, trace timeline in the centre, and context inspector on the right](docs/screenshots/full-console.png)

### Trace timeline — grouped tokens, tool call pairs, PING/PONG rows

![Trace timeline showing a merged TOKEN group row, indented TOOL_CALL and TOOL_RESULT pairs linked by call_id, and PING/PONG rows at the bottom](docs/screenshots/trace-timeline.png)

### Context inspector — structural diff between two snapshots

![Context inspector showing snapshot 2 of 2 with green added badges for analysis_complete and flagged_issues, and an amber changed badge for the tables key](docs/screenshots/context-diff.png)
