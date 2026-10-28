import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "100kb" }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3001;

const games = new Map();
const clients = new Map();
const allowedSets = [
  { code: "ltr", name: "The Lord of the Rings: Tales of Middle-earth" },
  { code: "ltc", name: "The Lord of the Rings: Tales of Middle-earth Commander" },
  { code: "woe", name: "Wilds of Eldraine" },
  { code: "mkm", name: "Murders at Karlov Manor" },
  { code: "mh3", name: "Modern Horizons 3" },
  { code: "dsk", name: "Duskmourn: House of Horror" },
  { code: "fdn", name: "Foundations" }
];

function safePlayer(p) {
  return { id: p.id, name: p.name, ready: !!p.ready, isHost: !!p.isHost };
}
function publicGame(g) {
  return {
    id: g.id, title: g.title, status: g.status, setCode: g.setCode, setName: g.setName,
    boosterCount: g.boosterCount, hostName: g.hostName, players: g.players.map(safePlayer),
    maxPlayers: g.maxPlayers, createdAt: g.createdAt, votes: g.votes,
    messages: g.messages.slice(-60), draftRound: g.draftRound || 0,
    draftPick: g.draftPick || 0, picksDone: g.picksDone || 0
  };
}
function emitState() {
  io.emit("state", { games: [...games.values()].map(publicGame), sets: allowedSets });
}
function chat(g, player, text, system = false) {
  const message = { id: cryptoRandom(), name: system ? "Arena" : player.name, text: String(text).slice(0, 500), at: Date.now(), system };
  g.messages.push(message);
  if (g.messages.length > 150) g.messages.shift();
  return message;
}
function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function currentPlayer(socket, game) {
  const info = clients.get(socket.id);
  return info && game.players.find(p => p.id === info.playerId);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "draft-arena", games: games.size }));
