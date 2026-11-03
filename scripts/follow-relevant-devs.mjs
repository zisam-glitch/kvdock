import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_FILE = path.resolve(__dirname, "../docs/FOLLOWED_USERS.json");

// Load already followed users to avoid duplicates
let followedHistory = new Set();
if (fs.existsSync(HISTORY_FILE)) {
  try {
    const list = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    followedHistory = new Set(list);
  } catch (e) {
    followedHistory = new Set();
  }
}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([...followedHistory], null, 2));
}

// Target repositories with active caching, runtime, and systems developers
const TARGET_REPOS = [
  "unjs/unstorage",
  "node-cache/node-cache",
  "redis/ioredis",
  "jaredwray/keyv",
  "honojs/hono",
  "fastify/fastify",
  "oven-sh/bun",
  "valkey-io/valkey",
  "tokio-rs/tokio",
  "BurntSushi/aho-corasick",
  "gofiber/fiber",
  "gin-gonic/gin",
  "trpc/trpc",
  "vitejs/vite",
  "supabase/supabase"
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function followUser(username) {
  try {
    execSync(`gh api -X PUT user/following/${username} --silent`);
    console.log(`[Follower Engine] Successfully followed: @${username}`);
    followedHistory.add(username);
    saveHistory();
    return true;
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("user") || msg.includes("404")) {
      console.log(`[Follower Engine] Requires 'user' scope. Run: gh auth refresh -h github.com -s user`);
      return false;
    }
    console.log(`[Follower Engine] Skipped @${username}: ${msg.slice(0, 100)}`);
    return false;
  }
}

async function findActiveDevelopers(limit = 20) {
  const candidates = new Set();

  for (const repo of TARGET_REPOS) {
    if (candidates.size >= limit) break;
    try {
      // Find active contributors
      const out = execSync(`gh api "repos/${repo}/contributors?per_page=15" --jq '.[].login'`, { encoding: "utf-8" });
      const logins = out.split("\n").map((s) => s.trim()).filter(Boolean);
      for (const login of logins) {
        if (!followedHistory.has(login) && login !== "zisam-glitch" && !login.includes("[bot]")) {
          candidates.add(login);
          if (candidates.size >= limit) break;
        }
      }
    } catch (err) {
      // Continue to next repo
    }
  }

  return [...candidates];
}

async function main() {
  console.log("===============================================================");
  console.log("           KVDock High-Signal Follower Engagement             ");
  console.log("===============================================================\n");

  const BATCH_SIZE = 15;
  console.log(`[1] Discovering active systems & caching developers...`);
  const devs = await findActiveDevelopers(BATCH_SIZE);
  console.log(`Found ${devs.length} high-signal developer targets.\n`);

  let followedCount = 0;
  for (const dev of devs) {
    const ok = await followUser(dev);
    if (!ok && followedCount === 0) {
      console.log("\n⚠️ GitHub API 'user' scope is needed to follow users.");
      console.log("👉 Please run: gh auth refresh -h github.com -s user\n");
      break;
    }
    if (ok) followedCount++;
    // Safe pacing: 2.5 second delay between follows to comply with GitHub rate limits
    await sleep(2500);
  }

  console.log(`\nFollow session completed: ${followedCount} new developers followed.`);
}

main().catch(console.error);
