import { DurableObject } from "cloudflare:workers";

const ROOM_CONFIG = {
  fieldSize: 38,
  foodMax: 25,
  foodCount: 4,
  roundDuration: 180,
  maxVisiblePlayers: 32,
  playerTtlMs: 15000,
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...(init.headers || {}),
    },
  });
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function publicPlayer(player) {
  return {
    uid: player.uid,
    x: player.x,
    z: player.z,
    rot: player.rot,
    idx: player.idx,
    segCount: player.segCount,
    isMoving: !!player.isMoving,
    lastSeen: player.lastSeen,
  };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map();
    this.food = new Map();
    this.session = null;
    this.ready = this.load();
  }

  async load() {
    const storedFood = await this.ctx.storage.get("food");
    const storedSession = await this.ctx.storage.get("session");
    this.food = new Map((storedFood || []).map((item) => [item.id, item]));
    this.session = storedSession || {
      round: 1,
      roundEnd: Date.now() + ROOM_CONFIG.roundDuration * 1000,
    };
    this.restorePlayersFromSockets();
    await this.ensureFood();
  }

  restorePlayersFromSockets() {
    for (const ws of this.ctx.getWebSockets()) {
      const attached = ws.deserializeAttachment();
      if (attached?.uid) this.players.set(attached.uid, { ...attached, ws });
    }
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return json({
        ok: true,
        service: "GAME sync room",
        websocket: "Connect with wss://<worker>/room/<name>",
      });
    }

    await this.ready;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (typeof message !== "string") return;

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Bad JSON" }));
      return;
    }

    if (data.type === "join") {
      const uid = String(data.uid || crypto.randomUUID()).slice(0, 80);
      const player = this.sanitizePlayer({ uid, idx: data.idx, lastSeen: Date.now() });
      this.players.set(uid, { ...player, ws });
      ws.serializeAttachment(player);
      this.sendState(ws, "welcome", uid);
      return;
    }

    const current = this.playerForSocket(ws);
    if (!current) {
      ws.send(JSON.stringify({ type: "error", message: "Join first" }));
      return;
    }

    if (data.type === "player") {
      const next = this.sanitizePlayer({ ...current, ...data, uid: current.uid, lastSeen: Date.now() });
      this.players.set(current.uid, { ...next, ws });
      ws.serializeAttachment(next);
      this.cleanupPlayers();
      this.sendState(ws);
      return;
    }

    if (data.type === "eatFood") {
      const id = String(data.id || "");
      if (this.food.delete(id)) {
        await this.ctx.storage.put("food", [...this.food.values()]);
        this.broadcast({ type: "foodGone", id });
        await this.ensureFood();
      }
      this.sendState(ws);
      return;
    }

    if (data.type === "steal" || data.type === "hit") {
      const targetUid = String(data.uid || "");
      const target = this.players.get(targetUid);
      if (target) {
        const amount = clampNumber(data.amount, data.type === "hit" ? 2 : 1, 1, 8);
        target.segCount = Math.max(0, (target.segCount || 0) - amount);
        target.lastSeen = Date.now();
        this.players.set(targetUid, target);
        this.patchPlayer(target);
      }
      this.sendState(ws);
      return;
    }

    if (data.type === "newRound") {
      const duration = clampNumber(data.duration, ROOM_CONFIG.roundDuration, 30, 600);
      this.session = { round: (this.session?.round || 0) + 1, roundEnd: Date.now() + duration * 1000 };
      this.food.clear();
      await this.ensureFood();
      await this.ctx.storage.put("session", this.session);
      this.broadcastState();
    }
  }

  async webSocketClose(ws) {
    await this.ready;
    const player = this.playerForSocket(ws);
    if (player) this.players.delete(player.uid);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  sanitizePlayer(data) {
    return {
      uid: String(data.uid || crypto.randomUUID()).slice(0, 80),
      x: clampNumber(data.x, 0, -ROOM_CONFIG.fieldSize, ROOM_CONFIG.fieldSize),
      z: clampNumber(data.z, 0, -ROOM_CONFIG.fieldSize, ROOM_CONFIG.fieldSize),
      rot: clampNumber(data.rot, 0, -Math.PI * 4, Math.PI * 4),
      idx: Math.floor(clampNumber(data.idx, 0, 0, 64)),
      segCount: Math.floor(clampNumber(data.segCount, 0, 0, 999)),
      isMoving: !!data.isMoving,
      lastSeen: clampNumber(data.lastSeen, Date.now(), 0, Date.now() + 10000),
    };
  }

  playerForSocket(ws) {
    const attached = ws.deserializeAttachment();
    if (attached?.uid) return this.players.get(attached.uid);
    for (const player of this.players.values()) {
      if (player.ws === ws) return player;
    }
    return null;
  }

  cleanupPlayers() {
    const now = Date.now();
    for (const [uid, player] of this.players) {
      if (now - (player.lastSeen || 0) > ROOM_CONFIG.playerTtlMs) this.players.delete(uid);
    }
  }

  async ensureFood() {
    let changed = false;
    while (this.food.size < ROOM_CONFIG.foodMax) {
      const id = crypto.randomUUID();
      this.food.set(id, {
        id,
        x: (Math.random() * 2 - 1) * ROOM_CONFIG.fieldSize,
        z: (Math.random() * 2 - 1) * ROOM_CONFIG.fieldSize,
        t: Math.floor(Math.random() * ROOM_CONFIG.foodCount),
      });
      changed = true;
    }
    if (changed) await this.ctx.storage.put("food", [...this.food.values()]);
  }

  visiblePlayersFor(ws) {
    const me = this.playerForSocket(ws);
    const players = [...this.players.values()];
    if (!me) return players.slice(0, ROOM_CONFIG.maxVisiblePlayers).map(publicPlayer);

    const visible = players
      .map((p) => ({ p, d: p.uid === me.uid ? -1 : (p.x - me.x) ** 2 + (p.z - me.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, ROOM_CONFIG.maxVisiblePlayers + 1)
      .map(({ p }) => publicPlayer(p));
    return visible;
  }

  sendState(ws, type = "state", uid = null) {
    ws.send(JSON.stringify({
      type,
      uid,
      session: this.session,
      food: [...this.food.values()],
      players: this.visiblePlayersFor(ws),
    }));
  }

  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) ws.send(payload);
  }

  broadcastState() {
    for (const ws of this.ctx.getWebSockets()) this.sendState(ws);
  }

  patchPlayer(player) {
    if (player.ws) {
      player.ws.send(JSON.stringify({ type: "patchPlayer", uid: player.uid, segCount: player.segCount }));
      const attached = publicPlayer(player);
      player.ws.serializeAttachment(attached);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) {
      return json({
        ok: true,
        service: "GAME Cloudflare WebSocket sync",
        example: `${url.origin.replace(/^http/, "ws")}/room/main`,
      });
    }

    const roomName = decodeURIComponent(match[1]).slice(0, 80) || "main";
    const id = env.GAME_ROOM.idFromName(roomName);
    const room = env.GAME_ROOM.get(id);
    return room.fetch(request);
  },
};