app.get("/api/sets", async (_req, res) => {
  try {
    const response = await fetch("https://api.scryfall.com/sets");
    if (!response.ok) throw new Error("Scryfall returned " + response.status);
    const data = await response.json();
    res.json(data.data.map(s => ({ code: s.code, name: s.name, released_at: s.released_at, set_type: s.set_type })));
  } catch {
    res.json(allowedSets);
  }
});
app.get("/api/cards/:id", async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9-]{20,40}$/i.test(id)) return res.status(400).json({ error: "Invalid Scryfall ID" });
  try {
    const r = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`, { headers: { "User-Agent": "DraftArena/1.0", "Accept": "application/json" } });
    res.status(r.status).set("Cache-Control", "public, max-age=300").send(await r.text());
  } catch { res.status(502).json({ error: "Scryfall is temporarily unreachable from the server." }); }
});
app.get("/api/card-search", async (req, res) => {
  const q = String(req.query.q || "").slice(0, 160);
  if (!q) return res.status(400).json({ error: "Missing q" });
  try {
    const r = await fetch("https://api.scryfall.com/cards/search?q=" + encodeURIComponent(q), { headers: { "User-Agent": "DraftArena/1.0", "Accept": "application/json" } });
    res.status(r.status).set("Cache-Control", "public, max-age=300").send(await r.text());
  } catch { res.status(502).json({ error: "Scryfall is temporarily unreachable from the server." }); }
});
// Serve the built React frontend from the same Render service. This keeps deployment simple:
// one GitHub repository, one Render Web Service, and one public URL.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../client/dist");
app.use(express.static(clientDist));

// Image proxy: the browser only requests our own server. This first version streams images and
// keeps no permanent server-side copy; the browser's ImageCache handles in-memory reuse.
app.get("/api/image", async (req, res) => {
  const raw = String(req.query.url || "");
  let url;
  try { url = new URL(raw); } catch { return res.status(400).send("Invalid image URL"); }
  if (url.protocol !== "https:" || !["cards.scryfall.io", "c1.scryfall.com", "c2.scryfall.com", "c3.scryfall.com"].includes(url.hostname)) {
    return res.status(400).send("Image host not allowed");
  }
  try {
    const r = await fetch(url, { headers: { "User-Agent": "DraftArena/1.0" } });
    if (!r.ok) return res.status(r.status).send("Image unavailable");
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    res.set("X-Content-Type-Options", "nosniff");
    const bytes = Buffer.from(await r.arrayBuffer());
    res.send(bytes);
  } catch { res.status(502).send("Image proxy failed"); }
});

// SPA fallback: unknown non-API paths should load the React app.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(clientDist, "index.html"), err => { if (err) next(err); });
});

io.on("connection", socket => {
  socket.emit("state", { games: [...games.values()].map(publicGame), sets: allowedSets });

  socket.on("join-arena", ({ playerName } = {}) => {
    const name = String(playerName || "Player").trim().slice(0, 24) || "Player";
    clients.set(socket.id, { playerId: cryptoRandom(), playerName: name });
    socket.emit("identity", { playerId: clients.get(socket.id).playerId, playerName: name });
    emitState();
  });

  socket.on("create-game", ({ title, maxPlayers } = {}) => {
    const c = clients.get(socket.id);
    if (!c) return socket.emit("notice", "Kies eerst een spelersnaam.");
    const id = cryptoRandom();
    const host = { id: c.playerId, name: c.playerName, ready: true, isHost: true, socketId: socket.id, hand: [], picks: [], booster: [] };
    const g = {
      id, title: String(title || `${c.playerName}'s draft`).slice(0, 50), status: "lobby",
      setCode: "ltr", setName: "The Lord of the Rings: Tales of Middle-earth",
      boosterCount: 3, hostName: c.playerName, players: [host],
      maxPlayers: Math.max(2, Math.min(8, Number(maxPlayers) || 8)),
      createdAt: Date.now(), votes: {}, messages: [], draftRound: 0, draftPick: 0, picksDone: 0
    };
    games.set(id, g);
    clients.set(socket.id, { ...c, playerId: host.id, gameId: id });
    chat(g, host, `${host.name} heeft de lobby aangemaakt.`, true);
    socket.join(id);
    emitState();
  });

  socket.on("join-game", ({ gameId } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g) return socket.emit("notice", "Game niet gevonden.");
    if (g.status !== "lobby") return socket.emit("notice", "Deze game is al bezig. Je kunt alleen toeschouwer worden in een volgende update.");
    if (g.players.some(p => p.id === c.playerId)) return;
    if (g.players.length >= g.maxPlayers) return socket.emit("notice", "Deze lobby is vol.");
    const p = { id: c.playerId, name: c.playerName, ready: false, isHost: false, socketId: socket.id, hand: [], picks: [], booster: [] };
    g.players.push(p);
    clients.set(socket.id, { ...c, gameId });
    socket.join(gameId);
    chat(g, p, `${p.name} is gejoined.`, true);
    emitState();
  });

  socket.on("vote", ({ gameId, setCode, boosterCount } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g || g.status !== "lobby") return;
    const p = currentPlayer(socket, g);
    if (!p) return;
    if (setCode && allowedSets.some(s => s.code === setCode)) p.voteSet = setCode;
    if ([1, 2, 3, 4, 5, 6].includes(Number(boosterCount))) p.voteBoosters = Number(boosterCount);
    const setVotes = {}, boosterVotes = {};
    for (const player of g.players) {
      if (player.voteSet) setVotes[player.voteSet] = (setVotes[player.voteSet] || 0) + 1;
      if (player.voteBoosters) boosterVotes[player.voteBoosters] = (boosterVotes[player.voteBoosters] || 0) + 1;
    }
    g.votes = { sets: setVotes, boosters: boosterVotes, mySet: p.voteSet, myBoosters: p.voteBoosters };
    emitState();
  });

  socket.on("chat-message", ({ gameId, text } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g) return;
    const p = currentPlayer(socket, g);
    if (!p) return;
    const msg = String(text || "").trim();
    if (!msg) return;
    chat(g, p, msg);
    io.to(gameId).emit("game-message", publicGame(g));
    emitState();
  });

  socket.on("start-game", ({ gameId } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g) return;
    const p = currentPlayer(socket, g);
    if (!p?.isHost || g.status !== "lobby") return socket.emit("notice", "Alleen de host kan de draft starten.");
    if (g.players.length < 2) return socket.emit("notice", "Je hebt minimaal 2 spelers nodig. Je kunt de demo ook met 1 speler testen via de knop 'Start demo'.");
    const setVotes = {}, boosterVotes = {};
    for (const pl of g.players) {
      if (pl.voteSet) setVotes[pl.voteSet] = (setVotes[pl.voteSet] || 0) + 1;
      if (pl.voteBoosters) boosterVotes[pl.voteBoosters] = (boosterVotes[pl.voteBoosters] || 0) + 1;
    }
    const winner = Object.entries(setVotes).sort((a,b)=>b[1]-a[1])[0]?.[0] || g.setCode;
    const boosters = Number(Object.entries(boosterVotes).sort((a,b)=>b[1]-a[1])[0]?.[0] || g.boosterCount);
    g.setCode = winner; g.setName = allowedSets.find(s=>s.code===winner)?.name || g.setName;
    g.boosterCount = boosters; g.status = "drafting"; g.draftRound = 1; g.draftPick = 1;
    // MVP demo: fetch sample cards through Scryfall search; draft selection is server-tracked.
    chat(g, p, `Draft gestart: ${g.setName}, ${g.boosterCount} booster(s) per speler.`, true);
    emitState();
    for (const pl of g.players) {
      pl.hand = [];
      pl.picks = [];
      pl.booster = [];
    }
    socket.emit("notice", "Draft gestart. De boosterkaarten worden geladen.");
    io.to(gameId).emit("draft-started", { gameId, setCode: winner, boosterCount: boosters });
    emitState();
  });

  socket.on("request-booster", async ({ gameId } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g || g.status !== "drafting") return;
    const p = currentPlayer(socket, g);
    if (!p) return;
    try {
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent("set:"+g.setCode)}&order=set&unique=cards`, { headers: { "User-Agent": "DraftArena/1.0" } });
      const data = await r.json();
      if (!data.data?.length) throw new Error("No cards");
      const cards = data.data.filter(card => card.image_uris || card.card_faces?.[0]?.image_uris).sort(()=>Math.random()-0.5).slice(0, 15).map(card => ({
        id: card.id, name: card.name, image: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null,
        small: card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || null,
        mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || "", type_line: card.type_line || "",
        oracle_text: card.oracle_text || card.card_faces?.[0]?.oracle_text || ""
      }));
      p.booster = cards;
      socket.emit("booster", { gameId, cards, round: g.draftRound, pick: g.draftPick });
    } catch {
      socket.emit("notice", "Kon geen booster laden via Scryfall. Controleer of Render Scryfall kan bereiken.");
    }
  });

  socket.on("pick-card", ({ gameId, cardId } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g || g.status !== "drafting") return;
    const p = currentPlayer(socket, g);
    if (!p) return;
    const idx = p.booster.findIndex(card => card.id === cardId);
    if (idx < 0) return socket.emit("notice", "Deze kaart zit niet meer in jouw booster.");
    const [picked] = p.booster.splice(idx, 1);
    p.picks.push(picked);
    g.picksDone++;
    g.draftPick++;
    chat(g, p, `kiest ${picked.name}.`);
    if (p.booster.length === 0) {
      p.hand = [...p.picks];
      chat(g, p, `heeft de booster afgerond (${p.picks.length} kaarten).`, true);
    }
    socket.emit("pick-confirmed", { card: picked, remaining: p.booster.length, picks: p.picks });
    emitState();
  });

  socket.on("end-game", ({ gameId } = {}) => {
    const c = clients.get(socket.id), g = games.get(gameId);
    if (!c || !g) return;
    const p = currentPlayer(socket, g);
    if (!p) return;
    g.status = "finished";
    chat(g, p, "heeft de game beëindigd.", true);
    emitState();
  });

  socket.on("disconnect", () => {
    const c = clients.get(socket.id);
    if (c?.gameId) {
      const g = games.get(c.gameId);
      if (g) {
        const p = g.players.find(x => x.id === c.playerId);
        if (p) p.connected = false;
        chat(g, { name: c.playerName || "Player" }, `${c.playerName || "Een speler"} is disconnected.`, true);
      }
    }
    clients.delete(socket.id);
    emitState();
  });
});

httpServer.listen(PORT, () => console.log(`Draft Arena server listening on ${PORT}`));
