import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Config: load from rc-config.json if available, else fall back to env/defaults
const __dirname = dirname(fileURLToPath(import.meta.url));
const cfgPath = resolve(__dirname, "rc-config.json");

let RC_URL = process.env.RC_URL ?? "http://127.0.0.1:3000";
let RC_AUTH_TOKEN = process.env.RC_AUTH_TOKEN ?? "";
let RC_USER_ID = process.env.RC_USER_ID ?? "";
let RC_BOT_USERNAME = process.env.RC_BOT_USERNAME ?? "OCAgent";
let DEFAULT_ROOM = process.env.RC_DEFAULT_ROOM ?? "";
let MIDDLEWARE_PORT = parseInt(process.env.MIDDLEWARE_PORT ?? "3005", 10);

let OC_URL = process.env.OC_URL ?? "http://127.0.0.1:18789";
let OC_HOOK_TOKEN = process.env.OC_HOOK_TOKEN ?? "";
const OC_CHANNEL = "rocketchat-webhook";

if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  RC_URL = cfg.rcUrl ?? RC_URL;
  RC_AUTH_TOKEN = cfg.bot?.authToken ?? RC_AUTH_TOKEN;
  RC_USER_ID = cfg.bot?.userId ?? RC_USER_ID;
  RC_BOT_USERNAME = cfg.bot?.username ?? RC_BOT_USERNAME;
  DEFAULT_ROOM = cfg.dmRoomId ?? DEFAULT_ROOM;
  MIDDLEWARE_PORT = cfg.middlewarePort ?? MIDDLEWARE_PORT;
  OC_URL = cfg.ocUrl ?? OC_URL;
  OC_HOOK_TOKEN = cfg.ocHookToken ?? OC_HOOK_TOKEN;
  console.log("[middleware] loaded config from rc-config.json");
} else if (!RC_AUTH_TOKEN) {
  console.warn("[middleware] no rc-config.json found and no env vars set. Run: npm run setup");
}
const TYPING_INTERVAL_MS = 4000;
const TYPING_MAX_DURATION_MS = 10 * 60 * 1000; // 10 min cap

// ── Track active runs so we can stop typing on completion ───────────────────
interface ActiveRun {
  timer: ReturnType<typeof setInterval>;
  roomId: string;
  messageId?: string;
}
const activeRuns = new Map<string, ActiveRun>();
/** runId -> status line message _id (delete when run completes) */
const processingStatusByRunId = new Map<string, string>();
const STATUS_LINE_TTL_MS = 15 * 60 * 1000;

// ── RC helpers ──────────────────────────────────────────────────────────────

async function rcSendTyping(roomId: string, typing: boolean): Promise<void> {
  const payload = JSON.stringify({
    msg: "method",
    method: "stream-notify-room",
    params: [`${roomId}/typing`, RC_BOT_USERNAME, typing],
  });
  try {
    await fetch(`${RC_URL}/api/v1/method.call/stream-notify-room`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": RC_AUTH_TOKEN,
        "X-User-Id": RC_USER_ID,
      },
      body: JSON.stringify({ message: payload }),
    });
  } catch (e) {
    console.error("[middleware] typing indicator failed:", e);
  }
}

function startTypingKeepalive(roomId: string, runId: string, messageId?: string): void {
  rcSendTyping(roomId, true);

  const timer = setInterval(() => rcSendTyping(roomId, true), TYPING_INTERVAL_MS);
  activeRuns.set(runId, { timer, roomId, messageId });

  setTimeout(() => stopTypingKeepalive(runId), TYPING_MAX_DURATION_MS);
}

function stopTypingKeepalive(runId: string, completed = false): void {
  const entry = activeRuns.get(runId);
  if (!entry) return;
  clearInterval(entry.timer);
  rcSendTyping(entry.roomId, false);
  if (completed && entry.messageId) {
    rcUnreact(entry.messageId, "brain");
    rcReact(entry.messageId, "white_check_mark");
  }
  if (completed) {
    const statusId = processingStatusByRunId.get(runId);
    if (statusId) {
      void rcDeleteMessage(entry.roomId, statusId);
      processingStatusByRunId.delete(runId);
    }
  }
  activeRuns.delete(runId);
}

async function rcSendMessage(roomId: string, msg: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${RC_URL}/api/v1/chat.sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": RC_AUTH_TOKEN,
        "X-User-Id": RC_USER_ID,
      },
      body: JSON.stringify({ message: { rid: roomId, msg } }),
    });
    const json = (await res.json()) as { message?: { _id?: string } };
    return json.message?._id;
  } catch (e) {
    console.error("[middleware] sendMessage failed:", e);
    return undefined;
  }
}

async function rcDeleteMessage(roomId: string, msgId: string): Promise<void> {
  try {
    await fetch(`${RC_URL}/api/v1/chat.delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": RC_AUTH_TOKEN,
        "X-User-Id": RC_USER_ID,
      },
      body: JSON.stringify({ roomId, msgId }),
    });
  } catch (e) {
    console.error("[middleware] deleteMessage failed:", e);
  }
}

function scheduleStatusLineCleanup(runId: string, roomId: string, statusMsgId: string): void {
  setTimeout(() => {
    if (!processingStatusByRunId.has(runId)) return;
    processingStatusByRunId.delete(runId);
    void rcDeleteMessage(roomId, statusMsgId);
  }, STATUS_LINE_TTL_MS);
}

async function rcReact(messageId: string, emoji: string): Promise<void> {
  try {
    await fetch(`${RC_URL}/api/v1/chat.react`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": RC_AUTH_TOKEN,
        "X-User-Id": RC_USER_ID,
      },
      body: JSON.stringify({ messageId, emoji, shouldReact: true }),
    });
  } catch (e) {
    console.error("[middleware] react failed:", e);
  }
}

async function rcUnreact(messageId: string, emoji: string): Promise<void> {
  try {
    await fetch(`${RC_URL}/api/v1/chat.react`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": RC_AUTH_TOKEN,
        "X-User-Id": RC_USER_ID,
      },
      body: JSON.stringify({ messageId, emoji, shouldReact: false }),
    });
  } catch (e) {
    console.error("[middleware] unreact failed:", e);
  }
}

async function rcPostMessage(roomId: string, text: string): Promise<void> {
  try {
    await fetch(`${RC_URL}/api/v1/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": RC_AUTH_TOKEN,
        "X-User-Id": RC_USER_ID,
      },
      body: JSON.stringify({ roomId, text }),
    });
  } catch (e) {
    console.error("[middleware] postMessage failed:", e);
  }
}

