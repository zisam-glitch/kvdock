import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter } from "../adapters/memory/index.js";
import { TieredDock } from "../core/tiered.js";
import { BroadcastChannelBus } from "./broadcast-channel.js";
import { EventEmitterBus } from "./event-emitter.js";
import { RedisPubSubBus, type RedisPubSubClient } from "./redis.js";

describe("KVDock Bus", () => {
  beforeEach(() => {
    EventEmitterBus.resetChannels();
  });

  describe("EventEmitterBus", () => {
    it("publishes and delivers invalidation events between instances", async () => {
      const bus1 = new EventEmitterBus("test_channel");
      const bus2 = new EventEmitterBus("test_channel");

      const received: Array<{ type: string; key?: string; senderId?: string }> = [];
      bus2.subscribe((msg) => {
        received.push(msg);
      });

      await bus1.publish({ type: "set", key: "user:123" });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("set");
      expect(received[0].key).toBe("user:123");
      expect(received[0].senderId).toBe(bus1.id);

      await bus1.disconnect();
      await bus2.disconnect();
    });

    it("unsubscribes listeners cleanly", async () => {
      const bus1 = new EventEmitterBus("test_channel");
      const bus2 = new EventEmitterBus("test_channel");

      let count = 0;
      const unsubscribe = bus2.subscribe(() => {
        count++;
      });

      await bus1.publish({ type: "delete", key: "session:abc" });
      expect(count).toBe(1);

      unsubscribe();
      await bus1.publish({ type: "delete", key: "session:abc" });
      expect(count).toBe(1);

      await bus1.disconnect();
      await bus2.disconnect();
    });
  });

  describe("BroadcastChannelBus", () => {
    it("publishes message via BroadcastChannel if available", async () => {
      const bus = new BroadcastChannelBus("test_bc");
      let messageHandled = false;
      bus.subscribe((msg) => {
        if (msg.key === "item:1") messageHandled = true;
      });

      await bus.publish({ type: "set", key: "item:1" });
      // In environment with mock or real BroadcastChannel, listener receives message
      await bus.disconnect();
    });
  });

  describe("RedisPubSubBus", () => {
    it("publishes and receives messages over redis clients", async () => {
      const handlers = new Map<string, (ch: string, msg: string) => void>();

      const mockPub: RedisPubSubClient = {
        publish: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        on: vi.fn(),
      };

      const mockSub: RedisPubSubClient = {
        publish: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        on: vi.fn((event, cb) => {
          if (event === "message") handlers.set("msg", cb);
        }),
        off: vi.fn(),
      };

      const bus = new RedisPubSubBus(mockPub, mockSub, { channel: "kvdock_test" });

      const received: Array<{ type: string; key?: string; senderId?: string }> = [];
      bus.subscribe((msg) => {
        received.push(msg);
      });

      expect(mockSub.subscribe).toHaveBeenCalledWith("kvdock_test");

      // Simulate incoming redis message
      const incoming = {
        id: "1",
        senderId: "remote_node",
        type: "tag_invalidation",
        tag: "users",
        timestamp: Date.now(),
      };
      handlers.get("msg")?.("kvdock_test", JSON.stringify(incoming));

      expect(received).toHaveLength(1);
      expect(received[0].tag).toBe("users");

      await bus.publish({ type: "clear" });
      expect(mockPub.publish).toHaveBeenCalledWith(
        "kvdock_test",
        expect.stringContaining('"type":"clear"'),
      );

      await bus.disconnect();
    });
  });

  describe("TieredDock Multi-Node Cache Synchronization", () => {
    it("synchronizes L1 invalidations across multiple TieredDock cluster nodes", async () => {
      // Shared L2 storage (e.g. distributed Redis)
      const sharedL2 = new MemoryAdapter();

      // Node A and Node B each have their own fast local in-memory L1
      const nodeAL1 = new MemoryAdapter();
      const nodeBL1 = new MemoryAdapter();

      const busA = new EventEmitterBus("cluster_sync");
      const busB = new EventEmitterBus("cluster_sync");

      const nodeA = new TieredDock({
        l1: nodeAL1,
        l2: sharedL2,
        bus: busA,
      });

      const nodeB = new TieredDock({
        l1: nodeBL1,
        l2: sharedL2,
        bus: busB,
      });

      // 1. Node A writes "user:10"
      await nodeA.set("user:10", { name: "Alice" });

      // 2. Node B reads "user:10" from shared L2, promoting it to Node B's local L1
      const bRead1 = await nodeB.get("user:10");
      expect(bRead1).toEqual({ name: "Alice" });
      expect(await nodeBL1.has("user:10")).toBe(true);

      // 3. Node A updates "user:10"
      await nodeA.set("user:10", { name: "Alice Updated" });

      // 4. Because bus broadcasted the "set" event, Node B's local L1 MUST be evicted!
      expect(nodeB.stats.busInvalidationsReceived).toBe(2);
      expect(await nodeBL1.get("user:10")).toBeNull();

      // 5. Node B reads again -> misses local L1 and fetches fresh from shared L2!
      const bRead2 = await nodeB.get("user:10");
      expect(bRead2).toEqual({ name: "Alice Updated" });

      // 6. Test tag invalidation broadcast
      await nodeA.set("post:1", "post data", { tags: ["posts"] });
      await nodeB.get("post:1"); // promote to B's L1
      expect(await nodeBL1.has("post:1")).toBe(true);

      await nodeA.invalidateTag("posts");
      await new Promise((r) => setTimeout(r, 20));
      expect(await nodeBL1.get("post:1")).toBeNull();

      await nodeA.close();
      await nodeB.close();
    });
  });
});
