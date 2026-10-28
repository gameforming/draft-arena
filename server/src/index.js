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

const io = new Server(httpServer, {
  cors: { origin: "*" },
  pingTimeout: 20000,
  pingInterval: 25000,
});

const PORT = Number(process.env.PORT) || 3001;

const games = new Map();
const clients = new Map();

const allowedSets = [
  {
    code: "ltr",
    name: "The Lord of the Rings: Tales of Middle-earth",
  },
  {
    code: "ltc",
    name: "The Lord of the Rings: Tales of Middle-earth Commander",
  },
  { code: "woe", name: "Wilds of Eldraine" },
  { code: "mkm", name: "Murders at Karlov Manor" },
  { code: "mh3", name: "Modern Horizons 3" },
  { code: "dsk", name: "Duskmourn: House of Horror" },
  { code: "fdn", name: "Foundations" },
];

const allowedBoosterCounts = [1, 2, 3, 4, 5, 6];

function createId() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function safePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    ready: Boolean(player.ready),
    isHost: Boolean(player.isHost),
    connected: player.connected !== false,
  };
}

function getVoteTotals(game) {
  const sets = {};
  const boosters = {};

  for (const player of game.players) {
    if (player.voteSet) {
      sets[player.voteSet] = (sets[player.voteSet] || 0) + 1;
    }

    if (player.voteBoosters) {
      const count = String(player.voteBoosters);
      boosters[count] = (boosters[count] || 0) + 1;
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
    draftRound: game.draftRound || 0,
    draftPick: game.draftPick || 0,
    picksDone: game.picksDone || 0,
  };
}

function emitState() {
  io.emit("state", {
    games: [...games.values()].map(publicGame),
    sets: allowedSets,
  });
}

function addChatMessage(game, playerName, text, system = false) {
  const message = {
    id: createId(),
    name: system ? "Arena" : playerName,
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

function notify(socket, message) {
  socket.emit("notice", message);
}

function getClient(socket) {
  return clients.get(socket.id);
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

function leaveCurrentRoom(socket, client) {
  if (client?.gameId) {
    socket.leave(client.gameId);
  }

  if (client) {
    client.gameId = null;
    client.watching = false;
  }
}

function addSystemMessage(game, text) {
  addChatMessage(game, "Arena", text, true);
}

function chooseWinner(votes, fallback, numeric = false) {
  const entries = Object.entries(votes);

  if (entries.length === 0) {
    return String(fallback);
  }

  const highest = Math.max(
    ...entries.map(([, count]) => count)
  );

  const tied = entries
    .filter(([, count]) => count === highest)
    .map(([key]) => key)
    .sort((a, b) =>
      numeric
        ? Number(a) - Number(b)
        : a.localeCompare(b)
    );

  if (tied.includes(String(fallback))) {
    return String(fallback);
  }

  return tied[0];
}

// --------------------------------------------------
// HTTP API
// --------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "draft-arena",
    games: games.size,
  });
});

app.get("/api/sets", async (_req, res) => {
  try {
    const response = await fetch(
      "https://api.scryfall.com/sets",
      {
        headers: {
          "User-Agent": "DraftArena/1.1",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`Scryfall returned ${response.status}`);
    }

    const data = await response.json();

    res.json(
      (data.data || []).map((set) => ({
        code: set.code,
        name: set.name,
        released_at: set.released_at,
        set_type: set.set_type,
      }))
    );
  } catch (error) {
    console.error(
      "Scryfall sets ophalen mislukt:",
      error.message
    );

    res.json(allowedSets);
  }
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
          "User-Agent": "DraftArena/1.1",
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
    console.error(
      "Scryfall kaart ophalen mislukt:",
      error.message
    );

    res.status(502).json({
      error: "Scryfall is temporarily unreachable.",
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
          "User-Agent": "DraftArena/1.1",
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
    console.error(
      "Scryfall kaart zoeken mislukt:",
      error.message
    );

    res.status(502).json({
      error: "Scryfall is temporarily unreachable.",
    });
  }
});

// --------------------------------------------------
// Tijdelijke kaartafbeeldingen via Scryfall
// --------------------------------------------------

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
        "User-Agent": "DraftArena/1.1",
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
      response.headers.get("content-type") || "image/jpeg"
    );
    res.set("Cache-Control", "public, max-age=3600");
    res.set("X-Content-Type-Options", "nosniff");

    res.send(image);
  } catch (error) {
    console.error(
      "Afbeelding ophalen mislukt:",
      error.message
    );

    res.status(502).send("Image proxy failed");
  }
});

