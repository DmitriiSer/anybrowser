import type { Socket } from "node:net";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * An MCP Transport over a raw net.Socket, using the same newline-delimited
 * JSON framing the SDK's stdio transport uses. Reuses the SDK's ReadBuffer
 * and serializeMessage so framing behavior (message parsing, trailing
 * newline) matches stdio exactly.
 *
 * Accepts an optional initial chunk of bytes that were already read off the
 * socket before this transport was constructed (the hello-line handshake
 * reads a chunk that may contain bytes belonging to the MCP session that
 * follows; those bytes must be handed to this transport rather than lost).
 */
export class SocketTransport implements Transport {
  private readonly socket: Socket;
  private readonly readBuffer = new ReadBuffer();
  private readonly initialData: Buffer | undefined;
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;
  sessionId?: string;

  constructor(socket: Socket, initialData?: Buffer) {
    this.socket = socket;
    this.initialData =
      initialData && initialData.length > 0 ? initialData : undefined;
  }

  start(): Promise<void> {
    if (this.started) {
      return Promise.reject(new Error("SocketTransport already started"));
    }
    this.started = true;

    this.socket.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.drainReadBuffer();
    });
    this.socket.on("close", () => {
      this.onclose?.();
    });
    this.socket.on("error", (error: Error) => {
      this.onerror?.(error);
    });

    // Bytes read before this transport existed (leftover after the hello
    // line) must be processed too, now that callbacks are installed.
    if (this.initialData) {
      this.readBuffer.append(this.initialData);
      this.drainReadBuffer();
    }

    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const line = serializeMessage(message);
      this.socket.write(line, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.end(() => resolve());
    });
  }

  private drainReadBuffer(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      if (message === null) {
        return;
      }
      this.onmessage?.(message);
    }
  }
}
