import { randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  multiplayerRoomsTable,
  multiplayerSessionsTable,
  multiplayerSignalsTable,
} from "@workspace/db";
import { logger } from "./lib/logger";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

const API_PREFIX = "/api";
const MULTIPLAYER_PATH = "/v6/multiplayer";
const SUPPORTED_VERSION = "0.6.0-beta2";
const MAX_ROOM_PLAYERS = 32;
const ROOM_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGE_BYTES = 1_000_000;
const SIGNAL_POLL_MS = 100;
const SIGNAL_TTL_MS = 60 * 1000;

type Role = "host" | "join";
type JsonObject = Record<string, unknown>;

interface ClientConnection {
  id: string;
  instanceId: string;
  role: Role;
  socket: WebSocket;
  alive: boolean;
  messageQueue: Promise<void>;
  inviteCode?: string;
  sessionId?: string;
}

class JoinFailure extends Error {
  constructor(readonly code: "ExpiredInvite" | "SessionFull") {
    super(code);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function sendJson(socket: WebSocket, message: JsonObject): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket: WebSocket, error: string): void {
  sendJson(socket, { type: "error", error });
}

function makeInviteCode(): string {
  return randomInt(10_000).toString().padStart(4, "0");
}

function writeUpgradeError(socket: Duplex, status: 400 | 403 | 404): void {
  const message =
    status === 404
      ? "Not Found"
      : status === 403
        ? "Forbidden"
        : "Bad Request";
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function getRole(request: IncomingMessage): Role | null {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === `${API_PREFIX}${MULTIPLAYER_PATH}/host`) return "host";
  if (pathname === `${API_PREFIX}${MULTIPLAYER_PATH}/join`) return "join";
  return null;
}

export function attachMultiplayerSignaling(server: Server): void {
  const instanceId = randomUUID();
  const connections = new Map<string, ClientConnection>();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });
  const rolesBySocket = new WeakMap<WebSocket, Role>();
  let signalPoll: NodeJS.Timeout | null = null;
  let signalPumpRunning = false;

  async function drainSignals(): Promise<void> {
    if (signalPumpRunning) return;
    signalPumpRunning = true;
    try {
      const queued = await db
        .select()
        .from(multiplayerSignalsTable)
        .where(eq(multiplayerSignalsTable.targetInstanceId, instanceId))
        .orderBy(asc(multiplayerSignalsTable.createdAt))
        .limit(100);
      if (queued.length === 0) return;

      await db
        .delete(multiplayerSignalsTable)
        .where(
          inArray(
            multiplayerSignalsTable.id,
            queued.map((signal) => signal.id),
          ),
        );

      for (const signal of queued) {
        const recipient = connections.get(signal.targetConnectionId);
        if (recipient) {
          const recipientSocketIsOpen =
            recipient.socket.readyState === WebSocket.OPEN;
          sendJson(recipient.socket, signal.payload);
          if (signal.payload.type === "joinInvite") {
            logger.info(
              {
                delivery: recipientSocketIsOpen
                  ? "sent-to-host"
                  : "host-socket-not-open",
              },
              "Multiplayer join invite delivery attempted",
            );
          }
        } else if (signal.payload.type === "joinInvite") {
          logger.warn(
            { delivery: "host-not-connected" },
            "Multiplayer join invite delivery attempted",
          );
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "Could not deliver multiplayer signaling");
    } finally {
      signalPumpRunning = false;
    }
  }

  function startSignalPolling(): void {
    if (signalPoll) return;
    signalPoll = setInterval(() => void drainSignals(), SIGNAL_POLL_MS);
    signalPoll.unref();
    void drainSignals();
  }

  function stopSignalPollingIfIdle(): void {
    if (connections.size !== 0 || !signalPoll) return;
    clearInterval(signalPoll);
    signalPoll = null;
  }

  async function signal(
    targetInstanceId: string,
    targetConnectionId: string,
    payload: JsonObject,
  ): Promise<void> {
    const localRecipient = connections.get(targetConnectionId);
    if (localRecipient?.instanceId === targetInstanceId) {
      const recipientSocketIsOpen =
        localRecipient.socket.readyState === WebSocket.OPEN;
      sendJson(localRecipient.socket, payload);
      if (payload.type === "joinInvite") {
        logger.info(
          {
            delivery: recipientSocketIsOpen
              ? "sent-to-host"
              : "host-socket-not-open",
          },
          "Multiplayer join invite delivery attempted",
        );
      }
      return;
    }

    await db.insert(multiplayerSignalsTable).values({
      targetInstanceId,
      targetConnectionId,
      payload,
    });
    if (payload.type === "joinInvite") {
      logger.info(
        { delivery: "queued-for-host" },
        "Multiplayer join invite delivery attempted",
      );
    }
  }

  async function createRoom(connection: ClientConnection): Promise<string> {
    const expiresAt = new Date(Date.now() + ROOM_TTL_MS);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const inviteCode = makeInviteCode();
      const inserted = await db
        .insert(multiplayerRoomsTable)
        .values({
          inviteCode,
          hostInstanceId: instanceId,
          hostConnectionId: connection.id,
          version: SUPPORTED_VERSION,
          playerCount: 1,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ inviteCode: multiplayerRoomsTable.inviteCode });

      if (inserted.length > 0) return inviteCode;
    }
    throw new Error("Could not allocate a multiplayer invite code");
  }

  async function reserveJoinSlot(
    connection: ClientConnection,
    message: JsonObject,
  ): Promise<{
    sessionId: string;
    hostInstanceId: string;
    hostConnectionId: string;
  }> {
    const inviteCode =
      typeof message.inviteCode === "string"
        ? message.inviteCode.trim()
        : "";
    if (!/^\d{4}$/.test(inviteCode)) {
      throw new JoinFailure("ExpiredInvite");
    }

    const sessionId = randomUUID();
    return db.transaction(async (tx) => {
      const [room] = await tx
        .select()
        .from(multiplayerRoomsTable)
        .where(eq(multiplayerRoomsTable.inviteCode, inviteCode))
        .limit(1);

      if (!room || room.expiresAt.getTime() <= Date.now()) {
        throw new JoinFailure("ExpiredInvite");
      }

      const reserved = await tx
        .update(multiplayerRoomsTable)
        .set({
          playerCount: sql`${multiplayerRoomsTable.playerCount} + 1`,
        })
        .where(
          and(
            eq(multiplayerRoomsTable.inviteCode, inviteCode),
            lt(multiplayerRoomsTable.playerCount, MAX_ROOM_PLAYERS),
            gt(multiplayerRoomsTable.expiresAt, new Date()),
          ),
        )
        .returning({ inviteCode: multiplayerRoomsTable.inviteCode });

      if (reserved.length === 0) {
        const [currentRoom] = await tx
          .select({ expiresAt: multiplayerRoomsTable.expiresAt })
          .from(multiplayerRoomsTable)
          .where(eq(multiplayerRoomsTable.inviteCode, inviteCode))
          .limit(1);
        if (!currentRoom || currentRoom.expiresAt.getTime() <= Date.now()) {
          throw new JoinFailure("ExpiredInvite");
        }
        throw new JoinFailure("SessionFull");
      }

      await tx.insert(multiplayerSessionsTable).values({
        sessionId,
        inviteCode,
        hostInstanceId: room.hostInstanceId,
        hostConnectionId: room.hostConnectionId,
        joinInstanceId: instanceId,
        joinConnectionId: connection.id,
      });

      return {
        sessionId,
        hostInstanceId: room.hostInstanceId,
        hostConnectionId: room.hostConnectionId,
      };
    });
  }

  async function releaseJoinSession(
    connection: ClientConnection,
    sessionId: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(multiplayerSessionsTable)
        .where(
          and(
            eq(multiplayerSessionsTable.sessionId, sessionId),
            eq(multiplayerSessionsTable.joinInstanceId, instanceId),
            eq(multiplayerSessionsTable.joinConnectionId, connection.id),
          ),
        )
        .returning({ inviteCode: multiplayerSessionsTable.inviteCode });

      if (deleted.length === 0) return;
      await tx
        .update(multiplayerRoomsTable)
        .set({
          playerCount: sql`GREATEST(${multiplayerRoomsTable.playerCount} - 1, 1)`,
        })
        .where(eq(multiplayerRoomsTable.inviteCode, deleted[0].inviteCode));
    });
    if (connection.sessionId === sessionId) connection.sessionId = undefined;
  }

  async function closeHostRoom(connection: ClientConnection): Promise<void> {
    if (!connection.inviteCode) return;
    const sessions = await db
      .select()
      .from(multiplayerSessionsTable)
      .where(eq(multiplayerSessionsTable.inviteCode, connection.inviteCode));

    await Promise.all(
      sessions.map((session) =>
        signal(session.joinInstanceId, session.joinConnectionId, {
          type: "error",
          error: "ExpiredInvite",
        }),
      ),
    );

    await db
      .delete(multiplayerRoomsTable)
      .where(
        and(
          eq(multiplayerRoomsTable.inviteCode, connection.inviteCode),
          eq(multiplayerRoomsTable.hostInstanceId, instanceId),
          eq(multiplayerRoomsTable.hostConnectionId, connection.id),
        ),
      );
  }

  async function handleHostMessage(
    connection: ClientConnection,
    message: JsonObject,
  ): Promise<void> {
    if (!connection.inviteCode) {
      if (message.type !== "createInvite" || message.version !== SUPPORTED_VERSION) {
        sendError(connection.socket, "VersionMismatch");
        return;
      }
      const hostNickname = message.nickname;
      if (
        hostNickname !== undefined &&
        (typeof hostNickname !== "string" ||
          hostNickname.trim().length === 0 ||
          hostNickname.length > 32)
      ) {
        sendError(connection.socket, "InvalidMessage");
        return;
      }
      const inviteCode = await createRoom(connection);
      if (connection.socket.readyState !== WebSocket.OPEN) {
        await db
          .delete(multiplayerRoomsTable)
          .where(eq(multiplayerRoomsTable.inviteCode, inviteCode));
        return;
      }
      connection.inviteCode = inviteCode;
      logger.info({ role: "host" }, "Multiplayer invite created");
      sendJson(connection.socket, {
        type: "createInvite",
        inviteCode,
        timeoutMilliseconds: ROOM_TTL_MS,
        censoredNickname:
          typeof hostNickname === "string" ? hostNickname.trim() : null,
      });
      return;
    }

    if (message.version !== SUPPORTED_VERSION) {
      sendError(connection.socket, "VersionMismatch");
      return;
    }

    const sessionId = message.session;
    if (typeof sessionId !== "string") {
      sendError(connection.socket, "InvalidMessage");
      return;
    }
    const [session] = await db
      .select()
      .from(multiplayerSessionsTable)
      .where(
        and(
          eq(multiplayerSessionsTable.sessionId, sessionId),
          eq(multiplayerSessionsTable.hostInstanceId, instanceId),
          eq(multiplayerSessionsTable.hostConnectionId, connection.id),
        ),
      )
      .limit(1);
    if (!session) {
      sendError(connection.socket, "ExpiredInvite");
      return;
    }

    if (message.type === "acceptJoin") {
      if (
        typeof message.answer !== "string" ||
        !Array.isArray(message.mods) ||
        !message.mods.every((mod) => typeof mod === "string") ||
        typeof message.isModsVanillaCompatible !== "boolean" ||
        !Number.isSafeInteger(message.clientId) ||
        (message.clientId as number) <= 0
      ) {
        sendError(connection.socket, "InvalidMessage");
        return;
      }
      await signal(session.joinInstanceId, session.joinConnectionId, message);
      return;
    }

    if (message.type === "declineJoin") {
      if (typeof message.reason !== "string") {
        sendError(connection.socket, "InvalidMessage");
        return;
      }
      await signal(session.joinInstanceId, session.joinConnectionId, message);
      const joinConnection = connections.get(session.joinConnectionId);
      if (joinConnection) {
        await releaseJoinSession(joinConnection, sessionId);
      } else {
        await db
          .delete(multiplayerSessionsTable)
          .where(eq(multiplayerSessionsTable.sessionId, sessionId));
        await db
          .update(multiplayerRoomsTable)
          .set({
            playerCount: sql`GREATEST(${multiplayerRoomsTable.playerCount} - 1, 1)`,
          })
          .where(eq(multiplayerRoomsTable.inviteCode, session.inviteCode));
      }
      return;
    }

    if (message.type === "iceCandidate") {
      await signal(session.joinInstanceId, session.joinConnectionId, {
        type: "iceCandidate",
        candidate: message.candidate ?? null,
      });
      return;
    }

    sendError(connection.socket, "InvalidMessage");
  }

  async function handleJoinMessage(
    connection: ClientConnection,
    message: JsonObject,
  ): Promise<void> {
    if (message.version !== SUPPORTED_VERSION) {
      logger.info(
        { role: "join", outcome: "rejected", reason: "version-mismatch" },
        "Multiplayer join offer processed",
      );
      sendError(connection.socket, "VersionMismatch");
      return;
    }

    if (!connection.sessionId) {
      if (
        typeof message.offer !== "string" ||
        !Array.isArray(message.mods) ||
        !message.mods.every((mod) => typeof mod === "string") ||
        typeof message.isModsVanillaCompatible !== "boolean" ||
        typeof message.nickname !== "string" ||
        message.nickname.length > 32 ||
        (message.countryCode !== null &&
          message.countryCode !== undefined &&
          typeof message.countryCode !== "string") ||
        typeof message.carStyle !== "string"
      ) {
        logger.info(
          { role: "join", outcome: "rejected", reason: "invalid-offer" },
          "Multiplayer join offer processed",
        );
        sendError(connection.socket, "InvalidMessage");
        return;
      }

      let reservation: Awaited<ReturnType<typeof reserveJoinSlot>>;
      try {
        reservation = await reserveJoinSlot(connection, message);
      } catch (error) {
        if (error instanceof JoinFailure) {
          logger.info(
            { role: "join", outcome: "rejected", reason: error.code },
            "Multiplayer join offer processed",
          );
          if (error.code === "SessionFull") {
            sendJson(connection.socket, {
              type: "declineJoin",
              reason: "SessionFull",
            });
          } else {
            sendError(connection.socket, error.code);
          }
          return;
        }
        throw error;
      }

      connection.inviteCode = message.inviteCode as string;
      connection.sessionId = reservation.sessionId;
      if (connection.socket.readyState !== WebSocket.OPEN) {
        await releaseJoinSession(connection, reservation.sessionId);
        return;
      }

      await signal(
        reservation.hostInstanceId,
        reservation.hostConnectionId,
        {
          type: "joinInvite",
          version: SUPPORTED_VERSION,
          session: reservation.sessionId,
          offer: message.offer,
          mods: message.mods,
          isModsVanillaCompatible: message.isModsVanillaCompatible,
          nickname: message.nickname,
          countryCode: message.countryCode ?? null,
          carStyle: message.carStyle,
        },
      );
      logger.info(
        { role: "join", outcome: "forwarded" },
        "Multiplayer join offer processed",
      );
      return;
    }

    if (message.type !== undefined && message.type !== "iceCandidate") {
      sendError(connection.socket, "InvalidMessage");
      return;
    }
    if (!("candidate" in message)) {
      sendError(connection.socket, "InvalidMessage");
      return;
    }

    const [session] = await db
      .select()
      .from(multiplayerSessionsTable)
      .where(
        and(
          eq(multiplayerSessionsTable.sessionId, connection.sessionId),
          eq(multiplayerSessionsTable.joinInstanceId, instanceId),
          eq(multiplayerSessionsTable.joinConnectionId, connection.id),
        ),
      )
      .limit(1);
    if (!session) {
      sendError(connection.socket, "ExpiredInvite");
      return;
    }
    await signal(session.hostInstanceId, session.hostConnectionId, {
      type: "iceCandidate",
      version: SUPPORTED_VERSION,
      session: session.sessionId,
      candidate: message.candidate,
    });
  }

  async function handleMessage(
    connection: ClientConnection,
    message: JsonObject,
  ): Promise<void> {
    if (connection.role === "host") {
      await handleHostMessage(connection, message);
    } else {
      await handleJoinMessage(connection, message);
    }
  }

  webSocketServer.on("connection", (socket) => {
    const role = rolesBySocket.get(socket);
    if (!role) {
      socket.close(1011, "Missing multiplayer role");
      return;
    }
    const connection: ClientConnection = {
      id: randomUUID(),
      instanceId,
      role,
      socket,
      alive: true,
      messageQueue: Promise.resolve(),
    };
    connections.set(connection.id, connection);
    startSignalPolling();

    logger.info({ role }, "Multiplayer WebSocket connected");
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        sendError(socket, "InvalidMessage");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(rawDataToString(data));
      } catch {
        sendError(socket, "InvalidMessage");
        return;
      }
      if (!isJsonObject(message)) {
        sendError(socket, "InvalidMessage");
        return;
      }
      const messageKind =
        role === "join"
          ? connection.sessionId
            ? "ice-candidate"
            : "join-offer"
          : message.type === "createInvite"
            ? "create-invite"
            : message.type === "acceptJoin"
              ? "accept-join"
              : message.type === "declineJoin"
                ? "decline-join"
                : message.type === "iceCandidate"
                  ? "ice-candidate"
                  : "other";
      if (messageKind !== "ice-candidate") {
        logger.info(
          { role, messageKind },
          "Multiplayer signaling message received",
        );
      }
      // Preserve WebSocket message order across async database operations.
      // In particular, join ICE candidates can arrive before the offer's room
      // reservation finishes; they must wait until sessionId is assigned.
      connection.messageQueue = connection.messageQueue
        .then(() => handleMessage(connection, message))
        .catch((error: unknown) => {
          logger.warn(
            { err: error, role },
            "Multiplayer signaling request failed",
          );
          sendError(socket, "ServerError");
        });
    });
    socket.on("close", (code) => {
      logger.info({ role, code }, "Multiplayer WebSocket closed");
      connections.delete(connection.id);
      stopSignalPollingIfIdle();
      if (connection.role === "host") {
        void closeHostRoom(connection).catch((error: unknown) =>
          logger.warn({ err: error }, "Could not close multiplayer room"),
        );
      } else if (connection.sessionId) {
        void releaseJoinSession(connection, connection.sessionId).catch(
          (error: unknown) =>
            logger.warn({ err: error }, "Could not release multiplayer session"),
        );
      }
    });
    socket.on("error", (error: Error) => {
      logger.debug({ err: error, role }, "Multiplayer WebSocket error");
    });
  });

  webSocketServer.on("error", (error: Error) => {
    logger.warn({ err: error }, "Multiplayer WebSocket server error");
  });

  server.on("upgrade", (request, socket, head) => {
    let role: Role | null;
    try {
      role = getRole(request);
    } catch {
      logger.warn(
        { status: 400 },
        "Rejected malformed multiplayer WebSocket upgrade",
      );
      writeUpgradeError(socket, 400);
      return;
    }
    if (!role) {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith(`${API_PREFIX}${MULTIPLAYER_PATH}/`)) {
        logger.warn(
          { pathname, status: 404 },
          "Rejected multiplayer WebSocket upgrade",
        );
        writeUpgradeError(socket, 404);
      }
      return;
    }
    logger.info({ role }, "Multiplayer WebSocket upgrade received");
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      rolesBySocket.set(webSocket, role);
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  const cleanupTimer = setInterval(() => {
    const cutoff = new Date(Date.now() - SIGNAL_TTL_MS);
    void Promise.all([
      db
        .delete(multiplayerRoomsTable)
        .where(lt(multiplayerRoomsTable.expiresAt, new Date())),
      db
        .delete(multiplayerSignalsTable)
        .where(lt(multiplayerSignalsTable.createdAt, cutoff)),
    ]).catch((error: unknown) =>
      logger.warn({ err: error }, "Could not clean up expired multiplayer state"),
    );
  }, SIGNAL_TTL_MS);
  cleanupTimer.unref();

  const heartbeatTimer = setInterval(() => {
    for (const connection of connections.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, 30_000);
  heartbeatTimer.unref();

  server.on("close", () => {
    clearInterval(cleanupTimer);
    clearInterval(heartbeatTimer);
    if (signalPoll) clearInterval(signalPoll);
    signalPoll = null;
  });
}