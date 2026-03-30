import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as rc from "./rc-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "rc-config.json");
const OC_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");

// ── Load existing config (if any) for defaults ─────────────

interface PrevConfig {
  rcUrl?: string;
  bot?: { username?: string; name?: string; email?: string };
  middlewarePort?: number;
  webhook?: { url?: string };
}
let prev: PrevConfig = {};
if (existsSync(CONFIG_PATH)) {
  try { prev = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
}

// ── Prompt helpers ──────────────────────────────────────────

function prompt(question: string, fallback?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = fallback ? ` [${fallback}]` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback || "");
    });
  });
}

function info(msg: string) { console.log(`  ${msg}`); }
function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function step(msg: string) { console.log(`  ⏳ ${msg}`); }

function heading(n: number, title: string) {
  console.log(`\n── Step ${n}: ${title} ${"─".repeat(Math.max(0, 40 - title.length))}`);
}

// ── OpenClaw config writer (safe merge) ─────────────────────

function readOcConfig(): Record<string, unknown> {
  if (!existsSync(OC_CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(OC_CONFIG_PATH, "utf-8"));
}

function writeOcConfig(cfg: Record<string, unknown>) {
  const tmp = OC_CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  renameSync(tmp, OC_CONFIG_PATH);
}

function updateOcChannelConfig(bot: { userId: string; authToken: string; username: string }, rcUrl: string) {
  const cfg = readOcConfig() as Record<string, any>;

  if (!cfg.channels) cfg.channels = {};
  cfg.channels["rocketchat-webhook"] = {
    enabled: true,
    serverUrl: rcUrl,
    botUsername: bot.username,
    botUserId: bot.userId,
    botAuthToken: bot.authToken,
  };

  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.allow) cfg.plugins.allow = [];
  if (!cfg.plugins.allow.includes("openclaw-rocketchat-webhook")) {
    cfg.plugins.allow.push("openclaw-rocketchat-webhook");
  }
  if (!cfg.plugins.load) cfg.plugins.load = {};
  const pluginPath = resolve(__dirname, "..");
  if (!cfg.plugins.load.paths) cfg.plugins.load.paths = [];
  if (!cfg.plugins.load.paths.includes(pluginPath)) {
    cfg.plugins.load.paths.push(pluginPath);
  }

  writeOcConfig(cfg);
}

// ── Main setup

