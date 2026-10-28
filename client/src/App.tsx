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
} from "lucide-react";

const SERVER =
  (import.meta as any).env.VITE_SERVER_URL ||
  window.location.origin;

type Player = {
  id: string;
  name: string;
  ready: boolean;
  isHost: boolean;
  connected?: boolean;
};

type Msg = {
  id: string;
  name: string;
  text: string;
  at: number;
  system: boolean;
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
};

type Card = {
  id: string;
  name: string;
  image: string | null;
  small: string | null;
  mana_cost: string;
  type_line: string;
  oracle_text: string;
};

type SetInfo = {
  code: string;
  name: string;
};

const fallbackSets: SetInfo[] = [
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

function countVotes(
  votes: VoteTotals | undefined,
  category: "sets" | "boosters"
): number {
  const totals: Record<string, number> =
    votes?.[category] ?? {};

  return Object.values(totals).reduce<number>(
    (total, count) => total + Number(count || 0),
    0
  );
}

function proxiedImage(
  url: string | null,
  size = "normal"
): string {
  if (!url) return "";

  try {
    const parsed = new URL(url);

    if (size === "small") {
      parsed.pathname = parsed.pathname.replace(
        "/normal/",
        "/small/"
      );
    }

    return `${SERVER}/api/image?url=${encodeURIComponent(
      parsed.toString()
    )}`;
  } catch {
    return "";
  }
}

// Tijdelijke afbeeldingscache in het geheugen van de browser.
const imageMemory = new Map<string, string>();

function useCachedImage(
  url: string | null,
  size = "normal"
): string {
  const [src, setSrc] = useState("");

  useEffect(() => {
    if (!url) {
      setSrc("");
      return;
    }

    const proxied = proxiedImage(url, size);

    if (!proxied) {
      setSrc("");
      return;
    }

    const cached = imageMemory.get(proxied);

    if (cached) {
      setSrc(cached);
      return;
    }

    let cancelled = false;

    fetch(proxied)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Afbeelding kon niet worden geladen");
        }

        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;

        const objectUrl = URL.createObjectURL(blob);

        imageMemory.set(proxied, objectUrl);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(proxied);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, size]);

  return src;
}

function CardImage({
  card,
  onClick,
  small = false,
}: {
  card: Card;
  onClick: () => void;
  small?: boolean;
}) {
  const src = useCachedImage(
    card.image,
    small ? "small" : "normal"
  );

  return (
    <button
      className={`card-image ${small ? "small" : ""}`}
      onClick={onClick}
      title={`Bekijk ${card.name}`}
      type="button"
    >
      <div className="image-wrap">
        {src ? (
          <img
            src={src}
            alt={card.name}
            loading="lazy"
          />
        ) : (
          <div className="card-placeholder">
            <ImageIcon size={28} />
            <span>{card.name}</span>
          </div>
        )}
      </div>
    </button>
  );
}

