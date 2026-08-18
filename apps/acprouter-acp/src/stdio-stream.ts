import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Wraps THIS process's own stdio into an ACP `Stream` — the mirror image of
 * `apps/acprouter-cli/src/daemon/subprocess-stream.ts#streamFromChildProcess`,
 * which wraps a SPAWNED child's stdio into a `Stream`. There is no child
 * here: from Zed/JetBrains' point of view this process itself IS the child,
 * so `process.stdin`/`process.stdout` play the role `child.stdout`/
 * `child.stdin` play there. Same framing (ACP over stdio is
 * newline-delimited JSON — `acp.ndJsonStream` already parses and serializes
 * it), same `Readable.toWeb`/`Writable.toWeb` glue, copied rather than
 * re-derived per this task's own brief.
 */
export function streamFromProcessStdio(): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
}
