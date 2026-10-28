import {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import {
  Swords,
  Users,
  MessageCircle,
  Layers,
  Vote,
  Play,
  Plus,
  Eye,
  Send,
  X,
  Sparkles,
  ArrowLeft,
  Image as ImageIcon,
  Search,
  LoaderCircle,
  RotateCcw,
  CheckCircle2,
  ArrowLeftRight,
  Minus,
  Mountain,
  BookOpen,
} from "lucide-react";

const SERVER = (
  (import.meta as any).env.VITE_SERVER_URL ||
  window.location.origin
).replace(/\/+$/, "");

const BASIC_LANDS = [
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
] as const;

type BasicLand = (typeof BASIC_LANDS)[number];

type BasicLands = Record<BasicLand, number>;

type CardFace = {
  name: string;
  image: string | null;
  small: string | null;
  mana_cost: string;
  type_line: string;
  oracle_text: string;
};

type Card = {
  id: string;
  instanceId?: string;
  name: string;
  image: string | null;
  small: string | null;
  mana_cost: string;
  type_line: string;
  oracle_text: string;
  rarity?: string;
  layout?: string;
  faces?: CardFace[];
};

type Player = {
  id: string;
  name: string;
  ready: boolean;
  isHost: boolean;
  connected?: boolean;
  hasPicked?: boolean;
  picksCount?: number;
};

type Msg = {
  id: string;
  name: string;
  text: string;
  at: number;
  system: boolean;
};

type SetInfo = {
  code: string;
  name: string;
  released_at?: string | null;
  set_type?: string | null;
};

type VoteTotals = {
  sets?: Record<string, number>;
  boosters?: Record<string, number>;
};

type Game = {
  id: string;
  title: string;
  status: string;
  setCode: string;
  setName: string;
  boosterCount: number;
  hostName: string;
  players: Player[];
  maxPlayers: number;
  createdAt: number;
  votes: VoteTotals;
  messages: Msg[];
  draftRound: number;
  draftPick: number;
  picksDone: number;
  direction?: "left" | "right" | null;
  pickProgress?: number;
};

type PrivateDraftState = {
  gameId: string;
  status: string;
  booster: Card[];
  picks: Card[];
  basicLands: BasicLands;
  hasPicked: boolean;
  round: number;
  boosterCount: number;
  pick: number;
  direction: "left" | "right" | null;
  remaining: number;
};

const EMPTY_LANDS: BasicLands = {
  Plains: 0,
  Island: 0,
  Swamp: 0,
  Mountain: 0,
  Forest: 0,
};

const FALLBACK_SETS: SetInfo[] = [
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

const PLAY_CSS = `
  .spin { animation: draft-spin 1s linear infinite; }
  @keyframes draft-spin { to { transform: rotate(360deg); } }

  .play-summary {
    display:flex; align-items:center; justify-content:space-between;
    flex-wrap:wrap; gap:12px; margin:14px 0 18px;
  }
  .play-summary-item {
    display:flex; flex-direction:column; gap:4px;
    padding:12px 16px; border-radius:12px;
    border:1px solid var(--border,#343746);
    background:rgba(139,92,246,.08); min-width:105px;
  }
  .play-summary-item strong { font-size:1.2rem; }
  .play-summary-item span { opacity:.72; font-size:.8rem; }
  .pick-progress-track {
    height:7px; border-radius:20px; overflow:hidden;
    background:rgba(128,128,128,.2); margin:10px 0;
  }
  .pick-progress-fill {
    height:100%; background:#a78bfa; border-radius:20px;
    transition:width .2s ease;
  }
  .draft-status-box {
    display:flex; align-items:flex-start; gap:12px;
    padding:14px 16px; margin:14px 0;
    border:1px solid var(--border,#343746); border-radius:12px;
    background:rgba(139,92,246,.08);
  }
  .draft-status-box p { margin:4px 0 0; opacity:.75; font-size:.9rem; }
  .play-card-grid {
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(145px,1fr));
    gap:15px; margin:20px 0;
  }
  .play-card {
    min-width:0; padding:9px;
    border-radius:13px; border:1px solid var(--border,#343746);
    background:rgba(255,255,255,.025);
    display:flex; flex-direction:column; gap:8px;
  }
  .play-card:has(.choose-card:not(:disabled):hover) {
    border-color:rgba(167,139,250,.65);
  }
  .play-card-photo {
    display:block; width:100%; padding:0; border:0;
    overflow:hidden; border-radius:9px;
    background:rgba(128,128,128,.12); cursor:zoom-in;
    aspect-ratio:5/7;
  }
  .play-card-photo img {
    display:block; width:100%; height:100%;
    object-fit:contain; border-radius:9px;
  }
  .play-card-placeholder {
    height:100%; display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    gap:8px; padding:8px; text-align:center; opacity:.75;
  }
  .play-card-controls {
    display:flex; flex-wrap:wrap; gap:5px; align-items:center;
  }
  .play-card-name {
    display:block; width:100%; font-size:.84rem;
    font-weight:650; overflow-wrap:anywhere;
  }
  .flip-card-btn,.card-details-btn {
    flex:1; min-width:0; padding:6px 7px;
    border:1px solid var(--border,#343746); border-radius:7px;
    background:transparent; color:inherit; cursor:pointer;
    font-size:.75rem;
  }
  .flip-card-btn:hover,.card-details-btn:hover {
    border-color:#a78bfa;
  }
  .choose-card {
    width:100%; padding:9px 6px; border:0;
    border-radius:8px; background:#8b5cf6;
    color:white; font-weight:700; cursor:pointer;
  }
  .choose-card:disabled {
    cursor:not-allowed; background:rgba(128,128,128,.25);
    color:inherit; opacity:.7;
  }
  .draft-lock-note {
    display:flex; align-items:center; gap:8px;
    font-size:.9rem; opacity:.8; margin:12px 0;
  }
  .drafted-pool {
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(115px,1fr));
    gap:12px; margin:18px 0;
  }
  .drafted-pool .play-card { padding:6px; }
  .drafted-pool .play-card-name { font-size:.75rem; }
  .basic-land-grid {
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(155px,1fr));
    gap:10px; margin:18px 0;
  }
  .basic-land-card {
    display:flex; align-items:center; gap:10px;
    padding:12px; border:1px solid var(--border,#343746);
    border-radius:12px; background:rgba(255,255,255,.025);
  }
  .land-symbol {
    width:40px; height:40px; flex-shrink:0;
    display:flex; align-items:center; justify-content:center;
    border-radius:50%; background:rgba(139,92,246,.14);
  }
  .land-details { min-width:0; flex:1; }
  .land-details strong { display:block; }
  .land-details small { opacity:.65; }
  .land-qty {
    display:flex; align-items:center; gap:7px;
    font-variant-numeric:tabular-nums;
  }
  .land-qty button {
    width:27px; height:27px; display:flex;
    justify-content:center; align-items:center;
    border:1px solid var(--border,#343746);
    border-radius:7px; background:transparent;
    color:inherit; cursor:pointer;
  }
  .land-qty button:disabled { opacity:.3; cursor:not-allowed; }
  .deck-count-bar {
    display:flex; flex-wrap:wrap; justify-content:space-between;
    align-items:center; gap:12px; padding:14px;
    border:1px solid var(--border,#343746); border-radius:12px;
    background:rgba(139,92,246,.08);
  }
  .deck-count-bar strong { font-size:1.2rem; }
  .set-search-input {
    width:100%; box-sizing:border-box; padding:11px 12px;
    border:1px solid var(--border,#343746); border-radius:9px;
    background:transparent; color:inherit;
  }
  .set-option {
    display:flex; width:100%; align-items:center; gap:10px;
    padding:10px; text-align:left; border:1px solid transparent;
    border-radius:8px; background:transparent; color:inherit;
    cursor:pointer;
  }
  .set-option:hover { background:rgba(139,92,246,.08); }
  .set-option.selected {
    border-color:#a78bfa; background:rgba(139,92,246,.14);
  }
  .set-option-code {
    min-width:42px; text-align:center; padding:4px;
    border-radius:6px; background:rgba(128,128,128,.12);
    font-size:.74rem; font-weight:800;
  }
  .set-option-name { flex:1; min-width:0; }
  .set-option-name small { display:block; opacity:.65; margin-top:3px; }
  .set-option-check { color:#a78bfa; font-weight:800; }
  .card-modal-img {
    display:block; width:100%; max-width:330px;
    max-height:70vh; object-fit:contain;
    margin:0 auto; border-radius:12px;
  }
  .modal-flip-row {
    display:flex; justify-content:center; gap:9px;
    flex-wrap:wrap; margin:12px 0;
  }
  .modal-flip-row button {
    display:flex; align-items:center; gap:6px;
    padding:8px 12px; border:1px solid var(--border,#343746);
    border-radius:8px; color:inherit;
    background:transparent; cursor:pointer;
  }
  .pool-heading {
    display:flex; justify-content:space-between; align-items:center;
    flex-wrap:wrap; gap:8px; margin-top:24px;
  }
  .pool-heading p { margin:4px 0 0; opacity:.7; font-size:.9rem; }
  .play-action-row {
    display:flex; flex-wrap:wrap; gap:10px; margin-top:16px;
  }
  @media(max-width:600px) {
    .play-card-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
    .drafted-pool { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .basic-land-grid { grid-template-columns:1fr; }
    .play-card { padding:6px; }
    .play-card-name { font-size:.78rem; }
  }
`;

function countVotes(
  votes: VoteTotals | undefined,
  category: "sets" | "boosters"
): number {
  return Object.values(votes?.[category] ?? {}).reduce<number>(
    (total, value) => total + Number(value || 0),
    0
  );
}

function imageProxy(url: string | null | undefined): string {
  if (!url) return "";

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") return "";

    return `${SERVER}/api/image?url=${encodeURIComponent(
      parsed.toString()
    )}`;
  } catch {
    return "";
  }
}

function faceFor(card: Card, faceIndex: number): CardFace {
  return (
    card.faces?.[faceIndex] || {
      name: card.name,
      image: card.image,
      small: card.small,
      mana_cost: card.mana_cost,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
    }
  );
}

// --------------------------------------------------
// Kaarttegel: toont de kaart, laat flippen en kiezen toe.
// --------------------------------------------------

function CardTile({
  card,
  onPick,
  disabled = false,
  onPreview,
  compact = false,
}: {
  card: Card;
  onPick?: () => void;
  disabled?: boolean;
  onPreview: (card: Card) => void;
  compact?: boolean;
}) {
  const [faceIndex, setFaceIndex] = useState(0);

  useEffect(() => {
    setFaceIndex(0);
  }, [card.instanceId, card.id]);

  const face = faceFor(card, faceIndex);
  const image = imageProxy(face.image || card.image);
  const doubleFaced = (card.faces?.length ?? 0) > 1;

  const flip = () => {
    const total = card.faces?.length ?? 0;
    if (total > 1) {
      setFaceIndex((current) => (current + 1) % total);
    }
  };

  return (
    <article
      className={`play-card ${compact ? "play-card-compact" : ""}`}
    >
      <button
        className="play-card-photo"
        type="button"
        onClick={() => onPreview(card)}
        title={`Bekijk ${face.name}`}
      >
        {image ? (
          <img src={image} alt={face.name} loading="lazy" />
        ) : (
          <div className="play-card-placeholder">
            <ImageIcon size={25} />
            <span>{face.name}</span>
          </div>
        )}
      </button>

      <div className="play-card-controls">
        <span className="play-card-name" title={face.name}>
          {face.name}
        </span>

        {doubleFaced && (
          <button
            className="flip-card-btn"
            type="button"
            onClick={flip}
            title="Draai naar de andere kaartzijde"
          >
            <RotateCcw size={12} /> Flip
          </button>
        )}

        <button
          className="card-details-btn"
          type="button"
          onClick={() => onPreview(card)}
        >
          Bekijk
        </button>
      </div>

      {onPick && (
        <button
          className="choose-card"
          type="button"
          disabled={disabled}
          onClick={onPick}
        >
          {disabled ? "Pick gedaan" : "Kies kaart"}
        </button>
      )}
    </article>
  );
}

// --------------------------------------------------
// Modal met kaartdetails en flipfunctie.
// --------------------------------------------------

function CardModal({
  card,
  onClose,
}: {
  card: Card | null;
  onClose: () => void;
}) {
  const [faceIndex, setFaceIndex] = useState(0);

  useEffect(() => {
    setFaceIndex(0);
  }, [card?.instanceId, card?.id]);

  if (!card) return null;

  const face = faceFor(card, faceIndex);
  const image = imageProxy(face.image || card.image);
  const doubleFaced = (card.faces?.length ?? 0) > 1;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="icon-button close"
          onClick={onClose}
          type="button"
          aria-label="Sluiten"
        >
          <X />
        </button>

        {image ? (
          <img
            className="card-modal-img"
            src={image}
            alt={face.name}
          />
        ) : (
          <div className="large-placeholder">{face.name}</div>
        )}

        {doubleFaced && (
          <div className="modal-flip-row">
            <button
              type="button"
              onClick={() =>
                setFaceIndex(
                  (current) =>
                    (current + 1) % (card.faces?.length ?? 1)
                )
              }
            >
              <ArrowLeftRight size={16} />
              Draai kaart
            </button>

            {(card.faces || []).map((item, index) => (
              <button
                key={`${item.name}-${index}`}
                type="button"
                onClick={() => setFaceIndex(index)}
                aria-pressed={faceIndex === index}
              >
                {index + 1}. {item.name}
              </button>
            ))}
          </div>
        )}

        <div className="modal-info">
          <h2>{face.name}</h2>
          <p>{face.mana_cost}</p>
          <strong>{face.type_line}</strong>
          <p>{face.oracle_text}</p>
          <small>Setkaart-ID: {card.id}</small>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------
// App
// --------------------------------------------------

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

  const [activeGameId, setActiveGameId] = useState("");
  const [selectedSet, setSelectedSet] = useState("ltr");
  const [boosterCount, setBoosterCount] = useState(3);
  const [maxPlayers, setMaxPlayers] = useState(8);

  const [newTitle, setNewTitle] = useState("");
  const [chatText, setChatText] = useState("");

  const [draftCards, setDraftCards] = useState<Card[]>([]);
  const [myPicks, setMyPicks] = useState<Card[]>([]);
  const [basicLands, setBasicLands] =
    useState<BasicLands>({ ...EMPTY_LANDS });
  const basicLandsRef = useRef<BasicLands>({ ...EMPTY_LANDS });

  const [hasPicked, setHasPicked] = useState(false);
  const [privateStateLoaded, setPrivateStateLoaded] =
    useState(false);
  const [privateRound, setPrivateRound] = useState(0);
  const [privatePick, setPrivatePick] = useState(0);
  const [privateDirection, setPrivateDirection] =
    useState<"left" | "right" | null>(null);

  const [spectator, setSpectator] = useState(false);
  const [selectedCard, setSelectedCard] =
    useState<Card | null>(null);

  const [notice, setNotice] = useState("");
  const [screen, setScreen] = useState<"home" | "arena">("home");
  const [tab, setTab] = useState<"all" | "lobby" | "active">(
    "all"
  );

  const chatEnd = useRef<HTMLDivElement>(null);

  const activeGame =
    games.find((game) => game.id === activeGameId) ?? null;

  const myPlayer = activeGame?.players.find(
    (player) => player.id === playerId
  );

  const messages = activeGame?.messages ?? [];

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
        set.code.toLocaleLowerCase().includes(query) ||
        (set.set_type || "")
          .toLocaleLowerCase()
          .includes(query)
    );
  }, [sets, setSearch]);

  const pickedPlayers =
    activeGame?.players.filter((player) => player.hasPicked)
      .length ?? 0;

  const landTotal = BASIC_LANDS.reduce(
    (total, name) => total + basicLands[name],
    0
  );

  const deckTotal = myPicks.length + landTotal;

  // ------------------------------------------------
  // Socket.IO
  // ------------------------------------------------

  useEffect(() => {
    const connection = io(SERVER, {
      transports: ["websocket", "polling"],
    });

    setSocket(connection);

    connection.on("connect", () => {
      setConnected(true);
    });

    connection.on("disconnect", () => {
      setConnected(false);
    });

    connection.on(
      "state",
      (data: { games?: Game[]; sets?: SetInfo[] }) => {
        setGames(data.games ?? []);

        if (data.sets?.length) {
          setSets(data.sets);
        }
      }
    );

    connection.on(
      "identity",
      (data: { playerId: string }) => {
        setPlayerId(data.playerId);
      }
    );

    connection.on(
      "game-created",
      (data: { gameId: string }) => {
        setActiveGameId(data.gameId);
        setScreen("arena");
        setSpectator(false);
      }
    );

    connection.on(
      "game-joined",
      (data: { gameId: string; watching?: boolean }) => {
        setActiveGameId(data.gameId);
        setScreen("arena");
        setSpectator(Boolean(data.watching));
      }
    );

    connection.on("notice", (message: string) => {
      setNotice(message);
    });

    connection.on(
      "draft-private-state",
      (data: PrivateDraftState) => {
        setActiveGameId(data.gameId);
        setDraftCards(data.booster ?? []);
        setMyPicks(data.picks ?? []);

        const lands: BasicLands = {
          ...EMPTY_LANDS,
          ...(data.basicLands || {}),
        };

        basicLandsRef.current = lands;
        setBasicLands(lands);

        setHasPicked(Boolean(data.hasPicked));
        setPrivateRound(Number(data.round) || 0);
        setPrivatePick(Number(data.pick) || 0);
        setPrivateDirection(data.direction || null);
        setPrivateStateLoaded(true);

        setSpectator(false);
        setScreen("arena");
      }
    );

    connection.on(
      "draft-round-started",
      (data: {
        round: number;
        boosterCount: number;
        direction: "left" | "right";
      }) => {
        setNotice(
          `Booster ${data.round}/${data.boosterCount} gestart. Doorgeven naar ${data.direction === "left" ? "links" : "rechts"}.`
        );
      }
    );

    connection.on("draft-finished", () => {
      setHasPicked(false);
      setNotice(
        "Draft afgerond! Je kunt nu basic lands toevoegen."
      );
    });

    return () => {
      connection.disconnect();
    };
  }, []);

  // Spelernaam doorgeven nadat het startscherm is voltooid.
  useEffect(() => {
    if (joined && socket) {
      socket.emit("join-arena", { playerName });
    }
  }, [joined, socket, playerName]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages.length, activeGameId]);

  // ------------------------------------------------
  // Volledige setlijst laden
  // ------------------------------------------------

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
          .sort((a, b) => {
            return (
              String(b.released_at || "").localeCompare(
                String(a.released_at || "")
              ) || a.name.localeCompare(b.name)
            );
          });

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
            "De volledige setlijst kon niet worden geladen. De standaardsets worden getoond."
          );
        }
      } finally {
        if (!cancelled) {
          setSetsLoading(false);
        }
      }
    }

    void loadSets();

    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------
  // Acties
  // ------------------------------------------------

  const enter = () => {
    const name = playerName.trim().slice(0, 24);

    if (!name) {
      setNotice("Vul eerst een spelersnaam in.");
      return;
    }

    localStorage.setItem("draft-name", name);
    setPlayerName(name);
    setJoined(true);
    setScreen("home");
  };

  const createGame = () => {
    if (!socket || !connected) {
      setNotice("De server is nog niet verbonden.");
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
    setScreen("arena");

    if (game.status === "lobby") {
      socket.emit("join-game", { gameId: game.id });
    } else {
      socket.emit("watch-game", { gameId: game.id });
    }
  };

  const vote = () => {
    if (!socket || !activeGameId) return;

    socket.emit("vote", {
      gameId: activeGameId,
      setCode: selectedSet,
      boosterCount,
    });
  };

  const startDraft = () => {
    if (!socket || !activeGameId) return;

    setPrivateStateLoaded(false);
    socket.emit("start-game", { gameId: activeGameId });
  };

  const doPick = (card: Card) => {
    if (!socket || !activeGameId || hasPicked) return;

    const cardId = card.instanceId || card.id;

    socket.emit("pick-card", {
      gameId: activeGameId,
      cardId,
    });
  };

  const updateBasicLand = (
    name: BasicLand,
    delta: number
  ) => {
    if (
      !socket ||
      !activeGameId ||
      activeGame?.status !== "finished" ||
      spectator
    ) {
      return;
    }

    const current = basicLandsRef.current;
    const nextCount = Math.max(
      0,
      Math.min(60, current[name] + delta)
    );

    if (nextCount === current[name]) return;

    const next: BasicLands = {
      ...current,
      [name]: nextCount,
    };

    const total = BASIC_LANDS.reduce(
      (sum, land) => sum + next[land],
      0
    );

    if (total > 100) {
      setNotice(
        "Je kunt maximaal 100 basic lands toevoegen."
      );
      return;
    }

    basicLandsRef.current = next;
    setBasicLands(next);

    socket.emit("set-basic-lands", {
      gameId: activeGameId,
      lands: next,
    });
  };

  const sendChat = (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    const text = chatText.trim();

    if (!text || !activeGameId || !socket) return;

    socket.emit("chat-message", {
      gameId: activeGameId,
      text,
    });

    setChatText("");
  };

  const renamePlayer = () => {
    const name = playerName.trim().slice(0, 24);

    if (!name) return;

    localStorage.setItem("draft-name", name);

    socket?.emit("rename-player", {
      playerName: name,
    });
  };

  const backToLobby = () => {
    setScreen("home");
    setActiveGameId("");
    setDraftCards([]);
    setMyPicks([]);
    setSelectedCard(null);
    setHasPicked(false);
    setPrivateStateLoaded(false);
    setSpectator(false);
  };

  // ------------------------------------------------
  // Render
  // ------------------------------------------------

  return (
    <>
      <style>{PLAY_CSS}</style>

      {!joined ? (
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

            <h2>Jouw volgende draft begint hier.</h2>

            <p>
              Stem op een Magic-set, draft kaarten met je
              vrienden en bouw daarna je eigen pool op.
            </p>

            <label htmlFor="start-player-name">
              Spelersnaam
            </label>

            <input
              id="start-player-name"
              value={playerName}
              onChange={(event) =>
                setPlayerName(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") enter();
              }}
              placeholder="Bijv. GandalfTheGrey"
              maxLength={24}
            />

            <button
              className="primary full"
              onClick={enter}
              type="button"
            >
              <Play size={17} />
              Naar de lobby
            </button>

            <div className="feature-row">
              <span>
                <Users size={15} /> Multiplayer
              </span>
              <span>
                <Vote size={15} /> Stemmen
              </span>
              <span>
                <Layers size={15} /> Kaarten doorgeven
              </span>
            </div>
          </div>

          <div className="start-footer">
            <span
              className={connected ? "dot online" : "dot"}
            />
            {connected
              ? "Server verbonden"
              : "Verbinden met server…"}
            <span>·</span> Draft Arena
          </div>
        </main>
      ) : (
        <div className="app-shell">
          <header className="topbar">
            <button
              className="brand mini"
              onClick={backToLobby}
              type="button"
            >
              <div className="brand-icon">
                <Swords />
              </div>

              <div>
                <span className="eyebrow">
                  MULTIPLAYER
                </span>
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
              className="toast"
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
                    Vind een tafel, stem mee en start een
                    nieuwe draft.
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
                    placeholder={`${playerName}'s draft`}
                    maxLength={50}
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
                          setMaxPlayers(
                            Number(event.target.value)
                          )
                        }
                      >
                        {[2, 3, 4, 5, 6, 7, 8].map(
                          (number) => (
                            <option
                              key={number}
                              value={number}
                            >
                              {number} spelers
                            </option>
                          )
                        )}
                      </select>
                    </div>

                    <div>
                      <label htmlFor="player-name-edit">
                        Jouw naam
                      </label>

                      <input
                        id="player-name-edit"
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
                    onClick={createGame}
                    type="button"
                  >
                    <Plus size={17} />
                    Lobby aanmaken
                  </button>

                  <div className="mini-note">
                    <Sparkles size={14} />
                    Stem met elkaar over set en boosters.
                  </div>
                </section>

                <section className="panel games-panel">
                  <div className="panel-heading">
                    <div className="heading-icon blue">
                      <Swords />
                    </div>

                    <div>
                      <h3>Alle games</h3>
                      <p>Open en actieve tafels</p>
                    </div>

                    <span className="count-badge">
                      {games.length}
                    </span>
                  </div>

                  <div className="tabs">
                    <button
                      className={
                        tab === "all" ? "selected" : ""
                      }
                      onClick={() => setTab("all")}
                      type="button"
                    >
                      Alle <b>{games.length}</b>
                    </button>

                    <button
                      className={
                        tab === "lobby" ? "selected" : ""
                      }
                      onClick={() => setTab("lobby")}
                      type="button"
                    >
                      Lobby's{" "}
                      <b>
                        {
                          games.filter(
                            (game) =>
                              game.status === "lobby"
                          ).length
                        }
                      </b>
                    </button>

                    <button
                      className={
                        tab === "active" ? "selected" : ""
                      }
                      onClick={() => setTab("active")}
                      type="button"
                    >
                      Bezig{" "}
                      <b>
                        {
                          games.filter(
                            (game) =>
                              game.status !== "lobby"
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
                          Maak de eerste lobby om te beginnen.
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
                                {game.players.length}/
                                {game.maxPlayers}
                              </span>

                              <span
                                className={`status ${
                                  game.status !== "lobby"
                                    ? "playing"
                                    : ""
                                }`}
                              >
                                {game.status === "lobby"
                                  ? "Lobby open"
                                  : game.status === "finished"
                                    ? "Afgelopen"
                                    : game.status === "loading"
                                      ? "Kaarten laden"
                                      : "Bezig"}
                              </span>
                            </div>
                          </div>

                          <button
                            className="join-button"
                            onClick={() => joinGame(game)}
                            type="button"
                          >
                            {game.status === "lobby"
                              ? "Join"
                              : "Bekijk"}
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
                  onClick={backToLobby}
                  type="button"
                >
                  <ArrowLeft size={16} />
                  Alle games
                </button>

                {!activeGame ? (
                  <div className="panel empty-game">
                    <h2>Selecteer een game</h2>
                    <p>Kies een lobby uit het overzicht.</p>
                  </div>
                ) : (
                  <>
                    <div className="game-title-row">
                      <div>
                        <div className="eyebrow">
                          {activeGame.status === "lobby"
                            ? "LOBBY ROOM"
                            : "DRAFT ARENA"}
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
                          : activeGame.status === "loading"
                            ? "Boosterpacks laden"
                            : activeGame.status === "finished"
                              ? "Draft afgelopen"
                              : "Draft bezig"}
                      </span>
                    </div>

                    <section className="panel roster-panel">
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
                        {activeGame.players.map(
                          (player, index) => (
                            <div
                              className="roster-player"
                              key={player.id}
                            >
                              <div
                                className={`avatar ${
                                  index === 0
                                    ? "host-avatar"
                                    : ""
                                }`}
                              >
                                {player.name
                                  .slice(0, 1)
                                  .toUpperCase()}
                              </div>

                              <div>
                                <strong>{player.name}</strong>
                                <span>
                                  {player.isHost
                                    ? "Host"
                                    : player.id === playerId
                                      ? "Jij"
                                      : "Speler"}
                                  {activeGame.status ===
                                    "drafting" &&
                                    player.hasPicked
                                    ? " · pick gedaan"
                                    : ""}
                                </span>
                              </div>

                              {player.isHost && (
                                <span className="host-tag">
                                  HOST
                                </span>
                              )}
                            </div>
                          )
                        )}
                      </div>
                    </section>

                    {activeGame.status === "lobby" ? (
                      <section className="panel vote-panel">
                        <div className="panel-heading">
                          <div className="heading-icon gold">
                            <Vote />
                          </div>

                          <div>
                            <h3>Stem voor de draft</h3>
                            <p>
                              Kies een set en aantal boosters.
                            </p>
                          </div>
                        </div>

                        <div className="vote-fields">
                          <div>
                            <label htmlFor="set-search">
                              Zoek een Magic-set
                            </label>

                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                marginBottom: 8,
                              }}
                            >
                              <Search size={18} />

                              <input
                                id="set-search"
                                className="set-search-input"
                                type="search"
                                value={setSearch}
                                onChange={(event) =>
                                  setSetSearch(
                                    event.target.value
                                  )
                                }
                                placeholder="Naam of setcode…"
                              />
                            </div>

                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 8,
                              }}
                            >
                              <small>
                                {setsLoading
                                  ? "Sets laden…"
                                  : `${filteredSets.length} van ${sets.length} sets`}
                              </small>

                              {setsLoading && (
                                <LoaderCircle
                                  size={15}
                                  className="spin"
                                />
                              )}
                            </div>

                            {setsError && (
                              <p
                                style={{
                                  color: "#eab308",
                                  fontSize: ".85rem",
                                }}
                              >
                                {setsError}
                              </p>
                            )}

                            <div
                              style={{
                                maxHeight: 260,
                                overflowY: "auto",
                                border: "1px solid var(--border,#343746)",
                                borderRadius: 10,
                                padding: 5,
                              }}
                            >
                              {filteredSets.length === 0 ? (
                                <div style={{ padding: 15 }}>
                                  Geen sets gevonden.
                                </div>
                              ) : (
                                filteredSets.map((set) => {
                                  const selected =
                                    selectedSet === set.code;

                                  return (
                                    <button
                                      className={`set-option ${
                                        selected
                                          ? "selected"
                                          : ""
                                      }`}
                                      type="button"
                                      role="option"
                                      aria-selected={selected}
                                      key={set.code}
                                      onClick={() =>
                                        setSelectedSet(set.code)
                                      }
                                    >
                                      <span className="set-option-code">
                                        {set.code.toUpperCase()}
                                      </span>

                                      <span className="set-option-name">
                                        {set.name}
                                        {set.released_at && (
                                          <small>
                                            {set.released_at}
                                            {set.set_type
                                              ? ` · ${set.set_type}`
                                              : ""}
                                          </small>
                                        )}
                                      </span>

                                      {selected && (
                                        <span className="set-option-check">
                                          ✓
                                        </span>
                                      )}
                                    </button>
                                  );
                                })
                              )}
                            </div>

                            <p className="subtle-note">
                              Gekozen:{" "}
                              <strong>
                                {sets.find(
                                  (set) =>
                                    set.code === selectedSet
                                )?.name || selectedSet}
                              </strong>
                            </p>
                          </div>

                          <div>
                            <label>
                              Aantal boosters per speler
                            </label>

                            <div className="booster-options">
                              {[1, 2, 3, 4, 5, 6].map(
                                (number) => (
                                  <button
                                    key={number}
                                    type="button"
                                    className={
                                      boosterCount === number
                                        ? "booster selected"
                                        : "booster"
                                    }
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
                                )
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="vote-footer">
                          <div className="vote-summary">
                            <span>
                              <Vote size={15} />
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
                            onClick={vote}
                            type="button"
                          >
                            Stem uitbrengen
                          </button>
                        </div>

                        {myPlayer?.isHost && (
                          <button
                            className="primary full start-draft"
                            onClick={startDraft}
                            type="button"
                          >
                            <Play size={17} />
                            Start draft
                          </button>
                        )}

                        <p className="subtle-note">
                          Na het starten krijgt iedere speler
                          automatisch een booster van 14 kaarten.
                        </p>
                      </section>
                    ) : activeGame.status === "loading" ? (
                      <section className="panel draft-panel">
                        <div className="draft-status-box">
                          <LoaderCircle
                            size={24}
                            className="spin"
                          />
                          <div>
                            <strong>Boosters samenstellen</strong>
                            <p>
                              De kaarten worden opgehaald en de
                              persoonlijke boosters worden klaargezet.
                            </p>
                          </div>
                        </div>
                      </section>
                    ) : activeGame.status === "drafting" ? (
                      <section className="panel draft-panel">
                        {spectator || !myPlayer ? (
                          <div className="draft-status-box">
                            <Eye size={25} />
                            <div>
                              <strong>
                                Je kijkt mee als toeschouwer
                              </strong>
                              <p>
                                De kaartkeuzes en boosters van andere
                                spelers blijven privé tijdens de draft.
                              </p>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="panel-heading">
                              <div className="heading-icon purple">
                                <Layers />
                              </div>

                              <div>
                                <h3>
                                  Booster{" "}
                                  {privateRound ||
                                    activeGame.draftRound}
                                  /
                                  {activeGame.boosterCount}
                                </h3>
                                <p>
                                  Pick{" "}
                                  {privatePick ||
                                    activeGame.draftPick}
                                  /14 ·{" "}
                                  {draftCards.length} kaarten
                                  over
                                </p>
                              </div>
                            </div>

                            <div className="play-summary">
                              <div className="play-summary-item">
                                <span>Booster</span>
                                <strong>
                                  {privateRound ||
                                    activeGame.draftRound}
                                  /{activeGame.boosterCount}
                                </strong>
                              </div>

                              <div className="play-summary-item">
                                <span>Pick</span>
                                <strong>
                                  {privatePick ||
                                    activeGame.draftPick}
                                  /14
                                </strong>
                              </div>

                              <div className="play-summary-item">
                                <span>Gekozen</span>
                                <strong>{myPicks.length}</strong>
                              </div>

                              <div className="play-summary-item">
                                <span>Doorgifte</span>
                                <strong>
                                  {privateDirection === "left"
                                    ? "← Links"
                                    : privateDirection === "right"
                                      ? "Rechts →"
                                      : activeGame.direction ===
                                          "left"
                                        ? "← Links"
                                        : "Rechts →"}
                                </strong>
                              </div>
                            </div>

                            <div className="draft-status-box">
                              {hasPicked ? (
                                <CheckCircle2
                                  size={23}
                                  color="#86efac"
                                />
                              ) : (
                                <ArrowLeftRight size={23} />
                              )}

                              <div>
                                <strong>
                                  {hasPicked
                                    ? "Je kaart is gekozen"
                                    : "Kies één kaart"}
                                </strong>
                                <p>
                                  {hasPicked
                                    ? "Je resterende booster wordt automatisch doorgegeven zodra de andere spelers ook hebben gekozen."
                                    : "Je kunt een kaart bekijken of flippen voordat je deze kiest."}
                                </p>
                              </div>
                            </div>

                            <div className="pick-progress-track">
                              <div
                                className="pick-progress-fill"
                                style={{
                                  width: `${
                                    activeGame.players.length
                                      ? (pickedPlayers /
                                          activeGame.players.length) *
                                        100
                                      : 0
                                  }%`,
                                }}
                              />
                            </div>

                            <small>
                              {pickedPlayers} van{" "}
                              {activeGame.players.length} spelers
                              hebben hun huidige pick gedaan.
                            </small>

                            {draftCards.length > 0 ? (
                              <div className="play-card-grid">
                                {draftCards.map((card) => (
                                  <CardTile
                                    key={
                                      card.instanceId || card.id
                                    }
                                    card={card}
                                    disabled={hasPicked}
                                    onPick={() => doPick(card)}
                                    onPreview={setSelectedCard}
                                  />
                                ))}
                              </div>
                            ) : (
                              <div className="draft-status-box">
                                <LoaderCircle
                                  size={22}
                                  className="spin"
                                />
                                <div>
                                  <strong>
                                    Wachten op je booster
                                  </strong>
                                  <p>
                                    De server deelt de volgende
                                    booster automatisch uit.
                                  </p>
                                </div>
                              </div>
                            )}

                            {hasPicked && (
                              <p className="draft-lock-note">
                                <CheckCircle2 size={16} />
                                Geen tweede pick mogelijk deze beurt.
                              </p>
                            )}

                            {myPlayer.isHost && (
                              <div className="play-action-row">
                                <button
                                  className="secondary"
                                  type="button"
                                  onClick={() =>
                                    socket?.emit("end-game", {
                                      gameId: activeGame.id,
                                    })
                                  }
                                >
                                  Draft beëindigen
                                </button>
                              </div>
                            )}
                          </>
                        )}

                        {!spectator && (
                          <div className="pool-heading">
                            <div>
                              <h3>Jouw picks</h3>
                              <p>
                                {myPicks.length} kaarten in je
                                persoonlijke draftpool
                              </p>
                            </div>
                          </div>
                        )}

                        {!spectator && myPicks.length > 0 && (
                          <div className="drafted-pool">
                            {myPicks
                              .slice(-12)
                              .map((card) => (
                                <CardTile
                                  key={
                                    card.instanceId || card.id
                                  }
                                  card={card}
                                  compact
                                  onPreview={setSelectedCard}
                                />
                              ))}
                          </div>
                        )}
                      </section>
                    ) : (
                      <section className="panel draft-panel">
                        {!myPlayer || spectator ? (
                          <div className="draft-status-box">
                            <CheckCircle2 size={25} />
                            <div>
                              <strong>Draft afgerond</strong>
                              <p>
                                Je bekijkt deze game als toeschouwer.
                              </p>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="panel-heading">
                              <div className="heading-icon purple">
                                <CheckCircle2 />
                              </div>

                              <div>
                                <h3>Je draft is klaar!</h3>
                                <p>
                                  Bekijk je kaartenpool en voeg
                                  basic lands toe aan je deck.
                                </p>
                              </div>
                            </div>

                            <div className="deck-count-bar">
                              <div>
                                <span>Decktotaal</span>
                                <br />
                                <strong>
                                  {deckTotal} kaarten
                                </strong>
                              </div>

                              <div>
                                <span>Gedraft</span>
                                <br />
                                <strong>
                                  {myPicks.length}
                                </strong>
                              </div>

                              <div>
                                <span>Basic lands</span>
                                <br />
                                <strong>{landTotal}</strong>
                              </div>
                            </div>

                            <div className="pool-heading">
                              <div>
                                <h3>Basic lands toevoegen</h3>
                                <p>
                                  Kies hoeveel basislanden je wilt
                                  toevoegen. Je kunt dit aanpassen.
                                </p>
                              </div>
                            </div>

                            <div className="basic-land-grid">
                              {BASIC_LANDS.map((land) => (
                                <div
                                  className="basic-land-card"
                                  key={land}
                                >
                                  <div className="land-symbol">
                                    <Mountain size={20} />
                                  </div>

                                  <div className="land-details">
                                    <strong>{land}</strong>
                                    <small>Basic land</small>
                                  </div>

                                  <div className="land-qty">
                                    <button
                                      type="button"
                                      aria-label={`Minder ${land}`}
                                      disabled={
                                        basicLands[land] <= 0
                                      }
                                      onClick={() =>
                                        updateBasicLand(
                                          land,
                                          -1
                                        )
                                      }
                                    >
                                      <Minus size={13} />
                                    </button>

                                    <strong>
                                      {basicLands[land]}
                                    </strong>

                                    <button
                                      type="button"
                                      aria-label={`Meer ${land}`}
                                      disabled={
                                        landTotal >= 100 ||
                                        basicLands[land] >= 60
                                      }
                                      onClick={() =>
                                        updateBasicLand(
                                          land,
                                          1
                                        )
                                      }
                                    >
                                      <Plus size={13} />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>

                            <p className="subtle-note">
                              Je landaantallen worden op de server
                              bijgehouden voor deze tijdelijke game.
                            </p>

                            <div className="pool-heading">
                              <div>
                                <h3>Jouw draftpool</h3>
                                <p>
                                  {myPicks.length} kaarten gekozen
                                  tijdens de draft. Flip kaarten om
                                  de achterkant te bekijken.
                                </p>
                              </div>
                            </div>

                            {myPicks.length > 0 ? (
                              <div className="drafted-pool">
                                {myPicks.map((card) => (
                                  <CardTile
                                    key={
                                      card.instanceId || card.id
                                    }
                                    card={card}
                                    compact
                                    onPreview={setSelectedCard}
                                  />
                                ))}
                              </div>
                            ) : (
                              <div className="draft-status-box">
                                <BookOpen size={22} />
                                <div>
                                  <strong>
                                    Geen picks opgeslagen
                                  </strong>
                                  <p>
                                    Deze game is mogelijk handmatig
                                    beëindigd voordat je kaarten kon
                                    kiezen.
                                  </p>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </section>
                    )}
                  </>
                )}
              </div>

              <aside className="chat-panel panel">
                <div className="chat-heading">
                  <div className="heading-icon green">
                    <MessageCircle />
                  </div>

                  <div>
                    <h3>Lobby chat</h3>
                    <p>Praat met iedereen aan tafel</p>
                  </div>

                  <span className="chat-live">
                    <span className="dot online" />
                    LIVE
                  </span>
                </div>

                <div className="chat-context">
                  {activeGame?.title ||
                    "Geen game geselecteerd"}
                </div>

                <div className="messages">
                  {messages.map((message) => (
                    <div
                      className={`message ${
                        message.system
                          ? "system-message"
                          : ""
                      }`}
                      key={message.id}
                    >
                      <div className="message-top">
                        <strong>{message.name}</strong>
                        <time>
                          {new Date(
                            message.at
                          ).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
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
                    placeholder="Typ een bericht…"
                    disabled={!activeGameId}
                    maxLength={500}
                  />

                  <button
                    className="send-button"
                    type="submit"
                    disabled={
                      !activeGameId || !chatText.trim()
                    }
                    aria-label="Bericht versturen"
                  >
                    <Send size={17} />
                  </button>
                </form>

                <div className="chat-footnote">
                  Draft Arena · tijdelijke game
                </div>
              </aside>
            </main>
          )}

          <footer className="app-footer">
            <span>
              Draft Arena <b>2.0</b>
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
      )}

      <CardModal
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
      />
    </>
  );
}

export default App;
