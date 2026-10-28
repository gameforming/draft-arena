import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --------------------------------------------------
// Basisconfiguratie
// --------------------------------------------------

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "100kb" }));

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingTimeout: 20000,
  pingInterval: 25000,
});

const PORT = Number(process.env.PORT) || 3001;
const games = new Map();
const clients = new Map();
const setCache = new Map();
const cardPoolCache = new Map();

const SET_CACHE_MS = 60 * 60 * 1000;
const CARD_CACHE_MS = 30 * 60 * 1000;
const CARDS_PER_BOOSTER = 14;
const BASIC_LANDS = [
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
];

const ALLOWED_BOOSTER_COUNTS = [1, 2, 3, 4, 5, 6];

const FALLBACK_SETS = [
  { code: "ltr", name: "The Lord of the Rings: Tales of Middle-earth" },
  { code: "ltc", name: "The Lord of the Rings: Tales of Middle-earth Commander" },
  { code: "woe", name: "Wilds of Eldraine" },
  { code: "mkm", name: "Murders at Karlov Manor" },
  { code: "mh3", name: "Modern Horizons 3" },
  { code: "dsk", name: "Duskmourn: House of Horror" },
  { code: "fdn", name: "Foundations" },
];

let setCatalog = [...FALLBACK_SETS];
let setCatalogUpdatedAt = 0;
let setCatalogPromise = null;

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function createId() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function emptyBasicLands() {
  return Object.fromEntries(
    BASIC_LANDS.map((name) => [name, 0])
  );
}

function notify(socket, message) {
  socket.emit("notice", message);
}

function getClient(socket) {
  return clients.get(socket.id);
}

function getSet(code) {
  return setCatalog.find((set) => set.code === code);
}

function getPlayer(socket, game) {
  const client = getClient(socket);

  if (
    !client ||
    client.gameId !== game.id ||
    client.watching
  ) {
    return null;
  }

  return (
    game.players.find(
      (player) => player.id === client.playerId
    ) || null
  );
}

function addChatMessage(game, name, text, system = false) {
  const message = {
    id: createId(),
    name: system ? "Arena" : name,
    text: String(text).slice(0, 500),
    at: Date.now(),
    system,
  };

  game.messages.push(message);

  if (game.messages.length > 150) {
    game.messages.shift();
  }

  return message;
}

function addSystemMessage(game, text) {
  return addChatMessage(game, "Arena", text, true);
}

function leaveRoom(socket, client) {
  if (client?.gameId) {
    socket.leave(client.gameId);
  }

  if (client) {
    client.gameId = null;
    client.watching = false;
  }
}

function safePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    ready: Boolean(player.ready),
    isHost: Boolean(player.isHost),
    connected: player.connected !== false,
    hasPicked: Boolean(player.hasPicked),
    picksCount: player.picks.length,
  };
}

function getVoteTotals(game) {
  const sets = {};
  const boosters = {};

  for (const player of game.players) {
    if (player.voteSet) {
      sets[player.voteSet] =
        (sets[player.voteSet] || 0) + 1;
    }

    if (player.voteBoosters) {
      const key = String(player.voteBoosters);

      boosters[key] =
        (boosters[key] || 0) + 1;
    }
  }

  return { sets, boosters };
}

function publicGame(game) {
  return {
    id: game.id,
    title: game.title,
    status: game.status,
    setCode: game.setCode,
    setName: game.setName,
    boosterCount: game.boosterCount,
    hostName: game.hostName,
    players: game.players.map(safePlayer),
    maxPlayers: game.maxPlayers,
    createdAt: game.createdAt,
    votes: getVoteTotals(game),
    messages: game.messages.slice(-60),
    draftRound: game.draftRound,
    draftPick: game.draftPick,
    picksDone: game.picksDone,
    direction: game.direction,
    pickProgress: game.players.filter(
      (player) => player.hasPicked
    ).length,
  };
}

function emitState() {
  io.emit("state", {
    games: [...games.values()].map(publicGame),
    sets: setCatalog,
  });
}

