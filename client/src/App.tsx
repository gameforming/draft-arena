import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Swords, Users, MessageCircle, Layers, Vote, Play, Plus, Eye, Send, X, Wifi, Sparkles, ArrowLeft, Image as ImageIcon } from 'lucide-react';

const SERVER = (import.meta as any).env.VITE_SERVER_URL || window.location.origin;
type Player = { id:string; name:string; ready:boolean; isHost:boolean };
type Msg = { id:string; name:string; text:string; at:number; system:boolean };
type Game = { id:string; title:string; status:string; setCode:string; setName:string; boosterCount:number; hostName:string; players:Player[]; maxPlayers:number; createdAt:number; votes:any; messages:Msg[]; draftRound:number; draftPick:number; picksDone:number };
type Card = { id:string; name:string; image:string|null; small:string|null; mana_cost:string; type_line:string; oracle_text:string };
type SetInfo = {code:string;name:string};
const fallbackSets:SetInfo[] = [{code:'ltr',name:'The Lord of the Rings: Tales of Middle-earth'},{code:'ltc',name:'The Lord of the Rings: Tales of Middle-earth Commander'},{code:'woe',name:'Wilds of Eldraine'},{code:'mkm',name:'Murders at Karlov Manor'},{code:'mh3',name:'Modern Horizons 3'},{code:'dsk',name:'Duskmourn: House of Horror'},{code:'fdn',name:'Foundations'}];

