import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_FILE = path.resolve(__dirname, "../docs/FOLLOWED_USERS.json");

// Fetch real-time live following list directly from GitHub API
function getLiveFollowingSet() {
  const set = new Set();
  try {
    const out = execSync(`gh api "user/following?per_page=100" --jq '.[].login'`, { encoding: "utf-8" });
    for (const login of out.split("\n")) {
      const clean = login.trim();
      if (clean) set.add(clean);
    }
  } catch (err) {
    console.error("[Follower Engine] Error querying live following list:", err.message);
  }

  // Also include local cache
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      for (const u of cached) set.add(u);
    } catch (e) {}
  }
  return set;
}

const followedHistory = getLiveFollowingSet();

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([...followedHistory], null, 2));
}

// Diverse ecosystems: Rust, Go, TypeScript, Node, Edge runtimes
const TARGET_REPOS = [
  "tokio-rs/tokio",
  "BurntSushi/aho-corasick",
  "gofiber/fiber",
  "gin-gonic/gin",
  "biomejs/biome",
  "trpc/trpc",
  "vitejs/vite",
  "shadcn-ui/ui",
  "unjs/unstorage",
  "fastify/fastify",
  "honojs/hono",
  "oven-sh/bun",
  "redis/ioredis"
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
    console.log(`[Follower Engine] Skipped @${username}: ${msg.slice(0, 100)}`);
    return false;
  }
}

async function findActiveDevelopers(limit = 20) {
  const candidates = new Set();

  for (const repo of TARGET_REPOS) {
    if (candidates.size >= limit) break;
    try {
      const out = execSync(`gh api "repos/${repo}/contributors?per_page=20" --jq '.[].login'`, { encoding: "utf-8" });
      const logins = out.split("\n").map((s) => s.trim()).filter(Boolean);
      for (const login of logins) {
        if (!followedHistory.has(login) && login !== "zisam-glitch" && !login.includes("[bot]")) {
          candidates.add(login);
          if (candidates.size >= limit) break;
        }
      }
    } catch (err) {
      // Ignore and continue
    }
  }

  return [...candidates];
}

async function main() {
  console.log("===============================================================");
  console.log("           KVDock High-Signal Follower Engagement             ");
  console.log("===============================================================\n");

  console.log(`Currently following ${followedHistory.size} unique developers on GitHub.`);
  const BATCH_SIZE = 20;
  console.log(`[1] Scanning Rust, Go, TypeScript, and Runtime repositories...`);
  const devs = await findActiveDevelopers(BATCH_SIZE);
  console.log(`Found ${devs.length} new fresh high-signal developer targets.\n`);

  let followedCount = 0;
  for (const dev of devs) {
    const ok = await followUser(dev);
    if (ok) followedCount++;
    // Safe pacing: 2.5 second delay between follows to comply with GitHub rate limits
    await sleep(2500);
  }

  console.log(`\nFollow session completed: ${followedCount} new developers followed.`);
  console.log(`Total followed developer network: ${followedHistory.size}`);
}

main().catch(console.error);