// Elke speler krijgt uitsluitend de eigen booster en eigen picks.
function sendPrivateState(game, player) {
  if (!player.socketId) return;

  const socket = io.sockets.sockets.get(player.socketId);
  if (!socket) return;

  socket.emit("draft-private-state", {
    gameId: game.id,
    status: game.status,
    booster: player.booster,
    picks: player.picks,
    basicLands: player.basicLands,
    hasPicked: player.hasPicked,
    round: game.draftRound,
    boosterCount: game.boosterCount,
    pick: game.draftPick,
    direction: game.direction,
    remaining: player.booster.length,
  });
}

function sendAllPrivateStates(game) {
  for (const player of game.players) {
    sendPrivateState(game, player);
  }
}

function chooseWinner(votes, fallback) {
  const entries = Object.entries(votes);

  if (!entries.length) {
    return String(fallback);
  }

  const maxVotes = Math.max(
    ...entries.map(([, total]) => total)
  );

  const tied = entries
    .filter(([, total]) => total === maxVotes)
    .map(([key]) => key)
    .sort();

  return tied.includes(String(fallback))
    ? String(fallback)
    : tied[0];
}

// --------------------------------------------------
// Scryfall setcatalogus
// --------------------------------------------------

async function loadSetCatalog(force = false) {
  const valid =
    Date.now() - setCatalogUpdatedAt < SET_CACHE_MS;

  if (!force && valid) return setCatalog;
  if (setCatalogPromise) return setCatalogPromise;

  setCatalogPromise = (async () => {
    try {
      const response = await fetch(
        "https://api.scryfall.com/sets",
        {
          headers: {
            "User-Agent": "DraftArena/2.0",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Scryfall sets HTTP ${response.status}`
        );
      }

      const data = await response.json();

      if (!Array.isArray(data.data)) {
        throw new Error("Ongeldige setcatalogus");
      }

      setCatalog = data.data
        .filter(
          (set) =>
            typeof set.code === "string" &&
            typeof set.name === "string"
        )
        .map((set) => ({
          code: set.code.toLowerCase(),
          name: set.name,
          released_at: set.released_at || null,
          set_type: set.set_type || null,
        }))
        .sort((a, b) => {
          return (
            String(b.released_at || "").localeCompare(
              String(a.released_at || "")
            ) || a.name.localeCompare(b.name)
          );
        });

      setCache.clear();
      setCatalogUpdatedAt = Date.now();

      console.log(
        `Scryfall: ${setCatalog.length} sets geladen.`
      );

      emitState();
      return setCatalog;
    } catch (error) {
      console.error(
        "Setcatalogus laden mislukt:",
        error.message
      );

      return setCatalog;
    } finally {
      setCatalogPromise = null;
    }
  })();

  return setCatalogPromise;
}

// --------------------------------------------------
// Scryfall-kaarten ophalen en cachen
// --------------------------------------------------

async function searchScryfall(query, maxCards = 700) {
  let url = new URL(
    "https://api.scryfall.com/cards/search"
  );

  url.searchParams.set("q", query);
  url.searchParams.set("order", "set");
  url.searchParams.set("unique", "cards");

  const cards = [];
  const seen = new Set();

  for (
    let page = 0;
    url && page < 8 && cards.length < maxCards;
    page++
  ) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "DraftArena/2.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    // Scryfall kan HTTP 404 geven als een zoekopdracht
    // helemaal geen kaarten oplevert.
    if (response.status === 404) {
      break;
    }

    if (!response.ok) {
      throw new Error(
        `Scryfall search HTTP ${response.status}`
      );
    }

    const data = await response.json();

    for (const card of data.data || []) {
      if (!card.id || seen.has(card.id)) continue;

      const hasImage =
        card.image_uris ||
        card.card_faces?.some(
          (face) => face.image_uris
        );

      if (!hasImage) continue;

      seen.add(card.id);
      cards.push(card);

      if (cards.length >= maxCards) break;
    }

    if (
      !data.has_more ||
      !data.next_page ||
      cards.length >= maxCards
    ) {
      break;
    }

    const nextUrl = new URL(data.next_page);

    if (nextUrl.hostname !== "api.scryfall.com") {
      throw new Error("Ongeldige Scryfall-vervolgpagina");
    }

    url = nextUrl;
  }

  return cards;
}

function normalizeCard(raw) {
  const faces = (raw.card_faces || []).map((face) => ({
    name: face.name || raw.name,
    image:
      face.image_uris?.normal ||
      face.image_uris?.large ||
      null,
    small: face.image_uris?.small || null,
    mana_cost: face.mana_cost || "",
    type_line: face.type_line || "",
    oracle_text: face.oracle_text || "",
  }));

  const firstFace = faces[0];

  return {
    id: raw.id,
    name: raw.name,
    image:
      raw.image_uris?.normal ||
      firstFace?.image ||
      null,
    small:
      raw.image_uris?.small ||
      firstFace?.small ||
      null,
    mana_cost:
      raw.mana_cost ||
      firstFace?.mana_cost ||
      "",
    type_line:
      raw.type_line ||
      faces.map((face) => face.type_line).filter(Boolean).join(" // "),
    oracle_text:
      raw.oracle_text ||
      faces.map((face) => face.oracle_text).filter(Boolean).join(" // "),
    rarity: raw.rarity || "common",
    layout: raw.layout || "normal",
    faces: faces.length > 1 ? faces : [],
  };
}

async function loadCardPool(setCode) {
  const cached = cardPoolCache.get(setCode);

  if (
    cached &&
    Date.now() - cached.updatedAt < CARD_CACHE_MS
  ) {
    return cached.cards;
  }

  let rawCards = await searchScryfall(
    `set:${setCode} game:paper is:booster`
  );

  let normalized = rawCards
    .map(normalizeCard)
    .filter((card) => card.image);

  // Sommige sets hebben geen bruikbare is:booster-resultaten.
  if (normalized.length < CARDS_PER_BOOSTER) {
    rawCards = await searchScryfall(
      `set:${setCode} game:paper`
    );

    normalized = rawCards
      .map(normalizeCard)
      .filter((card) => card.image);
  }

  const uniqueById = new Map();

  for (const card of normalized) {
    uniqueById.set(card.id, card);
  }

  const pool = [...uniqueById.values()];

  if (pool.length < CARDS_PER_BOOSTER) {
    throw new Error(
      `Set ${setCode} heeft onvoldoende verschillende kaarten met afbeeldingen.`
    );
  }

  cardPoolCache.set(setCode, {
    cards: pool,
    updatedAt: Date.now(),
  });

  console.log(
    `Set ${setCode}: ${pool.length} bruikbare kaarten gecachet.`
  );

  return pool;
}

// --------------------------------------------------
// Booster samenstellen
// --------------------------------------------------

// Vereenvoudigde 14-kaartenindeling:
// 10 commons, 3 uncommons, 1 rare/mythic.
// Ontbrekende zeldzaamheden worden uit de resterende pool gevuld.
function buildBooster(pool) {
  const chosen = [];
  const usedIds = new Set();

  function addFrom(source, count) {
    const options = shuffle(
      source.filter((card) => !usedIds.has(card.id))
    );

    for (const card of options) {
      if (chosen.length >= CARDS_PER_BOOSTER) break;
      if (count <= 0) break;

      chosen.push({
        ...card,
        faces: card.faces ? [...card.faces] : [],
        instanceId: createId(),
      });

      usedIds.add(card.id);
      count--;
    }
  }

  addFrom(
    pool.filter((card) => card.rarity === "common"),
    10
  );

  addFrom(
    pool.filter((card) => card.rarity === "uncommon"),
    3
  );

  addFrom(
    pool.filter(
      (card) =>
        card.rarity === "rare" ||
        card.rarity === "mythic"
    ),
    1
  );

  // Set met afwijkende rariteiten? Vul de booster aan.
  addFrom(pool, CARDS_PER_BOOSTER - chosen.length);

  if (chosen.length !== CARDS_PER_BOOSTER) {
    throw new Error(
      `Booster bevat ${chosen.length} kaarten; ${CARDS_PER_BOOSTER} vereist.`
    );
  }

  return shuffle(chosen);
}

// --------------------------------------------------
// Draftlogica
// --------------------------------------------------

function startBoosterRound(game) {
  game.draftPick = 1;
  game.direction =
    game.draftRound % 2 === 1 ? "left" : "right";

  for (const player of game.players) {
    player.booster = buildBooster(game.cardPool);
    player.hasPicked = false;
  }

  addSystemMessage(
    game,
    `Booster ${game.draftRound}/${game.boosterCount} gestart. Doorgeven naar ${game.direction === "left" ? "links" : "rechts"}.`
  );

  io.to(game.id).emit("draft-round-started", {
    gameId: game.id,
    round: game.draftRound,
    boosterCount: game.boosterCount,
    direction: game.direction,
    cardsPerBooster: CARDS_PER_BOOSTER,
  });

  sendAllPrivateStates(game);
  emitState();
}

function finishDraft(game) {
  game.status = "finished";
  game.direction = null;

  addSystemMessage(
    game,
    "De draft is afgerond. Je kunt nu basic lands toevoegen en je eigen pool bekijken."
  );

  io.to(game.id).emit("draft-finished", {
    gameId: game.id,
    boosterCount: game.boosterCount,
  });

  sendAllPrivateStates(game);
  emitState();
}

function resolveDraftPick(game) {
  if (
    game.status !== "drafting" ||
    game.resolving
  ) {
    return;
  }

  // Verbinding weggevallen? Kies automatisch een kaart voor
  // die speler zodat de andere spelers niet eindeloos wachten.
  for (const player of game.players) {
    if (
      player.connected === false &&
      !player.hasPicked &&
      player.booster.length > 0
    ) {
      const index = Math.floor(
        Math.random() * player.booster.length
      );

      const [card] = player.booster.splice(index, 1);

      player.picks.push(card);
      player.hasPicked = true;
      game.picksDone++;
    }
  }

  const allReady = game.players.every(
    (player) =>
      player.hasPicked || player.booster.length === 0
  );

  if (!allReady) {
    emitState();
    return;
  }

  game.resolving = true;

  try {
    const allPacksEmpty = game.players.every(
      (player) => player.booster.length === 0
    );

    // Alle kaarten van deze booster zijn gekozen.
    if (allPacksEmpty) {
      if (game.draftRound < game.boosterCount) {
        game.draftRound++;
        startBoosterRound(game);
      } else {
        finishDraft(game);
      }

      return;
    }

    // Bewaar eerst alle resterende pakketten om te voorkomen
    // dat een pack wordt overschreven voordat het is doorgegeven.
    const packs = game.players.map(
      (player) => player.booster
    );

    const playerCount = game.players.length;

    game.players.forEach((player, index) => {
      const targetIndex =
        game.direction === "left"
          ? (index + 1) % playerCount
          : (index - 1 + playerCount) % playerCount;

      game.players[targetIndex].booster = packs[index];
    });

    for (const player of game.players) {
      player.hasPicked = false;
    }

    game.draftPick++;

    sendAllPrivateStates(game);
    emitState();
  } finally {
    game.resolving = false;
  }
}

// --------------------------------------------------
// HTTP API
// --------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "draft-arena",
    games: games.size,
    sets: setCatalog.length,
  });
});

app.get("/api/sets", async (_req, res) => {
  await loadSetCatalog();

  res.set("Cache-Control", "public, max-age=3600");
  res.json(setCatalog);
});

app.get("/api/cards/:id", async (req, res) => {
  const id = String(req.params.id || "");

  if (!/^[a-f0-9-]{20,40}$/i.test(id)) {
    return res.status(400).json({
      error: "Invalid Scryfall ID",
    });
  }

  try {
    const response = await fetch(
      `https://api.scryfall.com/cards/${encodeURIComponent(id)}`,
      {
        headers: {
          "User-Agent": "DraftArena/2.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    res
      .status(response.status)
      .set("Cache-Control", "public, max-age=300")
      .send(await response.text());
  } catch (error) {
    console.error("Kaart ophalen mislukt:", error.message);
    res.status(502).json({
      error: "Scryfall is tijdelijk niet bereikbaar.",
    });
  }
});

app.get("/api/card-search", async (req, res) => {
  const query = String(req.query.q || "").slice(0, 160);

  if (!query) {
    return res.status(400).json({
      error: "Missing q",
    });
  }

  try {
    const response = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": "DraftArena/2.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    res
      .status(response.status)
      .set("Cache-Control", "public, max-age=300")
      .send(await response.text());
  } catch (error) {
    console.error("Kaarten zoeken mislukt:", error.message);
    res.status(502).json({
      error: "Scryfall is tijdelijk niet bereikbaar.",
    });
  }
});

// Afbeeldingen tijdelijk via Render doorsturen.
// De server slaat geen afbeeldingbestanden permanent op.
app.get("/api/image", async (req, res) => {
  let url;

  try {
    url = new URL(String(req.query.url || ""));
  } catch {
    return res.status(400).send("Invalid image URL");
  }

  const allowedHosts = new Set([
    "cards.scryfall.io",
    "c1.scryfall.com",
    "c2.scryfall.com",
    "c3.scryfall.com",
  ]);

  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname)
  ) {
    return res.status(400).send("Image host not allowed");
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "DraftArena/2.0",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return res.status(response.status).send(
        "Image unavailable"
      );
    }

    const image = Buffer.from(
      await response.arrayBuffer()
    );

    res.set(
      "Content-Type",
      response.headers.get("content-type") ||
        "image/jpeg"
    );
    res.set("Cache-Control", "public, max-age=3600");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(image);
  } catch (error) {
    console.error("Afbeelding ophalen mislukt:", error.message);
    res.status(502).send("Image proxy failed");
  }
});

// --------------------------------------------------
// Frontend
// --------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../client/dist");

app.use(express.static(clientDist));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API endpoint not found",
    });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return next();
  }

  res.sendFile(
    path.join(clientDist, "index.html"),
    (error) => {
      if (error) next(error);
    }
  );
});

