import type { CacheBusMessage, KVDockBus } from "./types.js";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bus_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export class BroadcastChannelBus implements KVDockBus {
  public readonly id: string;
  private channel?: BroadcastChannel;
  private readonly listeners = new Set<(msg: CacheBusMessage) => void>();
  private readonly onMessageBound: (event: MessageEvent<CacheBusMessage>) => void;

  constructor(channelName = "kvdock_cache_bus", busId?: string) {
    this.id = busId ?? generateUUID();

    if (typeof globalThis.BroadcastChannel !== "undefined") {
      this.channel = new globalThis.BroadcastChannel(channelName);
    }

    this.onMessageBound = (event: MessageEvent<CacheBusMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      for (const listener of Array.from(this.listeners)) {
        try {
          listener(msg);
        } catch {
          // Ignore listener errors
        }
      }
    };

    if (this.channel) {
      this.channel.addEventListener("message", this.onMessageBound);
    }
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

    if (this.channel) {
      this.channel.postMessage(fullMessage);
    }
  }

  public subscribe(handler: (message: CacheBusMessage) => void | Promise<void>): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  public async disconnect(): Promise<void> {
    if (this.channel) {
      this.channel.removeEventListener("message", this.onMessageBound);
      this.channel.close();
      this.channel = undefined;
    }
    this.listeners.clear();
  }
}
