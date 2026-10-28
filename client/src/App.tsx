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
      }
    );

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

  const backToHome = () => {
    setScreen("home");
    setActiveGameId("");
    setSelectedCard(null);
    setSpectator(false);
    setDraftPrivate(null);
    setMatchPrivate(null);
    setSelectedAttackers([]);
    setBlockAssignments({});
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
    if (draftPrivate?.deckReady) return;

    setBasicLands((current) => {
      const next = {
        ...current,
        [name]: Math.max(0, Math.min(60, current[name] + delta)),
      };

      const total = BASIC_LANDS.reduce(
        (sum, land) => sum + next[land],
        0
      );

      if (total > 100) {
        setNoticeMessage("Je kunt maximaal 100 basic lands toevoegen.");
        return current;
      }

      return next;
    });
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
                              ? "Match bezig"
                              : activeGame.status === "finished"
                                ? "Game afgelopen"
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
                            setBasicLands({ ...EMPTY_LANDS });
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

                  {/* Speelbord */}
                  {activeGame.status === "playing" && match && (
                    <>
                      <section className="panel play-section">
                        <div className="section-bar">
                          <div>
                            <h3>
                              <Swords
                                size={17}
                                style={{
                                  display: "inline",
                                  marginRight: 7,
                                }}
                              />
                              Spelbord
                            </h3>

                            <p>
                              Beurt {match.turnNumber} ·{" "}
                              {match.phase === "main1"
                                ? "Hoofdfase 1"
                                : match.phase === "combat"
                                  ? `Combat — ${match.combatStep}`
                                  : match.phase === "main2"
                                    ? "Hoofdfase 2"
                                    : match.phase === "end"
                                      ? "Eindfase"
                                      : match.phase}
                            </p>
                          </div>

                          <span
                            className={`status ${
                              isMyTurn ? "playing" : ""
                            }`}
                          >
                            {isMyTurn
                              ? "Jouw beurt"
                              : `${
                                  activeGame.players.find(
                                    (player) =>
                                      player.id ===
                                      match.activePlayerId
                                  )?.name || "Tegenstander"
                                } speelt`}
                          </span>
                        </div>

                        <div className="game-stats">
                          <div className="stat-card">
                            <span>Jouw leven</span>
                            <strong>
                              <Heart
                                size={15}
                                style={{
                                  display: "inline",
                                  color: "#ff9eae",
                                }}
                              />{" "}
                              {myPlayer?.life ?? 20}
                            </strong>
                          </div>

                          <div className="stat-card">
                            <span>Hand</span>
                            <strong>
                              {matchPrivate?.hand.length ?? 0}
                            </strong>
                          </div>

                          <div className="stat-card">
                            <span>Library</span>
                            <strong>
                              {matchPrivate?.libraryCount ?? 0}
                            </strong>
                          </div>

                          <div className="stat-card">
                            <span>Land gespeeld</span>
                            <strong>
                              {matchPrivate?.landPlayed ? "Ja" : "Nee"}
                            </strong>
                          </div>
                        </div>

                        <div className="mana-row">
                          {COLORS.map((color) => (
                            <span
                              className="mana-pill"
                              title={MANA_LABEL[color]}
                              key={color}
                            >
                              {color}:{" "}
                              <strong>
                                {currentMana[color] || 0}
                              </strong>
                            </span>
                          ))}
                        </div>

                        {isMyTurn && (
                          <div className="turn-actions">
                            {(match.phase === "main1" ||
                              match.phase === "main2" ||
                              match.phase === "end") && (
                              <button
                                className="primary"
                                type="button"
                                onClick={advancePhase}
                              >
                                {match.phase === "main1"
                                  ? "Naar combat"
                                  : match.phase === "main2"
                                    ? "Naar eindfase"
                                    : "Einde beurt"}
                                <ChevronRight size={15} />
                              </button>
                            )}

                            {match.phase === "combat" &&
                              match.combatStep === "attackers" && (
                                <button
                                  className="secondary"
                                  type="button"
                                  onClick={advancePhase}
                                >
                                  Combat overslaan
                                </button>
                              )}

                            <button
                              className="secondary"
                              type="button"
                              onClick={concede}
                            >
                              <Flag size={14} />
                              Opgeven
                            </button>
                          </div>
                        )}

                        {match.phase === "combat" &&
                          match.combatStep === "attackers" &&
                          isMyTurn && (
                            <>
                              <div className="status-box">
                                <Swords size={20} />
                                <div>
                                  <strong>
                                    Kies je aanvallers
                                  </strong>
                                  <p>
                                    Selecteer creatures die mogen
                                    aanvallen en kies hun verdediger.
                                  </p>
                                </div>
                              </div>

                              {(myPlayer?.battlefield || [])
                                .filter(
                                  (card) =>
                                    cardIsCreature(card) &&
                                    !card.tapped &&
                                    (!card.summoningSick ||
                                      cardHasKeyword(card, "haste"))
                                )
                                .map((creature) => (
                                  <div
                                    className="land-item"
                                    key={creature.permanentId}
                                  >
                                    <label
                                      className="deck-select-row"
                                      style={{ margin: 0 }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedAttackers.includes(
                                          creature.permanentId || ""
                                        )}
                                        onChange={() =>
                                          setSelectedAttackers(
                                            (current) =>
                                              current.includes(
                                                creature.permanentId || ""
                                              )
                                                ? current.filter(
                                                    (key) =>
                                                      key !==
                                                      creature.permanentId
                                                  )
                                                : [
                                                    ...current,
                                                    creature.permanentId || "",
                                                  ]
                                          )
                                        }
                                      />

                                      <span>
                                        {creature.name} (
                                        {powerToughness(creature)})
                                      </span>
                                    </label>

                                    <select
                                      disabled={
                                        !selectedAttackers.includes(
                                          creature.permanentId || ""
                                        )
                                      }
                                      value={
                                        attackTargets[
                                          creature.permanentId || ""
                                        ] ||
                                        opponents[0]?.id ||
                                        ""
                                      }
                                      onChange={(event) =>
                                        setAttackTargets(
                                          (current) => ({
                                            ...current,
                                            [creature.permanentId || ""]:
                                              event.target.value,
                                          })
                                        )
                                      }
                                    >
                                      {opponents.map((opponent) => (
                                        <option
                                          key={opponent.id}
                                          value={opponent.id}
                                        >
                                          {opponent.name} (
                                          {opponent.life ?? 20} leven)
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                ))}

                              <button
                                className="primary full"
                                type="button"
                                onClick={declareAttackers}
                              >
                                Aanvallen bevestigen
                              </button>
                            </>
                          )}

                        {match.phase === "combat" &&
                          match.combatStep === "blockers" &&
                          isDefender && (
                            <>
                              <div className="status-box">
                                <Shield size={20} />
                                <div>
                                  <strong>
                                    Kies je blockers
                                  </strong>
                                  <p>
                                    Wijs elk eigen creature toe aan
                                    maximaal één aanvallend creature.
                                  </p>
                                </div>
                              </div>

                              {(myPlayer?.battlefield || [])
                                .filter(
                                  (card) =>
                                    cardIsCreature(card) &&
                                    !card.tapped
                                )
                                .map((blocker) => (
                                  <div
                                    className="land-item"
                                    key={blocker.permanentId}
                                  >
                                    <div className="land-desc">
                                      <strong>{blocker.name}</strong>
                                      <small>
                                        {powerToughness(blocker)}
                                      </small>
                                    </div>

                                    <select
                                      value={
                                        blockAssignments[
                                          blocker.permanentId || ""
                                        ] || ""
                                      }
                                      onChange={(event) =>
                                        setBlockAssignments(
                                          (current) => ({
                                            ...current,
                                            [blocker.permanentId || ""]:
                                              event.target.value,
                                          })
                                        )
                                      }
                                    >
                                      <option value="">
                                        Niet blocken
                                      </option>

                                      {incomingAttacks.map(
                                        (attack) => {
                                          const owner =
                                            activeGame.players.find(
                                              (player) =>
                                                player.id ===
                                                attack.attackerControllerId
                                            );

                                          const attacker =
                                            owner?.battlefield?.find(
                                              (card) =>
                                                card.permanentId ===
                                                attack.attackerId
                                            );

                                          return (
                                            <option
                                              key={attack.attackerId}
                                              value={attack.attackerId}
                                            >
                                              {attacker?.name ||
                                                "Attacker"}{" "}
                                              ({owner?.name})
                                            </option>
                                          );
                                        }
                                      )}
                                    </select>
                                  </div>
                                ))}

                              <button
                                className="primary full"
                                type="button"
                                onClick={submitBlockers}
                              >
                                Blockers bevestigen
                              </button>
                            </>
                          )}

                        {match.phase === "combat" &&
                          match.combatStep === "blockers" &&
                          !isDefender && (
                            <div className="status-box">
                              <LoaderCircle className="spin" />
                              <div>
                                <strong>Wachten op blockers</strong>
                                <p>
                                  De verdediger(s) wijzen hun blockers
                                  toe.
                                </p>
                              </div>
                            </div>
                          )}
                      </section>

                      {/* Alle battlefieldkaarten */}
                      <section className="panel play-section">
                        <div className="section-bar">
                          <div>
                            <h3>Battlefield</h3>
                            <p>
                              Permanente kaarten van alle spelers.
                            </p>
                          </div>
                        </div>

                        {activeGame.players
                          .filter((player) => !player.eliminated)
                          .map((player) => (
                            <div
                              className={`table-player ${
                                match.activePlayerId === player.id
                                  ? "active-turn"
                                  : ""
                              }`}
                              key={player.id}
                            >
                              <div className="table-player-head">
                                <div className="table-player-id">
                                  <span className="avatar">
                                    {player.name
                                      .slice(0, 1)
                                      .toUpperCase()}
                                  </span>

                                  <div>
                                    <strong>
                                      {player.name}
                                      {player.id === playerId
                                        ? " (jij)"
                                        : ""}
                                    </strong>

                                    <small>
                                      {player.handCount ?? 0} kaarten
                                      in hand ·{" "}
                                      {player.libraryCount ?? 0} in
                                      library ·{" "}
                                      {player.graveyard?.length ?? 0} in
                                      graveyard
                                    </small>
                                  </div>
                                </div>

                                <span className="life-pill">
                                  <Heart size={14} />
                                  {player.life ?? 20}
                                </span>
                              </div>

                              <div className="battlefield-row">
                                {!player.battlefield?.length ? (
                                  <span className="card-tile-meta">
                                    Nog geen permanents op het battlefield.
                                  </span>
                                ) : (
                                  player.battlefield.map(
                                    (permanent) => {
                                      const face =
                                        faceAt(
                                          permanent,
                                          permanent.faceIndex || 0
                                        );

                                      const image = imgProxy(
                                        face.image || permanent.image
                                      );

                                      return (
                                        <div
                                          className={`permanent ${
                                            permanent.tapped
                                              ? "tapped"
                                              : ""
                                          }`}
                                          key={permanent.permanentId}
                                        >
                                          {image ? (
                                            <img
                                              src={image}
                                              alt={permanent.name}
                                              onClick={() =>
                                                setSelectedCard(permanent)
                                              }
                                            />
                                          ) : (
                                            <div className="card-art-placeholder">
                                              {permanent.name}
                                            </div>
                                          )}

                                          <div className="permanent-name">
                                            {permanent.tapped
                                              ? "↻ "
                                              : ""}
                                            {permanent.name}
                                          </div>

                                          <div className="permanent-stats">
                                            {cardIsCreature(permanent)
                                              ? powerToughness(permanent)
                                              : permanent.type_line}
                                            {permanent.damageMarked
                                              ? ` · ${permanent.damageMarked} schade`
                                              : ""}
                                          </div>

                                          {player.id === playerId &&
                                            isMyTurn &&
                                            cardIsLand(permanent) && (
                                              <button
                                                type="button"
                                                disabled={Boolean(
                                                  permanent.tapped
                                                )}
                                                onClick={() =>
                                                  tapLand(permanent)
                                                }
                                              >
                                                Tap voor mana
                                              </button>
                                            )}

                                          {player.id === playerId &&
                                            isMyTurn &&
                                            permanent.faces &&
                                            permanent.faces.length > 1 &&
                                            ["transform", "modal_dfc"].includes(
                                              permanent.layout || ""
                                            ) && (
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  flipPermanent(permanent)
                                                }
                                              >
                                                Flip / transform
                                              </button>
                                            )}
                                        </div>
                                      );
                                    }
                                  )
                                )}
                              </div>
                            </div>
                          ))}
                      </section>

                      {/* Handkaarten */}
                      <section className="panel play-section">
                        <div className="section-bar">
                          <div>
                            <h3>Jouw hand</h3>
                            <p>
                              Speel landen, tap mana en cast spells.
                            </p>
                          </div>

                          <span className="count-badge">
                            {matchPrivate?.hand.length ?? 0} kaarten
                          </span>
                        </div>

                        {!matchPrivate ? (
                          <div className="empty-zone">
                            Je hand wordt geladen…
                          </div>
                        ) : (
                          <>
                            <div className="land-item">
                              <div className="land-desc">
                                <strong>Spell targets</strong>
                                <small>
                                  Voor de eenvoudige kaart-effecten die
                                  een target nodig hebben.
                                </small>
                              </div>
                              <div
                                className="two-fields"
                                style={{ width: "100%" }}
                              >
                                <div className="select-field">
                                  <label htmlFor="target-player">
                                    Target speler
                                  </label>

                                  <select
                                    id="target-player"
                                    value={targetPlayerId}
                                    onChange={(event) =>
                                      setTargetPlayerId(
                                        event.target.value
                                      )
                                    }
                                  >
                                    <option value="">
                                      Geen target
                                    </option>
                                    {activeGame.players
                                      .filter((p) => !p.eliminated)
                                      .map((player) => (
                                        <option
                                          key={player.id}
                                          value={player.id}
                                        >
                                          {player.name}
                                        </option>
                                      ))}
                                  </select>
                                </div>

                                <div className="select-field">
                                  <label htmlFor="target-permanent">
                                    Target creature
                                  </label>

                                  <select
                                    id="target-permanent"
                                    value={targetPermanentId}
                                    onChange={(event) =>
                                      setTargetPermanentId(
                                        event.target.value
                                      )
                                    }
                                  >
                                    <option value="">
                                      Geen target
                                    </option>

                                    {activeGame.players.flatMap(
                                      (player) =>
                                        (player.battlefield || [])
                                          .filter((card) =>
                                            cardIsCreature(card)
                                          )
                                          .map((card) => (
                                            <option
                                              key={card.permanentId}
                                              value={card.permanentId}
                                            >
                                              {player.name}: {card.name}
                                            </option>
                                          ))
                                    )}
                                  </select>
                                </div>
                              </div>
                            </div>

                            <div className="mana-row">
                              <span className="mana-pill">
                                Beschikbare mana
                              </span>
                              <span className="mana-pill">
                                {manaLabel(currentMana)}
                              </span>
                            </div>

                            <div className="card-grid">
                              {matchPrivate.hand.map((card) => {
                                const canCast =
                                  isMyTurn &&
                                  (match.phase === "main1" ||
                                    match.phase === "main2");

                                const instantSpeed =
                                  cardIsInstantOrFlash(card);

                                return (
                                  <CardTile
                                    key={card.instanceId}
                                    card={card}
                                    onPreview={setSelectedCard}
                                    onPlay={playCard}
                                    disabled={
                                      !canCast && !instantSpeed
                                    }
                                  />
                                );
                              })}
                            </div>
                          </>
                        )}
                      </section>
                    </> 
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

            {/* Chat blijft rechts beschikbaar */}
            <aside className="chat-panel panel">
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
                  placeholder="Typ een bericht…"
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