function proxiedImage(url:string|null, size='normal') {
  if (!url) return '';
  try { const u = new URL(url); if (size==='small') u.pathname=u.pathname.replace('/normal/','/small/'); return `${SERVER}/api/image?url=${encodeURIComponent(u.toString())}`; } catch { return ''; }
}
// Temporary in-memory image cache: cleared on page refresh/close, never stored on Render.
const imageMemory = new Map<string, string>();
function useCachedImage(url:string|null, size='normal') {
  const [src,setSrc] = useState('');
  useEffect(() => {
    if (!url) { setSrc(''); return; }
    const proxied=proxiedImage(url,size);
    if (imageMemory.has(proxied)) { setSrc(imageMemory.get(proxied)!); return; }
    let cancelled=false;
    fetch(proxied).then(r=>{ if(!r.ok) throw new Error('image'); return r.blob(); }).then(blob=>{
      if(cancelled) return;
      const objectUrl=URL.createObjectURL(blob);
      imageMemory.set(proxied,objectUrl); setSrc(objectUrl);
    }).catch(()=>{ if(!cancelled) setSrc(proxied); });
    return ()=>{cancelled=true;};
  },[url,size]);
  return src;
}
function CardImage({card,onClick,small=false}:{card:Card;onClick:()=>void;small?:boolean}) {
  const src=useCachedImage(card.image,small?'small':'normal');
  return <button className={`card-image ${small?'small':''}`} onClick={onClick} title={`Bekijk ${card.name}`}><div className="image-wrap">{src?<img src={src} alt={card.name} loading="lazy"/>:<div className="card-placeholder"><ImageIcon size={28}/><span>{card.name}</span></div>}</div></button>;
}
function Modal({card,onClose}:{card:Card|null;onClose:()=>void}) {
  if(!card) return null;
  const src=useCachedImage(card.image);
  return <div className="modal-backdrop" onClick={onClose}><div className="card-modal" onClick={e=>e.stopPropagation()}><button className="icon-button close" onClick={onClose}><X/></button>{src?<img src={src} alt={card.name}/>:<div className="large-placeholder">{card.name}</div>}<div className="modal-info"><h2>{card.name}</h2><p>{card.mana_cost}</p><strong>{card.type_line}</strong><p>{card.oracle_text}</p><small>Scryfall kaart-ID: {card.id}</small></div></div></div>;
}
function App() {
  const [socket,setSocket]=useState<Socket|null>(null);
  const [connected,setConnected]=useState(false);
  const [playerName,setPlayerName]=useState(localStorage.getItem('draft-name')||'');
  const [joined,setJoined]=useState(false);
  const [playerId,setPlayerId]=useState('');
  const [games,setGames]=useState<Game[]>([]);
  const [sets,setSets]=useState<SetInfo[]>(fallbackSets);
  const [activeGameId,setActiveGameId]=useState('');
  const [selectedSet,setSelectedSet]=useState('ltr');
  const [boosterCount,setBoosterCount]=useState(3);
  const [maxPlayers,setMaxPlayers]=useState(8);
  const [newTitle,setNewTitle]=useState('');
  const [chatText,setChatText]=useState('');
  const [draftCards,setDraftCards]=useState<Card[]>([]);
  const [myPicks,setMyPicks]=useState<Card[]>([]);
  const [selectedCard,setSelectedCard]=useState<Card|null>(null);
  const [notice,setNotice]=useState('');
  const [tab,setTab]=useState<'all'|'lobby'|'active'>('all');
  const [screen,setScreen]=useState<'home'|'arena'>('home');
  const chatEnd=useRef<HTMLDivElement>(null);
  const activeGame=games.find(g=>g.id===activeGameId)||null;
  const myPlayer=activeGame?.players.find(p=>p.id===playerId);
  const messages=activeGame?.messages||[];
  const visibleGames=useMemo(()=>games.filter(g=>tab==='all'||(tab==='lobby'?g.status==='lobby':g.status!=='lobby')), [games,tab]);

  useEffect(()=>{
    const s=io(SERVER,{transports:['websocket','polling']});
    setSocket(s);
    s.on('connect',()=>setConnected(true)); s.on('disconnect',()=>setConnected(false));
    s.on('state',(data:any)=>{setGames(data.games||[]);if(data.sets?.length)setSets(data.sets);});
    s.on('identity',(data:any)=>setPlayerId(data.playerId));
    s.on('game-created',(data:{gameId:string})=>{setActiveGameId(data.gameId);setScreen('arena');});
    s.on('notice',(text:string)=>{setNotice(text);window.setTimeout(()=>setNotice(''),4200);});
    s.on('booster',(data:any)=>{setActiveGameId(data.gameId);setDraftCards(data.cards||[]);setMyPicks([]);setScreen('arena');});
    s.on('pick-confirmed',(data:any)=>{setMyPicks(data.picks||[]);setDraftCards(prev=>prev.filter(c=>c.id!==data.card.id));});
    return ()=>{s.disconnect();};
  },[]);
  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:'smooth'});},[messages.length,activeGameId]);
  useEffect(()=>{if(joined&&socket) socket.emit('join-arena',{playerName});},[joined,socket]);
  const enter=()=>{const n=playerName.trim().slice(0,24);if(!n)return setNotice('Vul eerst een spelersnaam in.');localStorage.setItem('draft-name',n);setPlayerName(n);setJoined(true);setScreen('home');};
  const createGame=()=>{socket?.emit('create-game',{title:newTitle.trim()||`${playerName}'s draft`,maxPlayers});setNewTitle('');};
  const joinGame=(g:Game)=>{if(g.status!=='lobby'){socket?.emit('watch-game',{gameId:g.id});setActiveGameId(g.id);setScreen('arena');return;}socket?.emit('join-game',{gameId:g.id});setActiveGameId(g.id);setScreen('arena');};
  const vote=()=>{if(activeGameId)socket?.emit('vote',{gameId:activeGameId,setCode:selectedSet,boosterCount});};
  const sendChat=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();if(!chatText.trim()||!activeGameId)return;socket?.emit('chat-message',{gameId:activeGameId,text:chatText.trim()});setChatText('');};
  const startDraft=()=>{if(!activeGameId)return;socket?.emit('start-game',{gameId:activeGameId});};
  const loadBooster=()=>{if(activeGameId)socket?.emit('request-booster',{gameId:activeGameId});};
  const pick=(card:Card)=>{if(activeGameId)socket?.emit('pick-card',{gameId:activeGameId,cardId:card.id});};
  const demoStart=()=>{if(!activeGameId)return;setNotice('Voor een echte multiplayer-draft zijn minimaal 2 spelers nodig. Open de game in een tweede browser om te testen.');};
  const backToLobby=()=>{setScreen('home');setActiveGameId('');setDraftCards([]);setMyPicks([]);setSelectedCard(null);};
  const countVotes=(obj:any,key:string)=>obj?.[key]||{};
  if(!joined) return <main className="start-screen"><div className="hero-glow"/><div className="brand"><div className="brand-icon"><Swords/></div><div><span className="eyebrow">MULTIPLAYER CARD GAME</span><h1>Draft <em>Arena</em></h1></div></div><div className="start-card"><div className="eyebrow">WELCOME TO THE TABLE</div><h2>Jouw volgende draft begint hier.</h2><p>Join een lobby, stem op de set en boosters, en draft samen met vrienden.</p><label>Spelersnaam</label><input value={playerName} onChange={e=>setPlayerName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&enter()} placeholder="Bijv. GandalfTheGrey" maxLength={24}/><button className="primary full" onClick={enter}><Play size={17}/> Naar de lobby</button><div className="feature-row"><span><Users size={15}/> Multiplayer</span><span><Vote size={15}/> Stemmen</span><span><Layers size={15}/> Scryfall kaarten</span></div></div><div className="start-footer"><span className={connected?'dot online':'dot'}/>{connected?'Server verbonden':'Verbinden met server…'} <span>·</span> Versie 1.0 MVP</div></main>;

  return <div className="app-shell">
    <header className="topbar"><button className="brand mini" onClick={backToLobby}><div className="brand-icon"><Swords/></div><div><span className="eyebrow">MULTIPLAYER</span><h1>Draft <em>Arena</em></h1></div></button><div className="top-actions"><span className={`connection ${connected?'good':''}`}><span className="dot"/>{connected?'Live server':'Offline'}</span><span className="user-chip"><span className="avatar">{playerName.slice(0,1).toUpperCase()}</span>{playerName}</span></div></header>
    {notice&&<div className="toast" onClick={()=>setNotice('')}>{notice}<X size={15}/></div>}
    {screen==='home'?<main className="main-layout">
      <section className="welcome-row"><div><div className="eyebrow">ARENA OVERVIEW</div><h2>Welkom terug, <em>{playerName}</em></h2><p>Vind een tafel, stem mee en start een nieuwe draft.</p></div><div className="live-pill"><span className="dot online"/>{games.length} games live</div></section>
      <div className="dashboard-grid">
        <section className="panel create-panel"><div className="panel-heading"><div className="heading-icon purple"><Plus/></div><div><h3>Nieuwe lobby</h3><p>Maak een tafel voor je vrienden</p></div></div><label>Lobby naam</label><input value={newTitle} onChange={e=>setNewTitle(e.target.value)} placeholder={`${playerName}'s draft`}/><div className="two-fields"><div><label>Max. spelers</label><select value={maxPlayers} onChange={e=>setMaxPlayers(Number(e.target.value))}>{[2,3,4,5,6,7,8].map(n=><option key={n} value={n}>{n} spelers</option>)}</select></div><div><label>Jouw naam</label><input value={playerName} onChange={e=>setPlayerName(e.target.value)} onBlur={()=>{const n=playerName.trim().slice(0,24);if(n){setPlayerName(n);localStorage.setItem('draft-name',n);socket?.emit('rename-player',{playerName:n});}}} maxLength={24}/></div></div><button className="primary full" onClick={createGame}><Plus size={17}/> Lobby aanmaken</button><div className="mini-note"><Sparkles size={14}/> Stel samen met de lobby je draft in.</div></section>
        <section className="panel games-panel"><div className="panel-heading"><div className="heading-icon blue"><Swords/></div><div><h3>Alle games</h3><p>Ook games die al bezig zijn</p></div><span className="count-badge">{games.length}</span></div><div className="tabs"><button className={tab==='all'?'selected':''} onClick={()=>setTab('all')}>Alle games <b>{games.length}</b></button><button className={tab==='lobby'?'selected':''} onClick={()=>setTab('lobby')}>Lobby's <b>{games.filter(g=>g.status==='lobby').length}</b></button><button className={tab==='active'?'selected':''} onClick={()=>setTab('active')}>Bezig <b>{games.filter(g=>g.status!=='lobby').length}</b></button></div><div className="game-list">{visibleGames.length===0?<div className="empty-state"><div className="empty-icon"><Users/></div><strong>Nog geen games</strong><span>Maak de eerste lobby en nodig spelers uit.</span></div>:visibleGames.map(g=><div className="game-row" key={g.id}><div className={`game-art ${g.status!=='lobby'?'active-art':''}`}><Layers/></div><div className="game-details"><strong>{g.title}</strong><span>{g.setName}</span><div className="game-meta"><span><Users size={13}/>{g.players.length}/{g.maxPlayers}</span><span className={`status ${g.status!=='lobby'?'playing':''}`}>{g.status==='lobby'?'Lobby open':g.status==='finished'?'Afgelopen':'Bezig'}</span></div></div><button className="join-button" onClick={()=>joinGame(g)}>{g.status==='lobby'?'Join':'Bekijk'}</button></div>)}</div></section>
      </div>
    </main>:<main className="game-layout">
      <div className="game-main">
        <button className="back-link" onClick={backToLobby}><ArrowLeft size={16}/> Alle games</button>
        {!activeGame?<div className="panel empty-game"><h2>Selecteer een game</h2><p>Kies een lobby uit het overzicht.</p></div>:<>
          <div className="game-title-row"><div><div className="eyebrow">{activeGame.status==='lobby'?'LOBBY ROOM':'LIVE GAME'}</div><h2>{activeGame.title}</h2><p>{activeGame.setName}</p></div><span className={`status large ${activeGame.status!=='lobby'?'playing':''}`}>{activeGame.status==='lobby'?'Lobby open':activeGame.status==='finished'?'Afgelopen':'Bezig'}</span></div>
          <section className="panel roster-panel"><div className="panel-heading"><div className="heading-icon blue"><Users/></div><div><h3>Spelers</h3><p>{activeGame.players.length} van {activeGame.maxPlayers} plaatsen gevuld</p></div></div><div className="roster">{activeGame.players.map((p,i)=><div className="roster-player" key={p.id}><div className={`avatar ${i===0?'host-avatar':''}`}>{p.name.slice(0,1).toUpperCase()}</div><div><strong>{p.name}</strong><span>{p.isHost?'Host':p.id===playerId?'Jij':'Speler'}</span></div>{p.isHost&&<span className="host-tag">HOST</span>}</div>)}</div></section>
          {activeGame.status==='lobby'?<section className="panel vote-panel"><div className="panel-heading"><div className="heading-icon gold"><Vote/></div><div><h3>Stem voor de draft</h3><p>De meeste stemmen bepalen de instellingen.</p></div></div><div className="vote-fields"><div><label>Welke set?</label><select value={selectedSet} onChange={e=>setSelectedSet(e.target.value)}>{sets.map(s=><option key={s.code} value={s.code}>{s.name}</option>)}</select></div><div><label>Aantal boosters per speler</label><div className="booster-options">{[1,2,3,4,5,6].map(n=><button key={n} className={boosterCount===n?'booster selected':'booster'} onClick={()=>setBoosterCount(n)}><span>{n}</span><small>{n===1?'booster':'boosters'}</small></button>)}</div></div></div><div className="vote-footer"><div className="vote-summary"><span><Vote size={15}/> Stemmen tellen live mee</span><small>Setstemmen: {Object.values(countVotes(activeGame.votes,'sets')).reduce((a:any,b:any)=>a+b,0)} · Boosters: {Object.values(countVotes(activeGame.votes,'boosters')).reduce((a:any,b:any)=>a+b,0)}</small></div><button className="secondary" onClick={vote}>Stem uitbrengen</button></div>{myPlayer?.isHost&&<button className="primary full start-draft" onClick={startDraft}><Play size={17}/> Start draft</button>}<p className="subtle-note">De host start wanneer iedereen klaar is. Gelijkspel? De eerste optie met de meeste stemmen wint.</p></section>:<section className="panel draft-panel"><div className="panel-heading"><div className="heading-icon purple"><Layers/></div><div><h3>{activeGame.status==='finished'?'Game afgelopen':'Jouw booster'}</h3><p>{draftCards.length?`${draftCards.length} kaarten over · ${myPicks.length} gekozen`:'Laad je kaarten via de serverproxy.'}</p></div>{myPlayer&&activeGame.status==='drafting'&&<button className="secondary small-button" onClick={loadBooster}>Laad booster</button>}</div>{!myPlayer?<div className="draft-empty"><Eye size={28}/><strong>Je kijkt mee als toeschouwer</strong><span>Je ziet de gedeelde chat, maar niet de handkaarten van spelers.</span></div>:draftCards.length>0?<div className="draft-cards">{draftCards.map(card=><div key={card.id} className="draft-card"><CardImage card={card} onClick={()=>setSelectedCard(card)}/><button className="pick-button" onClick={()=>pick(card)}>Kies kaart</button></div>)}</div>:<div className="draft-empty"><Layers size={28}/><strong>Je booster verschijnt hier</strong><span>Klik op “Laad booster” om kaarten op te halen via Render.</span></div>}{myPicks.length>0&&<><h4>Jouw picks ({myPicks.length})</h4><div className="picks-strip">{myPicks.map(c=><CardImage key={c.id} card={c} small onClick={()=>setSelectedCard(c)}/>)}</div></>}{myPlayer?.isHost&&activeGame.status==='drafting'&&<div className="game-actions"><button className="secondary" onClick={()=>socket?.emit('end-game',{gameId:activeGame.id})}>Draft beëindigen en lobby openen</button></div>}</section>}
        </>}
      </div>
      <aside className="chat-panel panel"><div className="chat-heading"><div className="heading-icon green"><MessageCircle/></div><div><h3>Lobby chat</h3><p>Praat met iedereen aan tafel</p></div><span className="chat-live"><span className="dot online"/>LIVE</span></div><div className="chat-context">{activeGame?.title||'Geen game geselecteerd'}</div><div className="messages">{messages.map(m=><div className={`message ${m.system?'system-message':''}`} key={m.id}><div className="message-top"><strong>{m.name}</strong><time>{new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div><p>{m.text}</p></div>)}<div ref={chatEnd}/>{!messages.length&&<div className="chat-empty"><MessageCircle/><span>De chat is nog stil. Zeg hallo!</span></div>}</div><form className="chat-compose" onSubmit={sendChat}><input value={chatText} onChange={e=>setChatText(e.target.value)} placeholder="Typ een bericht…" disabled={!activeGameId}/><button className="send-button" type="submit" disabled={!activeGameId||!chatText.trim()}><Send size={17}/></button></form><div className="chat-footnote">Wees sportief. Spelacties worden in de log bijgehouden.</div></aside>
    </main>}
    <footer className="app-footer"><span>Draft Arena <b>v1.0</b></span><span><span className="dot online"/> Scryfall via Render proxy</span><span>Gemaakt voor draft night <Sparkles size={13}/></span></footer>
    <Modal card={selectedCard} onClose={()=>setSelectedCard(null)}/>
  </div>;
}
export default App;
