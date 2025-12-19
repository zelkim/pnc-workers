# PNC Mineflayer Bots

Simple multi-bot Mineflayer setup tailored for PINOYCRAFT with basic
server-switch detection (e.g. lobby vs survival) based on chat messages.

## Setup

From the `mineflayer-app` folder:

```bash
npm install
```

## Configuration

Environment variables:

- `MC_HOST` – Minecraft server host (default: `localhost`)
- `MC_PORT` – Minecraft server port (default: `25565`)
 - `GEMINI_API_KEY` or `GOOGLE_API_KEY` – API key for Google Gemini (free tier, e.g. `gemini-1.5-flash`)

To add more bots, edit `accounts` in `index.js` and, if you are on an
online-mode server, provide a `password` field per account.

## Run

From the `mineflayer-app` folder:

```bash
npm start
```

On server switch, each bot logs its detected current server and the
exact chat message that triggered the detection.

The first bot (`index 0`) also has an AI chat assistant powered by a free Gemini model. It keeps a rolling history of the last 100 chat messages since join and only responds when a player starts their message with the bot's username (e.g. `zlkm_worker_1 how are you`).
