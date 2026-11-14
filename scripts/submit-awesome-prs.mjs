#!/usr/bin/env node
/**
 * KVDock Awesome Lists PR Generator & Submitter
 *
 * Targets high-signal Awesome repositories where KVDock has native, verified support:
 * 1. elysiajs/awesome-elysia (Plugins section)
 * 2. oven-sh/awesome-bun (Libraries section)
 * 3. officialrajdeepsingh/awesome-nextjs (Cache Handler section)
 *
 * Usage:
 *   node scripts/submit-awesome-prs.mjs            # Dry-run preview of diffs
 *   node scripts/submit-awesome-prs.mjs --submit   # Forks, branches, commits & opens PRs via gh CLI
 */

import { execFileSync, execSync } from "node:child_process";

const TARGETS = [
  {
    repo: "elysiajs/awesome-elysia",
    file: "readme.md",
    branch: "add-kvdock-plugin",
    prTitle: "Add kvdock to Plugins",
    prBody:
      "Adds [kvdock](https://github.com/zisam-glitch/kvdock) to the Plugins section.\n\n- **What it is**: Multi-tier caching and session plugin with single-flight stampede protection (`kvdock/elysia`).\n- **Guideline compliance**: Placed at the bottom of the `## Plugins` section, formatted as `[name](link) - Description.` without starting with `A`/`An` or repeating `Elysia.js`.",
    anchor: "- [Fulgur](https://github.com/wiizzl/fulgur)",
    lineToAdd:
      "- [kvdock](https://github.com/zisam-glitch/kvdock) - Multi-tier caching and session plugin with single-flight stampede protection.",
  },
  {
    repo: "oven-sh/awesome-bun",
    file: "README.md",
    branch: "add-kvdock-library",
    prTitle: "Add KVDock to Libraries",
    prBody:
      "Adds [KVDock](https://github.com/zisam-glitch/kvdock) under `### Libraries`.\n\n- Zero-dependency key-value and multi-tier caching engine with single-flight stampede protection and native Bun SQLite / memory drivers.\n- Link: https://github.com/zisam-glitch/kvdock",
    anchor: "- [bun-types](https://www.npmjs.com/package/bun-types) - Typescript with Bun.",
    lineToAdd:
      "- [KVDock](https://github.com/zisam-glitch/kvdock) - Zero-dependency key-value and multi-tier caching engine with single-flight stampede protection.",
  },
  {
    repo: "officialrajdeepsingh/awesome-nextjs",
    file: "README.md",
    branch: "add-kvdock-cache-handler",
    prTitle: "Add KVDock to Cache Handler",
    prBody:
      "Adds [KVDock](https://github.com/zisam-glitch/kvdock) under the `## Cache Handler` section.\n\n- Provides a drop-in Next.js 15 App Router Incremental Cache Handler (`kvdock/next`) pairing L1 in-memory cache with L2 Redis/SQLite and single-flight stampede protection.",
    anchor: "## Cache Handler",
    insertAfterNextNonEmptyLine: true,
    lineToAdd:
      "- [KVDock](https://github.com/zisam-glitch/kvdock) - Zero-dependency Next.js App Router incremental cache handler with multi-tier L1/L2 storage and single-flight stampede protection.",
  },
];

const shouldSubmit = process.argv.includes("--submit");

async function main() {
  console.log("===============================================================");
  console.log(`   KVDock Awesome Lists PR Engine (${shouldSubmit ? "LIVE SUBMIT" : "DRY RUN"})`);
  console.log("===============================================================\n");

  for (const t of TARGETS) {
    console.log(`Target: ${t.repo} (${t.file})`);
    console.log(`  PR Title : ${t.prTitle}`);
    console.log(`  Entry    : ${t.lineToAdd}`);

    if (!shouldSubmit) {
      console.log(`  Status   : Ready (run with --submit to open PR)\n`);
      continue;
    }

    try {
      // 1. Ensure fork exists
      execSync(`gh repo fork ${t.repo} --clone=false`, { stdio: "pipe" });
      const repoName = t.repo.split("/")[1];
      const forkRepo = `zisam-glitch/${repoName}`;

      // 2. Fetch upstream default branch & file content
      const repoMeta = JSON.parse(execSync(`gh api repos/${t.repo}`, { encoding: "utf-8" }));
      const defaultBranch = repoMeta.default_branch;
      const refMeta = JSON.parse(
        execSync(`gh api repos/${t.repo}/git/ref/heads/${defaultBranch}`, { encoding: "utf-8" })
      );
      const baseSha = refMeta.object.sha;

      // Create branch on fork (ignore if already exists)
      try {
        execSync(
          `gh api -X POST repos/${forkRepo}/git/refs -f ref="refs/heads/${t.branch}" -f sha="${baseSha}"`,
          { stdio: "pipe" }
        );
      } catch {}

      const fileMeta = JSON.parse(
        execSync(`gh api "repos/${forkRepo}/contents/${t.file}?ref=${t.branch}"`, { encoding: "utf-8" })
      );
      const content = Buffer.from(fileMeta.content, "base64").toString("utf-8");

      if (content.includes("zisam-glitch/kvdock")) {
        console.log(`  ✓ Already present in ${forkRepo}:${t.branch}`);
      } else {
        const lines = content.split("\n");
        const idx = lines.findIndex((l) => l.includes(t.anchor));
        if (idx === -1) {
          console.log(`  ⚠️ Could not locate anchor "${t.anchor}" in ${t.repo}`);
          continue;
        }
        let insertIdx = idx + 1;
        if (t.insertAfterNextNonEmptyLine) {
          while (insertIdx < lines.length && lines[insertIdx].trim() === "") insertIdx++;
          insertIdx++;
        }
        lines.splice(insertIdx, 0, t.lineToAdd);
        const updatedB64 = Buffer.from(lines.join("\n"), "utf-8").toString("base64");

        execSync(
          `gh api -X PUT repos/${forkRepo}/contents/${t.file} ` +
            `-f message="${t.prTitle} (https://github.com/zisam-glitch/kvdock)" ` +
            `-f content="${updatedB64}" ` +
            `-f sha="${fileMeta.sha}" ` +
            `-f branch="${t.branch}"`,
          { stdio: "pipe" }
        );
        console.log(`  ✓ Committed entry to ${forkRepo}@${t.branch}`);
      }

      // Check if PR already open
      const existingPrs = JSON.parse(
        execSync(
          `gh pr list --repo ${t.repo} --author zisam-glitch --state all --json url,state`,
          { encoding: "utf-8" }
        )
      );
      if (existingPrs.length > 0) {
        console.log(`  ✓ PR already exists: ${existingPrs[0].url} (${existingPrs[0].state})\n`);
      } else {
        const prUrl = execFileSync(
          "gh",
          [
            "pr",
            "create",
            "--repo",
            t.repo,
            "--head",
            `zisam-glitch:${t.branch}`,
            "--base",
            defaultBranch,
            "--title",
            t.prTitle,
            "--body",
            t.prBody,
          ],
          { encoding: "utf-8" }
        ).trim();
        console.log(`  🎉 Opened PR: ${prUrl}\n`);
      }
    } catch (err) {
      console.error(`  ❌ Error on ${t.repo}:`, err.message);
    }
  }
}

main().catch(console.error);
