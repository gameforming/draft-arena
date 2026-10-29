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
const io = new Server(httpServer, { cors: { origin: "*" }, pingTimeout: 20000, pingInterval: 25000 });
const PORT = Number(process.env.PORT) || 3001;
const games = new Map();
const clients = new Map();
const setCache = new Map();
const cardPoolCache = new Map();
const basicLandCache = new Map();
const SET_CACHE_MS = 60 * 60 * 1000;
const CARD_CACHE_MS = 30 * 60 * 1000;
const BOOSTER_SIZE = 14;
const BOOSTER_COUNTS = [1, 2, 3, 4, 5, 6];
const COLORS = ["W", "U", "B", "R", "G", "C"];
const COLOR_NAMES = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest", C: "Colorless" };
const BASIC_LANDS = ["Plains", "Island", "Swamp", "Mountain", "Forest"];
const FALLBACK_SETS = [
  { code: "ltr", name: "The Lord of the Rings: Tales of Middle-earth" },
  { code: "woe", name: "Wilds of Eldraine" },
  { code: "mkm", name: "Murders at Karlov Manor" },
  { code: "mh3", name: "Modern Horizons 3" },
  { code: "dsk", name: "Duskmourn: House of Horror" },
  { code: "fdn", name: "Foundations" },
];
let setCatalog = [...FALLBACK_SETS];
let setCatalogUpdatedAt = 0;
let setCatalogPromise = null;

function id() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36); }
function shuffle(list) { const result = [...list]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
function emptyMana() { return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }; }
function emptyLands() { return Object.fromEntries(BASIC_LANDS.map((name) => [name, 0])); }
function notify(socket, message) { socket.emit("notice", message); }
function getClient(socket) { return clients.get(socket.id); }
function getSet(code) { return setCatalog.find((s) => s.code === String(code || "").toLowerCase()); }
function isLand(card) { return /\bland\b/i.test(card?.type_line || ""); }
function isCreature(card) { return /\bcreature\b/i.test(card?.type_line || ""); }
function isInstantOrSorcery(card) { return /\binstant\b|\bsorcery\b/i.test(card?.type_line || ""); }
function hasKeyword(card, keyword) { return (card?.keywords || []).some((k) => String(k).toLowerCase() === keyword.toLowerCase()) || new RegExp(`\\b${keyword}\\b`, "i").test(card?.oracle_text || ""); }
function getPlayer(socket, game) {
  const client = getClient(socket);
  if (!client || client.gameId !== game.id || client.watching) return null;
  return game.players.find((p) => p.id === client.playerId) || null;
}
function getPlayerById(game, playerId) { return game.players.find((p) => p.id === playerId); }
function addMessage(game, name, text, system = false) {
  game.messages.push({ id: id(), name: system ? "Arena" : name, text: String(text).slice(0, 500), at: Date.now(), system });
  if (game.messages.length > 150) game.messages.shift();
}
function systemMessage(game, text) { addMessage(game, "Arena", text, true); }
function leaveRoom(socket, client) { if (client?.gameId) socket.leave(client.gameId); if (client) { client.gameId = null; client.watching = false; } }
function chooseWinner(votes, fallback) {
  const rows = Object.entries(votes);
  if (!rows.length) return String(fallback);
  const max = Math.max(...rows.map(([, count]) => count));
  const ties = rows.filter(([, count]) => count === max).map(([key]) => key).sort();
  return ties.includes(String(fallback)) ? String(fallback) : ties[0];
}
function getVoteTotals(game) {
  const sets = {}; const boosters = {};
  for (const p of game.players) {
    if (p.voteSet) sets[p.voteSet] = (sets[p.voteSet] || 0) + 1;
    if (p.voteBoosters) { const key = String(p.voteBoosters); boosters[key] = (boosters[key] || 0) + 1; }
  }
  return { sets, boosters };
}
function cloneCard(card) { return { ...card, faces: card.faces ? card.faces.map((f) => ({ ...f })) : [], instanceId: card.instanceId || id() }; }
function publicPermanent(permanent) { return { ...permanent }; }
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, ready: Boolean(p.ready), isHost: Boolean(p.isHost), connected: p.connected !== false,
    hasPicked: Boolean(p.hasPicked), picksCount: p.picks.length, deckReady: Boolean(p.deckReady),
    life: p.life ?? 20, handCount: p.hand?.length ?? 0, libraryCount: p.library?.length ?? 0,
    battlefield: (p.battlefield || []).map(publicPermanent), graveyard: (p.graveyard || []).map((c) => ({ ...c })),
    exile: (p.exile || []).map((c) => ({ ...c })), manaPool: { ...(p.manaPool || emptyMana()) }, landPlayed: Boolean(p.landPlayed),
    mulliganStatus: p.mulliganStatus || "", eliminated: Boolean(p.eliminated),
  };
}
function publicGame(game) {
  const match = game.match ? {
    phase: game.match.phase, combatStep: game.match.combatStep, turnNumber: game.match.turnNumber,
    activePlayerId: game.match.activePlayerId, startingPlayerId: game.match.startingPlayerId,
    attacks: game.match.attacks, blockers: game.match.blockers, blockingPlayerIds: game.match.blockingPlayerIds,
    winnerId: game.match.winnerId, winnerName: game.match.winnerName,
  } : null;
  return {
    id: game.id, title: game.title, status: game.status, setCode: game.setCode, setName: game.setName,
    boosterCount: game.boosterCount, hostName: game.hostName, players: game.players.map(publicPlayer), maxPlayers: game.maxPlayers,
    createdAt: game.createdAt, votes: getVoteTotals(game), messages: game.messages.slice(-60), draftRound: game.draftRound || 0,
    draftPick: game.draftPick || 0, picksDone: game.picksDone || 0, direction: game.direction || null,
    pickProgress: game.players.filter((p) => p.hasPicked).length, match,
    kickVotes: Object.fromEntries(Object.entries(game.kickVotes || {}).map(([targetId, voters]) => [targetId, Array.isArray(voters) ? voters.length : 0])),
  };
}
function emitState() { io.emit("state", { games: [...games.values()].map(publicGame), sets: setCatalog }); }
function socketForPlayer(player) { return player.socketId ? io.sockets.sockets.get(player.socketId) : null; }
function sendPrivateState(game, player) {
  const socket = socketForPlayer(player); if (!socket) return;
  if (game.status === "drafting" || game.status === "deckbuilding" || game.status === "loading-match") {
    socket.emit("draft-private-state", {
      gameId: game.id, status: game.status, booster: player.booster || [], picks: player.picks || [],
      basicLands: player.basicLands || emptyLands(), deckReady: Boolean(player.deckReady),
      deckSelection: player.deckSelection || player.picks.map((c) => c.instanceId), hasPicked: Boolean(player.hasPicked),
      round: game.draftRound || 0, boosterCount: game.boosterCount, pick: game.draftPick || 0,
      direction: game.direction || null,
    });
  }
  if (["mulligan", "playing", "finished"].includes(game.status) && game.match) {
    socket.emit("match-private-state", {
      gameId: game.id, status: game.status, hand: player.hand || [], picks: player.picks || [],
      libraryCount: player.library?.length || 0, manaPool: player.manaPool || emptyMana(),
      landPlayed: Boolean(player.landPlayed), basicLands: player.basicLands || emptyLands(),
      mulligansTaken: player.mulligansTaken || 0, bottomNeeded: player.bottomNeeded || 0,
      mulliganStatus: player.mulliganStatus || "", deckReady: Boolean(player.deckReady),
      deckSelection: player.deckSelection || [], deckCount: player.deck?.length || 0,
    });
  }
}
function sendAllPrivateStates(game) { for (const p of game.players) sendPrivateState(game, p); }