// --------------------------------------------------
// Socket.IO
// --------------------------------------------------

io.on("connection", (socket) => {
  socket.emit("state", {
    games: [...games.values()].map(publicGame),
    sets: setCatalog,
  });

  // Spelersnaam instellen.
  socket.on("join-arena", ({ playerName } = {}) => {
    const previous = getClient(socket);

    const name =
      String(playerName || "Player")
        .trim()
        .slice(0, 24) || "Player";

    const client = {
      playerId: previous?.playerId || createId(),
      playerName: name,
      gameId: previous?.gameId || null,
      watching: previous?.watching || false,
    };

    clients.set(socket.id, client);

    for (const game of games.values()) {
      const player = game.players.find(
        (item) => item.id === client.playerId
      );

      if (player) {
        player.name = name;
        player.socketId = socket.id;
        player.connected = true;

        if (player.isHost) {
          game.hostName = name;
        }

        sendPrivateState(game, player);
      }
    }

    socket.emit("identity", {
      playerId: client.playerId,
      playerName: client.playerName,
    });

    emitState();
  });

  socket.on("rename-player", ({ playerName } = {}) => {
    const client = getClient(socket);

    if (!client) {
      return notify(socket, "Kies eerst een spelersnaam.");
    }

    const name = String(playerName || "")
      .trim()
      .slice(0, 24);

    if (!name) {
      return notify(
        socket,
        "De spelersnaam mag niet leeg zijn."
      );
    }

    client.playerName = name;

    for (const game of games.values()) {
      const player = game.players.find(
        (item) => item.id === client.playerId
      );

      if (player) {
        player.name = name;

        if (player.isHost) {
          game.hostName = name;
        }
      }
    }

    socket.emit("identity", {
      playerId: client.playerId,
      playerName: name,
    });

    emitState();
  });

  // Nieuwe lobby.
  socket.on("create-game", ({ title, maxPlayers } = {}) => {
    const client = getClient(socket);

    if (!client) {
      return notify(socket, "Kies eerst een spelersnaam.");
    }

    const id = createId();
    const defaultSet = getSet("ltr") || FALLBACK_SETS[0];

    const game = {
      id,
      title:
        String(title || `${client.playerName}'s draft`)
          .trim()
          .slice(0, 50) ||
        `${client.playerName}'s draft`,
      status: "lobby",
      setCode: defaultSet.code,
      setName: defaultSet.name,
      boosterCount: 3,
      hostName: client.playerName,
      players: [
        {
          id: client.playerId,
          name: client.playerName,
          ready: true,
          isHost: true,
          connected: true,
          socketId: socket.id,
          voteSet: null,
          voteBoosters: null,
          booster: [],
          picks: [],
          hasPicked: false,
          basicLands: emptyBasicLands(),
        },
      ],
      maxPlayers: Math.max(
        2,
        Math.min(8, Number(maxPlayers) || 8)
      ),
      createdAt: Date.now(),
      messages: [],
      draftRound: 0,
      draftPick: 0,
      picksDone: 0,
      direction: null,
      cardPool: [],
      resolving: false,
    };

    games.set(id, game);

    leaveRoom(socket, client);
    client.gameId = id;
    client.watching = false;
    socket.join(id);

    addSystemMessage(
      game,
      `${client.playerName} heeft de lobby aangemaakt.`
    );

    socket.emit("game-created", {
      gameId: id,
    });

    sendPrivateState(game, game.players[0]);
    emitState();
  });

  // Lobby binnenkomen of opnieuw verbinden met een bestaande game.
  socket.on("join-game", ({ gameId } = {}) => {
    const client = getClient(socket);
    const game = games.get(String(gameId || ""));

    if (!client) {
      return notify(socket, "Kies eerst een spelersnaam.");
    }

    if (!game) {
      return notify(socket, "Game niet gevonden.");
    }

    const existing = game.players.find(
      (player) => player.id === client.playerId
    );

    if (existing) {
      leaveRoom(socket, client);

      client.gameId = game.id;
      client.watching = false;

      existing.connected = true;
      existing.socketId = socket.id;

      socket.join(game.id);
      socket.emit("game-joined", { gameId: game.id });

      sendPrivateState(game, existing);
      emitState();
      return;
    }

    if (game.status !== "lobby") {
      return notify(
        socket,
        "Deze draft is al bezig. Je kunt hem als toeschouwer bekijken."
      );
    }

    if (game.players.length >= game.maxPlayers) {
      return notify(socket, "Deze lobby is vol.");
    }

    const player = {
      id: client.playerId,
      name: client.playerName,
      ready: false,
      isHost: false,
      connected: true,
      socketId: socket.id,
      voteSet: null,
      voteBoosters: null,
      booster: [],
      picks: [],
      hasPicked: false,
      basicLands: emptyBasicLands(),
    };

    leaveRoom(socket, client);

    game.players.push(player);
    client.gameId = game.id;
    client.watching = false;

    socket.join(game.id);

    addSystemMessage(
      game,
      `${player.name} is de lobby binnengekomen.`
    );

    socket.emit("game-joined", { gameId: game.id });
    sendPrivateState(game, player);
    emitState();
  });

  // Actieve game bekijken.
  socket.on("watch-game", ({ gameId } = {}) => {
    const client = getClient(socket);
    const game = games.get(String(gameId || ""));

    if (!client) {
      return notify(socket, "Kies eerst een spelersnaam.");
    }

    if (!game) {
      return notify(socket, "Game niet gevonden.");
    }

    const existing = game.players.find(
      (player) => player.id === client.playerId
    );

    leaveRoom(socket, client);

    client.gameId = game.id;
    client.watching = !existing;

    socket.join(game.id);

    if (existing) {
      existing.connected = true;
      existing.socketId = socket.id;
    }

    socket.emit("game-joined", {
      gameId: game.id,
      watching: client.watching,
    });

    if (existing) {
      sendPrivateState(game, existing);
    }

    emitState();
  });

  // Stemmen op set en aantal boosters.
  socket.on(
    "vote",
    async ({ gameId, setCode, boosterCount } = {}) => {
      const client = getClient(socket);
      const game = games.get(String(gameId || ""));

      if (
        !client ||
        !game ||
        game.status !== "lobby"
      ) {
        return;
      }

      const player = getPlayer(socket, game);

      if (!player) {
        return notify(
          socket,
          "Join eerst deze lobby om te stemmen."
        );
      }

      await loadSetCatalog();

      if (typeof setCode === "string") {
        const code = setCode.trim().toLowerCase();

        if (getSet(code)) {
          player.voteSet = code;
        }
      }

      const count = Number(boosterCount);

      if (ALLOWED_BOOSTER_COUNTS.includes(count)) {
        player.voteBoosters = count;
      }

      emitState();
    }
  );

  // Lobby- en gamechat.
  socket.on("chat-message", ({ gameId, text } = {}) => {
    const client = getClient(socket);
    const game = games.get(String(gameId || ""));

    if (!client || !game || client.gameId !== game.id) {
      return;
    }

    const message = String(text || "")
      .trim()
      .slice(0, 500);

    if (!message) return;

    const player = getPlayer(socket, game);
    const name = player
      ? player.name
      : client.watching
        ? client.playerName
        : null;

    if (!name) return;

    addChatMessage(game, name, message);

    io.to(game.id).emit(
      "game-message",
      publicGame(game)
    );

    emitState();
  });

  // Draft starten en alle persoonlijke boosters tegelijk uitdelen.
  socket.on("start-game", async ({ gameId } = {}) => {
    const game = games.get(String(gameId || ""));

    if (!game || game.status !== "lobby") return;

    const host = getPlayer(socket, game);

    if (!host?.isHost) {
      return notify(
        socket,
        "Alleen de host kan de draft starten."
      );
    }

    if (game.players.length < 2) {
      return notify(
        socket,
        "Je hebt minimaal twee spelers nodig."
      );
    }

    const setVotes = {};
    const boosterVotes = {};

    for (const player of game.players) {
      if (player.voteSet) {
        setVotes[player.voteSet] =
          (setVotes[player.voteSet] || 0) + 1;
      }

      if (player.voteBoosters) {
        const key = String(player.voteBoosters);
        boosterVotes[key] =
          (boosterVotes[key] || 0) + 1;
      }
    }

    const winningSet = chooseWinner(
      setVotes,
      game.setCode
    );

    const winningCount = Number(
      chooseWinner(
        boosterVotes,
        String(game.boosterCount)
      )
    );

    if (!getSet(winningSet)) {
      return notify(
        socket,
        "De gekozen set is niet beschikbaar in Scryfall."
      );
    }

    game.status = "loading";
    game.setCode = winningSet;
    game.setName = getSet(winningSet).name;

    game.boosterCount =
      ALLOWED_BOOSTER_COUNTS.includes(winningCount)
        ? winningCount
        : 3;

    emitState();

    try {
      game.cardPool = await loadCardPool(game.setCode);

      for (const player of game.players) {
        player.booster = [];
        player.picks = [];
        player.hasPicked = false;
        player.basicLands = emptyBasicLands();
      }

      game.status = "drafting";
      game.draftRound = 1;
      game.draftPick = 1;
      game.picksDone = 0;
      game.resolving = false;

      io.to(game.id).emit("draft-started", {
        gameId: game.id,
        setCode: game.setCode,
        boosterCount: game.boosterCount,
        cardsPerBooster: CARDS_PER_BOOSTER,
      });

      startBoosterRound(game);
    } catch (error) {
      console.error(
        "Draft starten mislukt:",
        error.message
      );

      game.status = "lobby";
      emitState();

      notify(
        socket,
        `Draft kon niet starten: ${error.message}`
      );
    }
  });

  // Kies precies één kaart uit de huidige booster.
  socket.on("pick-card", ({ gameId, cardId } = {}) => {
    const game = games.get(String(gameId || ""));

    if (!game || game.status !== "drafting") return;

    const player = getPlayer(socket, game);

    if (!player) {
      return notify(
        socket,
        "Je bent geen speler in deze draft."
      );
    }

    if (player.hasPicked) {
      return notify(
        socket,
        "Je hebt voor deze beurt al een kaart gekozen. Wacht tot de booster wordt doorgegeven."
      );
    }

    const index = player.booster.findIndex(
      (card) => card.instanceId === cardId
    );

    if (index < 0) {
      return notify(
        socket,
        "Deze kaart zit niet meer in jouw booster."
      );
    }

    const [card] = player.booster.splice(index, 1);

    player.picks.push(card);
    player.hasPicked = true;
    game.picksDone++;

    // De kaartnaam blijft privé tot de draft is afgelopen.
    addChatMessage(
      game,
      "Arena",
      `${player.name} heeft een kaart gekozen.`,
      true
    );

    sendPrivateState(game, player);
    emitState();

    resolveDraftPick(game);
  });

  // Basic lands mogen alleen worden bijgewerkt nadat de draft klaar is.
  socket.on(
    "set-basic-lands",
    ({ gameId, lands } = {}) => {
      const game = games.get(String(gameId || ""));

      if (!game || game.status !== "finished") {
        return notify(
          socket,
          "Je kunt basic lands toevoegen nadat de draft is afgelopen."
        );
      }

      const player = getPlayer(socket, game);

      if (!player) {
        return notify(
          socket,
          "Alleen spelers kunnen hun eigen landaantallen wijzigen."
        );
      }

      const next = emptyBasicLands();

      for (const name of BASIC_LANDS) {
        const raw = Number(lands?.[name] || 0);

        next[name] = Number.isFinite(raw)
          ? Math.max(0, Math.min(60, Math.floor(raw)))
          : 0;
      }

      const total = Object.values(next).reduce(
        (sum, count) => sum + count,
        0
      );

      if (total > 100) {
        return notify(
          socket,
          "Je kunt maximaal 100 basic lands toevoegen."
        );
      }

      player.basicLands = next;

      sendPrivateState(game, player);
      emitState();
    }
  );

  // Host kan een game ook handmatig beëindigen.
  socket.on("end-game", ({ gameId } = {}) => {
    const game = games.get(String(gameId || ""));

    if (!game) return;

    const player = getPlayer(socket, game);

    if (!player?.isHost) {
      return notify(
        socket,
        "Alleen de host kan de game beëindigen."
      );
    }

    if (game.status === "finished") return;

    game.status = "finished";
    game.direction = null;

    addSystemMessage(
      game,
      "De host heeft de draft beëindigd."
    );

    io.to(game.id).emit("draft-finished", {
      gameId: game.id,
      boosterCount: game.boosterCount,
    });

    sendAllPrivateStates(game);
    emitState();
  });

  // Bij verlies van verbinding wordt de speler automatisch
  // overgeslagen zodra de overige spelers hun picks afronden.
  socket.on("disconnect", (reason) => {
    const client = getClient(socket);

    if (client?.gameId) {
      const game = games.get(client.gameId);

      if (game) {
        const player = game.players.find(
          (item) => item.id === client.playerId
        );

        if (player) {
          player.connected = false;

          addSystemMessage(
            game,
            `${player.name} heeft de verbinding verloren.`
          );

          // Als deze speler nog moest kiezen, kan de draft
          // na de volgende pick veilig verdergaan.
          resolveDraftPick(game);
        }
      }
    }

    clients.delete(socket.id);

    console.log(
      `Socket disconnected: ${socket.id} (${reason})`
    );

    emitState();
  });
});

// --------------------------------------------------
// Opstarten
// --------------------------------------------------

loadSetCatalog().catch((error) => {
  console.error(
    "Initiële setcatalogus laden mislukt:",
    error.message
  );
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Draft Arena server listening on port ${PORT}`
  );
});