// ── OC forward ──────────────────────────────────────────────────────────────

interface OCHookPayload {
  message: string;
  name: string;
  agentId: string;
  sessionKey: string;
  wakeMode: string;
  deliver: boolean;
  channel: string;
  to: string;
  timeoutSeconds?: number;
}

async function forwardToOpenClaw(
  payload: OCHookPayload
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  try {
    const res = await fetch(`${OC_URL}/hooks/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OC_HOOK_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as Record<string, unknown>;
    return {
      ok: !!body.ok,
      runId: body.runId as string | undefined,
      error: body.error as string | undefined,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Hono app ────────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

/**
 * POST /webhook  --  entry point for RC outgoing webhook.
 *
 * Accepts the raw RC outgoing-webhook payload (the fields RC sends by default:
 * token, bot, channel_id (room _id), room_id / rid as fallbacks, user_id,
 * user_name, text, trigger_word, timestamp, etc.)
 *
 * The RC script can be a simple passthrough -- all smart logic lives here.
 */
app.post("/webhook", async (c) => {
  const body = await c.req.json();
  console.log("[middleware] incoming webhook:", JSON.stringify(body).slice(0, 300));

  // RC sends either the raw payload directly or nested under `data` if the
  // RC script wraps it. Handle both.
  const d = body.data ?? body;

  const triggerWord = (d.trigger_word ?? "").trim();
  const rawText: string = d.text ?? d.message ?? "";
  const cleanedText = triggerWord && rawText.startsWith(triggerWord)
    ? rawText.slice(triggerWord.length).trim()
    : rawText.trim();

  if (!cleanedText) {
    return c.json({ ok: true, skipped: true, reason: "empty message" });
  }

  // Room _id for RC API + OpenClaw `to` (sync only; no name→id resolution here).
  const roomId: string = (d.channel_id ?? d.room_id ?? d.rid ?? DEFAULT_ROOM) as string;
  const messageId: string | undefined = d.message_id;
  const sessionKey = `hook:rc:v15:${roomId}`;

  // 1. React with hourglass + typing indicator immediately
  if (messageId) await rcReact(messageId, "hourglass_flowing_sand");
  startTypingKeepalive(roomId, `pending-${roomId}-${Date.now()}`, messageId);

  // 2. Forward to OC
  const ocPayload: OCHookPayload = {
    message: cleanedText,
    name: "Rocket.Chat",
    agentId: "main",
    sessionKey,
    wakeMode: "now",
    deliver: true,
    channel: OC_CHANNEL,
    to: roomId,
    timeoutSeconds: 600,
  };

  console.log("[middleware] forwarding to OC:", JSON.stringify(ocPayload).slice(0, 300));
  const result = await forwardToOpenClaw(ocPayload);

  // Clean up the temporary typing run and start a proper one keyed by runId
  const pendingKey = [...activeRuns.keys()].find((k) => k.startsWith(`pending-${roomId}`));
  if (pendingKey) stopTypingKeepalive(pendingKey);

  if (!result.ok) {
    console.error("[middleware] OC hook error:", result.error);
    if (messageId) {
      await rcUnreact(messageId, "hourglass_flowing_sand");
      await rcReact(messageId, "x");
    }
    await rcPostMessage(
      roomId,
      `*[Bot Error]* Failed to process your message: ${result.error ?? "unknown error"}`
    );
    return c.json({ ok: false, error: result.error }, 502);
  }

  // Swap hourglass -> brain to show OC is thinking
  if (messageId) {
    await rcUnreact(messageId, "hourglass_flowing_sand");
    await rcReact(messageId, "brain");
  }

  // Status line in chat (bot): visible "processing" UX alongside emoji + typing
  if (result.runId) {
    const statusText = "_🦞 OpenClaw is processing your message…_";
    const statusMsgId = await rcSendMessage(roomId, statusText);
    if (statusMsgId) {
      processingStatusByRunId.set(result.runId, statusMsgId);
      scheduleStatusLineCleanup(result.runId, roomId, statusMsgId);
    }
    startTypingKeepalive(roomId, result.runId, messageId);
    console.log(`[middleware] run ${result.runId} started, typing keepalive active`);
  }

  return c.json({ ok: true, runId: result.runId });
});

/**
 * POST /run/:runId/complete  --  optional callback to stop typing.
 * OC or an external watcher can hit this when the run finishes.
 */
app.post("/run/:runId/complete", async (c) => {
  const { runId } = c.req.param();
  stopTypingKeepalive(runId, true);
  console.log(`[middleware] run ${runId} marked complete`);
  return c.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────────────────────

console.log(`[middleware] starting on port ${MIDDLEWARE_PORT}...`);
serve({ fetch: app.fetch, port: MIDDLEWARE_PORT }, (info) => {
  console.log(`[middleware] listening on http://127.0.0.1:${info.port}`);
  console.log(`[middleware] RC webhook URL: http://127.0.0.1:${info.port}/webhook`);
});
