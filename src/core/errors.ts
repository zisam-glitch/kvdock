export type ErrorCode =
  | "ERR_ADAPTER"
  | "ERR_CONNECTION"
  | "ERR_NOT_FOUND"
  | "ERR_SERIALIZATION"
  | "ERR_TTL_INVALID"
  | "ERR_CONDITION_FAILED";

export class KVDockError extends Error {
  public readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = "ERR_ADAPTER", options?: ErrorOptions) {
    super(message, options);
    this.name = "KVDockError";
    this.code = code;
  }
}

export class AdapterConnectionError extends KVDockError {
  constructor(adapterName: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`failed to connect to ${adapterName}${detail}`, "ERR_CONNECTION", { cause });
    this.name = "AdapterConnectionError";
  }
}

export class SerializationError extends KVDockError {
  constructor(message: string, cause?: unknown) {
    super(message, "ERR_SERIALIZATION", { cause });
    this.name = "SerializationError";
  }
}

export class TTLValidationError extends KVDockError {
  constructor(ttl: unknown) {
    super(`invalid ttl value: ${String(ttl)}`, "ERR_TTL_INVALID");
    this.name = "TTLValidationError";
  }
}
