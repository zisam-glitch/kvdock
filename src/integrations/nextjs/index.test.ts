import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../adapters/memory/index.js";
import { KVDock } from "../../core/store.js";
import { TieredDock } from "../../core/tiered.js";
import { KVDockNextCacheHandler, createNextCacheHandler } from "./index.js";

describe("KVDockNextCacheHandler", () => {
  let adapter: MemoryAdapter;
  let dock: KVDock;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    dock = new KVDock({ adapter });
  });

  it("stores and retrieves cache entries with metadata", async () => {
    const handler = new KVDockNextCacheHandler({ dock });

    await handler.set("/blog/post-1", { title: "Hello World", content: "Post body" });

    const entry = await handler.get("/blog/post-1");
    expect(entry).not.toBeNull();
    expect(entry?.value).toEqual({ title: "Hello World", content: "Post body" });
    expect(typeof entry?.lastModified).toBe("number");
    expect(entry?.tags).toEqual([]);
  });

  it("returns null for non-existent cache keys", async () => {
    const handler = new KVDockNextCacheHandler({ dock });
    const entry = await handler.get("/missing-page");
    expect(entry).toBeNull();
  });

  it("revalidates cache entries by tag", async () => {
    const handler = new KVDockNextCacheHandler({ dock });

    await handler.set(
      "/products/1",
      { id: 1, name: "Keyboard" },
      { tags: ["product", "product-1"] },
    );
    await handler.set("/products/2", { id: 2, name: "Mouse" }, { tags: ["product", "product-2"] });
    await handler.set("/user/profile", { id: 10, name: "Alice" }, { tags: ["user"] });

    expect(await handler.get("/products/1")).not.toBeNull();
    expect(await handler.get("/products/2")).not.toBeNull();
    expect(await handler.get("/user/profile")).not.toBeNull();

    // Revalidate single tag
    await handler.revalidateTag("product-1");
    expect(await handler.get("/products/1")).toBeNull();
    expect(await handler.get("/products/2")).not.toBeNull();

    // Revalidate multiple tags
    await handler.revalidateTag(["product", "user"]);
    expect(await handler.get("/products/2")).toBeNull();
    expect(await handler.get("/user/profile")).toBeNull();
  });

  it("supports factory creation with createNextCacheHandler even when Next.js passes runtime ctx", async () => {
    const HandlerClass = createNextCacheHandler({ adapter });
    // Next.js passes `{ serverDistDir, maxMemoryCacheSize, revalidatedTags, ... }` to `new CacheHandler(ctx)`
    const handler = new HandlerClass({ serverDistDir: ".next", maxMemoryCacheSize: 0 });

    await handler.set("home-page", { html: "<div>Home</div>" }, { revalidate: 3600 });
    const result = await handler.get("home-page");
    expect(result?.value).toEqual({ html: "<div>Home</div>" });

    handler.resetRequestCache();
  });

  it("supports TieredDock with l1Ttl and l2Ttl option aliases", async () => {
    const tiered = new TieredDock({
      l1: new MemoryAdapter(),
      l2: new MemoryAdapter(),
      l1Ttl: 150,
      l2Ttl: 300,
    });
    const HandlerClass = createNextCacheHandler({ dock: tiered });
    const handler = new HandlerClass({ serverDistDir: ".next" });

    await handler.set("tiered-page", { ok: true }, { tags: ["t1"] });
    expect((await handler.get("tiered-page"))?.value).toEqual({ ok: true });

    await handler.revalidateTag(["t1"]);
    expect(await handler.get("tiered-page")).toBeNull();
  });

  it("throws error if constructed without options or configuration", () => {
    KVDockNextCacheHandler.configure(undefined as never);
    expect(() => new KVDockNextCacheHandler()).toThrow("KVDockNextCacheHandler requires options");
  });
});