// --------------------- Set catalog ---------------------
async function loadSetCatalog(force = false) {
  if (!force && Date.now() - setCatalogUpdatedAt < SET_CACHE_MS) return setCatalog;
  if (setCatalogPromise) return setCatalogPromise;
  setCatalogPromise = (async () => {
    try {
      const response = await fetch("https://api.scryfall.com/sets", { headers: { "User-Agent": "DraftArena/3.0", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Scryfall sets HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.data)) throw new Error("Ongeldige setcatalogus");
      const eligibleTypes = new Set(["core", "expansion", "masters", "draft_innovation"]);
      const filtered = data.data.filter((set) => {
        const size = Number(set.printed_size || set.card_count || 0);
        return eligibleTypes.has(set.set_type) && set.digital !== true && !set.parent_set_code && size >= 200;
      });
      const result = filtered.map((set) => ({ code: String(set.code).toLowerCase(), name: set.name, released_at: set.released_at || null, set_type: set.set_type || null, card_count: Number(set.card_count || 0), printed_size: Number(set.printed_size || 0) })).sort((a, b) => String(b.released_at || "").localeCompare(String(a.released_at || "")) || a.name.localeCompare(b.name));
      if (result.length) setCatalog = result;
      setCatalogUpdatedAt = Date.now();
      emitState();
    } catch (error) {
      console.error("Setcatalogus laden mislukt:", error.message);
    } finally { setCatalogPromise = null; }
    return setCatalog;
  })();
  return setCatalogPromise;
}

// --------------------- Scryfall cards ---------------------
async function searchScryfall(query, maxCards = 700) {
  let url = new URL("https://api.scryfall.com/cards/search");
  url.searchParams.set("q", query); url.searchParams.set("order", "set"); url.searchParams.set("unique", "cards");
  const cards = []; const seen = new Set();
  for (let page = 0; url && page < 8 && cards.length < maxCards; page++) {
    const response = await fetch(url, { headers: { "User-Agent": "DraftArena/3.0", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (response.status === 404) break;
    if (!response.ok) throw new Error(`Scryfall search HTTP ${response.status}`);
    const data = await response.json();
    for (const raw of data.data || []) {
      if (!raw.id || seen.has(raw.id)) continue;
      if (!(raw.image_uris || raw.card_faces?.some((f) => f.image_uris))) continue;
      seen.add(raw.id); cards.push(raw); if (cards.length >= maxCards) break;
    }
    if (!data.has_more || !data.next_page || cards.length >= maxCards) break;
    const next = new URL(data.next_page); if (next.hostname !== "api.scryfall.com") throw new Error("Ongeldige Scryfall-vervolgpagina"); url = next;
  }
  return cards;
}
function normalizeCard(raw) {
  const faces = (raw.card_faces || []).map((face) => ({
    name: face.name || raw.name, image: face.image_uris?.normal || face.image_uris?.large || null,
    small: face.image_uris?.small || null, mana_cost: face.mana_cost || "", type_line: face.type_line || "",
    oracle_text: face.oracle_text || "", power: face.power ?? null, toughness: face.toughness ?? null,
    colors: face.colors || [], loyalty: face.loyalty || null,
  }));
  const firstFace = faces[0];
  return {
    id: raw.id, name: raw.name, image: raw.image_uris?.normal || firstFace?.image || null,
    small: raw.image_uris?.small || firstFace?.small || null, mana_cost: raw.mana_cost || firstFace?.mana_cost || "",
    type_line: raw.type_line || faces.map((f) => f.type_line).filter(Boolean).join(" // "),
    oracle_text: raw.oracle_text || faces.map((f) => f.oracle_text).filter(Boolean).join(" // "),
    rarity: raw.rarity || "common", layout: raw.layout || "normal", faces, power: raw.power ?? firstFace?.power ?? null,
    toughness: raw.toughness ?? firstFace?.toughness ?? null, loyalty: raw.loyalty ?? firstFace?.loyalty ?? null,
    cmc: Number(raw.cmc || 0), colors: raw.colors || firstFace?.colors || [], color_identity: raw.color_identity || [],
    keywords: raw.keywords || [], set: raw.set || "", basicLandName: null,
  };
}
async function loadCardPool(setCode) {
  const cached = cardPoolCache.get(setCode);
  if (cached && Date.now() - cached.at < CARD_CACHE_MS) return cached.cards;
  let raw = await searchScryfall(`set:${setCode} game:paper is:booster`);
  let cards = raw.map(normalizeCard).filter((c) => c.image);
  if (cards.length < 200) {
    raw = await searchScryfall(`set:${setCode} game:paper`);
    cards = raw.map(normalizeCard).filter((c) => c.image);
  }
  const unique = [...new Map(cards.map((c) => [c.id, c])).values()];
  if (unique.length < 200) throw new Error(`Set ${setCode} heeft maar ${unique.length} bruikbare kaarten; kies een grotere set.`);
  cardPoolCache.set(setCode, { cards: unique, at: Date.now() });
  return unique;
}
function fallbackBasicLand(name) {
  const manaByName = {
    Plains: "W",
    Island: "U",
    Swamp: "B",
    Mountain: "R",
    Forest: "G",
  };
  const mana = manaByName[name];
  if (!mana) throw new Error(`Onbekend basic land: ${name}`);

  // The gameplay engine only needs the card's identity, type, and mana text.
  // A null image is valid: the GUI displays a readable placeholder instead.
  return {
    id: `draft-arena-basic-${name.toLowerCase()}`,
    name,
    image: null,
    small: null,
    mana_cost: "",
    type_line: `Basic Land — ${name}`,
    oracle_text: `{T}: Add {${mana}}.`,
    rarity: "common",
    layout: "normal",
    faces: [],
    power: null,
    toughness: null,
    loyalty: null,
    cmc: 0,
    colors: [mana],
    color_identity: [mana],
    keywords: [],
    set: "basic",
    basicLandName: name,
  };
}

async function loadBasicLand(name) {
  if (!BASIC_LANDS.includes(name)) throw new Error(`Onbekend basic land: ${name}`);
  if (basicLandCache.has(name)) return basicLandCache.get(name);

  const result = (async () => {
    try {
      const raw = await searchScryfall(`t:basic name:${name} game:paper`, 10);
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const card = raw
        .map(normalizeCard)
        .find((candidate) => candidate.image && new RegExp(`\\b${escapedName}\\b`, "i").test(candidate.type_line || ""));
      if (card) {
        card.basicLandName = name;
        return card;
      }
      console.warn(`Scryfall gaf geen afbeelding voor ${name}; lokale basic-land fallback wordt gebruikt.`);
    } catch (error) {
      console.warn(`Basic land ${name} kon niet via Scryfall worden geladen; lokale fallback wordt gebruikt: ${error.message}`);
    }

    return fallbackBasicLand(name);
  })();

  // Cache the promise so concurrent players do not trigger five duplicate searches.
  basicLandCache.set(name, result);
  try {
    return await result;
  } catch (error) {
    basicLandCache.delete(name);
    throw error;
  }
}

function buildBooster(pool) {
  const chosen = []; const used = new Set();
  function add(source, amount) {
    for (const card of shuffle(source.filter((c) => !used.has(c.id)))) {
      if (amount <= 0 || chosen.length >= BOOSTER_SIZE) break;
      chosen.push({ ...card, instanceId: id() }); used.add(card.id); amount--;
    }
  }
  add(pool.filter((c) => c.rarity === "common"), 10);
  add(pool.filter((c) => c.rarity === "uncommon"), 3);
  add(pool.filter((c) => c.rarity === "rare" || c.rarity === "mythic"), 1);
  add(pool, BOOSTER_SIZE - chosen.length);
  if (chosen.length !== BOOSTER_SIZE) throw new Error(`Kon geen booster van ${BOOSTER_SIZE} kaarten maken.`);
  return shuffle(chosen);
}

// --------------------- Mana and game rules ---------------------
function cardPower(card) {
  const raw = card?.power ?? card?.faces?.[card.faceIndex || 0]?.power ?? 0;
  const number = Number.parseInt(String(raw), 10);
  return Number.isFinite(number) ? number + Number(card.powerMod || 0) : Number(card.powerMod || 0);
}
function cardToughness(card) {
  const raw = card?.toughness ?? card?.faces?.[card.faceIndex || 0]?.toughness ?? 0;
  const number = Number.parseInt(String(raw), 10);
  return Number.isFinite(number) ? number + Number(card.toughnessMod || 0) : Number(card.toughnessMod || 0);
}
function activeFaceCard(card, faceIndex = 0) {
  if (!card.faces?.length || !card.faces[faceIndex]) return { ...card, faceIndex };
  const face = card.faces[faceIndex];
  return { ...card, faceIndex, name: face.name, image: face.image || card.image, small: face.small || card.small, mana_cost: face.mana_cost || card.mana_cost, type_line: face.type_line || card.type_line, oracle_text: face.oracle_text || card.oracle_text, power: face.power ?? card.power, toughness: face.toughness ?? card.toughness, loyalty: face.loyalty ?? card.loyalty };
}
function availableManaChoices(permanent) {
  const card = permanent.card || permanent;
  const basic = card.basicLandName || BASIC_LANDS.find((name) => new RegExp(`\\b${name}\\b`, "i").test(card.type_line || ""));
  if (basic) {
    const mapping = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };
    return [mapping[basic]];
  }
  const text = card.oracle_text || "";
  if (/add one mana of any color/i.test(text)) return ["W", "U", "B", "R", "G"];
  const choices = [...text.matchAll(/add(?:s)?\s+(?:one\s+)?(?:mana\s+)?\{([WUBRGC])\}/gi)].map((m) => m[1].toUpperCase());
  return [...new Set(choices)];
}
function parseManaCost(cost) {
  const tokens = [...String(cost || "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1].toUpperCase());
  const colored = emptyMana(); const hybrids = []; let generic = 0;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) { generic += Number(token); continue; }
    if (token === "X" || token === "Y" || token === "Z") continue;
    if (COLORS.includes(token) && token !== "C") { colored[token]++; continue; }
    if (token === "C") { colored.C++; continue; }
    if (token.includes("/")) { hybrids.push(token.split("/")); continue; }
  }
  return { colored, hybrids, generic };
}
function payMana(pool, cost) {
  const parsed = parseManaCost(cost);
  const next = { ...pool };
  for (const color of ["W", "U", "B", "R", "G", "C"]) {
    if (next[color] < parsed.colored[color]) return null;
    next[color] -= parsed.colored[color];
  }
  let generic = parsed.generic;
  for (const options of parsed.hybrids) {
    const coloredOptions = options.filter((o) => COLORS.includes(o));
    const available = coloredOptions.find((color) => next[color] > 0);
    if (available) { next[available]--; continue; }
    const numericOption = options.find((o) => /^\d+$/.test(o));
    if (numericOption) { generic += Number(numericOption); continue; }
    return null;
  }
  const total = COLORS.reduce((sum, color) => sum + next[color], 0);
  if (total < generic) return null;
  let remaining = generic;
  for (const color of ["C", "W", "U", "B", "R", "G"]) {
    const take = Math.min(next[color], remaining);
    next[color] -= take; remaining -= take;
    if (remaining === 0) break;
  }
  return next;
}
function cardHasType(card, word) { return new RegExp(`\\b${word}\\b`, "i").test(card?.type_line || ""); }
function clonePermanent(card, controllerId, turnNumber, faceIndex = 0) {
  const resolved = activeFaceCard(card, faceIndex);
  return {
    ...resolved, permanentId: id(), instanceId: card.instanceId || id(), controllerId,
    tapped: false, summoningSick: cardHasType(resolved, "creature"), enteredTurn: turnNumber,
    damageMarked: 0, deathtouchDamage: false, powerMod: 0, toughnessMod: 0,
    faceIndex, attacking: false, blocking: false,
  };
}
function drawCards(player, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (!player.library.length) return { drawn, failed: true };
    drawn.push(player.library.shift());
  }
  player.hand.push(...drawn);
  return { drawn, failed: false };
}
function shuffleIntoLibrary(player, cards) {
  player.library = shuffle([...player.library, ...cards]);
}
function gameMatchState(game) {
  return game.match || null;
}
function sendPrivateMatchState(game, player) { sendPrivateState(game, player); }
function isActivePlayer(game, player) { return game.match?.activePlayerId === player.id && !player.eliminated; }
function setPhase(game, phase, combatStep = null) {
  game.match.phase = phase; game.match.combatStep = combatStep;
  for (const p of game.players) p.manaPool = emptyMana();
}
function opponents(game, player) { return game.players.filter((p) => p.id !== player.id && !p.eliminated); }
function checkWin(game) {
  if (!game.match || !["playing", "mulligan"].includes(game.status)) return;
  for (const p of game.players) {
    if (p.life <= 0) p.eliminated = true;
  }
  const remaining = game.players.filter((p) => !p.eliminated);
  if (remaining.length <= 1) {
    game.status = "finished";
    game.match.phase = "finished";
    game.match.winnerId = remaining[0]?.id || null;
    game.match.winnerName = remaining[0]?.name || "Gelijkspel";
    systemMessage(game, remaining[0] ? `${remaining[0].name} wint de game!` : "De game eindigt in gelijkspel.");
    io.to(game.id).emit("match-finished", { gameId: game.id, winnerId: game.match.winnerId, winnerName: game.match.winnerName });
    sendAllPrivateStates(game);
    emitState();
  }
}
function sweepDeadCreatures(game) {
  for (const owner of game.players) {
    const kept = [];
    for (const perm of owner.battlefield) {
      const dead = cardHasType(perm, "creature") && (cardToughness(perm) <= 0 || perm.deathtouchDamage || perm.damageMarked >= cardToughness(perm));
      if (dead) {
        owner.graveyard.push({ ...perm, tapped: false, damageMarked: 0 });
        systemMessage(game, `${perm.name} gaat naar de graveyard.`);
      } else kept.push(perm);
    }
    owner.battlefield = kept;
  }
  checkWin(game);
}
function addLife(game, player, amount) { if (!player || player.eliminated) return; player.life += amount; }
function startTurn(game, player, firstTurn = false) {
  if (!player || player.eliminated) return advanceToNextTurn(game);
  game.match.turnNumber += 1;
  game.match.activePlayerId = player.id;
  game.match.combatStep = null;
  game.match.attacks = [];
  game.match.blockers = [];
  game.match.blockingPlayerIds = [];
  game.match.phase = "main1";
  for (const p of game.players) {
    p.manaPool = emptyMana();
    if (p.id !== player.id) continue;
    p.landPlayed = false;
    for (const perm of p.battlefield) {
      perm.tapped = false;
      perm.attacking = false;
      perm.blocking = false;
      if (cardHasType(perm, "creature") && perm.enteredTurn < game.match.turnNumber) perm.summoningSick = false;
    }
  }
  const skipDraw = game.players.length === 2 && game.match.turnNumber === 1 && player.id === game.match.startingPlayerId;
  if (!skipDraw) {
    const result = drawCards(player, 1);
    if (result.failed) {
      player.eliminated = true;
      systemMessage(game, `${player.name} verliest omdat er geen kaart meer in de library ligt.`);
      checkWin(game);
      if (game.status !== "playing") { sendAllPrivateStates(game); emitState(); return; }
      return advanceToNextTurn(game);
    }
  }
  systemMessage(game, `Beurt ${game.match.turnNumber}: ${player.name} speelt. Hoofdfase 1.`);
  sendAllPrivateStates(game); emitState();
}
function advanceToNextTurn(game) {
  for (const owner of game.players) {
    for (const permanent of owner.battlefield) {
      permanent.damageMarked = 0;
      permanent.deathtouchDamage = false;
      permanent.powerMod = 0;
      permanent.toughnessMod = 0;
    }
  }
  const alive = game.players.filter((p) => !p.eliminated);
  if (alive.length <= 1) { checkWin(game); return; }
  const currentIndex = game.players.findIndex((p) => p.id === game.match.activePlayerId);
  let next;
  for (let i = 1; i <= game.players.length; i++) {
    const candidate = game.players[(currentIndex + i) % game.players.length];
    if (candidate && !candidate.eliminated) { next = candidate; break; }
  }
  if (!next) { checkWin(game); return; }
  startTurn(game, next, false);
}
function progressMulligan(game) {
  if (game.status !== "mulligan") return;
  const readyStatuses = new Set(["kept", "bottoming", "bottomed"]);
  if (!game.players.every((p) => readyStatuses.has(p.mulliganStatus))) return;
  const needsBottom = game.players.some((p) => p.bottomNeeded > 0 && p.mulliganStatus !== "bottomed");
  if (needsBottom) {
    for (const p of game.players) {
      if (p.bottomNeeded > 0 && p.mulliganStatus === "kept") p.mulliganStatus = "bottoming";
    }
    sendAllPrivateStates(game); emitState(); return;
  }
  if (!game.players.every((p) => ["kept", "bottomed"].includes(p.mulliganStatus))) return;
  game.match.mulliganComplete = true;
  game.status = "playing";
  const starter = getPlayerById(game, game.match.startingPlayerId) || game.players[0];
  systemMessage(game, `${starter.name} begint. Beide spelers houden hun openingshand.`);
  startTurn(game, starter, true);
}
function resolveSpell(game, caster, card, payload) {
  const text = String(card.oracle_text || "");
  const lower = text.toLowerCase();
  const targetPlayer = getPlayerById(game, payload.targetPlayerId);
  const targetOwner = game.players.find((p) => p.battlefield.some((perm) => perm.permanentId === payload.targetPermanentId));
  const targetPermanent = targetOwner?.battlefield.find((perm) => perm.permanentId === payload.targetPermanentId);
  let handled = false;
  const numberWords = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const drawMatch = lower.match(/draw (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards?/);
  if (drawMatch) {
    const n = Number(drawMatch[1]) || numberWords[drawMatch[1]] || 1;
    const result = drawCards(caster, Math.min(10, n));
    if (result.failed) { caster.eliminated = true; systemMessage(game, `${caster.name} verliest door een lege library.`); checkWin(game); }
    handled = true;
  }
  const gainMatch = lower.match(/you gain (\d+) life/);
  if (gainMatch) { addLife(game, caster, Number(gainMatch[1])); handled = true; }
  const damageMatch = lower.match(/deals? (\d+) damage to (?:any target|target creature|target player|target opponent)/);
  if (damageMatch) {
    const damage = Number(damageMatch[1]);
    if (targetPermanent && cardHasType(targetPermanent, "creature")) {
      targetPermanent.damageMarked += damage;
      sweepDeadCreatures(game);
      handled = true;
    } else if (targetPlayer && !targetPlayer.eliminated && /target player|target opponent|any target/.test(damageMatch[0])) {
      targetPlayer.life -= damage; checkWin(game); handled = true;
    }
  }
  if (/destroy target creature/.test(lower) && targetPermanent && cardHasType(targetPermanent, "creature")) {
    targetOwner.battlefield = targetOwner.battlefield.filter((p) => p.permanentId !== targetPermanent.permanentId);
    targetOwner.graveyard.push(targetPermanent); handled = true;
  }
  if (/exile target creature/.test(lower) && targetPermanent && cardHasType(targetPermanent, "creature")) {
    targetOwner.battlefield = targetOwner.battlefield.filter((p) => p.permanentId !== targetPermanent.permanentId);
    targetOwner.exile.push(targetPermanent); handled = true;
  }
  const buffMatch = lower.match(/target creature gets ([+-]\d+)\/([+-]\d+)/);
  if (buffMatch && targetPermanent && cardHasType(targetPermanent, "creature")) {
    targetPermanent.powerMod = Number(targetPermanent.powerMod || 0) + Number(buffMatch[1]);
    targetPermanent.toughnessMod = Number(targetPermanent.toughnessMod || 0) + Number(buffMatch[2]);
    handled = true;
  }
  if (!handled) {
    systemMessage(game, `“${card.name}” is gespeeld; dit kaart-effect wordt nog niet automatisch uitgevoerd.`);
  } else {
    systemMessage(game, `${caster.name} lost ${card.name} op.`);
  }
}
function finishCombat(game) {
  const match = game.match;
  if (!match || match.resolvingCombat) return;
  match.resolvingCombat = true;
  try {
    const attacks = match.attacks || [];
    for (const attack of attacks) {
      const attackerOwner = game.players.find((p) => p.battlefield.some((perm) => perm.permanentId === attack.attackerId));
      const attacker = attackerOwner?.battlefield.find((perm) => perm.permanentId === attack.attackerId);
      const defender = getPlayerById(game, attack.defenderId);
      if (!attacker || !defender || defender.eliminated) continue;
      const blockers = match.blockers.filter((b) => b.attackerId === attack.attackerId).map((b) => {
        const owner = game.players.find((p) => p.battlefield.some((perm) => perm.permanentId === b.blockerId));
        return { owner, permanent: owner?.battlefield.find((perm) => perm.permanentId === b.blockerId) };
      }).filter((b) => b.owner && b.permanent);
      const attackerPower = Math.max(0, cardPower(attacker));
      const attackerDeathtouch = hasKeyword(attacker, "deathtouch");
      if (!blockers.length) {
        defender.life -= attackerPower;
        if (hasKeyword(attacker, "lifelink")) addLife(game, attackerOwner, attackerPower);
        continue;
      }
      let remaining = attackerPower;
      for (const block of blockers) {
        if (remaining <= 0) break;
        const toughness = Math.max(1, cardToughness(block.permanent));
        const lethal = attackerDeathtouch ? 1 : Math.max(0, toughness - block.permanent.damageMarked);
        const dealt = Math.min(remaining, Math.max(1, lethal));
        block.permanent.damageMarked += dealt;
        if (attackerDeathtouch && dealt > 0) block.permanent.deathtouchDamage = true;
        remaining -= dealt;
      }
      if (remaining > 0 && hasKeyword(attacker, "trample")) defender.life -= remaining;
      if (hasKeyword(attacker, "lifelink")) addLife(game, attackerOwner, attackerPower);
      let blockerDamage = 0;
      for (const block of blockers) {
        const power = Math.max(0, cardPower(block.permanent));
        attacker.damageMarked += power;
        if (hasKeyword(block.permanent, "deathtouch") && power > 0) attacker.deathtouchDamage = true;
        if (hasKeyword(block.permanent, "lifelink")) addLife(game, block.owner, power);
        blockerDamage += power;
      }
      if (blockerDamage > 0 && hasKeyword(attacker, "lifelink")) addLife(game, attackerOwner, 0);
    }
    sweepDeadCreatures(game);
    if (game.status !== "playing") return;
    for (const owner of game.players) {
      for (const permanent of owner.battlefield) {
        permanent.attacking = false;
        permanent.blocking = false;
      }
    }
    match.attacks = []; match.blockers = []; match.blockingPlayerIds = [];
    setPhase(game, "main2", null);
    systemMessage(game, "Gevecht afgerond. Tweede hoofdfase.");
    sendAllPrivateStates(game); emitState();
  } finally { match.resolvingCombat = false; }
}

// --------------------- HTTP API ---------------------
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "draft-arena", games: games.size, sets: setCatalog.length }));
app.get("/api/sets", async (_req, res) => { await loadSetCatalog(); res.set("Cache-Control", "public, max-age=3600"); res.json(setCatalog); });
app.get("/api/cards/:id", async (req, res) => {
  const cardId = String(req.params.id || "");
  if (!/^[a-f0-9-]{20,45}$/i.test(cardId)) return res.status(400).json({ error: "Invalid Scryfall ID" });
  try { const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(cardId)}`, { headers: { "User-Agent": "DraftArena/3.0", Accept: "application/json" }, signal: AbortSignal.timeout(10000) }); res.status(response.status).set("Cache-Control", "public, max-age=300").send(await response.text()); }
  catch (error) { console.error(error.message); res.status(502).json({ error: "Scryfall tijdelijk niet bereikbaar." }); }
});
app.get("/api/card-search", async (req, res) => {
  const query = String(req.query.q || "").slice(0, 160);
  if (!query) return res.status(400).json({ error: "Missing q" });
  try { const response = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": "DraftArena/3.0", Accept: "application/json" }, signal: AbortSignal.timeout(10000) }); res.status(response.status).set("Cache-Control", "public, max-age=300").send(await response.text()); }
  catch (error) { console.error(error.message); res.status(502).json({ error: "Scryfall tijdelijk niet bereikbaar." }); }
});
app.get("/api/image", async (req, res) => {
  let url; try { url = new URL(String(req.query.url || "")); } catch { return res.status(400).send("Invalid image URL"); }
  if (url.protocol !== "https:" || !["cards.scryfall.io", "c1.scryfall.com", "c2.scryfall.com", "c3.scryfall.com"].includes(url.hostname)) return res.status(400).send("Image host not allowed");
  try { const response = await fetch(url, { headers: { "User-Agent": "DraftArena/3.0" }, signal: AbortSignal.timeout(15000) }); if (!response.ok) return res.status(response.status).send("Image unavailable"); res.set("Content-Type", response.headers.get("content-type") || "image/jpeg").set("Cache-Control", "public, max-age=3600").set("X-Content-Type-Options", "nosniff").send(Buffer.from(await response.arrayBuffer())); }
  catch (error) { console.error(error.message); res.status(502).send("Image proxy failed"); }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../client/dist");
app.use(express.static(clientDist));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API endpoint not found" });
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.sendFile(path.join(clientDist, "index.html"), (error) => { if (error) next(error); });
});

// --------------------- Socket.IO / lobby ---------------------
function removeLobbyPlayer(game, player, reason = "heeft de lobby verlaten") {
  if (!game || game.status !== "lobby" || !player) return false;

  const playerSocket = socketForPlayer(player);
  if (playerSocket) {
    const playerClient = getClient(playerSocket);
    playerSocket.leave(game.id);
    playerSocket.emit("game-left", { gameId: game.id, reason });
    if (playerClient?.gameId === game.id) {
      playerClient.gameId = null;
      playerClient.watching = false;
    }
  }

  game.players = game.players.filter((item) => item.id !== player.id);
  if (game.kickVotes) {
    delete game.kickVotes[player.id];
    for (const targetId of Object.keys(game.kickVotes)) {
      game.kickVotes[targetId] = game.kickVotes[targetId].filter((voterId) => voterId !== player.id);
      if (!game.kickVotes[targetId].length) delete game.kickVotes[targetId];
    }
  }

  if (!game.players.length) {
    games.delete(game.id);
    emitState();
    return true;
  }

  if (!game.players.some((item) => item.isHost)) {
    game.players[0].isHost = true;
    game.players[0].ready = true;
    game.hostName = game.players[0].name;
  }

  systemMessage(game, `${player.name} ${reason}.`);
  emitState();
  return true;
}

io.on("connection", (socket) => {
  socket.emit("state", { games: [...games.values()].map(publicGame), sets: setCatalog });

  socket.on("join-arena", ({ playerName } = {}) => {
    const prev = getClient(socket); const name = String(playerName || "Player").trim().slice(0, 24) || "Player";
    const client = { playerId: prev?.playerId || id(), playerName: name, gameId: prev?.gameId || null, watching: prev?.watching || false };
    clients.set(socket.id, client);
    for (const game of games.values()) {
      const p = game.players.find((item) => item.id === client.playerId);
      if (p) { p.name = name; p.socketId = socket.id; p.connected = true; if (p.isHost) game.hostName = name; sendPrivateState(game, p); }
    }
    socket.emit("identity", { playerId: client.playerId, playerName: name }); emitState();
  });
  socket.on("rename-player", ({ playerName } = {}) => {
    const client = getClient(socket); if (!client) return notify(socket, "Kies eerst een spelersnaam.");
    const name = String(playerName || "").trim().slice(0, 24); if (!name) return notify(socket, "De spelersnaam mag niet leeg zijn.");
    client.playerName = name;
    for (const game of games.values()) { const p = game.players.find((x) => x.id === client.playerId); if (p) { p.name = name; if (p.isHost) game.hostName = name; } }
    socket.emit("identity", { playerId: client.playerId, playerName: name }); emitState();
  });
  socket.on("create-game", ({ title, maxPlayers } = {}) => {
    const client = getClient(socket); if (!client) return notify(socket, "Kies eerst een spelersnaam.");
    const idGame = id(); const defaultSet = getSet("ltr") || FALLBACK_SETS[0];
    const host = makePlayer(client.playerId, client.playerName, true, socket.id);
    const game = { id: idGame, title: String(title || `${client.playerName}'s draft`).trim().slice(0, 50) || `${client.playerName}'s draft`, status: "lobby", setCode: defaultSet.code, setName: defaultSet.name, boosterCount: 3, hostName: client.playerName, players: [host], maxPlayers: Math.max(2, Math.min(8, Number(maxPlayers) || 8)), createdAt: Date.now(), messages: [], draftRound: 0, draftPick: 0, picksDone: 0, direction: null, cardPool: [], match: null, matchInitializing: false, resolving: false };
    games.set(idGame, game); leaveRoom(socket, client); client.gameId = idGame; client.watching = false; socket.join(idGame);
    systemMessage(game, `${host.name} heeft de lobby aangemaakt.`); socket.emit("game-created", { gameId: idGame }); sendPrivateState(game, host); emitState();
  });
  socket.on("join-game", ({ gameId } = {}) => {
    const client = getClient(socket); const game = games.get(String(gameId || ""));
    if (!client) return notify(socket, "Kies eerst een spelersnaam."); if (!game) return notify(socket, "Game niet gevonden.");
    const existing = game.players.find((p) => p.id === client.playerId);
    if (existing) { leaveRoom(socket, client); client.gameId = game.id; client.watching = false; existing.connected = true; existing.socketId = socket.id; socket.join(game.id); socket.emit("game-joined", { gameId: game.id }); sendPrivateState(game, existing); emitState(); return; }
    if (game.status !== "lobby") return notify(socket, "Deze game is al gestart."); if (game.players.length >= game.maxPlayers) return notify(socket, "Deze lobby is vol.");
    const player = makePlayer(client.playerId, client.playerName, false, socket.id); game.players.push(player); leaveRoom(socket, client); client.gameId = game.id; client.watching = false; socket.join(game.id);
    systemMessage(game, `${player.name} is de lobby binnengekomen.`); socket.emit("game-joined", { gameId: game.id }); sendPrivateState(game, player); emitState();
  });
  socket.on("leave-game", ({ gameId } = {}) => {
    const client = getClient(socket);
    if (!client) return notify(socket, "Je bent nog niet aangemeld.");
    const game = games.get(String(gameId || client.gameId || ""));
    if (!game) {
      leaveRoom(socket, client);
      socket.emit("game-left", { gameId: gameId || null });
      emitState();
      return;
    }
    if (game.status !== "lobby") {
      return notify(socket, "Je kunt de lobby alleen verlaten voordat de draft start. Tijdens een match kun je opgeven.");
    }
    const player = game.players.find((item) => item.id === client.playerId);
    if (player) {
      removeLobbyPlayer(game, player, "heeft de lobby verlaten");
    } else {
      socket.leave(game.id);
      leaveRoom(socket, client);
    }
    client.gameId = null;
    client.watching = false;
    socket.emit("game-left", { gameId: game.id });
    emitState();
  });

  socket.on("vote-kick", ({ gameId, targetPlayerId } = {}) => {
    const game = games.get(String(gameId || ""));
    if (!game || game.status !== "lobby") return notify(socket, "Stemmen om iemand te verwijderen kan alleen in de lobby.");
    const voter = getPlayer(socket, game);
    if (!voter) return notify(socket, "Join eerst de lobby om te stemmen.");
    if (game.players.length < 3) return notify(socket, "Er moeten minimaal drie spelers in de lobby zijn om iemand weg te stemmen.");
    const target = game.players.find((item) => item.id === String(targetPlayerId || ""));
    if (!target) return notify(socket, "Deze speler zit niet meer in de lobby.");
    if (target.id === voter.id) return notify(socket, "Je kunt niet op jezelf stemmen.");
    if (!target.connected) return notify(socket, "Deze speler is niet verbonden; wacht tot die opnieuw verbindt of verlaat de lobby.");

    if (!game.kickVotes) game.kickVotes = {};
    if (!Array.isArray(game.kickVotes[target.id])) game.kickVotes[target.id] = [];
    const votes = game.kickVotes[target.id];
    if (votes.includes(voter.id)) {
      return notify(socket, `Je hebt al op ${target.name} gestemd.`);
    }
    votes.push(voter.id);

    const eligibleVoters = game.players.filter((item) => item.id !== target.id && item.connected !== false);
    const needed = Math.floor(eligibleVoters.length / 2) + 1;
    const voteCount = votes.filter((voterId) => eligibleVoters.some((item) => item.id === voterId)).length;
    systemMessage(game, `${voter.name} heeft gestemd om ${target.name} te verwijderen (${voteCount}/${needed}).`);

    if (voteCount >= needed) {
      removeLobbyPlayer(game, target, "is door een meerderheid uit de lobby gestemd");
      socket.emit("notice", `${target.name} is uit de lobby verwijderd.`);
    } else {
      emitState();
    }
  });

  socket.on("watch-game", ({ gameId } = {}) => {
    const client = getClient(socket); const game = games.get(String(gameId || "")); if (!client) return notify(socket, "Kies eerst een spelersnaam."); if (!game) return notify(socket, "Game niet gevonden.");
    const existing = game.players.find((p) => p.id === client.playerId); leaveRoom(socket, client); client.gameId = game.id; client.watching = !existing; socket.join(game.id);
    socket.emit("game-joined", { gameId: game.id, watching: client.watching }); if (existing) { existing.connected = true; existing.socketId = socket.id; sendPrivateState(game, existing); } emitState();
  });
  socket.on("vote", async ({ gameId, setCode, boosterCount } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "lobby") return; const p = getPlayer(socket, game); if (!p) return notify(socket, "Join eerst deze lobby om te stemmen.");
    await loadSetCatalog(); const code = String(setCode || "").toLowerCase(); if (getSet(code)) p.voteSet = code; const count = Number(boosterCount); if (BOOSTER_COUNTS.includes(count)) p.voteBoosters = count; emitState();
  });
  socket.on("chat-message", ({ gameId, text } = {}) => {
    const client = getClient(socket); const game = games.get(String(gameId || "")); if (!client || !game || client.gameId !== game.id) return;
    const msg = String(text || "").trim().slice(0, 500); if (!msg) return; const p = getPlayer(socket, game); const name = p?.name || (client.watching ? client.playerName : null); if (!name) return;
    addMessage(game, name, msg); io.to(game.id).emit("game-message", publicGame(game)); emitState();
  });

  // --------------------- Draft ---------------------
  socket.on("start-game", async ({ gameId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "lobby") return; const host = getPlayer(socket, game);
    if (!host?.isHost) return notify(socket, "Alleen de host kan de draft starten."); if (game.players.length < 2) return notify(socket, "Minimaal twee spelers zijn nodig.");
    await loadSetCatalog(); const sets = {}; const boosters = {};
    for (const p of game.players) { if (p.voteSet) sets[p.voteSet] = (sets[p.voteSet] || 0) + 1; if (p.voteBoosters) { const k = String(p.voteBoosters); boosters[k] = (boosters[k] || 0) + 1; } }
    const chosenSet = chooseWinner(sets, game.setCode); if (!getSet(chosenSet)) return notify(socket, "Deze set is niet beschikbaar.");
    game.setCode = chosenSet; game.setName = getSet(chosenSet).name; const count = Number(chooseWinner(boosters, String(game.boosterCount))); game.boosterCount = BOOSTER_COUNTS.includes(count) ? count : 3; game.status = "loading-draft"; emitState();
    try {
      game.cardPool = await loadCardPool(game.setCode);
      for (const p of game.players) { p.picks = []; p.booster = []; p.hasPicked = false; p.basicLands = emptyLands(); p.deckSelection = []; p.deckReady = false; }
      game.status = "drafting"; game.draftRound = 1; game.picksDone = 0; game.draftPick = 1; systemMessage(game, `Draft gestart: ${game.setName}. Boosters bevatten ${BOOSTER_SIZE} kaarten.`); startBoosterRound(game);
    } catch (error) { game.status = "lobby"; emitState(); notify(socket, `Draft starten mislukt: ${error.message}`); }
  });
  socket.on("pick-card", ({ gameId, cardId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "drafting") return; const p = getPlayer(socket, game); if (!p) return notify(socket, "Je bent geen speler in deze draft.");
    if (p.hasPicked) return notify(socket, "Je hebt al gekozen. Wacht tot de booster wordt doorgegeven.");
    const index = p.booster.findIndex((c) => c.instanceId === cardId); if (index < 0) return notify(socket, "Deze kaart zit niet in je huidige booster.");
    const [card] = p.booster.splice(index, 1); p.picks.push(card); p.hasPicked = true; game.picksDone++;
    addMessage(game, "Arena", `${p.name} heeft een kaart gekozen.`, true); sendPrivateState(game, p); emitState(); resolveDraftPick(game);
  });
  socket.on("set-basic-lands", ({ gameId, lands } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "deckbuilding") return; const p = getPlayer(socket, game); if (!p) return notify(socket, "Alleen een speler kan lands aanpassen.");
    const next = emptyLands(); for (const name of BASIC_LANDS) next[name] = Math.max(0, Math.min(60, Math.floor(Number(lands?.[name]) || 0)));
    if (Object.values(next).reduce((a, b) => a + b, 0) > 100) return notify(socket, "Maximaal 100 basic lands."); p.basicLands = next; p.deckReady = false; sendPrivateState(game, p); emitState();
  });
  socket.on("submit-deck", ({ gameId, cardIds, lands } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "deckbuilding") return; const p = getPlayer(socket, game); if (!p) return;
    const selected = Array.isArray(cardIds) ? [...new Set(cardIds)].filter((key) => p.picks.some((c) => c.instanceId === key)) : p.picks.map((c) => c.instanceId);
    const nextLands = emptyLands(); for (const name of BASIC_LANDS) nextLands[name] = Math.max(0, Math.min(60, Math.floor(Number(lands?.[name] ?? p.basicLands[name]) || 0)));
    const totalLands = Object.values(nextLands).reduce((a, b) => a + b, 0); if (totalLands > 100) return notify(socket, "Maximaal 100 basic lands.");
    const total = selected.length + totalLands; if (total < 40) return notify(socket, `Je deck heeft ${total} kaarten. Voeg ${40 - total} kaarten of basic lands toe (minimum 40).`);
    p.basicLands = nextLands; p.deckSelection = selected; p.deckReady = true; sendPrivateState(game, p); emitState();
    systemMessage(game, `${p.name} heeft deckbuilding afgerond (${total} kaarten).`); beginMatch(game);
  });

  // --------------------- Mulligan ---------------------
  socket.on("take-mulligan", ({ gameId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "mulligan") return; const p = getPlayer(socket, game); if (!p || p.mulliganStatus !== "deciding") return;
    if (p.mulligansTaken >= 7) return notify(socket, "Je kunt geen verdere mulligan nemen.");
    if (game.players.length <= 2 || p.mulligansTaken > 0) p.bottomNeeded++;
    p.mulligansTaken++;
    shuffleIntoLibrary(p, p.hand); p.hand = []; drawCards(p, Math.min(7, p.library.length));
    systemMessage(game, `${p.name} neemt mulligan nummer ${p.mulligansTaken}.`); sendPrivateState(game, p); emitState();
  });
  socket.on("keep-hand", ({ gameId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "mulligan") return; const p = getPlayer(socket, game); if (!p || p.mulliganStatus !== "deciding") return;
    p.mulliganStatus = "kept"; systemMessage(game, `${p.name} houdt de openingshand.`); progressMulligan(game); sendPrivateState(game, p); emitState();
  });
  socket.on("submit-bottom", ({ gameId, cardIds } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "mulligan") return; const p = getPlayer(socket, game); if (!p || p.mulliganStatus !== "bottoming") return;
    const wanted = Array.isArray(cardIds) ? [...new Set(cardIds)] : []; if (wanted.length !== p.bottomNeeded) return notify(socket, `Kies precies ${p.bottomNeeded} kaarten om onderop te leggen.`);
    const selected = []; for (const key of wanted) { const idx = p.hand.findIndex((c) => c.instanceId === key); if (idx < 0) return notify(socket, "Een geselecteerde kaart zit niet meer in je hand."); selected.push(p.hand[idx]); }
    p.hand = p.hand.filter((c) => !wanted.includes(c.instanceId)); p.library.push(...selected); p.mulliganStatus = "bottomed"; sendPrivateState(game, p); emitState(); progressMulligan(game);
  });

  // --------------------- Match gameplay ---------------------
  socket.on("toggle-permanent-tap", ({ gameId, permanentId } = {}) => {
    const game = games.get(String(gameId || ""));
    if (!game || game.status !== "playing") return;
    const p = getPlayer(socket, game);
    if (!p || p.eliminated) return notify(socket, "Je kunt deze kaart nu niet aanpassen.");
    const permanent = p.battlefield.find((item) => item.permanentId === String(permanentId || ""));
    if (!permanent) return notify(socket, "Deze kaart staat niet op jouw slagveld.");
    permanent.tapped = !permanent.tapped;
    if (!permanent.tapped) {
      permanent.attacking = false;
      permanent.blocking = false;
    }
    systemMessage(game, `${p.name} ${permanent.tapped ? "tapt" : "untapt"} ${permanent.name}.`);
    emitState();
  });

  socket.on("tap-land", ({ gameId, permanentId, color } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "playing") return; const p = getPlayer(socket, game); if (!p || p.eliminated) return notify(socket, "Je kunt nu geen mana maken.");
    const perm = p.battlefield.find((x) => x.permanentId === permanentId); if (!perm || !isLand(perm)) return notify(socket, "Dit is geen land."); if (perm.tapped) return notify(socket, "Dit land is al getapt.");
    const choices = availableManaChoices(perm); if (!choices.length) return notify(socket, "Dit land heeft geen automatisch herkende mana-vaardigheid.");
    const chosen = choices.includes(color) ? color : choices[0]; perm.tapped = true; p.manaPool[chosen] = (p.manaPool[chosen] || 0) + 1;
    systemMessage(game, `${p.name} tapt ${perm.name} voor ${chosen}.`); sendPrivateState(game, p); emitState();
  });
  socket.on("play-card", ({ gameId, cardId, faceIndex = 0, targetPlayerId, targetPermanentId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "playing") return; const p = getPlayer(socket, game); if (!p) return;
    const currentPlayerTurn = isActivePlayer(game, p); const rawIndex = p.hand.findIndex((c) => c.instanceId === cardId); if (rawIndex < 0) return notify(socket, "Deze kaart zit niet in je hand.");
    const source = p.hand[rawIndex]; const card = activeFaceCard(source, Math.max(0, Number(faceIndex) || 0));
    if (isLand(card)) {
      if (!currentPlayerTurn || !["main1", "main2"].includes(game.match.phase) || game.match.combatStep) return notify(socket, "Je mag een land alleen in je eigen hoofdfase spelen.");
      if (p.landPlayed) return notify(socket, "Je hebt dit beurt al een land gespeeld.");
      p.hand.splice(rawIndex, 1); p.battlefield.push(clonePermanent(card, p.id, game.match.turnNumber, Number(faceIndex) || 0)); p.landPlayed = true;
      systemMessage(game, `${p.name} speelt ${card.name}.`); sendPrivateState(game, p); emitState(); return;
    }
    const canUseMainPhase = currentPlayerTurn && ["main1", "main2"].includes(game.match.phase) && !game.match.combatStep;
    const instantSpeed = /\binstant\b/i.test(card.type_line || "") || hasKeyword(card, "flash");
    if (!canUseMainPhase && !instantSpeed) return notify(socket, "Speel deze kaart tijdens je eigen hoofdfase; instants/flash kunnen ook buiten je beurt.");
    const paid = payMana(p.manaPool, card.mana_cost);
    if (!paid) return notify(socket, `Onvoldoende mana voor ${card.name}. Tap eerst geschikte landen.`);
    p.manaPool = paid; p.hand.splice(rawIndex, 1);
    if (isInstantOrSorcery(card)) {
      resolveSpell(game, p, card, { targetPlayerId, targetPermanentId }); p.graveyard.push(card);
    } else {
      p.battlefield.push(clonePermanent(card, p.id, game.match.turnNumber, Number(faceIndex) || 0));
      systemMessage(game, `${p.name} speelt ${card.name}.`);
    }
    sweepDeadCreatures(game); sendPrivateState(game, p); emitState();
  });
  socket.on("transform-permanent", ({ gameId, permanentId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "playing") return; const p = getPlayer(socket, game); if (!p || !isActivePlayer(game, p) || !["main1", "main2"].includes(game.match.phase)) return;
    const perm = p.battlefield.find((c) => c.permanentId === permanentId); if (!perm || !["transform", "modal_dfc", "double_faced_token"].includes(perm.layout) || (perm.faces?.length || 0) < 2) return notify(socket, "Deze permanente kaart kan niet worden geflipt.");
    perm.faceIndex = (perm.faceIndex + 1) % perm.faces.length; const face = perm.faces[perm.faceIndex]; perm.name = face.name; perm.image = face.image || perm.image; perm.small = face.small || perm.small; perm.type_line = face.type_line || perm.type_line; perm.oracle_text = face.oracle_text || perm.oracle_text; perm.power = face.power ?? perm.power; perm.toughness = face.toughness ?? perm.toughness; perm.mana_cost = face.mana_cost || perm.mana_cost;
    systemMessage(game, `${p.name} draait ${perm.name} om.`); emitState();
  });
  socket.on("advance-phase", ({ gameId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "playing") return; const p = getPlayer(socket, game); if (!p || !isActivePlayer(game, p)) return notify(socket, "Alleen de actieve speler kan de fase beëindigen.");
    const m = game.match;
    if (m.phase === "main1") { setPhase(game, "combat", "attackers"); systemMessage(game, `${p.name} begint het gevecht: declare attackers.`); }
    else if (m.phase === "main2") { setPhase(game, "end", null); systemMessage(game, `${p.name} gaat naar de eindfase.`); }
    else if (m.phase === "end") { advanceToNextTurn(game); return; }
    else if (m.phase === "combat" && m.combatStep === "attackers") { m.attacks = []; setPhase(game, "main2", null); systemMessage(game, `${p.name} valt niet aan. Tweede hoofdfase.`); }
    else return notify(socket, "Rond eerst de huidige gevechtsstap af.");
    sendAllPrivateStates(game); emitState();
  });
  socket.on("declare-attackers", ({ gameId, attacks: submittedAttacks, attackerIds, targetPlayerId } = {}) => {
    const game = games.get(String(gameId || ""));
    if (!game || game.status !== "playing") return;
    const player = getPlayer(socket, game);
    const match = game.match;
    if (!player || !isActivePlayer(game, player) || match.phase !== "combat" || match.combatStep !== "attackers") {
      return notify(socket, "Je kunt nu geen aanvallers aanwijzen.");
    }

    let candidates = Array.isArray(submittedAttacks) ? submittedAttacks : null;
    if (!candidates) {
      const ids = Array.isArray(attackerIds) ? attackerIds : [];
      candidates = ids.map((attackerId) => ({ attackerId, defenderId: targetPlayerId }));
    }

    const validated = [];
    for (const candidate of candidates) {
      const permanent = player.battlefield.find((item) => item.permanentId === candidate.attackerId);
      const defender = getPlayerById(game, candidate.defenderId);
      if (!permanent || !isCreature(permanent) || permanent.tapped || permanent.attacking) continue;
      if (permanent.summoningSick && !hasKeyword(permanent, "haste")) continue;
      if (!defender || defender.id === player.id || defender.eliminated) continue;
      permanent.attacking = true;
      if (!hasKeyword(permanent, "vigilance")) permanent.tapped = true;
      validated.push({ attackerId: permanent.permanentId, attackerControllerId: player.id, defenderId: defender.id });
    }

    match.attacks = validated;
    match.blockers = [];
    match.blockingPlayerIds = [...new Set(validated.map((attack) => attack.defenderId))];
    if (!validated.length) {
      setPhase(game, "main2", null);
      systemMessage(game, `${player.name} valt niet aan. Tweede hoofdfase.`);
    } else {
      match.combatStep = "blockers";
      const names = match.blockingPlayerIds.map((pid) => getPlayerById(game, pid)?.name || "speler").join(", ");
      systemMessage(game, `${player.name} valt aan. Verdedigende speler(s): ${names}.`);
    }
    sendAllPrivateStates(game);
    emitState();
  });
  socket.on("assign-blockers", ({ gameId, assignments } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "playing") return; const p = getPlayer(socket, game); const m = game.match;
    if (!p || m.phase !== "combat" || m.combatStep !== "blockers" || !m.blockingPlayerIds.includes(p.id)) return notify(socket, "Je bent nu niet de verdedigende speler.");
    const input = Array.isArray(assignments) ? assignments : []; const usedBlockers = new Set(); const valid = [];
    for (const item of input) {
      const blocker = p.battlefield.find((x) => x.permanentId === item.blockerId);
      const attack = m.attacks.find((a) => a.attackerId === item.attackerId && a.defenderId === p.id);
      const attackerOwner = game.players.find((owner) => owner.battlefield.some((x) => x.permanentId === item.attackerId));
      const attacker = attackerOwner?.battlefield.find((x) => x.permanentId === item.attackerId);
      if (!blocker || !isCreature(blocker) || blocker.tapped || usedBlockers.has(blocker.permanentId) || !attack || !attacker) continue;
      if (hasKeyword(attacker, "flying") && !hasKeyword(blocker, "flying") && !hasKeyword(blocker, "reach")) continue;
      usedBlockers.add(blocker.permanentId); blocker.blocking = true;
      valid.push({ blockerId: blocker.permanentId, blockerControllerId: p.id, attackerId: attacker.permanentId });
    }
    m.blockers = m.blockers.filter((b) => b.blockerControllerId !== p.id).concat(valid);
    m.blockingPlayerIds = m.blockingPlayerIds.filter((pid) => pid !== p.id);
    systemMessage(game, `${p.name} heeft blockers aangewezen.`);
    if (!m.blockingPlayerIds.length) finishCombat(game); else { sendAllPrivateStates(game); emitState(); }
  });
  socket.on("concede", ({ gameId } = {}) => {
    const game = games.get(String(gameId || "")); if (!game || game.status !== "playing") return; const p = getPlayer(socket, game); if (!p) return;
    p.eliminated = true; p.life = 0; systemMessage(game, `${p.name} geeft op.`); checkWin(game); if (game.status === "playing") { if (game.match.activePlayerId === p.id) advanceToNextTurn(game); else { emitState(); sendAllPrivateStates(game); } } else { emitState(); sendAllPrivateStates(game); }
  });
  socket.on("disconnect", (reason) => {
    const client = getClient(socket);
    if (client?.gameId) {
      const game = games.get(client.gameId);
      if (game) {
        const p = game.players.find((x) => x.id === client.playerId);
        if (p) {
          p.connected = false;
          systemMessage(game, `${p.name} heeft de verbinding verloren.`);
          if (game.status === "drafting") resolveDraftPick(game);
          if (game.status === "playing" && game.match?.phase === "combat" && game.match.combatStep === "blockers" && game.match.blockingPlayerIds.includes(p.id)) {
            game.match.blockingPlayerIds = game.match.blockingPlayerIds.filter((pid) => pid !== p.id);
            if (!game.match.blockingPlayerIds.length) finishCombat(game);
          }
        }
      }
    }
    clients.delete(socket.id); console.log(`Socket disconnected: ${socket.id} (${reason})`); emitState();
  });
});

function makePlayer(playerId, name, isHost, socketId) {
  return {
    id: playerId, name, isHost, ready: isHost, connected: true, socketId,
    voteSet: null, voteBoosters: null, booster: [], picks: [], hasPicked: false,
    basicLands: emptyLands(), deckSelection: [], deckReady: false, deck: [],
    hand: [], library: [], battlefield: [], graveyard: [], exile: [], life: 20,
    manaPool: emptyMana(), landPlayed: false, mulligansTaken: 0, bottomNeeded: 0,
    mulliganStatus: "", eliminated: false,
  };
}
function startBoosterRound(game) {
  game.draftPick = 1; game.direction = game.draftRound % 2 === 1 ? "left" : "right";
  for (const p of game.players) { p.booster = buildBooster(game.cardPool); p.hasPicked = false; }
  systemMessage(game, `Booster ${game.draftRound}/${game.boosterCount} gestart. Doorgeven naar ${game.direction === "left" ? "links" : "rechts"}.`);
  io.to(game.id).emit("draft-round-started", { gameId: game.id, round: game.draftRound, boosterCount: game.boosterCount, direction: game.direction, cardsPerBooster: BOOSTER_SIZE });
  sendAllPrivateStates(game); emitState();
}
function finishDraft(game) {
  game.status = "deckbuilding"; game.direction = null;
  for (const p of game.players) { p.booster = []; p.hasPicked = false; p.deckSelection = p.picks.map((c) => c.instanceId); p.deckReady = false; if (!p.basicLands) p.basicLands = emptyLands(); }
  systemMessage(game, "Draft afgerond. Bouw je deck van minimaal 40 kaarten en voeg basic lands toe.");
  io.to(game.id).emit("draft-finished", { gameId: game.id, boosterCount: game.boosterCount });
  sendAllPrivateStates(game); emitState();
}
function resolveDraftPick(game) {
  if (game.status !== "drafting" || game.resolving) return;
  for (const p of game.players) {
    if (p.connected === false && !p.hasPicked && p.booster.length) {
      const [card] = p.booster.splice(Math.floor(Math.random() * p.booster.length), 1); p.picks.push(card); p.hasPicked = true; game.picksDone++;
    }
  }
  if (!game.players.every((p) => p.hasPicked || p.booster.length === 0)) return;
  game.resolving = true;
  try {
    if (game.players.every((p) => p.booster.length === 0)) {
      if (game.draftRound < game.boosterCount) { game.draftRound++; startBoosterRound(game); }
      else finishDraft(game);
      return;
    }
    const packs = game.players.map((p) => p.booster); const n = game.players.length;
    game.players.forEach((p, index) => { const target = game.direction === "left" ? (index + 1) % n : (index - 1 + n) % n; game.players[target].booster = packs[index]; });
    for (const p of game.players) p.hasPicked = false;
    game.draftPick++; sendAllPrivateStates(game); emitState();
  } finally { game.resolving = false; }
}
function beginMatch(game) {
  if (game.matchInitializing || game.status !== "deckbuilding" || !game.players.every((p) => p.deckReady)) return;
  game.matchInitializing = true; game.status = "loading-match"; emitState();
  (async () => {
    try {
      for (const p of game.players) {
        const deck = (p.deckSelection || []).map((key) => p.picks.find((c) => c.instanceId === key)).filter(Boolean).map(cloneCard);
        for (const name of BASIC_LANDS) {
          const count = p.basicLands[name] || 0; if (!count) continue; const base = await loadBasicLand(name);
          for (let n = 0; n < count; n++) {
            const mana = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" }[name];
            deck.push({ ...cloneCard(base), id: `${base.id}-${id()}`, instanceId: id(), name, basicLandName: name, type_line: `Basic Land — ${name}`, mana_cost: "", oracle_text: `{T}: Add {${mana}}.`, rarity: "common", power: null, toughness: null });
          }
        }
        if (deck.length < 40) throw new Error(`${p.name} heeft ${deck.length} kaarten; minimaal 40 is nodig.`);
        p.deck = deck; p.library = shuffle(deck.map(cloneCard)); p.hand = []; p.battlefield = []; p.graveyard = []; p.exile = []; p.life = 20; p.manaPool = emptyMana(); p.landPlayed = false; p.mulligansTaken = 0; p.bottomNeeded = 0; p.mulliganStatus = "deciding"; p.eliminated = false;
        drawCards(p, Math.min(7, p.library.length));
      }
      const starter = game.players[Math.floor(Math.random() * game.players.length)];
      game.match = { phase: "mulligan", combatStep: null, turnNumber: 0, activePlayerId: null, startingPlayerId: starter.id, attacks: [], blockers: [], blockingPlayerIds: [], winnerId: null, winnerName: null, mulliganComplete: false, resolvingCombat: false };
      game.status = "mulligan"; systemMessage(game, "Decks klaar. Kies mulligan of houd je openingshand."); sendAllPrivateStates(game); emitState();
    } catch (error) {
      console.error("Match voorbereiden mislukt:", error.message); game.status = "deckbuilding"; for (const p of game.players) p.deckReady = false; systemMessage(game, `Match kon niet starten: ${error.message}`); emitState(); sendAllPrivateStates(game);
    } finally { game.matchInitializing = false; }
  })();
}

loadSetCatalog().catch((error) => console.error("Initiële setcatalogus laden mislukt:", error.message));
httpServer.listen(PORT, "0.0.0.0", () => console.log(`Draft Arena server listening on port ${PORT}`));
