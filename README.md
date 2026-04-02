
https://github.com/user-attachments/assets/14c7dd0c-0d72-4e34-8554-ba1ff1f4ab39
# OpenClaw Rocket.Chat Webhook

This project connects **Rocket.Chat** to **OpenClaw** using two pieces: a **middleware HTTP server** that receives Rocket.Chat webhooks and forwards them to the OpenClaw Gateway, and an **OpenClaw channel plugin** that sends assistant replies back into Rocket.Chat over the REST API.

---

## Demo

**Onboarding**

https://github.com/user-attachments/assets/7795e906-71c2-4272-ad1a-f5a132c4e49e





**Sample async Task**



https://github.com/user-attachments/assets/e5fb78ef-f57a-446b-8d63-c7be6c97e51c






**Crons**



https://github.com/user-attachments/assets/a2c4744d-2962-4fa3-9c65-21001bf2a611




---

## Repository layout

| Path | Role |
| --- | --- |
| `index.ts` | OpenClaw channel plugin: registers `rocketchat-webhook`, implements outbound delivery. |
| `server.ts` | Standalone middleware: Rocket.Chat webhook in, OpenClaw hook out; typing and completion callbacks. |
| `cli/setup.ts` | Interactive setup: Rocket.Chat bot, outgoing integration, `rc-config.json`, and OpenClaw `openclaw.json` merge. |
| `cli/rc-api.ts` | Rocket.Chat REST helpers used by setup (login, webhooks, DMs, messages). |
| `rc-config.json` | Generated local config (not committed): Rocket.Chat URL, bot tokens, webhook URL, DM room id, OpenClaw URL and hook token. |
| `openclaw.plugin.json` | Plugin metadata for packaging. |

---

## Inbound path (Rocket.Chat to OpenClaw)

Flow:

1. Rocket.Chat fires an **outgoing webhook** (integration) to your middleware URL, typically `http://<host>:<port>/webhook`.
2. **`server.ts`** handles `POST /webhook`. It parses the payload (supports `body.data` or top-level fields), strips an optional trigger word prefix, and reads the user text and room identifiers.
3. It builds an OpenClaw **`/hooks/agent`** payload: user message, stable **`sessionKey`** (scoped to this Rocket.Chat room so context stays per-room), **`channel: rocketchat-webhook`**, **`to: <room id>`**, **`deliver: true`**, and posts to **`OC_URL`** with the configured bearer token.
4. On success, OpenClaw returns a **`runId`**. The middleware may show typing indicators, react to the user message, post a short status line, and start a typing keepalive tied to that run.
5. When the run finishes, OpenClaw (or your wiring) should call **`POST /run/:runId/complete`** so the middleware can stop typing and clean up reactions and status messages.

**`server.ts` endpoints**

- **`GET /health`** — Liveness JSON (`status`, `uptime`).
- **`POST /webhook`** — Rocket.Chat outbound integration; forwards to OpenClaw as above. Empty text after cleaning is skipped.
- **`POST /run/:runId/complete`** — Signals run completion for the given `runId`; stops typing keepalive and marks the run complete for UI cleanup.

Configuration is loaded from **`rc-config.json`** next to the project (or environment variables as fallbacks): Rocket.Chat base URL, bot `X-Auth-Token` / `X-User-Id`, default room, middleware port, OpenClaw base URL, and hook token.

---

## Outbound path (OpenClaw to Rocket.Chat)

Flow:

1. OpenClaw decides to send text to the **`rocketchat-webhook`** channel (for example after a hook run, or from a cron job configured with delivery to this channel and a room id).
2. The Gateway invokes the plugin registered in **`index.ts`**, which implements **`outbound.sendText`** (and **`sendMedia`** as a text-capable path).
3. The plugin resolves the target room: OpenClaw passes **`to`** when known; otherwise it falls back to **`dmRoomId`** from **`rc-config.json`** (loaded from the parent directory or next to the built plugin).
4. Messages are sent with **`POST /api/v1/chat.sendMessage`** using the bot credentials from config.

So: **inbound** is `server.ts` only; **outbound** is **`index.ts`** inside the OpenClaw process. Both read Rocket.Chat settings from **`rc-config.json`** (plugin also checks a sibling path for packaged installs).

---

## CLI setup

Run from the project root:

```bash
npm install
npm run setup
```

**`npm run setup`** walks through:

- Rocket.Chat URL and admin login.
- Bot user creation or selection and bot login token.
- Outgoing integration (webhook) pointing at your middleware URL.
- Optional welcome DM and persistence of **`rc-config.json`** in the project directory.
- Merge into **`~/.openclaw/openclaw.json`**: enables channel **`rocketchat-webhook`**, sets `serverUrl`, bot user id and token, registers this plugin path under **`plugins.load.paths`**, and adds the plugin id to **`plugins.allow`**.

After setup, restart OpenClaw, then start the middleware:

```bash
npm run server
```

Ensure Rocket.Chat’s integration URL matches **`rc-config.json`** `webhook.url` and that the OpenClaw Gateway is reachable at the configured **`ocUrl`** with a valid **`hooks.token`**.

---

## Build and development

```bash
npm run build    # compile TypeScript to dist/ (plugin entry is dist/index.js)
npm run dev      # watch mode for the plugin
npm run server   # run middleware with tsx
```

Node 22+ is required.

---

## Related documentation

- OpenClaw Gateway hooks and channels follow upstream OpenClaw documentation.
- Rocket.Chat outgoing webhooks and REST API are documented in Rocket.Chat’s own docs.

---

## License

MIT
