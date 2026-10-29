import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import {
  ArrowLeft,
  ArrowLeftRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Flag,
  Hand,
  Heart,
  Layers,
  LoaderCircle,
  MessageCircle,
  Minus,
  Mountain,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Shield,
  Sparkles,
  Swords,
  Users,
  Vote,
  X,
} from "lucide-react";

const SERVER = typeof window !== "undefined" ? window.location.origin : "";

const BASIC_LANDS = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;
type BasicLand = (typeof BASIC_LANDS)[number];
type BasicLands = Record<BasicLand, number>;
const EMPTY_LANDS: BasicLands = {
  Plains: 0,
  Island: 0,
  Swamp: 0,
  Mountain: 0,
  Forest: 0,
};

const COLORS = ["W", "U", "B", "R", "G", "C"] as const;
type ManaColor = (typeof COLORS)[number];
type ManaPool = Record<ManaColor, number>;
const EMPTY_MANA: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
const MANA_LABEL: Record<ManaColor, string> = {
  W: "Wit",
  U: "Blauw",
  B: "Zwart",
  R: "Rood",
  G: "Groen",
  C: "Kleurloos",
};

interface SetInfo {
  code: string;
  name: string;
  released_at?: string | null;
  set_type?: string | null;
  card_count?: number;
  printed_size?: number;
}

const FALLBACK_SETS: SetInfo[] = [
  { code: "ltr", name: "The Lord of the Rings: Tales of Middle-earth" },
  { code: "woe", name: "Wilds of Eldraine" },
  { code: "mkm", name: "Murders at Karlov Manor" },
  { code: "mh3", name: "Modern Horizons 3" },
  { code: "dsk", name: "Duskmourn: House of Horror" },
  { code: "fdn", name: "Foundations" },
];

interface CardFace {
  name?: string;
  image?: string | null;
  small?: string | null;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string | number | null;
  toughness?: string | number | null;
  loyalty?: string | number | null;
  colors?: string[];
}

interface Card {
  id: string;
  instanceId: string;
  name: string;
  image: string | null;
  small?: string | null;
  mana_cost: string;
  type_line: string;
  oracle_text: string;
  rarity?: string;
  layout?: string;
  faces?: CardFace[];
  power?: string | number | null;
  toughness?: string | number | null;
  loyalty?: string | number | null;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  set?: string;
  basicLandName?: BasicLand | null;
  permanentId?: string;
  tapped?: boolean;
  summoningSick?: boolean;
  damageMarked?: number;
  toughnessMod?: number;
  faceIndex?: number;
  controllerId?: string;
}

interface Player {
  id: string;
  name: string;
  ready?: boolean;
  isHost?: boolean;
  connected?: boolean;
  hasPicked?: boolean;
  picksCount?: number;
  deckReady?: boolean;
  life?: number;
  handCount?: number;
  libraryCount?: number;
  battlefield?: Card[];
  graveyard?: Card[];
  exile?: Card[];
  manaPool?: ManaPool;
  landPlayed?: boolean;
  mulliganStatus?: string;
  eliminated?: boolean;
}

interface GameMessage {
  id: string;
  name: string;
  text: string;
  at: number;
  system?: boolean;
}

interface VoteTotals {
  sets: Record<string, number>;
  boosters: Record<string, number>;
}

interface VoteKickState {
  targetPlayerId: string;
  initiatedBy: string;
  yesVotes: string[];
  noVotes: string[];
  required: number;
}

interface Attack {
  attackerId: string;
  attackerControllerId: string;
  defenderId: string;
}

interface MatchState {
  phase: string;
  combatStep: string | null;
  turnNumber: number;
  activePlayerId: string | null;
  startingPlayerId?: string | null;
  attacks: Attack[];
  blockers?: unknown[];
  blockingPlayerIds: string[];
  winnerId?: string | null;
  winnerName?: string | null;
}

interface Game {
  id: string;
  title: string;
  status: string;
  setCode: string;
  setName: string;
  boosterCount: number;
  hostName: string;
  players: Player[];
  maxPlayers: number;
  createdAt?: number;
  votes: VoteTotals;
  messages: GameMessage[];
  draftRound: number;
  draftPick: number;
  picksDone: number;
  direction?: string | null;
  pickProgress?: number;
  voteKick?: VoteKickState | null;
  match: MatchState | null;
}

interface DraftPrivate {
  gameId: string;
  status: string;
  booster: Card[];
  picks: Card[];
  basicLands?: BasicLands;
  deckReady: boolean;
  deckSelection?: string[];
  hasPicked: boolean;
  round: number;
  boosterCount: number;
  pick: number;
  direction: string | null;
}

interface MatchPrivate {
  gameId: string;
  status: string;
  hand: Card[];
  picks: Card[];
  libraryCount: number;
  manaPool: ManaPool;
  landPlayed: boolean;
  basicLands?: BasicLands;
  mulligansTaken: number;
  bottomNeeded: number;
  mulliganStatus: string;
  deckReady: boolean;
  deckSelection: string[];
  deckCount: number;
}

function faceAt(card: Card, faceIndex = 0): CardFace {
  const face = card.faces?.[faceIndex];
  if (!face) return card;
  return {
    ...card,
    ...face,
    name: face.name || card.name,
    image: face.image || card.image,
    small: face.small || card.small,
    mana_cost: face.mana_cost ?? card.mana_cost,
    type_line: face.type_line ?? card.type_line,
    oracle_text: face.oracle_text ?? card.oracle_text,
    power: face.power ?? card.power,
    toughness: face.toughness ?? card.toughness,
    loyalty: face.loyalty ?? card.loyalty,
  };
}

function imgProxy(url?: string | null): string {
  if (!url) return "";
  if (!/^https:\/\/(cards\.scryfall\.io|c1\.scryfall\.com|c2\.scryfall\.com|c3\.scryfall\.com)\//i.test(url)) {
    return url;
  }
  return `${SERVER}/api/image?url=${encodeURIComponent(url)}`;
}

function cardIsLand(card: Pick<Card, "type_line">): boolean {
  return /\bland\b/i.test(card.type_line || "");
}

function basicLandName(card: Pick<Card, "name" | "type_line" | "basicLandName">): BasicLand | null {
  if (card.basicLandName && BASIC_LANDS.includes(card.basicLandName)) {
    return card.basicLandName;
  }
  if (!/\bbasic land\b/i.test(card.type_line || "")) return null;
  return BASIC_LANDS.find((land) => new RegExp(`\\b${land}\\b`, "i").test(card.name || "")) || null;
}

function cardIsCreature(card: Pick<Card, "type_line">): boolean {
  return /\bcreature\b/i.test(card.type_line || "");
}

function cardHasKeyword(card: Pick<Card, "keywords" | "oracle_text">, keyword: string): boolean {
  return (card.keywords || []).some((item) => item.toLowerCase() === keyword.toLowerCase()) ||
    new RegExp(`\\b${keyword}\\b`, "i").test(card.oracle_text || "");
}

function cardIsInstantOrFlash(card: Pick<Card, "type_line" | "keywords" | "oracle_text">): boolean {
  return /\binstant\b/i.test(card.type_line || "") || cardHasKeyword(card, "flash");
}

function powerToughness(card: { power?: string | number | null; toughness?: string | number | null }): string {
  const power = card.power ?? "—";
  const toughness = card.toughness ?? "—";
  return `${power}/${toughness}`;
}