// --------------------------------------------------
// Frontend serveren vanuit client/dist
// --------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../client/dist");

app.use(express.static(clientDist));

// Onbekende API-routes moeten een 404 geven.
// Andere URL's openen de React-app.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API endpoint not found",
    });
  }

  res.sendFile(
    path.join(clientDist, "index.html"),
    (error) => {
      if (error) {
        next(error);
      }
    }
  );
});

// --------------------------------------------------
// Socket.IO multiplayer
// --------------------------------------------------

io.on("connection", (socket) => {
  socket.emit("state", {
    games: [...games.values()].map(publicGame),
    sets: allowedSets,
  });

  // De speler kiest zijn naam in het startscherm.
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

    socket.emit("identity", {
      playerId: client.playerId,
      playerName: client.playerName,
    });

    emitState();
  });

  // Spelersnaam wijzigen.
  socket.on("rename-player", ({ playerName } = {}) => {
    const client = getClient(socket);

    if (!client) {
      return notify(
        socket,
        "Kies eerst een spelersnaam."
      );
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

  // Een nieuwe lobby aanmaken.
  socket.on("create-game", ({ title, maxPlayers } = {}) => {
    const client = getClient(socket);

    if (!client) {
      return notify(
        socket,
        "Kies eerst een spelersnaam."
      );
    }

    const id = createId();

    const cleanTitle =
      String(title || `${client.playerName}'s draft`)
        .trim()
        .slice(0, 50) ||
      `${client.playerName}'s draft`;

    const host = {
      id: client.playerId,
      name: client.playerName,
      ready: true,
      isHost: true,
      connected: true,
      socketId: socket.id,
      voteSet: null,
      voteBoosters: null,
      hand: [],
      picks: [],
      booster: [],
    };

    const defaultSet = allowedSets.find(
      (set) => set.code === "ltr"
    );

    const game = {
      id,
      title: cleanTitle,
      status: "lobby",
      setCode: defaultSet.code,
      setName: defaultSet.name,
      boosterCount: 3,
      hostName: client.playerName,
      players: [host],
      maxPlayers: Math.max(
        2,
        Math.min(8, Number(maxPlayers) || 8)
      ),
      createdAt: Date.now(),
      messages: [],
      draftRound: 0,
      draftPick: 0,
      picksDone: 0,
    };

    games.set(id, game);

    leaveCurrentRoom(socket, client);

    client.gameId = id;
    client.watching = false;

    socket.join(id);

    addSystemMessage(
      game,
      `${host.name} heeft de lobby aangemaakt.`
    );

    // De bijgewerkte App.tsx wacht op dit event.
    socket.emit("game-created", {
      gameId: id,
    });

    emitState();
  });

  // Een open lobby binnenkomen.
  socket.on("join-game", ({ gameId } = {}) => {
    const client = getClient(socket);
    const game = games.get(String(gameId || ""));

    if (!client) {
      return notify(
        socket,
        "Kies eerst een spelersnaam."
      );
    }

    if (!game) {
      return notify(socket, "Game niet gevonden.");
    }

    // Als deze speler al deelnemer is, koppel de verbinding opnieuw.
    const existingPlayer = game.players.find(
      (player) => player.id === client.playerId
    );

    if (existingPlayer) {
      leaveCurrentRoom(socket, client);

      existingPlayer.connected = true;
      existingPlayer.socketId = socket.id;

      client.gameId = game.id;
      client.watching = false;

      socket.join(game.id);

      socket.emit("game-joined", {
        gameId: game.id,
      });

      emitState();
      return;
    }

    if (game.status !== "lobby") {
      return notify(
        socket,
        "Deze draft is al bezig. Open de game als toeschouwer."
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
      hand: [],
      picks: [],
      booster: [],
    };

    leaveCurrentRoom(socket, client);

    game.players.push(player);

    client.gameId = game.id;
    client.watching = false;

    socket.join(game.id);

    addSystemMessage(
      game,
      `${player.name} is de lobby binnengekomen.`
    );

    socket.emit("game-joined", {
      gameId: game.id,
    });

    emitState();
  });

  // Een actieve of afgelopen game als toeschouwer openen.
  socket.on("watch-game", ({ gameId } = {}) => {
    const client = getClient(socket);
    const game = games.get(String(gameId || ""));

    if (!client) {
      return notify(
        socket,
        "Kies eerst een spelersnaam."
      );
    }

    if (!game) {
      return notify(socket, "Game niet gevonden.");
    }

    const existingPlayer = game.players.find(
      (player) => player.id === client.playerId
    );

    leaveCurrentRoom(socket, client);

    client.gameId = game.id;
    client.watching = !existingPlayer;

    if (existingPlayer) {
      existingPlayer.connected = true;
      existingPlayer.socketId = socket.id;
    }

    socket.join(game.id);

    socket.emit("game-joined", {
      gameId: game.id,
      watching: client.watching,
    });

    emitState();
  });

  // Stemmen op de set en het aantal boosters.
  socket.on(
    "vote",
    ({ gameId, setCode, boosterCount } = {}) => {
      const client = getClient(socket);
      const game = games.get(String(gameId || ""));

      if (!client || !game || game.status !== "lobby") {
        return;
      }

      const player = getPlayer(socket, game);

      if (!player) {
        return notify(
          socket,
          "Join eerst deze lobby om te stemmen."
        );
      }

      if (
        setCode &&
        allowedSets.some((set) => set.code === setCode)
      ) {
        player.voteSet = setCode;
      }

      const count = Number(boosterCount);

      if (allowedBoosterCounts.includes(count)) {
        player.voteBoosters = count;
      }

      emitState();
    }
  );

  // Lobbychat en gamechat.
  // Deelnemers en toeschouwers mogen chatten in de game die zij open hebben.
  socket.on("chat-message", ({ gameId, text } = {}) => {
    const client = getClient(socket);
    const game = games.get(String(gameId || ""));

    if (!client || !game) {
      return;
    }

    if (client.gameId !== game.id) {
      return notify(
        socket,
        "Open eerst deze game om te chatten."
      );
    }

    const message = String(text || "")
      .trim()
      .slice(0, 500);

    if (!message) {
      return;
    }

    const player = getPlayer(socket, game);

    const name = player
      ? player.name
      : client.watching
        ? client.playerName
        : null;

    if (!name) {
      return;
    }

    addChatMessage(game, name, message);

    io.to(game.id).emit(
      "game-message",
      publicGame(game)
    );

    emitState();
  });

  // De host start de draft.
  socket.on("start-game", ({ gameId } = {}) => {
    const game = games.get(String(gameId || ""));

    if (!game) {
      return;
    }

    const player = getPlayer(socket, game);

    if (!player?.isHost || game.status !== "lobby") {
      return notify(
        socket,
        "Alleen de host kan de draft starten."
      );
    }

    if (game.players.length < 2) {
      return notify(
        socket,
        "Je hebt minimaal 2 spelers nodig. Open de game in een tweede browser om te testen."
      );
    }

    const setVotes = {};
    const boosterVotes = {};

    for (const member of game.players) {
      if (member.voteSet) {
        setVotes[member.voteSet] =
          (setVotes[member.voteSet] || 0) + 1;
      }

      if (member.voteBoosters) {
        const key = String(member.voteBoosters);

        boosterVotes[key] =
          (boosterVotes[key] || 0) + 1;
      }
    }

    // Bij een gelijkspel wint de standaardinstelling als die
    // een van de opties met de meeste stemmen is.
    const winningSet = chooseWinner(
      setVotes,
      game.setCode
    );

    const winningBoosterCount = Number(
      chooseWinner(
        boosterVotes,
        String(game.boosterCount),
        true
      )
    );

    game.setCode = winningSet;

    game.setName =
      allowedSets.find(
        (set) => set.code === winningSet
      )?.name || game.setName;

    game.boosterCount =
      allowedBoosterCounts.includes(winningBoosterCount)
        ? winningBoosterCount
        : 3;

    game.status = "drafting";
    game.draftRound = 1;
    game.draftPick = 1;
    game.picksDone = 0;

    for (const member of game.players) {
      member.hand = [];
      member.picks = [];
      member.booster = [];
    }

    addSystemMessage(
      game,
      `Draft gestart: ${game.setName}, ${game.boosterCount} booster(s) per speler.`
    );

    io.to(game.id).emit("draft-started", {
      gameId: game.id,
      setCode: game.setCode,
      boosterCount: game.boosterCount,
    });

    emitState();
  });

  // Een booster met kaarten ophalen via Scryfall.
  socket.on(
    "request-booster",
    async ({ gameId } = {}) => {
      const game = games.get(String(gameId || ""));

      if (!game || game.status !== "drafting") {
        return;
      }

      const player = getPlayer(socket, game);

      if (!player) {
        return notify(
          socket,
          "Alleen deelnemers kunnen kaarten laden."
        );
      }

      try {
        const query = `set:${game.setCode} game:paper`;

        const response = await fetch(
          `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=set&unique=cards`,
          {
            headers: {
              "User-Agent": "DraftArena/1.1",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(15000),
          }
        );

        if (!response.ok) {
          throw new Error(
            `Scryfall returned ${response.status}`
          );
        }

        const data = await response.json();

        const sourceCards = (data.data || []).filter(
          (card) =>
            card.image_uris ||
            card.card_faces?.some(
              (face) => face.image_uris
            )
        );

        if (sourceCards.length === 0) {
          throw new Error("No image cards available");
        }

        // MVP: een willekeurige selectie van maximaal 15 kaarten.
        // Dit is nog geen officiële Magic-booster.
        const shuffledCards = [...sourceCards];

        for (let i = shuffledCards.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledCards[i], shuffledCards[j]] = [
            shuffledCards[j],
            shuffledCards[i],
          ];
        }

        const cards = shuffledCards
          .slice(0, 15)
          .map((card) => {
            const face = card.card_faces?.[0];

            return {
              id: card.id,
              name: card.name,
              image:
                card.image_uris?.normal ||
                face?.image_uris?.normal ||
                null,
              small:
                card.image_uris?.small ||
                face?.image_uris?.small ||
                null,
              mana_cost:
                card.mana_cost ||
                face?.mana_cost ||
                "",
              type_line: card.type_line || "",
              oracle_text:
                card.oracle_text ||
                face?.oracle_text ||
                "",
            };
          });

        player.booster = cards;

        socket.emit("booster", {
          gameId: game.id,
          cards,
          round: game.draftRound,
          pick: game.draftPick,
        });
      } catch (error) {
        console.error(
          "Booster laden mislukt:",
          error.message
        );

        notify(
          socket,
          "Kon geen booster laden via Scryfall. Probeer het straks opnieuw."
        );
      }
    }
  );

  // Een kaart kiezen uit de persoonlijke booster.
  socket.on("pick-card", ({ gameId, cardId } = {}) => {
    const game = games.get(String(gameId || ""));

    if (!game || game.status !== "drafting") {
      return;
    }

    const player = getPlayer(socket, game);

    if (!player) {
      return notify(
        socket,
        "Je bent geen speler in deze draft."
      );
    }

    const index = player.booster.findIndex(
      (card) => card.id === cardId
    );

    if (index < 0) {
      return notify(
        socket,
        "Deze kaart zit niet meer in jouw booster."
      );
    }

    const [pickedCard] = player.booster.splice(index, 1);

    player.picks.push(pickedCard);
    game.picksDone += 1;
    game.draftPick += 1;

    addChatMessage(
      game,
      player.name,
      `kiest ${pickedCard.name}.`
    );

    if (player.booster.length === 0) {
      player.hand = [...player.picks];

      addSystemMessage(
        game,
        `${player.name} heeft deze booster afgerond (${player.picks.length} kaarten).`
      );
    }

    socket.emit("pick-confirmed", {
      card: pickedCard,
      remaining: player.booster.length,
      picks: player.picks,
    });

    emitState();
  });

  // Alleen de host mag de game beëindigen.
  socket.on("end-game", ({ gameId } = {}) => {
    const game = games.get(String(gameId || ""));

    if (!game) {
      return;
    }

    const player = getPlayer(socket, game);

    if (!player?.isHost) {
      return notify(
        socket,
        "Alleen de host kan de game beëindigen."
      );
    }

    if (game.status === "finished") {
      return;
    }

    game.status = "finished";

    addSystemMessage(
      game,
      `${player.name} heeft de game beëindigd.`
    );

    io.to(game.id).emit("game-finished", {
      gameId: game.id,
    });

    emitState();
  });

  // Verbinding weggevallen.
  socket.on("disconnect", (reason) => {
    const client = getClient(socket);

    if (client?.gameId) {
      const game = games.get(client.gameId);

      if (game) {
        const player = game.players.find(
          (member) =>
            member.id === client.playerId
        );

        if (player) {
          player.connected = false;
        }

        addSystemMessage(
          game,
          `${client.playerName || "Een speler"} heeft de verbinding verloren.`
        );
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
// Start server
// --------------------------------------------------

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Draft Arena server listening on port ${PORT}`
  );
});
