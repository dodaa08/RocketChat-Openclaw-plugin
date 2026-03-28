const RC_URL = "http://127.0.0.1:3000";
const RC_AUTH_TOKEN = "vM613t-De_85p0pyO19OzMF5sxkqVjnxbGYPLYvsF_b";
const RC_USER_ID = "YG3gFbJLbxJtAPtHv";

const DEFAULT_ROOM = "69c672c0a32d7a56a53910d6"

const buildMessageTarget = (target: string, text: string) => {
  const trimmed = target.trim();
  if (trimmed.startsWith("@") || trimmed.startsWith("#")) {
    return { channel: trimmed, text };
  }
  return { roomId: trimmed, text };
};

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
      console.log("🔥 SENDTEXT CALLED, Updated code", { room, text });

  const res = await fetch(`${RC_URL}/api/v1/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": RC_AUTH_TOKEN,
      "X-User-Id": RC_USER_ID,
    },
    body: JSON.stringify(buildMessageTarget(room, text)),
  });

  const body = await res.text();
  console.log("RESPONSE BODY:", body);

  return { ok: res.ok, channel: "rocketchat-webhook" };
    },

    async sendMedia({ to, text }: { to: string; text: string }) {
      console.log("🎥 SENDMEDIA CALLED", { to, text });
      if (!to) return { ok: false };
      const res = await fetch(`${RC_URL}/api/v1/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": RC_AUTH_TOKEN,
          "X-User-Id": RC_USER_ID,
        },
        body: JSON.stringify(buildMessageTarget(to, text)),
      });
      return { ok: res.ok, channel: "rocketchat-webhook" };
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