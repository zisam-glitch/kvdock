export type CacheBusMessageType = "set" | "delete" | "clear" | "tag_invalidation";

export interface CacheBusMessage {
  readonly id: string;
  readonly senderId: string;
  readonly type: CacheBusMessageType;
  readonly key?: string;
  readonly keys?: readonly string[];
  readonly tag?: string;
  readonly timestamp: number;
}

export interface KVDockBus {
  readonly id: string;
  publish(message: Omit<CacheBusMessage, "id" | "senderId" | "timestamp">): Promise<void>;
  subscribe(handler: (message: CacheBusMessage) => void | Promise<void>): () => void;
  disconnect?(): Promise<void>;
}