async function main() {
  console.log("\n  🦞 OpenClaw Rocket.Chat Plugin Setup\n");

  if (existsSync(CONFIG_PATH)) {
    info("Existing config found -- values will be used as defaults.");
    const answer = await prompt("Re-run setup? (y/N)", "N");
    if (answer.toLowerCase() !== "y") {
      info("Aborted."); process.exit(0);
    }
  }

  // Step 1: Connect
  heading(1, "Rocket.Chat Connection");
  const rcUrl = await prompt("Rocket.Chat URL", prev.rcUrl ?? "http://localhost:3000");
  const adminUser = await prompt("Admin username");
  const adminPass = await prompt("Admin password");

  step("Logging in...");
  let adminAuth: rc.RCLoginResult;
  try {
    adminAuth = await rc.login(rcUrl, adminUser, adminPass);
    ok(`Logged in as ${adminUser}`);
  } catch (e: any) {
    fail(`Login failed: ${e.message}`); process.exit(1);
  }

  // Step 2: Bot
  heading(2, "Bot User");
  const botUsername = await prompt("Bot username: ", prev.bot?.username);
  if (!botUsername) { fail("Bot username is required"); process.exit(1); }
  const botName = await prompt("Bot display name", prev.bot?.name ?? botUsername);
  const botEmail = await prompt("Bot email", prev.bot?.email ?? `${botUsername.toLowerCase()}@openclaw.local`);
  const botPassword = await prompt("Bot password");

  if (!botPassword) { fail("Password is required"); process.exit(1); }

  step("Checking if bot already exists...");
  let botUser: rc.RCUser;
  const existing = await rc.getUserByUsername(rcUrl, adminAuth, botUsername);

  if (existing) {
    ok(`Bot "${botUsername}" already exists (${existing._id}) -- reusing`);
    botUser = existing;
  } else {
    step("Creating bot...");
    try {
      botUser = await rc.createBotUser(rcUrl, adminAuth, {
        username: botUsername, name: botName, password: botPassword, email: botEmail,
      });
      ok(`Created bot: ${botUser.username} (${botUser._id})`);
    } catch (e: any) {
      fail(`Failed: ${e.message}`); process.exit(1);
    }
  }

  step("Getting bot auth token...");
  let botAuth: rc.RCLoginResult;
  try {
    botAuth = await rc.login(rcUrl, botUsername, botPassword);
    ok("Bot token obtained");
  } catch (e: any) {
    fail(`Bot login failed: ${e.message}`); process.exit(1);
  }

  // Step 3: Webhook
  heading(3, "Outgoing Webhook");
  const webhookName = "OpenClaw";
  const middlewarePort = parseInt(await prompt("Middleware port", String(prev.middlewarePort ?? 3005)), 10);
  const webhookUrl = await prompt("Webhook URL", prev.webhook?.url ?? `http://127.0.0.1:${middlewarePort}/webhook`);

  step("Checking for existing webhook...");
  let webhook: rc.RCWebhook;
  const existingHook = await rc.findOutgoingWebhook(rcUrl, adminAuth, webhookName, `@${botUsername}`);

  if (existingHook) {
    ok(`Webhook "${webhookName}" already exists (${existingHook._id}) -- reusing`);
    webhook = existingHook;
  } else {
    step("Creating webhook...");
    try {
      webhook = await rc.createOutgoingWebhook(rcUrl, adminAuth, {
        name: webhookName, channel: `@${botUsername}`, urls: [webhookUrl], username: botUsername,
      });
      ok(`Webhook created (${webhook._id})`);
    } catch (e: any) {
      fail(`Failed: ${e.message}`); process.exit(1);
    }
  }

  // Step 4: DM + welcome
  heading(4, "Welcome Message");
  let dmRoomId = "";
  try {
    step("Creating DM channel...");
    dmRoomId = await rc.createDirectMessage(rcUrl, adminAuth, botUsername);
    await rc.sendMessage(rcUrl, botAuth, dmRoomId, "🦞 OpenClaw is connected! Send me a message to get started.");
    ok(`Welcome message sent to @${botUsername}`);
  } catch (e: any) {
    info(`Welcome message skipped: ${e.message}`);
  }

  // Step 5: Save
  heading(5, "Save Config");

  const ocCfg = readOcConfig() as Record<string, any>;
  const ocHookToken: string = ocCfg.hooks?.token ?? "";
  const ocUrl: string = `http://127.0.0.1:${ocCfg.gateway?.port ?? 18789}`;

  if (!ocHookToken) {
    info("Warning: no hooks.token found in openclaw.json -- middleware auth will fail");
  }

  const config = {
    rcUrl,
    admin: adminAuth,
    bot: { username: botUsername, name: botName, userId: botUser._id, authToken: botAuth.authToken, email: botEmail },
    webhook: { id: webhook._id, token: webhook.token, url: webhookUrl },
    middlewarePort,
    dmRoomId,
    ocUrl,
    ocHookToken,
  };

  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmp, CONFIG_PATH);
  ok("Saved rc-config.json");

  // Step 6: Update openclaw.json
  step("Updating openclaw.json...");
  try {
    updateOcChannelConfig(
      { userId: botUser._id, authToken: botAuth.authToken, username: botUsername },
      rcUrl
    );
    ok("Updated openclaw.json (channel + plugin)");
  } catch (e: any) {
    info(`Skipped openclaw.json update: ${e.message}`);
  }

  console.log("\n── Done! ─────────────────────────────────────────");
  console.log(`
  Next steps:
    1. Restart OpenClaw:      openclaw restart
    2. Start the middleware:   npm run server
    3. Message @${botUsername} in Rocket.Chat
  `);
}

main().catch((e) => { console.error("\nSetup failed:", e.message ?? e); process.exit(1); });
