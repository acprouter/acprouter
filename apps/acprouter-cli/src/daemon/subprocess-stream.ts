import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Wraps a spawned agent's stdio into an ACP `Stream`.
 *
 * ACP over stdio is newline-delimited JSON — exactly the framing the SDK's
 * own `acp.ndJsonStream` already parses and serializes (it is how every
 * real ACP agent, including the ones this bridge spawns, talks to its
 * client). Unlike `acp-ws-stream.ts`'s `streamFromWebSocket` — which has to
 * build framing and a `readableClosed` double-close guard from scratch
 * because raw WebSocket frames are message-shaped but not already
 * JSON-RPC-parsed — stdio needs neither: `Readable.toWeb`/`Writable.toWeb`
 * (stable since Node 18) is the only glue required, and `ndJsonStream`
 * itself already guards its own controller against a double close/cancel
 * (see its `cancelled` flag in `@agentclientprotocol/sdk/dist/stream.js`).
 * Copying that guard here again would be dead code, not defense in depth.
 */
export function streamFromChildProcess(child: ChildProcessWithoutNullStreams): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}
