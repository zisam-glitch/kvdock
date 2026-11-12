import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { RouterDock } from "./index.js";

describe("RouterDock (Hierarchical Storage Mounts)", () => {
  it("routes operations to the correct adapter based on key prefix", async () => {
    const assetsAdapter = new MemoryAdapter();
    const sessionsAdapter = new MemoryAdapter();
    const defaultAdapter = new MemoryAdapter();

    const router = new RouterDock({ defaultAdapter });
    router.mount("assets", assetsAdapter);
    router.mount("session", sessionsAdapter);

    await router.set("assets:banner.png", "image_binary_data");
    await router.set("session:token_99", { userId: 42 });
    await router.set("global_flag", true);

    // Verify correct routing to isolated storage backends
    expect(await assetsAdapter.get("banner.png")).toBe('"image_binary_data"');
    expect(await sessionsAdapter.get("token_99")).toBe('{"userId":42}');
    expect(await defaultAdapter.get("global_flag")).toBe("true");

    // Read back through router
    expect(await router.get("assets:banner.png")).toBe("image_binary_data");
    expect(await router.get("session:token_99")).toEqual({ userId: 42 });
    expect(await router.get("global_flag")).toBe(true);
  });

  it("supports path-style slash syntax (/assets/img.png)", async () => {
    const assetsAdapter = new MemoryAdapter();
    const router = new RouterDock();
    router.mount("assets", assetsAdapter);

    await router.set("/assets/avatar.jpg", "avatar_data");
    expect(await router.get("/assets/avatar.jpg")).toBe("avatar_data");
    expect(await router.get("assets:avatar.jpg")).toBe("avatar_data");
    expect(await assetsAdapter.get("avatar.jpg")).toBe('"avatar_data"');
  });

  it("performs longest-prefix matching with nested mounts", async () => {
    const generalAssets = new MemoryAdapter();
    const avatars = new MemoryAdapter();

    const router = new RouterDock();
    router.mount("assets", generalAssets);
    router.mount("assets:avatars", avatars);

    await router.set("assets:avatars:user1.png", "avatar1");
    await router.set("assets:logo.png", "main_logo");

    expect(await avatars.has("user1.png")).toBe(true);
    expect(await generalAssets.has("user1.png")).toBe(false);
    expect(await generalAssets.has("logo.png")).toBe(true);

    expect(await router.get("assets:avatars:user1.png")).toBe("avatar1");
    expect(await router.get("assets:logo.png")).toBe("main_logo");
  });

  it("partitions and resolves cross-mount batch getMany, setMany, and deleteMany", async () => {
    const mem1 = new MemoryAdapter();
    const mem2 = new MemoryAdapter();

    const router = new RouterDock();
    router.mount("store1", mem1);
    router.mount("store2", mem2);

    await router.setMany([
      { key: "store1:k1", value: "v1" },
      { key: "store2:k2", value: "v2" },
      { key: "store1:k3", value: "v3" },
    ]);

    const res = await router.getMany(["store1:k1", "store2:k2", "store1:k3", "store1:missing"]);
    expect(res.get("store1:k1")).toBe("v1");
    expect(res.get("store2:k2")).toBe("v2");
    expect(res.get("store1:k3")).toBe("v3");
    expect(res.get("store1:missing")).toBeNull();

    const deleted = await router.deleteMany(["store1:k1", "store2:k2"]);
    expect(deleted).toBe(2);
    expect(await router.has("store1:k1")).toBe(false);
    expect(await router.has("store2:k2")).toBe(false);
  });

  it("coalesces stampede requests through router getOrSet", async () => {
    const mem = new MemoryAdapter();
    const router = new RouterDock();
    router.mount("cache", mem);

    let fetches = 0;
    const slowFetcher = async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return "coalesced_router_val";
    };

    const results = await Promise.all([
      router.getOrSet("cache:hot_key", slowFetcher),
      router.getOrSet("cache:hot_key", slowFetcher),
      router.getOrSet("cache:hot_key", slowFetcher),
    ]);

    expect(fetches).toBe(1);
    expect(results).toEqual([
      "coalesced_router_val",
      "coalesced_router_val",
      "coalesced_router_val",
    ]);
  });

  it("handles unmounting and pattern scanning across mounts", async () => {
    const mem1 = new MemoryAdapter();
    const mem2 = new MemoryAdapter();

    const router = new RouterDock();
    router.mount("m1", mem1);
    router.mount("m2", mem2);

    await router.set("m1:a", 1);
    await router.set("m2:b", 2);

    const keys = await router.keys();
    expect(keys).toContain("m1:a");
    expect(keys).toContain("m2:b");

    expect(router.unmount("m1")).toBe(true);
    expect(router.unmount("m1")).toBe(false);
  });
});
