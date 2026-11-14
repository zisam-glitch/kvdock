#!/usr/bin/env node
/**
 * KVDock Starstruck Autopilot Engine
 *
 * 1. Tracks live stargazer count on zisam-glitch/kvdock & polyglot ecosystem repos
 * 2. Tracks Dev.to article views, reactions & comments (and alerts on unanswered comments)
 * 3. Automatically publishes the next queued article from docs/growth/articles-queue/
 *    ONLY if >= 48 hours have elapsed since the last Dev.to article (preventing feed suppression)
 * 4. Updates the live GitHub Tracking Issue & notifies @zisam-glitch ONLY when new stars arrive
 *    or when the 16-star Starstruck milestone is unlocked!
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishToDevTo } from "./auto-publisher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ROOT_DIR, "docs/growth/starstruck-state.json");
const QUEUE_DIR = path.join(ROOT_DIR, "docs/growth/articles-queue");

const TARGET_BASE = 16;
const TARGET_BRONZE = 128;
const REPO = "zisam-glitch/kvdock";
const ECOSYSTEM_REPOS = [
  "zisam-glitch/kvdock",
  "zisam-glitch/kvdock-rs",
  "zisam-glitch/kvdock-go",
  "zisam-glitch/kvdock-kt",
  "zisam-glitch/kvdock-swift",
];

function ghJson(endpoint) {
  try {
    const out = execSync(`gh api "${endpoint}"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (err) {
    return null;
  }
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {}
  }
  return {
    lastKnownStars: 0,
    stargazers: [],
    publishedQueueFiles: [],
    unlocked16Notified: false,
    unlocked128Notified: false,
    lastCheckedAt: null,
  };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { title: "KVDock Technical Deep Dive", tags: ["typescript", "javascript", "webdev", "node"], body: markdown };
  const fm = match[1];
  const body = match[2].trim();
  const titleMatch = fm.match(/^title:\s*["']?(.*?)["']?\s*$/m);
  const tagsMatch = fm.match(/^tags:\s*(.*?)\s*$/m);
  const title = titleMatch ? titleMatch[1] : "KVDock Technical Deep Dive";
  const tags = tagsMatch
    ? tagsMatch[1].split(",").map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).slice(0, 4)
    : ["typescript", "javascript", "webdev", "node"];
  return { title, tags, body };
}

async function checkDevToAndMaybePublish(state, currentStars) {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) {
    return { totalViews: 0, totalReactions: 0, totalComments: 0, articles: [], newlyPublished: null };
  }

  try {
    const res = await fetch("https://dev.to/api/articles/me/all", {
      headers: { "api-key": apiKey },
    });
    if (!res.ok) return { totalViews: 0, totalReactions: 0, totalComments: 0, articles: [], newlyPublished: null };
    const articles = await res.json();

    let totalViews = 0;
    let totalReactions = 0;
    let totalComments = 0;
    let latestPublishedTime = 0;

    for (const a of articles) {
      totalViews += a.page_views_count || 0;
      totalReactions += a.positive_reactions_count || 0;
      totalComments += a.comments_count || 0;
      if (a.published_at) {
        const t = new Date(a.published_at).getTime();
        if (t > latestPublishedTime) latestPublishedTime = t;
      }
    }

    // Check if >= 48 hours have elapsed since the latest article so we never get suppressed by Dev.to's burst filter
    const hoursSinceLastPost = latestPublishedTime ? (Date.now() - latestPublishedTime) / (1000 * 60 * 60) : 999;
    let newlyPublished = null;

    if (hoursSinceLastPost >= 48 && currentStars < TARGET_BRONZE && fs.existsSync(QUEUE_DIR)) {
      const files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".md")).sort();
      const existingTitles = new Set(articles.map((a) => a.title.toLowerCase().trim()));

      for (const file of files) {
        if (state.publishedQueueFiles.includes(file)) continue;
        const fullPath = path.join(QUEUE_DIR, file);
        const raw = fs.readFileSync(fullPath, "utf-8");
        const { title, tags, body } = parseFrontmatter(raw);

        if (existingTitles.has(title.toLowerCase().trim())) {
          state.publishedQueueFiles.push(file);
          continue;
        }

        console.log(`[Autopilot] 48h+ cooldown satisfied (${hoursSinceLastPost.toFixed(1)}h). Publishing queued article: "${title}"...`);
        const pub = await publishToDevTo({ title, bodyMarkdown: body, tags });
        if (pub && pub.url) {
          newlyPublished = { title, url: pub.url, file };
          state.publishedQueueFiles.push(file);
        }
        break; // Never publish more than 1 article per 48h window!
      }
    }

    return {
      totalViews,
      totalReactions,
      totalComments,
      hoursSinceLastPost: Math.round(hoursSinceLastPost * 10) / 10,
      articles: articles.slice(0, 6).map((a) => ({
        title: a.title,
        url: a.url,
        views: a.page_views_count || 0,
        reactions: a.positive_reactions_count || 0,
        comments: a.comments_count || 0,
      })),
      newlyPublished,
    };
  } catch (err) {
    return { totalViews: 0, totalReactions: 0, totalComments: 0, articles: [], newlyPublished: null };
  }
}

export async function runAutopilot() {
  const state = loadState();
  const repoInfo = ghJson(`repos/${REPO}`);
  if (!repoInfo) {
    console.error("Failed to fetch repository info from GitHub API.");
    process.exit(1);
  }

  const stars = repoInfo.stargazers_count || 0;
  const forks = repoInfo.forks_count || 0;
  const stargazerList = ghJson(`repos/${REPO}/stargazers`) || [];
  const stargazerLogins = stargazerList.map((s) => s.login);

  // Ecosystem star count
  let ecosystemStars = 0;
  for (const r of ECOSYSTEM_REPOS) {
    const info = ghJson(`repos/${r}`);
    if (info) ecosystemStars += info.stargazers_count || 0;
  }

  const remainingBase = Math.max(0, TARGET_BASE - stars);
  const remainingBronze = Math.max(0, TARGET_BRONZE - stars);
  const pctBase = Math.min(100, Math.round((stars / TARGET_BASE) * 100));
  const barWidth = 20;
  const filled = Math.round((pctBase / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const devto = await checkDevToAndMaybePublish(state, stars);

  const newStarsDelta = stars - (state.lastKnownStars || 0);
  const newStargazers = stargazerLogins.filter((u) => !(state.stargazers || []).includes(u));

  const nowIso = new Date().toISOString();
  state.lastKnownStars = stars;
  state.stargazers = stargazerLogins;
  state.lastCheckedAt = nowIso;

  const summaryMd = [
    `## 🏆 Starstruck Achievement Autopilot Status`,
    ``,
    `| Metric | Value |`,
    `| :--- | :--- |`,
    `| **Flagship Stars (\`${REPO}\`)** | **${stars} / ${TARGET_BASE}** (${pctBase}%) \`[${bar}]\` |`,
    `| **Stars Needed for Base Unlock** | **${remainingBase === 0 ? "🎉 UNLOCKED!" : `${remainingBase} more star(s)`}** |`,
    `| **Stars Needed for Bronze Tier (128)** | **${remainingBronze} star(s)** |`,
    `| **Total KVDock Ecosystem Stars** | **${ecosystemStars} stars** (across 5 language repos) |`,
    `| **Repository Forks** | **${forks}** |`,
    `| **Current Stargazers** | ${stargazerLogins.map((u) => `\`@${u}\``).join(", ") || "None"} |`,
    `| **Dev.to Technical Reach** | **${devto.totalViews} views**, **${devto.totalReactions} reactions**, **${devto.totalComments} comments** |`,
    `| **Last Synchronized** | \`${nowIso}\` |`,
    ``,
    devto.newlyPublished
      ? `> 🚀 **Autopilot Published New Article:** [${devto.newlyPublished.title}](${devto.newlyPublished.url})`
      : `> ⏱️ **Dev.to Queue Status:** Next article auto-publishes after 48h cooldown (Last post: ${devto.hoursSinceLastPost ?? "N/A"}h ago).`,
  ].join("\n");

  console.log(summaryMd);

  // Write to GitHub Actions Step Summary if running in CI
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd + "\n");
  }

  saveState(state);
  return { stars, remainingBase, stargazerLogins, newStarsDelta, newStargazers, summaryMd, devto };
}

if (process.argv[1]?.endsWith("starstruck-autopilot.mjs")) {
  runAutopilot().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
