import { describe, expect, it } from "vitest";
import { defineKVDockDriver } from "./index.js";

describe("Nuxt 3 / Nitro Storage Driver", () => {
  it("conforms to unstorage driver contract for basic item lifecycle", async () => {
    const driver = defineKVDockDriver({ base: "nitro" });

    expect(await driver.hasItem("user:1")).toBe(false);
    await driver.setItem("user:1", { name: "Nuxt Dev" });
    expect(await driver.hasItem("user:1")).toBe(true);

    const item = await driver.getItem<{ name: string }>("user:1");
    expect(item).toEqual({ name: "Nuxt Dev" });

    await driver.removeItem("user:1");
    expect(await driver.hasItem("user:1")).toBe(false);
  });

  it("lists and clears scoped keys", async () => {
    const driver = defineKVDockDriver({ base: "cache" });

    await driver.setItem("page:home", "<html>1</html>");
    await driver.setItem("page:about", "<html>2</html>");
    await driver.setItem("api:status", "ok");

    const pageKeys = await driver.getKeys("page:");
    expect(pageKeys.sort()).toEqual(["page:about", "page:home"]);

    await driver.clear("page:");
    expect(await driver.hasItem("page:home")).toBe(false);
    expect(await driver.hasItem("api:status")).toBe(true);
  });
});
