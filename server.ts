import { Hono } from "hono";
import { serve } from "@hono/node-server";

// ── Config (hardcoded for now, extract to env later) ────────────────────────
const RC_URL = "http://127.0.0.1:3000";
const RC_AUTH_TOKEN = "45f3iIJkx63_r-EY3QsVP4hIF4XJcTQcmRY46bSKakY";
const RC_USER_ID = "YG3gFbJLbxJtAPtHv";
const RC_BOT_USERNAME = "OCAgent";

const OC_URL = "http://127.0.0.1:18789";
const OC_HOOK_TOKEN = "fde89832b9afbbb3124379f2b134694f5d0219cdac0aa7e1";
const OC_CHANNEL = "rocketchat-webhook";

const DEFAULT_ROOM = "69c672c0a32d7a56a53910d6";
const MIDDLEWARE_PORT = 3005;
const TYPING_INTERVAL_MS = 4000;
const TYPING_MAX_DURATION_MS = 10 * 60 * 1000; // 10 min cap

// ── Track active runs so we can stop typing on completion ───────────────────
interface ActiveRun {
  timer: ReturnType<typeof setInterval>;
  roomId: string;
  messageId?: string;
}
const activeRuns = new Map<string, ActiveRun>();

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
  activeRuns.delete(runId);
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
  timeoutSeconds: number;
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
 * token, bot, channel_id, channel_name, user_id, user_name, text,
 * trigger_word, timestamp, etc.)
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

  const roomId: string = d.channel_id ?? DEFAULT_ROOM;
  const messageId: string | undefined = d.message_id;
  const sessionKey = `hook:rc:v7:${roomId}`;

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

  // Start keepalive with the real runId (carries messageId for completion emoji)
  if (result.runId) {
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
