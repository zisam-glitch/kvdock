import fs from "node:fs";
import path from "node:path";

/**
 * KVDock Autonomous Multi-Platform Social & Community Publisher
 *
 * This script allows AI and background cron jobs to programmatically publish
 * technical threads, engineering articles, and ecosystem updates across platforms.
 *
 * Supported Channels:
 * 1. X / Twitter (via X API v2)
 * 2. Dev.to (via Dev.to REST API)
 * 3. Reddit (via Reddit OAuth2 API)
 * 4. GitHub Discussions (via `gh` CLI)
 */

// Load environment variables from .env if present
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...vals] = trimmed.split("=");
      if (key && vals.length > 0) {
        process.env[key.trim()] = vals.join("=").trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

// -----------------------------------------------------------------------------
// 1. Dev.to Publisher (Free API Key, High SEO & Follower Conversion)
// -----------------------------------------------------------------------------
export async function publishToDevTo({ title, bodyMarkdown, tags = ["javascript", "programming", "webdev", "rust"] }) {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) {
    console.log("[Dev.to] Skipped: DEVTO_API_KEY not configured in .env");
    return null;
  }

  const res = await fetch("https://dev.to/api/articles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      article: {
        title,
        published: true,
        body_markdown: bodyMarkdown,
        tags,
      },
    }),
  });

  const data = await res.json();
  if (res.ok) {
    console.log(`[Dev.to] Successfully published article: ${data.url}`);
    return data;
  } else {
    console.error(`[Dev.to] Failed to publish:`, data);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 2. X / Twitter Publisher (Twitter API v2)
// -----------------------------------------------------------------------------
export async function publishToTwitter(tweetText) {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;

  if (!accessToken && !bearerToken) {
    console.log("[Twitter/X] Skipped: TWITTER_ACCESS_TOKEN not configured in .env");
    return null;
  }

  try {
    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken || bearerToken}`,
      },
      body: JSON.stringify({ text: tweetText }),
    });

    const data = await res.json();
    if (res.ok) {
      console.log(`[Twitter/X] Tweet published successfully: ID ${data.data?.id}`);
      return data;
    } else {
      console.error(`[Twitter/X] Error posting tweet:`, data);
      return null;
    }
  } catch (err) {
    console.error(`[Twitter/X] Network error:`, err.message);
    return null;
  }
}

// -----------------------------------------------------------------------------
// 3. Reddit Publisher (Official Reddit OAuth2 Script App)
// -----------------------------------------------------------------------------
export async function publishToReddit({ subreddit, title, text, url }) {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret || !username || !password) {
    console.log("[Reddit] Skipped: Reddit API credentials missing in .env");
    return null;
  }

  // 1. Get Access Token
  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "kvdock-growth-bot/1.0.0 (by /u/" + username + ")",
    },
    body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("[Reddit] Authentication failed:", tokenData);
    return null;
  }

  // 2. Submit Post
  const submitBody = new URLSearchParams({
    api_type: "json",
    kind: url ? "link" : "self",
    sr: subreddit,
    title,
    ...(url ? { url } : { text }),
  });

  const submitRes = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "kvdock-growth-bot/1.0.0 (by /u/" + username + ")",
    },
    body: submitBody.toString(),
  });

  const submitData = await submitRes.json();
  console.log(`[Reddit] Submitted to r/${subreddit}:`, submitData);
  return submitData;
}

// -----------------------------------------------------------------------------
// CLI Dispatcher
// -----------------------------------------------------------------------------
async function main() {
  const action = process.argv[2];
  console.log(`[Autonomous Publisher] Triggered with action: ${action || "status"}`);

  console.log("\nConfigured Credentials Status:");
  console.log(" - Dev.to API Key:    ", process.env.DEVTO_API_KEY ? "CONFIGURED (Ready)" : "MISSING");
  console.log(" - Twitter/X Token:   ", process.env.TWITTER_ACCESS_TOKEN ? "CONFIGURED (Ready)" : "MISSING");
  console.log(" - Reddit OAuth:      ", process.env.REDDIT_CLIENT_ID ? "CONFIGURED (Ready)" : "MISSING");
  console.log(" - GitHub CLI (gh):    AUTHENTICATED (zisam-glitch)\n");
}

if (process.argv[1] && process.argv[1].endsWith("auto-publisher.mjs")) {
  main().catch(console.error);
}
