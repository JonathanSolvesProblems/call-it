import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { initialOverlayState, type OverlayState } from "./state.js";

const publicDirectory = fileURLToPath(new URL("./public/", import.meta.url));

export class OverlayServer {
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private state: OverlayState = initialOverlayState();

  constructor(private readonly port = parsePort(process.env.OVERLAY_PORT)) {
    this.server = createServer((request, response) => { void this.serve(request, response); });
    this.server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.sockets.emit("connection", webSocket, request);
      });
    });
    this.sockets.on("connection", (socket) => this.send(socket));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, () => {
        this.server.off("error", reject);
        console.log(`Overlay available at http://127.0.0.1:${this.port}/overlay`);
        console.log(`Debug view available at http://127.0.0.1:${this.port}/debug`);
        resolve();
      });
    });
  }

  update(patch: Partial<OverlayState>): void {
    this.state = {
      ...this.state,
      ...patch,
      ...(patch.decisions ? { decisions: patch.decisions.slice(-50) } : {}),
    };
    this.publish();
  }

  getState(): OverlayState {
    return structuredClone(this.state);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.clients) socket.close(1001, "server closing");
    await Promise.all([
      new Promise<void>((resolve, reject) => this.sockets.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve())),
    ]);
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = pathname === "/overlay" ? "overlay.html" : pathname === "/debug" ? "debug.html" : undefined;
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    try {
      const html = await readFile(join(publicDirectory, file));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Could not load overlay page");
    }
  }

  private publish(): void {
    for (const socket of this.sockets.clients) this.send(socket);
  }

  private send(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(this.state));
  }
}

function parsePort(value: string | undefined): number {
  if (!value) return 4545;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OVERLAY_PORT must be an integer between 1 and 65535.");
  return port;
}
