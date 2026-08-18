import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

/** The minimal shape this adapter needs from a `ws` WebSocket. */
export interface OpenWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(type: "message", listener: (data: unknown) => void): unknown;
  on(type: "close", listener: () => void): unknown;
  on(type: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Wraps an ALREADY-CONNECTED WebSocket into an ACP `Stream`.
 *
 * The official SDK ships `createWebSocketStream`, but it always dials a URL
 * itself. There is no equivalent for a socket a server already accepted, or
 * for a socket a caller dialled out and wants to hand to the SDK's *server*
 * (agent) side rather than its client side — which is exactly what
 * `acprouter-cli` does (spec §5.4): it dials out, then plays the ACP agent
 * role on that connection. Direction of the WebSocket handshake and ACP role
 * are independent; this adapter is the ~40 lines that make that true in code.
 */
export function streamFromWebSocket(socket: OpenWebSocketLike): Stream {
  let controller: ReadableStreamDefaultController<AnyMessage> | undefined;
  // The readable side can be torn down from either direction — the socket
  // closing/erroring, or the SDK cancelling the readable itself (e.g. on
  // `AcpServer.close()`) — and `ReadableStreamDefaultController` throws if
  // you close or error it twice. Guard once, here, rather than at each call site.
  let readableClosed = false;

  const closeReadable = () => {
    if (readableClosed) return;
    readableClosed = true;
    try {
      controller?.close();
    } catch {
      // Already closed by the consumer side (e.g. readable.cancel()) — fine.
    }
  };
  const errorReadable = (error: unknown) => {
    if (readableClosed) return;
    readableClosed = true;
    controller?.error(error);
  };

  socket.on("message", (data: unknown) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : String(data);
    try {
      controller?.enqueue(JSON.parse(text) as AnyMessage);
    } catch {
      // Malformed frame — same posture as the SDK's own ws-stream.js: drop it.
    }
  });
  socket.on("close", closeReadable);
  socket.on("error", errorReadable);

  return {
    readable: new ReadableStream<AnyMessage>({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        readableClosed = true;
        socket.close();
      },
    }),
    writable: new WritableStream<AnyMessage>({
      write: (message) => {
        socket.send(JSON.stringify(message));
      },
      close: () => socket.close(),
      abort: () => socket.close(),
    }),
  };
}
