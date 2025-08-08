# Star Atlas Monitor — Render ready

Monitora la sezione **BUY ORDERS** delle pagine EveEye e invia alert su Discord (embed colorati per nome oggetto).

## Deploy su Render (passi semplici)
1. Crea una nuova **repo GitHub** e carica il contenuto di questo progetto.
2. Vai su **Render → New → Web Service** e collega la repo.
3. Imposta:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. In **Environment** aggiungi:
   - `DISCORD_WEBHOOK` → incolla qui il tuo webhook
   - `POLL_SECONDS=60`
   - `HEADLESS=true`
   - `ALERT_COOLDOWN_SEC=90`
5. Fai **Create Web Service**. Nei log vedrai `Server on :3000` e la riga `[boot]` con le variabili.
6. Apri l'URL pubblico del servizio → UI “Le fucine di mordor…”, aggiungi i link da monitorare e premi **Start**.

### Nota sul piano gratuito
I servizi free su Render possono andare in **sleep** se inutilizzati. Per tenerlo attivo h24:
- usa un ping gratuito (es. cron-job.org) verso `https://TUO-SERVIZIO.onrender.com/api/items` ogni 10 minuti, **oppure**
- crea un **Background Worker** su Render con lo stesso repo e comando `node server.mjs` (rimane sveglio).

## Esecuzione locale (opzionale)
```
npm i
npx playwright install chromium
npm start
# apri http://localhost:3000
```
