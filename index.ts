import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfgPath = resolve(__dirname, "rc-config.json");

let RC_URL = "http://127.0.0.1:3000";
let RC_AUTH_TOKEN = "";
let RC_USER_ID = "";
let DEFAULT_ROOM = "";

if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  RC_URL = cfg.rcUrl ?? RC_URL;
  RC_AUTH_TOKEN = cfg.bot?.authToken ?? RC_AUTH_TOKEN;
  RC_USER_ID = cfg.bot?.userId ?? RC_USER_ID;
  DEFAULT_ROOM = cfg.dmRoomId ?? DEFAULT_ROOM;
}

async function rcSend(rid: string, msg: string): Promise<{ ok: boolean; body: string }> {
  const res = await fetch(`${RC_URL}/api/v1/chat.sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": RC_AUTH_TOKEN,
      "X-User-Id": RC_USER_ID,
    },
    body: JSON.stringify({ message: { rid, msg } }),
  });
  const body = await res.text();
  return { ok: res.ok, body };
}

const rocketchatChannel = {
  id: "rocketchat-webhook",

  meta: {
    id: "rocketchat-webhook",
    label: "Rocket.Chat (webhook)",
    selectionLabel: "Rocket.Chat (webhook)",
    blurb: "REST outbound to Rocket.Chat (chat.sendMessage).",
    aliases: ["rc-hook", "rocketchat-hook"],
  },

  capabilities: {
    chatTypes: ["direct", "group"],
  },

  config: {
    listAccountIds: (cfg: any) => ["default"],
    resolveAccount: (cfg: any, accountId: string) => ({ accountId: accountId ?? "default" }),
  },

  outbound: {
    deliveryMode: "direct",

    resolveTarget: ({ to }: { to: string }) => {
      const target = (to && to.trim()) ? to.trim() : DEFAULT_ROOM;
      return { ok: true, to: target };
    },

    async sendText({ to, text }: { to?: string; text: string }) {
      const room = to || DEFAULT_ROOM;
      console.log("🔥 SENDTEXT CALLED", { room, text });
      const { ok, body } = await rcSend(room, text);
      console.log("RESPONSE BODY:", body);
      return { ok, channel: "rocketchat-webhook" };
    },

    async sendMedia({ to, text }: { to: string; text: string }) {
      console.log("🎥 SENDMEDIA CALLED", { to, text });
      if (!to) return { ok: false };
      const { ok } = await rcSend(to, text);
      return { ok, channel: "rocketchat-webhook" };
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
    ctx.setStatus({ accountId: ctx.account?.accountId ?? "default", state: "connected" });
    return new Promise(() => {});
},
  },
};

const plugin = {
  id: "openclaw-rocketchat-webhook",
  name: "Rocket.Chat Webhook Channel",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api: any) {
    console.log("🚀 RC plugin register called");
    api.registerChannel({ plugin: rocketchatChannel });
  }
};

export default plugin;
