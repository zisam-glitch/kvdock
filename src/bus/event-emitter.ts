import type { CacheBusMessage, KVDockBus } from "./types.js";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bus_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export class EventEmitterBus implements KVDockBus {
  public readonly id: string;
  private static readonly globalChannels = new Map<string, Set<(msg: CacheBusMessage) => void>>();
  private readonly channelName: string;
  private readonly listeners = new Set<(msg: CacheBusMessage) => void>();

  constructor(channelName = "kvdock_default_channel", busId?: string) {
    this.id = busId ?? generateUUID();
    this.channelName = channelName;

    if (!EventEmitterBus.globalChannels.has(this.channelName)) {
      EventEmitterBus.globalChannels.set(this.channelName, new Set());
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

    const subscribers = EventEmitterBus.globalChannels.get(this.channelName);
    if (!subscribers) return;

    for (const handler of Array.from(subscribers)) {
      try {
        await handler(fullMessage);
      } catch {
        // Suppress subscriber errors to avoid breaking the publisher flow
      }
    }
  }

  public subscribe(handler: (message: CacheBusMessage) => void | Promise<void>): () => void {
    const subscribers = EventEmitterBus.globalChannels.get(this.channelName);
    if (!subscribers) return () => {};

    subscribers.add(handler);
    this.listeners.add(handler);

    return () => {
      subscribers.delete(handler);
      this.listeners.delete(handler);
    };
  }

  public async disconnect(): Promise<void> {
    const subscribers = EventEmitterBus.globalChannels.get(this.channelName);
    if (subscribers) {
      for (const listener of this.listeners) {
        subscribers.delete(listener);
      }
    }
    this.listeners.clear();
  }

  /**
   * Clears all static channels (useful for test resets).
   */
  public static resetChannels(): void {
    EventEmitterBus.globalChannels.clear();
  }
}
