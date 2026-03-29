import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = resolve(__dirname, "..", "rc-config.json");

export interface RCConfig {
  rcUrl: string;
  admin: { userId: string; authToken: string };
  bot: {
    username: string;
    name: string;
    userId: string;
    authToken: string;
    email: string;
  };
  webhook: { id: string; token: string; url: string };
  middlewarePort: number;
  dmRoomId: string;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): RCConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error("Config not found. Run: npm run setup");
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as RCConfig;
}