function Modal({
  card,
  onClose,
}: {
  card: Card | null;
  onClose: () => void;
}) {
  // De hook wordt altijd aangeroepen, ook wanneer er geen kaart is.
  const src = useCachedImage(card?.image ?? null);

  if (!card) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
    >
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

        {src ? (
          <img src={src} alt={card.name} />
        ) : (
          <div className="large-placeholder">
            {card.name}
          </div>
        )}

        <div className="modal-info">
          <h2>{card.name}</h2>
          <p>{card.mana_cost}</p>
          <strong>{card.type_line}</strong>
          <p>{card.oracle_text}</p>
          <small>Scryfall kaart-ID: {card.id}</small>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [socket, setSocket] = useState<Socket | null>(
    null
  );
  const [connected, setConnected] = useState(false);

  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem("draft-name") || ""
  );
  const [joined, setJoined] = useState(false);
  const [playerId, setPlayerId] = useState("");

  const [games, setGames] = useState<Game[]>([]);
  const [sets, setSets] = useState<SetInfo[]>(
    fallbackSets
  );

  const [activeGameId, setActiveGameId] = useState("");
  const [selectedSet, setSelectedSet] = useState("ltr");
  const [boosterCount, setBoosterCount] = useState(3);
  const [maxPlayers, setMaxPlayers] = useState(8);

  const [newTitle, setNewTitle] = useState("");
  const [chatText, setChatText] = useState("");

  const [draftCards, setDraftCards] = useState<Card[]>([]);
  const [myPicks, setMyPicks] = useState<Card[]>([]);
  const [selectedCard, setSelectedCard] =
    useState<Card | null>(null);

  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<
    "all" | "lobby" | "active"
  >("all");
  const [screen, setScreen] = useState<
    "home" | "arena"
  >("home");

  const chatEnd = useRef<HTMLDivElement>(null);

  const activeGame =
    games.find((game) => game.id === activeGameId) ??
    null;

  const myPlayer = activeGame?.players.find(
    (player) => player.id === playerId
  );

  const messages = activeGame?.messages ?? [];

  const visibleGames = useMemo(
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

  // Serververbinding en realtime events.
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
      (data: {
        games?: Game[];
        sets?: SetInfo[];
      }) => {
        setGames(data.games ?? []);

        if (data.sets?.length) {
          setSets(data.sets);
        }
      }
    );

    connection.on(
      "identity",
      (data: {
        playerId: string;
        playerName?: string;
      }) => {
        setPlayerId(data.playerId);

        if (data.playerName) {
          setPlayerName(data.playerName);
        }
      }
    );

    connection.on(
      "game-created",
      (data: { gameId: string }) => {
        setActiveGameId(data.gameId);
        setScreen("arena");
      }
    );

    connection.on(
      "game-joined",
      (data: { gameId: string }) => {
        setActiveGameId(data.gameId);
        setScreen("arena");
      }
    );

    connection.on("notice", (text: string) => {
      setNotice(text);
      window.setTimeout(() => setNotice(""), 4200);
    });

    connection.on(
      "booster",
      (data: {
        gameId: string;
        cards: Card[];
      }) => {
        setActiveGameId(data.gameId);
        setDraftCards(data.cards ?? []);
        setMyPicks([]);
        setScreen("arena");
      }
    );

    connection.on(
      "pick-confirmed",
      (data: {
        card: Card;
        picks: Card[];
      }) => {
        setMyPicks(data.picks ?? []);

        if (data.card) {
          setDraftCards((previous) =>
            previous.filter(
              (card) => card.id !== data.card.id
            )
          );
        }
      }
    );

    return () => {
      connection.disconnect();
    };
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages.length, activeGameId]);

  useEffect(() => {
    if (joined && socket) {
      socket.emit("join-arena", { playerName });
    }
  }, [joined, socket]);

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
    if (!activeGameId || !socket) return;

    socket.emit("vote", {
      gameId: activeGameId,
      setCode: selectedSet,
      boosterCount,
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

  const startDraft = () => {
    if (!activeGameId || !socket) return;

    socket.emit("start-game", {
      gameId: activeGameId,
    });
  };

  const loadBooster = () => {
    if (!activeGameId || !socket) return;

    socket.emit("request-booster", {
      gameId: activeGameId,
    });
  };

  const pick = (card: Card) => {
    if (!activeGameId || !socket) return;

    socket.emit("pick-card", {
      gameId: activeGameId,
      cardId: card.id,
    });
  };

  const backToLobby = () => {
    setScreen("home");
    setActiveGameId("");
    setDraftCards([]);
    setMyPicks([]);
    setSelectedCard(null);
  };

  const renamePlayer = () => {
    const name = playerName.trim().slice(0, 24);

    if (!name) return;

    setPlayerName(name);
    localStorage.setItem("draft-name", name);

    socket?.emit("rename-player", {
      playerName: name,
    });
  };

  if (!joined) {
    return (
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
            Join een lobby, stem op de set en boosters,
            en draft samen met vrienden.
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
              <Layers size={15} /> Scryfall kaarten
            </span>
          </div>
        </div>

        <div className="start-footer">
          <span
            className={
              connected ? "dot online" : "dot"
            }
          />
          {connected
            ? "Server verbonden"
            : "Verbinden met server…"}
          <span>·</span> Versie 1.0 MVP
        </div>
      </main>
    );
  }

  return (
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
          className="toast"
          onClick={() => setNotice("")}
          role="status"
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
              {games.length} games live
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
                Lobby naam
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
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        renamePlayer();
                      }
                    }}
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
                Stel samen met de lobby je draft in.
              </div>
            </section>

            <section className="panel games-panel">
              <div className="panel-heading">
                <div className="heading-icon blue">
                  <Swords />
                </div>

                <div>
                  <h3>Alle games</h3>
                  <p>Ook games die al bezig zijn</p>
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
                  Alle games <b>{games.length}</b>
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
                {visibleGames.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <Users />
                    </div>

                    <strong>Nog geen games</strong>

                    <span>
                      Maak de eerste lobby en nodig
                      spelers uit.
                    </span>
                  </div>
                ) : (
                  visibleGames.map((game) => (
                    <div
                      className="game-row"
                      key={game.id}
                    >
                      <div
                        className={`game-art ${
                          game.status !== "lobby"
                            ? "active-art"
                            : ""
                        }`}
                      >
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
                        : "LIVE GAME"}
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
                      : activeGame.status === "finished"
                        ? "Afgelopen"
                        : "Bezig"}
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
                        {activeGame.maxPlayers} plaatsen
                        gevuld
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
                          De meeste stemmen bepalen de
                          instellingen.
                        </p>
                      </div>
                    </div>

                    <div className="vote-fields">
                      <div>
                        <label htmlFor="draft-set">
                          Welke set?
                        </label>

                        <select
                          id="draft-set"
                          value={selectedSet}
                          onChange={(event) =>
                            setSelectedSet(
                              event.target.value
                            )
                          }
                        >
                          {sets.map((set) => (
                            <option
                              key={set.code}
                              value={set.code}
                            >
                              {set.name}
                            </option>
                          ))}
                        </select>
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
                                className={
                                  boosterCount === number
                                    ? "booster selected"
                                    : "booster"
                                }
                                onClick={() =>
                                  setBoosterCount(number)
                                }
                                type="button"
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
                      De host start wanneer iedereen klaar
                      is. Bij een gelijkspel wint de
                      standaardinstelling als die gelijk
                      eindigt.
                    </p>
                  </section>
                ) : (
                  <section className="panel draft-panel">
                    <div className="panel-heading">
                      <div className="heading-icon purple">
                        <Layers />
                      </div>

                      <div>
                        <h3>
                          {activeGame.status === "finished"
                            ? "Game afgelopen"
                            : "Jouw booster"}
                        </h3>

                        <p>
                          {draftCards.length
                            ? `${draftCards.length} kaarten over · ${myPicks.length} gekozen`
                            : "Laad je kaarten via de serverproxy."}
                        </p>
                      </div>

                      {myPlayer &&
                        activeGame.status ===
                          "drafting" && (
                          <button
                            className="secondary small-button"
                            onClick={loadBooster}
                            type="button"
                          >
                            Laad booster
                          </button>
                        )}
                    </div>

                    {!myPlayer ? (
                      <div className="draft-empty">
                        <Eye size={28} />
                        <strong>
                          Je kijkt mee als toeschouwer
                        </strong>
                        <span>
                          Je ziet de gedeelde chat, maar
                          niet de handkaarten van spelers.
                        </span>
                      </div>
                    ) : draftCards.length > 0 ? (
                      <div className="draft-cards">
                        {draftCards.map((card) => (
                          <div
                            key={card.id}
                            className="draft-card"
                          >
                            <CardImage
                              card={card}
                              onClick={() =>
                                setSelectedCard(card)
                              }
                            />

                            <button
                              className="pick-button"
                              onClick={() => pick(card)}
                              type="button"
                            >
                              Kies kaart
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="draft-empty">
                        <Layers size={28} />
                        <strong>
                          Je booster verschijnt hier
                        </strong>
                        <span>
                          Klik op “Laad booster” om kaarten
                          op te halen via Render.
                        </span>
                      </div>
                    )}

                    {myPicks.length > 0 && (
                      <>
                        <h4>
                          Jouw picks ({myPicks.length})
                        </h4>

                        <div className="picks-strip">
                          {myPicks.map((card) => (
                            <CardImage
                              key={card.id}
                              card={card}
                              small
                              onClick={() =>
                                setSelectedCard(card)
                              }
                            />
                          ))}
                        </div>
                      </>
                    )}

                    {myPlayer?.isHost &&
                      activeGame.status ===
                        "drafting" && (
                        <div className="game-actions">
                          <button
                            className="secondary"
                            onClick={() =>
                              socket?.emit("end-game", {
                                gameId: activeGame.id,
                              })
                            }
                            type="button"
                          >
                            Draft beëindigen
                          </button>
                        </div>
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
              {activeGame?.title || "Geen game geselecteerd"}
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

              {!messages.length && (
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
              Wees sportief. Spelacties worden in de log
              bijgehouden.
            </div>
          </aside>
        </main>
      )}

      <footer className="app-footer">
        <span>
          Draft Arena <b>v1.0</b>
        </span>

        <span>
          <span className="dot online" />
          Scryfall via Render proxy
        </span>

        <span>
          Gemaakt voor draft night <Sparkles size={13} />
        </span>
      </footer>

      <Modal
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
      />
    </div>
  );
}

export default App;
