/**
 * KVDock Example: Next.js 14/15 IncrementalCache & App Router ISR Handler
 *
 * Demonstrates:
 * 1. Drop-in Next.js IncrementalCache handler replacement (`cacheHandler` in `next.config.js`).
 * 2. Automatic tag tracking and clustered ISR revalidation (`revalidateTag`).
 * 3. Works seamlessly with any KVDock storage adapter (Redis, SQLite, Postgres, Memory).
 */

import { KVDock } from "kvdock";
import { MemoryAdapter } from "kvdock/adapters/memory";
import { KVDockNextCacheHandler } from "kvdock/integrations/nextjs";

async function main() {
  console.log("⚡ Initializing KVDock Next.js IncrementalCache Handler...");

  const dock = new KVDock({
    adapter: new MemoryAdapter(),
  });

  // Initialize handler
  const handler = new KVDockNextCacheHandler({
    dock,
    keyPrefix: "next-app:cache:",
    defaultTTL: 3600, // 1 hour default revalidation
  });

  // 1. Simulate Next.js caching a statically rendered page route
  console.log("\n--- 1. Simulating Next.js caching /blog/introducing-kvdock ---");
  await handler.set(
    "/blog/introducing-kvdock",
    {
      kind: "PAGE",
      html: "<h1>Introducing KVDock</h1><p>Universal caching for modern stacks.</p>",
      pageData: { title: "Introducing KVDock", author: "zisam" },
    },
    {
      revalidate: 60,
      tags: ["blog-post", "posts:introducing-kvdock", "author:zisam"],
    },
  );
  console.log('✅ Route cached successfully with tags: ["blog-post", "author:zisam"]');

  // 2. Simulate Next.js fetch cache entry
  console.log("\n--- 2. Simulating Next.js fetch() cache for API data ---");
  await handler.set(
    "fetch:https://api.github.com/repos/zisam-glitch/kvdock",
    {
      kind: "FETCH",
      data: { name: "kvdock", stars: 120, openIssues: 0 },
    },
    {
      revalidate: 120,
      tags: ["github-api", "repo:kvdock"],
    },
  );
  console.log('✅ Fetch data cached successfully with tag: "github-api"');

  // 3. Retrieve cached items
  console.log("\n--- 3. Verifying Cache Retrieval ---");
  const cachedPage = await handler.get("/blog/introducing-kvdock");
  console.log(
    "✅ Retrieved cached page:",
    (cachedPage?.value as { pageData: { title: string } })?.pageData?.title,
  );
  console.log("   Associated tags:", cachedPage?.tags);

  const cachedFetch = await handler.get("fetch:https://api.github.com/repos/zisam-glitch/kvdock");
  console.log(
    "✅ Retrieved cached fetch API response:",
    (cachedFetch?.value as { data: { name: string } })?.data?.name,
  );

  // 4. Test revalidateTag
  console.log('\n--- 4. Testing Next.js revalidateTag("blog-post") ---');
  await handler.revalidateTag("blog-post");
  const postInvalidationPage = await handler.get("/blog/introducing-kvdock");
  console.log(
    "✅ Page cache status after revalidateTag:",
    postInvalidationPage ? "STILL_CACHED" : "PURGED (null)",
  );

  // Verify fetch cache was unaffected because it has a different tag
  const stillCachedFetch = await handler.get(
    "fetch:https://api.github.com/repos/zisam-glitch/kvdock",
  );
  console.log(
    "✅ Unrelated fetch cache status:",
    stillCachedFetch ? "ACTIVE (Preserved)" : "PURGED",
  );

  console.log("\n🎉 Next.js IncrementalCache Demo Complete!");
}

main().catch(console.error);
