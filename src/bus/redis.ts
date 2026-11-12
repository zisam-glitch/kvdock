import type { CacheBusMessage, KVDockBus } from "./types.js";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bus_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number> | number;
  subscribe(channel: string): Promise<unknown> | unknown;
  unsubscribe(channel: string): Promise<unknown> | unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  off?(event: "message", listener: (channel: string, message: string) => void): unknown;
  removeListener?(event: "message", listener: (channel: string, message: string) => void): unknown;
  disconnect?(): Promise<void> | void;
  quit?(): Promise<unknown> | unknown;
}

export interface RedisBusOptions {
  /**
   * Pub/Sub channel name in Redis.
   * @default "kvdock_cache_sync"
   */
  readonly channel?: string;
  readonly busId?: string;
}

export interface RedisPubSubConfig extends RedisBusOptions {
  pubClient: RedisPubSubClient;
  subClient: RedisPubSubClient;
}

export class RedisPubSubBus implements KVDockBus {
  public readonly id: string;
  private readonly pubClient: RedisPubSubClient;
  private readonly subClient: RedisPubSubClient;
  private readonly channel: string;
  private readonly listeners = new Set<(msg: CacheBusMessage) => void>();
  private readonly onMessageBound: (channel: string, raw: string) => void;
  private isSubscribed = false;

  constructor(
    pubOrOptions: RedisPubSubClient | RedisPubSubConfig,
    subClient?: RedisPubSubClient,
    options?: RedisBusOptions,
  ) {
    if ("pubClient" in pubOrOptions && "subClient" in pubOrOptions) {
      this.pubClient = pubOrOptions.pubClient;
      this.subClient = pubOrOptions.subClient;
      this.channel = pubOrOptions.channel ?? "kvdock_cache_sync";
      this.id = pubOrOptions.busId ?? generateUUID();
    } else {
      if (!subClient) {
        throw new Error("RedisPubSubBus requires both pubClient and subClient.");
      }
      this.pubClient = pubOrOptions as RedisPubSubClient;
      this.subClient = subClient;
      this.channel = options?.channel ?? "kvdock_cache_sync";
      this.id = options?.busId ?? generateUUID();
    }

    this.onMessageBound = (ch: string, raw: string) => {
      if (ch !== this.channel) return;
      try {
        const msg = JSON.parse(raw) as CacheBusMessage;
        for (const listener of Array.from(this.listeners)) {
          listener(msg);
        }
      } catch {
        // Ignore unparseable messages
      }
    };

    this.subClient.on("message", this.onMessageBound);
  }

  public async publish(
    message: Omit<CacheBusMessage, "id" | "senderId" | "timestamp">,
  ): Promise<void> {
    const fullMessage: CacheBusMessage = {
      ...message,
      id: generateUUID(),
      senderId: this.id,
      timestamp: Date.now(),
    };

    await this.pubClient.publish(this.channel, JSON.stringify(fullMessage));
  }

  public subscribe(handler: (message: CacheBusMessage) => void | Promise<void>): () => void {
    this.listeners.add(handler);

    if (!this.isSubscribed) {
      this.isSubscribed = true;
      Promise.resolve(this.subClient.subscribe(this.channel)).catch(() => {
        this.isSubscribed = false;
      });
    }

    return () => {
      this.listeners.delete(handler);
      if (this.listeners.size === 0 && this.isSubscribed) {
        Promise.resolve(this.subClient.unsubscribe(this.channel)).catch(() => {});
        this.isSubscribed = false;
      }
    };
  }

  public async disconnect(): Promise<void> {
    if (this.subClient.off) {
      this.subClient.off("message", this.onMessageBound);
    } else if (this.subClient.removeListener) {
      this.subClient.removeListener("message", this.onMessageBound);
    }

    if (this.isSubscribed) {
      await Promise.resolve(this.subClient.unsubscribe(this.channel)).catch(() => {});
      this.isSubscribed = false;
    }

    this.listeners.clear();
  }
}