function countVotes(votes: VoteTotals, key: "sets" | "boosters"): number {
  return Object.values(votes?.[key] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

const EXTRA_CSS = `
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:12px;align-items:start}
.card-tile{min-width:0;border:1px solid #30394a;background:#151b26;border-radius:10px;padding:7px;overflow:hidden}
.card-tile.is-selected{border-color:#8878e9;box-shadow:0 0 0 2px #8878e933;background:#211f35}
.card-tile .card-image{width:100%;}
.card-tile .image-wrap{aspect-ratio:5/7;}
.card-tile-meta{display:flex;flex-direction:column;gap:4px;min-width:0;padding:7px 2px 2px}
.card-tile-meta strong{font-size:11px;line-height:1.35;overflow-wrap:anywhere}
.card-tile-meta small{font-size:9px;line-height:1.4;color:#909bb0;overflow-wrap:anywhere}
.card-tile-actions{display:flex;gap:5px;margin-top:6px}
.card-tile-actions button{flex:1;min-width:0;border:1px solid #393f53;background:#242b3a;color:#d5dced;border-radius:7px;padding:7px 5px;font-size:10px}
.card-tile-actions button.selected{border-color:#8b7bef;background:#3b326b;color:#f1edff}
.card-grid .pick-button{margin-top:6px}
.land-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px;margin:10px 0 18px}
.land-item{display:flex;align-items:center;gap:10px;min-width:0;border:1px solid #30394a;background:#151b26;border-radius:10px;padding:10px}
.land-symbol{width:32px;height:32px;flex-shrink:0;display:grid;place-items:center;border-radius:8px;background:#2a3040;color:#c6cfea}
.land-desc{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.land-desc strong{font-size:11px}
.land-desc small{font-size:9px;color:#8995aa}
.land-count{display:flex;align-items:center;gap:8px}
.land-count button{width:27px;height:27px;display:grid;place-items:center;border-radius:7px;border:1px solid #3b4356;background:#242b3a;color:#e2e7f2}
.land-count strong{min-width:20px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums}
.card-art-placeholder{display:flex;align-items:center;justify-content:center;min-height:140px;text-align:center;padding:12px;border:1px dashed #3a4356;border-radius:9px;color:#aeb8cd;font-size:11px}
@media(max-width:520px){.card-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.card-tile{padding:5px}.land-grid{grid-template-columns:1fr}}
`;

interface CardTileProps {
  card: Card;
  selected?: boolean;
  disabled?: boolean;
  onPreview?: (card: Card) => void;
  onPick?: (card: Card) => void;
  onToggle?: (card: Card) => void;
  onPlay?: (card: Card, faceIndex: number) => void;
}

function CardTile({ card, selected = false, disabled = false, onPreview, onPick, onToggle, onPlay }: CardTileProps) {
  const face = faceAt(card, card.faceIndex || 0);
  const image = imgProxy(face.image || card.image);

  return (
    <article className={`card-tile ${selected ? "is-selected" : ""}`}>
      <button
        className="card-image"
        type="button"
        onClick={() => onPreview?.(card)}
        aria-label={`Bekijk ${face.name || card.name}`}
      >
        <div className="image-wrap">
          {image ? (
            <img
              src={image}
              alt={face.name || card.name}
              loading="lazy"
              onError={(event) => { event.currentTarget.style.display = "none"; }}
            />
          ) : (
            <div className="card-placeholder">
              <Layers size={20} />
              <strong>{face.name || card.name}</strong>
              <small>{face.type_line || card.type_line}</small>
            </div>
          )}
        </div>
      </button>
      <div className="card-tile-meta">
        <strong>{face.name || card.name}</strong>
        <small>{face.mana_cost || "Geen mana cost"}</small>
        <small>{face.type_line || card.type_line}</small>
      </div>
      {onPick && (
        <button className="pick-button" type="button" disabled={disabled} onClick={() => onPick(card)}>
          Kies kaart
        </button>
      )}
      {(onToggle || onPlay) && (
        <div className="card-tile-actions">
          {onToggle && (
            <button className={selected ? "selected" : ""} type="button" disabled={disabled} onClick={() => onToggle(card)}>
              {selected ? "In deck" : "Toevoegen"}
            </button>
          )}
          {onPlay && (
            <button type="button" disabled={disabled} onClick={() => onPlay(card, card.faceIndex || 0)}>
              Speel
            </button>
          )}
        </div>
      )}
    </article>
  );
}

interface CardModalProps {
  card: Card | null;
  onClose: () => void;
}

function CardModal({ card, onClose }: CardModalProps) {
  if (!card) return null;
  const face = faceAt(card, card.faceIndex || 0);
  const image = imgProxy(face.image || card.image);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="card-modal" role="dialog" aria-modal="true" aria-label={`Kaart: ${face.name || card.name}`}>
        <button className="icon-button close" type="button" onClick={onClose} aria-label="Sluiten">
          <X size={16} />
        </button>
        {image ? (
          <img src={image} alt={face.name || card.name} onError={(event) => { event.currentTarget.style.display = "none"; }} />
        ) : (
          <div className="large-placeholder card-art-placeholder">{face.name || card.name}</div>
        )}
        <div className="modal-info">
          <h2>{face.name || card.name}</h2>
          <p><strong>{face.mana_cost || "Geen mana cost"}</strong></p>
          <p>{face.type_line || card.type_line}</p>
          {face.oracle_text && <p>{face.oracle_text}</p>}
          {(face.power != null || face.toughness != null) && <p><strong>{powerToughness(face as Card)}</strong></p>}
          <small>{card.set ? `Set: ${card.set.toUpperCase()} · ` : ""}{card.rarity || ""}</small>
        </div>
      </section>
    </div>
  );
}

function manaLabel(pool: ManaPool) {
  return COLORS.map(
    (color) => `${color}: ${pool[color] || 0}`
  ).join(" · ");
}

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem("draft-name") || ""
  );
  const [playerId, setPlayerId] = useState("");
  const [joined, setJoined] = useState(false);

  const [games, setGames] = useState<Game[]>([]);
  const [sets, setSets] = useState<SetInfo[]>(FALLBACK_SETS);
  const [setsLoading, setSetsLoading] = useState(true);
  const [setsError, setSetsError] = useState("");
  const [setSearch, setSetSearch] = useState("");
  const [selectedSet, setSelectedSet] = useState("ltr");
  const [boosterCount, setBoosterCount] = useState(3);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [newTitle, setNewTitle] = useState("");

  const [activeGameId, setActiveGameId] = useState("");
  const [screen, setScreen] = useState<"home" | "game">("home");
  const [tab, setTab] = useState<"all" | "lobby" | "active">("all");
  const [notice, setNotice] = useState("");
  const [spectator, setSpectator] = useState(false);

  const [draftPrivate, setDraftPrivate] =
    useState<DraftPrivate | null>(null);
  const [matchPrivate, setMatchPrivate] =
    useState<MatchPrivate | null>(null);

  const [deckSelection, setDeckSelection] = useState<string[]>([]);
  const [basicLands, setBasicLands] =
    useState<BasicLands>({ ...EMPTY_LANDS });
  const [bottomSelection, setBottomSelection] =
    useState<string[]>([]);

  const [chatText, setChatText] = useState("");
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);

  const [selectedAttackers, setSelectedAttackers] =
    useState<string[]>([]);
  const [attackTargets, setAttackTargets] =
    useState<Record<string, string>>({});
  const [blockAssignments, setBlockAssignments] =
    useState<Record<string, string>>({});
  const [targetPlayerId, setTargetPlayerId] = useState("");
  const [targetPermanentId, setTargetPermanentId] = useState("");

  const chatEnd = useRef<HTMLDivElement>(null);

  const activeGame =
    games.find((game) => game.id === activeGameId) ?? null;

  const myPlayer =
    activeGame?.players.find((player) => player.id === playerId) ?? null;

  const match = activeGame?.match ?? null;
  const messages = activeGame?.messages ?? [];
  const activeVoteKick = activeGame?.voteKick ?? null;
  const voteKickTarget = activeGame?.players.find(
    (player) => player.id === activeVoteKick?.targetPlayerId
  ) ?? null;
  const alreadyVotedKick = Boolean(
    activeVoteKick &&
      (activeVoteKick.yesVotes.includes(playerId) ||
        activeVoteKick.noVotes.includes(playerId))
  );
  const canVoteKick = Boolean(
    activeGame && activeVoteKick && !spectator &&
      playerId !== activeVoteKick.targetPlayerId &&
      activeGame.players.some((player) => player.id === playerId)
  );

  const isMyTurn = Boolean(
    activeGame &&
      match?.activePlayerId === playerId &&
      !myPlayer?.eliminated
  );

  const opponents = (activeGame?.players ?? []).filter(
    (player) => player.id !== playerId && !player.eliminated
  );

  const incomingAttacks = (match?.attacks ?? []).filter(
    (attack) => attack.defenderId === playerId
  );

  const isDefender = Boolean(
    match?.blockingPlayerIds?.includes(playerId)
  );

  const currentMana = matchPrivate?.manaPool ?? EMPTY_MANA;

  const filteredGames = useMemo(
    () =>
      games.filter(
        (game) =>
          tab === "all" ||
          (tab === "lobby"
            ? game.status === "lobby"
            : game.status !== "lobby")
      ),
    [games, tab]
  );

  const filteredSets = useMemo(() => {
    const query = setSearch.trim().toLocaleLowerCase();

    if (!query) return sets;

    return sets.filter(
      (set) =>
        set.name.toLocaleLowerCase().includes(query) ||
        set.code.toLowerCase().includes(query) ||
        (set.set_type || "").toLowerCase().includes(query)
    );
  }, [sets, setSearch]);

  const selectedDeckCount = deckSelection.length;
  const landCount = BASIC_LANDS.reduce(
    (sum, land) => sum + basicLands[land],
    0
  );
  const deckCount = selectedDeckCount + landCount;

  const setNoticeMessage = (message: string) => {
    setNotice(message);
    window.setTimeout(
      () => setNotice((current) => current === message ? "" : current),
      6000
    );
  };

  // --------------------------------------------------
  // Verbinding met de server
  // --------------------------------------------------

  useEffect(() => {
    const connection = io(SERVER, {
      transports: ["websocket", "polling"],
    });

    setSocket(connection);

    connection.on("connect", () => setConnected(true));
    connection.on("disconnect", () => setConnected(false));

    connection.on(
      "state",
      (data: { games?: Game[]; sets?: SetInfo[] }) => {
        setGames(data.games ?? []);
        if (data.sets?.length) setSets(data.sets);
      }
    );

    connection.on(
      "identity",
      (data: { playerId: string; playerName?: string }) => {
        setPlayerId(data.playerId);
        if (data.playerName) setPlayerName(data.playerName);
      }
    );

    connection.on(
      "game-created",
      (data: { gameId: string }) => {
        setActiveGameId(data.gameId);
        setScreen("game");
        setSpectator(false);
      }
    );

    connection.on(
      "game-joined",
      (data: { gameId: string; watching?: boolean }) => {
        setActiveGameId(data.gameId);
        setScreen("game");
        setSpectator(Boolean(data.watching));
        // A new room must never inherit the previous room's private hand.
        setDraftPrivate(null);
        setMatchPrivate(null);
        setBottomSelection([]);
        setSelectedCard(null);
      }
    );

    connection.on("game-left", () => {
      setActiveGameId("");
      setScreen("home");
      setSpectator(false);
      setDraftPrivate(null);
      setMatchPrivate(null);
      setBottomSelection([]);
      setSelectedCard(null);
      setSelectedAttackers([]);
      setBlockAssignments({});
    });

    connection.on("player-removed", (data: { reason?: string } = {}) => {
      setActiveGameId("");
      setScreen("home");
      setSpectator(false);
      setDraftPrivate(null);
      setMatchPrivate(null);
      setBottomSelection([]);
      setSelectedCard(null);
      setSelectedAttackers([]);
      setBlockAssignments({});
      setNoticeMessage(data.reason || "Je bent uit de tafel verwijderd.");
    });

    connection.on("notice", (message: string) => {
      setNoticeMessage(message);
    });

    connection.on("draft-private-state", (data: DraftPrivate) => {
      setDraftPrivate(data);

      setBasicLands({
        ...EMPTY_LANDS,
        ...(data.basicLands || {}),
      });

      if (data.status === "deckbuilding" && !data.deckReady) {
        setDeckSelection(data.deckSelection ?? data.picks.map((card) => card.instanceId));
      }

      if (data.status === "deckbuilding" && data.deckReady) {
        setDeckSelection(data.deckSelection || []);
      }

      if (data.status !== "deckbuilding") {
        setBottomSelection([]);
      }
    });

    connection.on("match-private-state", (data: MatchPrivate) => {
      setMatchPrivate(data);
      setBasicLands({
        ...EMPTY_LANDS,
        ...(data.basicLands || {}),
      });
      setDeckSelection(data.deckSelection || []);
      setSpectator(false);

      if (data.mulliganStatus !== "bottoming") {
        setBottomSelection([]);
      }
    });

    connection.on(
      "draft-round-started",
      (data: {
        round: number;
        boosterCount: number;
        direction: string;
      }) => {
        setNoticeMessage(
          `Booster ${data.round}/${data.boosterCount} gestart. Doorgeven naar ${
            data.direction === "left" ? "links" : "rechts"
          }.`
        );
      }
    );

    connection.on("draft-finished", () => {
      setNoticeMessage(
        "Draft afgerond! Bouw nu je deck van minimaal 40 kaarten."
      );
    });

    connection.on(
      "match-finished",
      (data: { winnerName?: string }) => {
        setNoticeMessage(
          data.winnerName
            ? `${data.winnerName} wint de game!`
            : "De match is afgelopen."
        );
      }
    );

    return () => {
      connection.disconnect();
    };
  }, []);

  useEffect(() => {
    if (joined && socket && connected) {
      socket.emit("join-arena", { playerName });
    }
  }, [joined, socket, connected]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, activeGameId]);

  // --------------------------------------------------
  // Alle beschikbare sets laden
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function loadSets() {
      setSetsLoading(true);
      setSetsError("");

      try {
        const response = await fetch(`${SERVER}/api/sets`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data: unknown = await response.json();

        if (!Array.isArray(data)) {
          throw new Error("Ongeldige setlijst");
        }

        const allSets = (data as SetInfo[])
          .filter(
            (set) =>
              typeof set.code === "string" &&
              typeof set.name === "string"
          )
          .sort(
            (a, b) =>
              String(b.released_at || "").localeCompare(
                String(a.released_at || "")
              ) || a.name.localeCompare(b.name)
          );

        if (!allSets.length) {
          throw new Error("Geen sets ontvangen");
        }

        if (cancelled) return;

        setSets(allSets);
        setSelectedSet((current) =>
          allSets.some((set) => set.code === current)
            ? current
            : allSets[0].code
        );
      } catch (error) {
        console.error("Sets laden mislukt:", error);

        if (!cancelled) {
          setSetsError(
            "De setlijst kon niet volledig worden geladen. De standaardsets blijven beschikbaar."
          );
        }
      } finally {
        if (!cancelled) setSetsLoading(false);
      }
    }

    void loadSets();

    return () => {
      cancelled = true;
    };
  }, []);

  // --------------------------------------------------
  // Lobbyacties
  // --------------------------------------------------

  const enterArena = () => {
    const name = playerName.trim().slice(0, 24);

    if (!name) {
      setNoticeMessage("Vul eerst een spelersnaam in.");
      return;
    }

    localStorage.setItem("draft-name", name);
    setPlayerName(name);
    setJoined(true);
    setScreen("home");
  };

  const createGame = () => {
    if (!socket || !connected) {
      setNoticeMessage("De server is nog niet verbonden.");
      return;
    }

    socket.emit("create-game", {
      title: newTitle.trim() || `${playerName}'s draft`,
      maxPlayers,
    });

    setNewTitle("");
  };

  const joinGame = (game: Game) => {
    if (!socket) return;

    setActiveGameId(game.id);
    setScreen("game");

    if (game.status === "lobby") {
      socket.emit("join-game", { gameId: game.id });
    } else {
      socket.emit("watch-game", { gameId: game.id });
    }
  };

  const sendVote = () => {
    if (!activeGameId || !socket) return;

    socket.emit("vote", {
      gameId: activeGameId,
      setCode: selectedSet,
      boosterCount,
    });
  };

  const startDraft = () => {
    if (!activeGameId || !socket) return;

    socket.emit("start-game", {
      gameId: activeGameId,
    });
  };

  const renamePlayer = () => {
    const name = playerName.trim().slice(0, 24);
    if (!name) return;

    localStorage.setItem("draft-name", name);
    socket?.emit("rename-player", { playerName: name });
  };

  const sendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const text = chatText.trim();
    if (!text || !activeGameId || !socket) return;

    socket.emit("chat-message", {
      gameId: activeGameId,
      text,
    });

    setChatText("");
  };

  const resetGameView = () => {
    setScreen("home");
    setActiveGameId("");
    setSelectedCard(null);
    setSpectator(false);
    setDraftPrivate(null);
    setMatchPrivate(null);
    setBottomSelection([]);
    setSelectedAttackers([]);
    setAttackTargets({});
    setBlockAssignments({});
    setTargetPlayerId("");
    setTargetPermanentId("");
  };

  const leaveGame = () => {
    if (activeGameId && socket) {
      socket.emit("leave-game", { gameId: activeGameId });
    }
    resetGameView();
  };

  const backToHome = () => leaveGame();

  const playBasicLand = (land: BasicLand) => {
    if (!socket || !activeGameId || spectator) return;
    socket.emit("play-basic-land", { gameId: activeGameId, land });
  };

  const togglePermanentTap = (permanent: Card) => {
    if (!socket || !activeGameId || spectator || !permanent.permanentId) return;
    socket.emit("toggle-permanent-tap", {
      gameId: activeGameId,
      permanentId: permanent.permanentId,
    });
  };

  const startVoteKick = (target: Player) => {
    if (!socket || !activeGameId || spectator || target.id === playerId) return;
    const confirmed = window.confirm(
      `Een vote kick starten voor ${target.name}? De andere spelers kunnen voor of tegen stemmen.`
    );
    if (!confirmed) return;
    socket.emit("start-vote-kick", {
      gameId: activeGameId,
      targetPlayerId: target.id,
    });
  };

  const castVoteKick = (vote: "yes" | "no") => {
    if (!socket || !activeGameId || spectator) return;
    socket.emit("cast-vote-kick", { gameId: activeGameId, vote });
  };

  // --------------------------------------------------
  // Draft- en deckbuildingacties
  // --------------------------------------------------

  const pickCard = (card: Card) => {
    if (!socket || !activeGameId || draftPrivate?.hasPicked) {
      return;
    }

    socket.emit("pick-card", {
      gameId: activeGameId,
      cardId: card.instanceId,
    });
  };

  const toggleDeckCard = (card: Card) => {
    if (draftPrivate?.deckReady) return;

    setDeckSelection((current) =>
      current.includes(card.instanceId)
        ? current.filter((key) => key !== card.instanceId)
        : [...current, card.instanceId]
    );
  };

  const updateLand = (name: BasicLand, delta: number) => {
    if (!socket || !activeGameId || draftPrivate?.deckReady) return;

    const next: BasicLands = {
      ...basicLands,
      [name]: Math.max(0, Math.min(60, (basicLands[name] || 0) + delta)),
    };

    const total = BASIC_LANDS.reduce((sum, land) => sum + next[land], 0);
    if (total > 100) {
      setNoticeMessage("Je kunt maximaal 100 basic lands toevoegen.");
      return;
    }

    // Update the GUI immediately and persist the count to the server on every click.
    setBasicLands(next);
    socket.emit("set-basic-lands", { gameId: activeGameId, lands: next });
  };

  const submitDeck = () => {
    if (!socket || !activeGameId || !draftPrivate) return;

    if (deckCount < 40) {
      setNoticeMessage(
        `Je deck heeft ${deckCount} kaarten. Voeg nog ${40 - deckCount} kaarten of basic lands toe.`
      );
      return;
    }

    socket.emit("submit-deck", {
      gameId: activeGameId,
      cardIds: deckSelection,
      lands: basicLands,
    });

    setNoticeMessage(
      "Deck verstuurd. Wachten tot de andere spelers klaar zijn."
    );
  };

  // --------------------------------------------------
  // Mulliganacties
  // --------------------------------------------------

  const takeMulligan = () => {
    if (!socket || !activeGameId) return;

    setBottomSelection([]);
    socket.emit("take-mulligan", {
      gameId: activeGameId,
    });
  };

  const keepHand = () => {
    if (!socket || !activeGameId) return;

    socket.emit("keep-hand", {
      gameId: activeGameId,
    });
  };

  const toggleBottomSelection = (card: Card) => {
    const maxCards = matchPrivate?.bottomNeeded || 0;

    setBottomSelection((current) => {
      if (current.includes(card.instanceId)) {
        return current.filter((key) => key !== card.instanceId);
      }

      if (current.length >= maxCards) {
        return current;
      }

      return [...current, card.instanceId];
    });
  };

  const submitBottom = () => {
    if (!socket || !activeGameId || !matchPrivate) return;

    if (bottomSelection.length !== matchPrivate.bottomNeeded) {
      setNoticeMessage(
        `Selecteer precies ${matchPrivate.bottomNeeded} kaarten om onderop te leggen.`
      );
      return;
    }

    socket.emit("submit-bottom", {
      gameId: activeGameId,
      cardIds: bottomSelection,
    });

    setBottomSelection([]);
  };

  // --------------------------------------------------
  // Matchacties
  // --------------------------------------------------

  const tapLand = (permanent: Card) => {
    if (!socket || !activeGameId || !isMyTurn) return;

    socket.emit("tap-land", {
      gameId: activeGameId,
      permanentId: permanent.permanentId,
    });
  };

  const playCard = (card: Card, faceIndex: number) => {
    if (!socket || !activeGameId) return;

    socket.emit("play-card", {
      gameId: activeGameId,
      cardId: card.instanceId,
      faceIndex,
      targetPlayerId: targetPlayerId || undefined,
      targetPermanentId: targetPermanentId || undefined,
    });
  };

  const advancePhase = () => {
    if (!socket || !activeGameId) return;

    socket.emit("advance-phase", {
      gameId: activeGameId,
    });
  };

  const declareAttackers = () => {
    if (!socket || !activeGameId || !match) return;

    const attacks = selectedAttackers
      .map((attackerId) => ({
        attackerId,
        defenderId:
          attackTargets[attackerId] ||
          opponents[0]?.id,
      }))
      .filter(
        (
          attack
        ): attack is {
          attackerId: string;
          defenderId: string;
        } => Boolean(attack.defenderId)
      );

    socket.emit("declare-attackers", {
      gameId: activeGameId,
      attacks,
    });

    setSelectedAttackers([]);
    setAttackTargets({});
  };

  const submitBlockers = () => {
    if (!socket || !activeGameId) return;

    const assignments = Object.entries(blockAssignments)
      .filter(([, attackerId]) => Boolean(attackerId))
      .map(([blockerId, attackerId]) => ({
        blockerId,
        attackerId,
      }));

    socket.emit("assign-blockers", {
      gameId: activeGameId,
      assignments,
    });

    setBlockAssignments({});
  };

  const concede = () => {
    if (
      window.confirm(
        "Weet je zeker dat je deze match wilt opgeven?"
      )
    ) {
      socket?.emit("concede", {
        gameId: activeGameId,
      });
    }
  };

  const flipPermanent = (permanent: Card) => {
    socket?.emit("transform-permanent", {
      gameId: activeGameId,
      permanentId: permanent.permanentId,
    });
  };

  // --------------------------------------------------
  // Startscherm
  // --------------------------------------------------

  if (!joined) {
    return (
      <>
        <style>{EXTRA_CSS}</style>

        <main className="start-screen">
          <div className="hero-glow" />

          <div className="brand">
            <div className="brand-icon">
              <Swords />
            </div>

            <div>
              <span className="eyebrow">
                MULTIPLAYER CARD GAME
              </span>
              <h1>
                Draft <em>Arena</em>
              </h1>
            </div>
          </div>

          <div className="start-card">
            <div className="eyebrow">
              WELCOME TO THE TABLE
            </div>

            <h2>Draft samen. Speel samen.</h2>

            <p>
              Kies een set, draft met vrienden, bouw je deck en
              speel een multiplayerwedstrijd.
            </p>

            <label htmlFor="player-name-start">
              Spelersnaam
            </label>

            <input
              id="player-name-start"
              value={playerName}
              onChange={(event) =>
                setPlayerName(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") enterArena();
              }}
              maxLength={24}
              placeholder="Bijv. GandalfTheGrey"
            />

            <button
              className="primary full"
              type="button"
              onClick={enterArena}
            >
              <Play size={17} />
              Naar de lobby
            </button>

            <div className="feature-row">
              <span>
                <Users size={15} /> Multiplayer
              </span>
              <span>
                <Layers size={15} /> Draft
              </span>
              <span>
                <Swords size={15} /> Matches
              </span>
            </div>
          </div>

          <div className="start-footer">
            <span
              className={`dot ${connected ? "online" : ""}`}
            />
            {connected
              ? "Server verbonden"
              : "Verbinden met server…"}
            <span>·</span>
            Draft Arena
          </div>
        </main>
      </>
    );
  }

  // --------------------------------------------------
  // Hoofdinterface
  // --------------------------------------------------

  return (
    <>
      <style>{EXTRA_CSS}</style>

      <div className="app-shell">
        <header className="topbar">
          <button
            className="brand mini"
            type="button"
            onClick={backToHome}
          >
            <div className="brand-icon">
              <Swords />
            </div>

            <div>
              <span className="eyebrow">MULTIPLAYER</span>
              <h1>
                Draft <em>Arena</em>
              </h1>
            </div>
          </button>

          <div className="top-actions">
            <span
              className={`connection ${
                connected ? "good" : ""
              }`}
            >
              <span className="dot" />
              {connected ? "Live server" : "Offline"}
            </span>

            <span className="user-chip">
              <span className="avatar">
                {playerName.slice(0, 1).toUpperCase()}
              </span>
              {playerName}
            </span>
          </div>
        </header>

        {notice && (
          <div
            className="arena-toast"
            role="status"
            onClick={() => setNotice("")}
          >
            {notice}
            <X size={15} />
          </div>
        )}

        {screen === "home" ? (
          <main className="main-layout">
            <section className="welcome-row">
              <div>
                <div className="eyebrow">
                  ARENA OVERVIEW
                </div>

                <h2>
                  Welkom terug, <em>{playerName}</em>
                </h2>

                <p>
                  Open een lobby of maak een nieuwe drafttafel.
                </p>
              </div>

              <div className="live-pill">
                <span className="dot online" />
                {games.length} games
              </div>
            </section>

            <div className="dashboard-grid">
              <section className="panel create-panel">
                <div className="panel-heading">
                  <div className="heading-icon purple">
                    <Plus />
                  </div>

                  <div>
                    <h3>Nieuwe lobby</h3>
                    <p>Maak een tafel voor je vrienden</p>
                  </div>
                </div>

                <label htmlFor="lobby-title">
                  Lobbynaam
                </label>

                <input
                  id="lobby-title"
                  value={newTitle}
                  onChange={(event) =>
                    setNewTitle(event.target.value)
                  }
                  maxLength={50}
                  placeholder={`${playerName}'s draft`}
                />

                <div className="two-fields">
                  <div>
                    <label htmlFor="max-players">
                      Max. spelers
                    </label>

                    <select
                      id="max-players"
                      value={maxPlayers}
                      onChange={(event) =>
                        setMaxPlayers(Number(event.target.value))
                      }
                    >
                      {[2, 3, 4, 5, 6, 7, 8].map((number) => (
                        <option key={number} value={number}>
                          {number} spelers
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="rename-player">
                      Jouw naam
                    </label>

                    <input
                      id="rename-player"
                      value={playerName}
                      onChange={(event) =>
                        setPlayerName(event.target.value)
                      }
                      onBlur={renamePlayer}
                      maxLength={24}
                    />
                  </div>
                </div>

                <button
                  className="primary full"
                  type="button"
                  onClick={createGame}
                >
                  <Plus size={16} />
                  Lobby aanmaken
                </button>

                <div className="mini-note">
                  <Sparkles size={14} />
                  Kies samen de set en het aantal boosters.
                </div>
              </section>

              <section className="panel games-panel">
                <div className="panel-heading">
                  <div className="heading-icon blue">
                    <Swords />
                  </div>

                  <div>
                    <h3>Alle games</h3>
                    <p>Open tafels en actieve matches</p>
                  </div>

                  <span className="count-badge">
                    {games.length}
                  </span>
                </div>

                <div className="tabs">
                  <button
                    type="button"
                    className={
                      tab === "all" ? "selected" : ""
                    }
                    onClick={() => setTab("all")}
                  >
                    Alle <b>{games.length}</b>
                  </button>

                  <button
                    type="button"
                    className={
                      tab === "lobby" ? "selected" : ""
                    }
                    onClick={() => setTab("lobby")}
                  >
                    Lobby's{" "}
                    <b>
                      {
                        games.filter(
                          (game) => game.status === "lobby"
                        ).length
                      }
                    </b>
                  </button>

                  <button
                    type="button"
                    className={
                      tab === "active" ? "selected" : ""
                    }
                    onClick={() => setTab("active")}
                  >
                    Bezig{" "}
                    <b>
                      {
                        games.filter(
                          (game) => game.status !== "lobby"
                        ).length
                      }
                    </b>
                  </button>
                </div>

                <div className="game-list">
                  {filteredGames.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <Users />
                      </div>

                      <strong>Nog geen games</strong>

                      <span>
                        Maak een lobby om te beginnen.
                      </span>
                    </div>
                  ) : (
                    filteredGames.map((game) => (
                      <div
                        className="game-row"
                        key={game.id}
                      >
                        <div className="game-art">
                          <Layers />
                        </div>

                        <div className="game-details">
                          <strong>{game.title}</strong>
                          <span>{game.setName}</span>

                          <div className="game-meta">
                            <span>
                              <Users size={13} />
                              {game.players.length}/{game.maxPlayers}
                            </span>

                            <span
                              className={`status ${
                                game.status !== "lobby"
                                  ? "playing"
                                  : ""
                              }`}
                            >
                              {game.status === "lobby"
                                ? "Lobby"
                                : game.status === "loading-draft" ||
                                    game.status === "loading-match"
                                  ? "Laden"
                                  : game.status === "deckbuilding"
                                    ? "Deck bouwen"
                                    : game.status === "mulligan"
                                      ? "Mulligan"
                                      : game.status === "playing"
                                        ? "Match"
                                        : game.status === "finished"
                                          ? "Afgelopen"
                                          : "Draft"}
                            </span>
                          </div>
                        </div>

                        <button
                          className="join-button"
                          type="button"
                          onClick={() => joinGame(game)}
                        >
                          {game.status === "lobby"
                            ? "Join"
                            : "Open"}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </main>
        ) : (
          <main className="game-layout">
            <div className="game-main">
              <button
                className="back-link"
                type="button"
                onClick={backToHome}
              >
                <ArrowLeft size={16} />
                Alle games
              </button>

              {!activeGame ? (
                <section className="panel play-section">
                  <h2>Game niet gevonden</h2>
                </section>
              ) : (
                <>
                  <div className="game-title-row">
                    <div>
                      <div className="eyebrow">
                        {activeGame.status === "lobby"
                          ? "LOBBY ROOM"
                          : activeGame.status === "playing"
                            ? "PLAYTESTER TABLE"
                            : "DRAFT ARENA MATCH"}
                      </div>

                      <h2>{activeGame.title}</h2>
                      <p>{activeGame.setName}</p>
                    </div>

                    <span
                      className={`status large ${
                        activeGame.status !== "lobby"
                          ? "playing"
                          : ""
                      }`}
                    >
                      {activeGame.status === "lobby"
                        ? "Lobby open"
                        : activeGame.status === "deckbuilding"
                          ? "Deck bouwen"
                          : activeGame.status === "mulligan"
                            ? "Mulligan"
                            : activeGame.status === "playing"
                              ? "Playtester open"
                              : activeGame.status === "finished"
                                ? "Game afgelopen"
                                : "Bezig"}
                    </span>
                  </div>

                  <section className={`panel roster-panel ${activeGame.status === "playing" ? "is-hidden-for-playtester" : ""}`}>
                    <div className="panel-heading">
                      <div className="heading-icon blue">
                        <Users />
                      </div>

                      <div>
                        <h3>Spelers</h3>
                        <p>
                          {activeGame.players.length} van{" "}
                          {activeGame.maxPlayers} plaatsen gevuld
                        </p>
                      </div>
                    </div>

                    <div className="roster">
                      {activeGame.players.map((player, index) => (
                        <div
                          className="roster-player"
                          key={player.id}
                        >
                          <div
                            className={`avatar ${
                              index === 0 ? "host-avatar" : ""
                            }`}
                          >
                            {player.name.slice(0, 1).toUpperCase()}
                          </div>

                          <div>
                            <strong>{player.name}</strong>
                            <span>
                              {player.isHost
                                ? "Host"
                                : player.id === playerId
                                  ? "Jij"
                                  : "Speler"}

                              {player.deckReady
                                ? " · deck klaar"
                                : ""}

                              {player.life != null && match
                                ? ` · ${player.life} leven`
                                : ""}
                            </span>
                          </div>

                          {player.isHost && (
                            <span className="host-tag">
                              HOST
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Lobby en setstemming */}
                  {activeGame.status === "lobby" && (
                    <section className="panel vote-panel">
                      <div className="panel-heading">
                        <div className="heading-icon gold">
                          <Vote />
                        </div>

                        <div>
                          <h3>Stem voor de draft</h3>
                          <p>
                            Kies een set en het aantal boosters.
                          </p>
                        </div>
                      </div>

                      <label htmlFor="set-search">
                        <Search
                          size={13}
                          style={{
                            display: "inline",
                            marginRight: 5,
                          }}
                        />
                        Zoek set
                      </label>

                      <input
                        id="set-search"
                        type="search"
                        value={setSearch}
                        onChange={(event) =>
                          setSetSearch(event.target.value)
                        }
                        placeholder="Zoek op naam of setcode…"
                      />

                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          margin: "8px 0",
                        }}
                      >
                        <small>
                          {setsLoading
                            ? "Sets laden…"
                            : `${filteredSets.length} van ${sets.length} sets`}
                        </small>

                        {setsLoading && (
                          <LoaderCircle
                            size={14}
                            className="spin"
                          />
                        )}
                      </div>

                      {setsError && (
                        <p className="subtle-note">{setsError}</p>
                      )}

                      <div
                        style={{
                          maxHeight: 260,
                          overflowY: "auto",
                          border: "1px solid #2f3748",
                          borderRadius: 10,
                          padding: 5,
                        }}
                      >
                        {filteredSets.map((set) => (
                          <button
                            type="button"
                            key={set.code}
                            className={`set-option ${
                              selectedSet === set.code
                                ? "selected"
                                : ""
                            }`}
                            onClick={() => setSelectedSet(set.code)}
                          >
                            <span className="set-option-code">
                              {set.code.toUpperCase()}
                            </span>

                            <span className="set-option-name">
                              {set.name}

                              <small>
                                {set.released_at || ""}
                                {set.set_type
                                  ? ` · ${set.set_type}`
                                  : ""}
                              </small>
                            </span>

                            {selectedSet === set.code && (
                              <span className="set-option-check">
                                ✓
                              </span>
                            )}
                          </button>
                        ))}

                        {filteredSets.length === 0 && (
                          <div className="empty-zone">
                            Geen sets gevonden.
                          </div>
                        )}
                      </div>

                      <label>Aantal boosters per speler</label>

                      <div className="booster-options">
                        {[1, 2, 3, 4, 5, 6].map((number) => (
                          <button
                            type="button"
                            key={number}
                            className={`booster ${
                              boosterCount === number
                                ? "selected"
                                : ""
                            }`}
                            onClick={() =>
                              setBoosterCount(number)
                            }
                          >
                            <span>{number}</span>
                            <small>
                              {number === 1
                                ? "booster"
                                : "boosters"}
                            </small>
                          </button>
                        ))}
                      </div>

                      <div className="vote-footer">
                        <div className="vote-summary">
                          <span>
                            <Vote size={14} />
                            Stemmen tellen live mee
                          </span>

                          <small>
                            Setstemmen:{" "}
                            {countVotes(
                              activeGame.votes,
                              "sets"
                            )}
                            {" · "}
                            Boosters:{" "}
                            {countVotes(
                              activeGame.votes,
                              "boosters"
                            )}
                          </small>
                        </div>

                        <button
                          className="secondary"
                          type="button"
                          onClick={sendVote}
                        >
                          Stem uitbrengen
                        </button>
                      </div>

                      {myPlayer?.isHost && (
                        <button
                          className="primary full"
                          type="button"
                          onClick={startDraft}
                        >
                          <Play size={16} />
                          Start draft
                        </button>
                      )}
                    </section>
                  )}

                  {/* Draftsets ophalen */}
                  {activeGame.status === "loading-draft" && (
                    <section className="panel play-section">
                      <div className="status-box">
                        <LoaderCircle className="spin" />
                        <div>
                          <strong>Draft voorbereiden</strong>
                          <p>
                            Scryfall-kaarten worden opgehaald.
                          </p>
                        </div>
                      </div>
                    </section>
                  )}

                  {/* Draft */}
                  {activeGame.status === "drafting" && (
                    <section className="panel play-section">
                      <div className="section-bar">
                        <div>
                          <h3>
                            Booster {draftPrivate?.round || activeGame.draftRound}/
                            {activeGame.boosterCount}
                          </h3>
                          <p>
                            Pick {draftPrivate?.pick || activeGame.draftPick}
                            {" · "}
                            {draftPrivate?.direction === "left"
                              ? "Naar links"
                              : "Naar rechts"}
                          </p>
                        </div>

                        <span className="count-badge">
                          {draftPrivate?.booster.length ?? 0} kaarten
                        </span>
                      </div>

                      <div className="game-stats">
                        <div className="stat-card">
                          <span>Jouw picks</span>
                          <strong>
                            {draftPrivate?.picks.length ?? 0}
                          </strong>
                        </div>
                        <div className="stat-card">
                          <span>Spelers die klaar zijn</span>
                          <strong>
                            {
                              activeGame.players.filter(
                                (player) => player.hasPicked
                              ).length
                            }
                            /{activeGame.players.length}
                          </strong>
                        </div>
                        <div className="stat-card">
                          <span>Kaarten per booster</span>
                          <strong>14</strong>
                        </div>
                      </div>

                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${
                              activeGame.players.length
                                ? ((activeGame.players.filter(
                                    (player) => player.hasPicked
                                  ).length /
                                    activeGame.players.length) *
                                  100)
                                : 0
                            }%`,
                          }}
                        />
                      </div>

                      {draftPrivate?.hasPicked && (
                        <div className="status-box">
                          <CheckCircle2 color="#8be0b4" />
                          <div>
                            <strong>Pick opgeslagen</strong>
                            <p>
                              Wachten tot de andere spelers gekozen
                              hebben. Je booster wordt daarna automatisch
                              doorgegeven.
                            </p>
                          </div>
                        </div>
                      )}

                      {spectator ? (
                        <div className="empty-zone">
                          Je kijkt mee als toeschouwer.
                        </div>
                      ) : (
                        <div className="card-grid">
                          {(draftPrivate?.booster || []).map((card) => (
                            <CardTile
                              key={card.instanceId}
                              card={card}
                              onPreview={setSelectedCard}
                              onPick={pickCard}
                              disabled={Boolean(
                                draftPrivate?.hasPicked
                              )}
                            />
                          ))}
                        </div>
                      )}

                      <h3 className="zone-title">
                        Jouw gekozen kaarten (
                        {draftPrivate?.picks.length ?? 0})
                      </h3>

                      <div className="card-grid">
                        {(draftPrivate?.picks || []).map((card) => (
                          <CardTile
                            key={card.instanceId}
                            card={card}
                            onPreview={setSelectedCard}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Deckbuilding */}
                  {activeGame.status === "deckbuilding" && (
                    <section className="panel play-section">
                      <div className="section-bar">
                        <div>
                          <h3>
                            <BookOpen
                              size={17}
                              style={{
                                display: "inline",
                                marginRight: 7,
                              }}
                            />
                            Bouw je deck
                          </h3>
                          <p>
                            Selecteer je kaarten en voeg basic lands toe.
                          </p>
                        </div>

                        <span className="count-badge">
                          {draftPrivate?.deckReady
                            ? "Deck ingediend"
                            : "Deck bouwen"}
                        </span>
                      </div>

                      <div className="game-stats">
                        <div className="stat-card">
                          <span>Geselecteerde kaarten</span>
                          <strong>{selectedDeckCount}</strong>
                        </div>
                        <div className="stat-card">
                          <span>Basic lands</span>
                          <strong>{landCount}</strong>
                        </div>
                        <div className="stat-card">
                          <span>Totaal</span>
                          <strong>{deckCount}/40</strong>
                        </div>
                      </div>

                      <div className="progress-track">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.min(100, deckCount / 40 * 100)}%`,
                          }}
                        />
                      </div>

                      <p className="subtle-note">
                        Kies minimaal 40 kaarten. Je kunt kaarten uit je
                        pool aan- en uitzetten.
                      </p>

                      <h3 className="zone-title">
                        Basic lands toevoegen
                      </h3>

                      <div className="land-grid">
                        {BASIC_LANDS.map((land) => (
                          <div className="land-item" key={land}>
                            <div className="land-symbol">
                              <Mountain size={18} />
                            </div>

                            <div className="land-desc">
                              <strong>{land}</strong>
                              <small>Basic land</small>
                            </div>

                            <div className="land-count">
                              <button
                                type="button"
                                disabled={
                                  basicLands[land] <= 0 ||
                                  Boolean(draftPrivate?.deckReady)
                                }
                                onClick={() =>
                                  updateLand(land, -1)
                                }
                                aria-label={`Minder ${land}`}
                              >
                                <Minus size={12} />
                              </button>

                              <strong>
                                {basicLands[land]}
                              </strong>

                              <button
                                type="button"
                                disabled={
                                  landCount >= 100 ||
                                  basicLands[land] >= 60 ||
                                  Boolean(draftPrivate?.deckReady)
                                }
                                onClick={() =>
                                  updateLand(land, 1)
                                }
                                aria-label={`Meer ${land}`}
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      <h3 className="zone-title">
                        Jouw draftpool ({draftPrivate?.picks.length ?? 0})
                      </h3>

                      <div className="card-grid">
                        {(draftPrivate?.picks || []).map((card) => (
                          <CardTile
                            key={card.instanceId}
                            card={card}
                            selected={deckSelection.includes(
                              card.instanceId
                            )}
                            onToggle={toggleDeckCard}
                            onPreview={setSelectedCard}
                          />
                        ))}
                      </div>

                      <div className="board-actions">
                        <button
                          className="primary"
                          type="button"
                          disabled={
                            Boolean(draftPrivate?.deckReady) ||
                            deckCount < 40
                          }
                          onClick={submitDeck}
                        >
                          <CheckCircle2 size={16} />
                          Deck bevestigen ({deckCount})
                        </button>

                        <button
                          className="secondary"
                          type="button"
                          disabled={Boolean(draftPrivate?.deckReady)}
                          onClick={() => {
                            setDeckSelection(
                              draftPrivate?.picks.map(
                                (card) => card.instanceId
                              ) || []
                            );
                            const empty = { ...EMPTY_LANDS };
                            setBasicLands(empty);
                            if (socket && activeGameId) {
                              socket.emit("set-basic-lands", {
                                gameId: activeGameId,
                                lands: empty,
                              });
                            }
                          }}
                        >
                          Reset selectie
                        </button>
                      </div>

                      {draftPrivate?.deckReady && (
                        <div className="status-box">
                          <CheckCircle2 color="#8be0b4" />
                          <div>
                            <strong>Deck ingediend</strong>
                            <p>
                              Wachten tot alle andere spelers hun deck
                              hebben ingediend.
                            </p>
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {/* Match voorbereiden */}
                  {activeGame.status === "loading-match" && (
                    <section className="panel play-section">
                      <div className="status-box">
                        <LoaderCircle className="spin" />
                        <div>
                          <strong>Match voorbereiden</strong>
                          <p>
                            De decks worden geschud en de openingshanden
                            worden uitgedeeld.
                          </p>
                        </div>
                      </div>
                    </section>
                  )}

                  {/* Mulligan */}
                  {activeGame.status === "mulligan" && (
                    <section className="panel play-section">
                      <div className="section-bar">
                        <div>
                          <h3>Openingshand</h3>
                          <p>
                            Houd je hand of neem een mulligan.
                          </p>
                        </div>

                        <span className="count-badge">
                          Mulligans:{" "}
                          {matchPrivate?.mulligansTaken ?? 0}
                        </span>
                      </div>

                      {spectator || !matchPrivate ? (
                        <div className="empty-zone">
                          Je kijkt mee terwijl spelers hun openingshand
                          kiezen.
                        </div>
                      ) : matchPrivate.mulliganStatus === "deciding" ? (
                        <>
                          <div className="status-box">
                            <Hand size={20} />
                            <div>
                              <strong>
                                Houd je hand of neem een mulligan
                              </strong>
                              <p>
                                Neem een nieuwe openingshand als je
                                onvoldoende bruikbare kaarten hebt. De
                                server bepaalt hoeveel kaarten na het
                                houden onderop moeten.
                              </p>
                            </div>
                          </div>

                          <div className="card-grid">
                            {matchPrivate.hand.map((card) => (
                              <CardTile
                                key={card.instanceId}
                                card={card}
                                onPreview={setSelectedCard}
                              />
                            ))}
                          </div>

                          <div className="board-actions">
                            <button
                              className="primary"
                              type="button"
                              onClick={keepHand}
                            >
                              <CheckCircle2 size={16} />
                              Hand houden
                            </button>

                            <button
                              className="secondary"
                              type="button"
                              onClick={takeMulligan}
                            >
                              <RotateCcw size={15} />
                              Mulligan nemen
                            </button>
                          </div>
                        </>
                      ) : matchPrivate.mulliganStatus === "bottoming" ? (
                        <>
                          <div className="status-box">
                            <ArrowLeftRight size={20} />
                            <div>
                              <strong>
                                Kies {matchPrivate.bottomNeeded} kaarten
                                om onderop te leggen
                              </strong>
                              <p>
                                Geselecteerd: {bottomSelection.length}/
                                {matchPrivate.bottomNeeded}
                              </p>
                            </div>
                          </div>

                          <div className="card-grid">
                            {matchPrivate.hand.map((card) => (
                              <CardTile
                                key={card.instanceId}
                                card={card}
                                selected={bottomSelection.includes(
                                  card.instanceId
                                )}
                                onToggle={toggleBottomSelection}
                                onPreview={setSelectedCard}
                              />
                            ))}
                          </div>

                          <button
                            className="primary full"
                            type="button"
                            disabled={
                              bottomSelection.length !==
                              matchPrivate.bottomNeeded
                            }
                            onClick={submitBottom}
                          >
                            Kaarten onderop leggen
                          </button>
                        </>
                      ) : (
                        <div className="status-box">
                          <CheckCircle2 />
                          <div>
                            <strong>Je hand is vastgezet</strong>
                            <p>
                              Wachten tot de andere spelers klaar zijn.
                            </p>
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {/* Playtester: open bord, private hand, geen beurtregels */}
                  {activeGame.status === "playing" && match && (
                    <section className="playtester-board">
                      <div className="playtester-hero">
                        <div>
                          <div className="eyebrow">OPEN TABLE · REALTIME</div>
                          <h2>Playtester</h2>
                          <p>Geen automatische spelregels. Speel basic lands, tap kaarten en vertel in de chat wat je doet.</p>
                        </div>
                        <div className="playtester-badges">
                          <span><i className="pt-dot" /> Iedereen ziet de battlefield</span>
                          <span><i className="pt-lock">●</i> Hand is privé</span>
                        </div>
                      </div>

                      <section className="panel playtester-toolbox">
                        <div className="pt-section-heading">
                          <div>
                            <h3>Basic lands</h3>
                            <p>Voeg direct een land toe aan jouw battlefield. Je hoeft niet op een beurt te wachten.</p>
                          </div>
                          <span className="pt-count">5 types</span>
                        </div>
                        <div className="playtester-land-buttons">
                          {BASIC_LANDS.map((land) => (
                            <button
                              className={`pt-land-button land-${land.toLowerCase()}`}
                              key={land}
                              type="button"
                              onClick={() => playBasicLand(land)}
                              disabled={spectator || !myPlayer}
                            >
                              <span className="pt-land-mark">{land === "Plains" ? "☼" : land === "Island" ? "◌" : land === "Swamp" ? "◕" : land === "Mountain" ? "▲" : "♣"}</span>
                              <span><strong>{land}</strong><small>Voeg toe</small></span>
                              <span className="pt-add">+</span>
                            </button>
                          ))}
                        </div>
                      </section>

                      <section className="panel playtester-zone private-hand-zone">
                        <div className="pt-section-heading">
                          <div>
                            <h3>Jouw hand <span className="pt-private-tag">PRIVÉ</span></h3>
                            <p>Alleen jij ziet de kaarten in je hand. Klik op een kaart om deze groter te bekijken.</p>
                          </div>
                          <span className="pt-count">{spectator ? "Verborgen" : `${matchPrivate?.hand.length ?? 0} kaarten`}</span>
                        </div>
                        {spectator || !matchPrivate ? (
                          <div className="pt-empty">Je kijkt mee. Handkaarten zijn niet zichtbaar voor toeschouwers.</div>
                        ) : matchPrivate.hand.length === 0 ? (
                          <div className="pt-empty">Je hand is leeg. Gebruik de basic lands hierboven om te oefenen.</div>
                        ) : (
                          <div className="pt-card-grid pt-hand-grid">
                            {matchPrivate.hand.map((card) => {
                              const image = imgProxy(card.image || card.faces?.[0]?.image);
                              const landName = basicLandName(card);
                              return (
                                <article className="pt-card" key={card.instanceId}>
                                  <button className="pt-card-art" type="button" onClick={() => setSelectedCard(card)} aria-label={`Bekijk ${card.name}`}>
                                    {image ? <img src={image} alt={card.name} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <span className="pt-card-placeholder">{card.name}</span>}
                                  </button>
                                  <button className="pt-card-name" type="button" onClick={() => setSelectedCard(card)} title={card.name}>{card.name}</button>
                                  <small className="pt-card-type">{card.type_line || "Kaart"}</small>
                                  {landName && (
                                    <button className="pt-card-action" type="button" onClick={() => playCard(card, card.faceIndex || 0)} disabled={spectator}>Speel land</button>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </section>

                      <section className="playtester-battlefields">
                        <div className="pt-section-heading pt-board-heading">
                          <div>
                            <h3>Battlefield</h3>
                            <p>Iedereen ziet deze kaarten. Klik op een kaart voor de grote weergave; de eigenaar kan deze tappen of untappen.</p>
                          </div>
                          <span className="pt-count">{activeGame.players.reduce((total, player) => total + (player.battlefield?.length || 0), 0)} kaarten op tafel</span>
                        </div>

                        {activeGame.players.map((player) => (
                          <section className={`pt-player-board ${player.id === playerId ? "is-own-board" : ""}`} key={player.id}>
                            <div className="pt-player-board-heading">
                              <div className="pt-player-avatar">{player.name.slice(0, 1).toUpperCase()}</div>
                              <div className="pt-player-heading-text">
                                <strong>{player.name}{player.id === playerId ? " (jij)" : ""}</strong>
                                <span>{player.battlefield?.length || 0} permanents · {player.connected === false ? "offline" : "online"}</span>
                              </div>
                              {player.isHost && <span className="pt-host-chip">HOST</span>}
                            </div>
                            {!player.battlefield?.length ? (
                              <div className="pt-empty pt-board-empty">Nog geen kaarten op deze battlefield.</div>
                            ) : (
                              <div className="pt-card-grid pt-battlefield-grid">
                                {player.battlefield.map((permanent) => {
                                  const image = imgProxy(permanent.image || permanent.faces?.[permanent.faceIndex || 0]?.image);
                                  const isBasic = Boolean(basicLandName(permanent));
                                  return (
                                    <article className={`pt-card ${permanent.tapped ? "is-tapped" : ""}`} key={permanent.permanentId || permanent.instanceId}>
                                      <button className="pt-card-art" type="button" onClick={() => setSelectedCard(permanent)} aria-label={`Bekijk ${permanent.name}`}>
                                        {image ? <img src={image} alt={permanent.name} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <span className="pt-card-placeholder">{permanent.name}</span>}
                                        {permanent.tapped && <span className="pt-tapped-badge">TAPPED</span>}
                                      </button>
                                      <button className="pt-card-name" type="button" onClick={() => setSelectedCard(permanent)} title={permanent.name}>{permanent.name}</button>
                                      <small className="pt-card-type">{permanent.type_line || "Permanent"}</small>
                                      <div className="pt-card-actions">
                                        {player.id === playerId && !spectator ? (
                                          <button className={permanent.tapped ? "is-untap" : ""} type="button" onClick={() => togglePermanentTap(permanent)}>{permanent.tapped ? "Untap" : "Tap"}</button>
                                        ) : (
                                          <span>{permanent.tapped ? "Tapped" : "Ready"}</span>
                                        )}
                                        {isBasic && <span className="pt-basic-chip">BASIC</span>}
                                      </div>
                                    </article>
                                  );
                                })}
                              </div>
                            )}
                          </section>
                        ))}
                      </section>
                    </section>
                  )}

                  {/* Eindmatch */}
                  {activeGame.status === "finished" && (
                    <section className="panel play-section">
                      <div className="match-winner">
                        <CheckCircle2
                          size={40}
                          color="#8be0b4"
                        />
                        <h2>
                          {match?.winnerName
                            ? `${match.winnerName} wint!`
                            : "Game afgelopen"}
                        </h2>
                        <p>
                          De match is afgerond. Hieronder staat je
                          persoonlijke draftpool.
                        </p>
                      </div>

                      <h3 className="zone-title">
                        Jouw kaartenpool
                      </h3>

                      <div className="card-grid">
                        {(draftPrivate?.picks ||
                          matchPrivate?.picks ||
                          []
                        ).map((card) => (
                          <CardTile
                            key={card.instanceId}
                            card={card}
                            onPreview={setSelectedCard}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>

            {/* Tafelaanwijzingen en moderatie blijven rechts zichtbaar */}
            <aside className="chat-panel panel">
              {activeGame && (
                <section className="table-side-controls">
                  <div className="pt-side-heading">
                    <div>
                      <h3>Tafelbediening</h3>
                      <p>Iedereen kan de tafel verlaten.</p>
                    </div>
                    <button className="pt-leave-button" type="button" onClick={leaveGame}>
                      <span>×</span> Quit &amp; leave lobby
                    </button>
                  </div>
                  {activeGame.status === "playing" && !spectator && !activeGame.voteKick && (
                    <div className="pt-kick-list">
                      <strong>Vote kick</strong>
                      <small>Start een stemming als iemand de tafel verstoort.</small>
                      {activeGame.players.filter((player) => player.id !== playerId).map((player) => (
                        <button className="pt-kick-player" type="button" key={player.id} onClick={() => startVoteKick(player)}>
                          <span className="pt-kick-avatar">{player.name.slice(0, 1).toUpperCase()}</span>
                          <span>Vote kick <b>{player.name}</b></span>
                          <span className="pt-kick-arrow">›</span>
                        </button>
                      ))}
                      {activeGame.players.length < 2 && <small>Er is niemand anders aan tafel om op te stemmen.</small>}
                    </div>
                  )}
                  {activeGame.status === "playing" && activeVoteKick && (
                    <div className="pt-vote-box">
                      <div className="pt-vote-title">Stemming actief</div>
                      <strong>{voteKickTarget?.name || "Speler"} verwijderen?</strong>
                      <p>{activeVoteKick.yesVotes.length} voor · {activeVoteKick.noVotes.length} tegen · {activeVoteKick.required} stemmen nodig</p>
                      {canVoteKick && (
                        <div className="pt-vote-actions">
                          <button className="pt-vote-yes" type="button" onClick={() => castVoteKick("yes")}>{alreadyVotedKick && activeVoteKick.yesVotes.includes(playerId) ? "✓ Voor" : "Voor"}</button>
                          <button className="pt-vote-no" type="button" onClick={() => castVoteKick("no")}>{alreadyVotedKick && activeVoteKick.noVotes.includes(playerId) ? "✓ Tegen" : "Tegen"}</button>
                        </div>
                      )}
                      {playerId === activeVoteKick.targetPlayerId && <small>Je kunt niet over jezelf stemmen.</small>}
                    </div>
                  )}
                </section>
              )}
              <div className="chat-heading">
                <div className="heading-icon green">
                  <MessageCircle />
                </div>

                <div>
                  <h3>Game chat</h3>
                  <p>Praat met iedereen aan tafel</p>
                </div>

                <span className="chat-live">
                  <span className="dot online" />
                  LIVE
                </span>
              </div>

              <div className="chat-context">
                {activeGame?.title || "Geen game geselecteerd"}
              </div>

              <div className="messages">
                {messages.map((message) => (
                  <div
                    className={`message ${
                      message.system ? "system-message" : ""
                    }`}
                    key={message.id}
                  >
                    <div className="message-top">
                      <strong>{message.name}</strong>
                      <time>
                        {new Date(message.at).toLocaleTimeString(
                          [],
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                          }
                        )}
                      </time>
                    </div>

                    <p>{message.text}</p>
                  </div>
                ))}

                <div ref={chatEnd} />

                {messages.length === 0 && (
                  <div className="chat-empty">
                    <MessageCircle />
                    <span>
                      De chat is nog stil.
                      <br />
                      Zeg hallo!
                    </span>
                  </div>
                )}
              </div>

              <form
                className="chat-compose"
                onSubmit={sendChat}
              >
                <input
                  value={chatText}
                  onChange={(event) =>
                    setChatText(event.target.value)
                  }
                  placeholder={activeGame?.status === "playing" ? "Beschrijf wat je doet…" : "Typ een bericht…"}
                  maxLength={500}
                  disabled={!activeGameId}
                />

                <button
                  className="send-button"
                  type="submit"
                  aria-label="Bericht versturen"
                  disabled={!activeGameId || !chatText.trim()}
                >
                  <Send size={17} />
                </button>
              </form>

              <div className="chat-footnote">
                Draft Arena · realtime multiplayer
              </div>
            </aside>
          </main>
        )}

        <footer className="app-footer">
          <span>
            Draft Arena <b>3.0</b>
          </span>
          <span>
            <span className="dot online" />
            Scryfall via Render
          </span>
          <span>
            Draft night <Sparkles size={13} />
          </span>
        </footer>
      </div>

      <CardModal
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
      />
    </>
  );
}

export default App;
