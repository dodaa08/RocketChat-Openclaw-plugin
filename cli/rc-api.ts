export interface RCLoginResult {
  userId: string;
  authToken: string;
}

export interface RCUser {
  _id: string;
  username: string;
  name: string;
}

export interface RCWebhook {
  _id: string;
  token: string;
}

async function rcFetch(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    body?: Record<string, unknown>;
    userId?: string;
    authToken?: string;
  } = {}
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.userId && opts.authToken) {
    headers["X-Auth-Token"] = opts.authToken;
    headers["X-User-Id"] = opts.userId;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.success === false) {
    const msg = (json.error as string) ?? (json.message as string) ?? res.statusText;
    throw new Error(`RC API ${path} failed: ${msg}`);
  }
  return json;
}

export async function login(baseUrl: string, user: string, password: string): Promise<RCLoginResult> {
  const json = await rcFetch(baseUrl, "/api/v1/login", {
    body: { user, password },
  });
  const data = json.data as { userId: string; authToken: string };
  return { userId: data.userId, authToken: data.authToken };
}

export async function createBotUser(
  baseUrl: string,
  auth: RCLoginResult,
  opts: { username: string; name: string; password: string; email: string }
): Promise<RCUser> {
  const json = await rcFetch(baseUrl, "/api/v1/users.create", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: {
      username: opts.username,
      name: opts.name,
      password: opts.password,
      email: opts.email,
      roles: ["bot", "user"],
      verified: true,
      requirePasswordChange: false,
      sendWelcomeEmail: false,
    },
  });
  const user = json.user as RCUser;
  return { _id: user._id, username: user.username, name: user.name };
}

export async function createOutgoingWebhook(
  baseUrl: string,
  auth: RCLoginResult,
  opts: {
    name: string;
    channel: string;
    urls: string[];
    triggerWords?: string[];
    scriptEnabled?: boolean;
    username: string;
  }
): Promise<RCWebhook> {
  const script = `
class Script {
  prepare_outgoing_request({ request }) {
    return {
      url: request.url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: request.data
    };
  }
  process_outgoing_response() { return; }
}
`.trim();

  const json = await rcFetch(baseUrl, "/api/v1/integrations.create", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: {
      type: "webhook-outgoing",
      name: opts.name,
      event: "sendMessage",
      enabled: true,
      channel: opts.channel,
      urls: opts.urls,
      triggerWords: opts.triggerWords ?? [],
      username: opts.username,
      scriptEnabled: opts.scriptEnabled ?? true,
      script,
    },
  });
  const integration = json.integration as RCWebhook;
  return { _id: integration._id, token: integration.token };
}

export async function findOutgoingWebhook(
  baseUrl: string,
  auth: RCLoginResult,
  name: string,
  channel?: string,
): Promise<RCWebhook | null> {
  const json = await rcFetch(baseUrl, "/api/v1/integrations.list", {
    method: "GET",
    userId: auth.userId,
    authToken: auth.authToken,
  });
  const integrations = (json.integrations ?? []) as Array<Record<string, unknown>>;
  const match = integrations.find((i) => {
    if (i.name !== name || i.type !== "webhook-outgoing") return false;
    if (channel) {
      const ch = i.channel as string[] | undefined;
      if (!ch || !ch.includes(channel)) return false;
    }
    return true;
  });
  if (!match) return null;
  return { _id: match._id as string, token: (match.token as string) ?? "" };
}

export async function getUserByUsername(
  baseUrl: string,
  auth: RCLoginResult,
  username: string,
): Promise<RCUser | null> {
  try {
    const json = await rcFetch(baseUrl, `/api/v1/users.info?username=${encodeURIComponent(username)}`, {
      method: "GET",
      userId: auth.userId,
      authToken: auth.authToken,
    });
    const user = json.user as RCUser;
    return { _id: user._id, username: user.username, name: user.name };
  } catch {
    return null;
  }
}

export async function sendMessage(
  baseUrl: string,
  auth: RCLoginResult,
  roomId: string,
  text: string
): Promise<void> {
  await rcFetch(baseUrl, "/api/v1/chat.postMessage", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { roomId, text },
  });
}

export async function createDirectMessage(
  baseUrl: string,
  auth: RCLoginResult,
  username: string
): Promise<string> {
  const json = await rcFetch(baseUrl, "/api/v1/im.create", {
    userId: auth.userId,
    authToken: auth.authToken,
    body: { username },
  });
  const room = json.room as { _id: string };
  return room._id;
}
