# Livello dati

Libreria Apps Script unica per autenticazione, chiamate API, retry, paginazione, log e
scrittura su Google Sheet. I tre strumenti (mappatura privacy, reportistica, forecast)
la usano come libreria e non chiamano mai le API direttamente.

## File

| File | Contenuto |
|---|---|
| `Core.gs` | Nomi di fogli e colonne, errori, date |
| `Auth.gs` | Token per piattaforma, rinnovo, flusso di autorizzazione, avvisi di scadenza |
| `Http.gs` | Richieste, tentativi con attesa crescente, schemi di paginazione |
| `Sheet.gs` | Lettura e scrittura a blocchi, upsert, file metriche per anno |
| `Config.gs` | Fogli `config` e `impostazioni`, installazione |
| `Connectors.gs` | Registro dei connettori, contratto comune, normalizzazione |
| `Runner.gs` | Piano dei lavori, ripresa, aggiornamento incrementale, trigger |
| `Log.gs` | Foglio `log`, oscuramento dei token nei messaggi |
| `Api.gs` | Funzioni pubbliche |
| `Connector_meta_ads.gs` | Meta Ads: account, metriche Insights, utenti assegnati |
| `Connector_linkedin_ads.gs` | LinkedIn Ads: account, metriche adAnalytics, utenti dell'account |
| `tests/` | Test locali con servizi Apps Script simulati (`node tests/run.js`, `node tests/meta.js`, `node tests/linkedin.js`) |

## Installazione sull'account Google

1. Crea un progetto Apps Script autonomo su script.google.com e copia l'ID dalle impostazioni.
2. Carica i file con clasp:

   ```bash
   npm install -g @google/clasp
   ```

   ```bash
   clasp login
   ```

   ```bash
   clasp clone <ID_PROGETTO> --rootDir .
   ```

   ```bash
   clasp push
   ```

   In alternativa copia a mano ogni `.gs` nell'editor e sostituisci `appsscript.json`
   (Impostazioni progetto > Mostra il file manifest).
3. Collega il progetto a un progetto Google Cloud standard (Impostazioni progetto >
   Progetto Google Cloud Platform) e abilita lì Google Analytics Data API, Google Analytics
   Admin API, Search Console API e Google Ads API. Serve per Google Ads, il cui livello di
   accesso ora si chiede sul progetto Cloud.
4. Esegui `setup` dall'editor: crea il file «Livello dati» con tutti i fogli.
5. Inserisci i segreti in Impostazioni progetto > Proprietà script (vedi sotto).
6. Compila una riga per cliente nel foglio `config`.
7. Esegui `installTriggers`: aggiornamento ogni ora, controllo token ogni giorno alle 8.

## Segreti (solo Proprietà script)

| Proprietà | Valore |
|---|---|
| `DL_TOKEN_meta` | Token dell'utente di sistema Meta (permessi `ads_read` e `business_management`) |
| `DL_CRED_linkedin_ads` | `{"client_id":"...","client_secret":"..."}` dell'app LinkedIn |
| `DL_CRED_linkedin_community` | Come sopra, per l'app Community Management |
| `DL_CRED_tiktok` | `{"client_id":"<app id>","client_secret":"<secret>"}` |

Per LinkedIn e TikTok: registra nell'app l'URL restituito da `getRedirectUri`, poi esegui
`getAuthorizationUrl('linkedin_ads')` (o `'tiktok'`) e apri il link. Il token viene
salvato da solo. Google non richiede nulla: usa l'account che esegue lo script.

## Aggiungere un cliente

Una riga in `config`: nome, `attivo`, `inizio_storico` e gli ID account nelle colonne
delle piattaforme (più ID nella stessa cella separati da virgola). Nessuna modifica al codice.

## Aggiungere un connettore

Un file `Connector_<id>.gs` con una funzione `Connector_<id>_()` che restituisce la
definizione descritta in testa a `Connectors.gs`. Dopo averlo aggiunto, riesegui `setup`
per creare la colonna in `config` e le righe di mappatura.

## Uso dagli altri strumenti

Aggiungi la libreria con l'ID di questo progetto e identificatore `DataLayer`:

```js
DataLayer.readMetrics({ cliente: 'Cliente A', dal: '2026-11-01', al: '2026-11-07', livello: 'campaign' });
DataLayer.readAccess('Cliente B');
DataLayer.readCampaigns('Cliente A');
DataLayer.listAccounts('meta_ads');
DataLayer.getAccessUsers('ga4', '123456789');
```

Le chiamate dirette alle API Google (`listAccounts`, `getMetrics`, `getAccessUsers` su GA4,
Search Console, Google Ads) usano l'autorizzazione dello script chiamante: il suo manifest
deve dichiarare gli stessi scope di `appsscript.json`. Le funzioni `read*` non lo richiedono.
