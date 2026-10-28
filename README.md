# Draft Arena v1

Een eerste multiplayer-MVP voor een Magic: The Gathering booster-draft. Deze repository is voorbereid voor **één Render Web Service**: Render bouwt de React-website en start de Node-server. Je hoeft Node.js niet op je eigen computer te installeren.

## Wat zit erin?
- Startscherm waar spelers een naam kiezen
- Overzicht van lobby's en games die al bezig zijn
- Lobbychat en live spelerslijst
- Stemmen op set en aantal boosters
- Booster-draftdemo met kaarten via Scryfall
- Kaarten aanklikken om ze groter te bekijken
- Acties worden in de chat gelogd
- Scryfall API- en afbeeldingsproxy via de server
- Afbeeldingen worden tijdelijk in het geheugen van de browser gecachet; er wordt geen permanente kaartafbeeldingendatabase gemaakt
- Lobby-/spelstatus staat in servergeheugen en verdwijnt als Render de server herstart

## Uploaden naar GitHub zonder lokaal Node.js
1. Download en pak `draft_arena_v1.zip` uit.
2. Open GitHub en maak een nieuwe repository, bijvoorbeeld `draft-arena`.
3. Gebruik op de lege repository **Add file → Upload files**.
4. Upload de inhoud van deze map (dus `package.json`, `render.yaml`, `client/`, `server/` en `README.md`, niet alleen de ZIP zelf).
5. Klik **Commit changes**.

## Publiceren op Render
1. Meld je aan bij Render en kies **New + → Blueprint** (aanbevolen) of **New + → Web Service**.
2. Koppel je GitHub-account aan Render en selecteer de repository.
3. Bij Blueprint gebruikt Render de instellingen in `render.yaml`. Bevestig het aanmaken van de service.
4. Wacht tot de build en deploy klaar zijn. Open de `onrender.com`-URL die Render toont.

Als je handmatig een Web Service maakt, gebruik dan:
- **Runtime:** Node
- **Build Command:** `npm run build`
- **Start Command:** `npm start`
- **Node version:** 20 (environment variable `NODE_VERSION=20`)

De frontend en backend delen dezelfde URL, dus je hoeft geen `VITE_SERVER_URL` in te stellen.

## Belangrijke beperkingen van v1
- Dit is een MVP/demo, geen volledige Magic-regelengine of officiële toernooidraft.
- De draftflow is eenvoudig: boosterkaarten worden per speler geladen; het volledige doorgeven van boosters tussen spelers is nog niet af.
- De server bewaart games alleen in RAM. Bij een herstart verdwijnen lobby's en actieve games.
- Render Free kan na inactiviteit slapen; de eerste opening kan daardoor even duren.
- De Scryfall API moet bereikbaar zijn vanaf Render. De proxy voorkomt dat de browser rechtstreeks Scryfall hoeft te openen, maar kan geen netwerkblokkades aan de serverkant oplossen.
