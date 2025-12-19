const mineflayer = require("mineflayer");
const { ShopAutomation } = require("./shopAutomation");
const { GeminiChat } = require("./geminiChat");

class PlayerBot {
  constructor(id, options) {
    this.id = id;
    this.options = options;
    this.bot = mineflayer.createBot(options);
    this.home_cmd = options.home_cmd || "/home";
    this.password = options.password || process.env.BOT_PASSWORD || "password";
    this.currentServer = null;
    this.username = options.username; // track configured username
    this.sessionContinued = false;

    this._reconnectScheduled = false;
    this._reconnectAttempts = 0;
    this._ensureSurvivalInterval = null;

    this.shopAutomation = new ShopAutomation(this);

    this.geminiChat = null;
    if (options.enableGemini) {
      this._setupGeminiChat();
    }

    this._setupEventHandlers();

    this._startEnsureSurvivalLoop();
  }

  _setupGeminiChat() {
    try {
      this.geminiChat = new GeminiChat(this);
    } catch (err) {
      console.error(`[${this.id}] Failed to initialize GeminiChat:`, err);
      this.geminiChat = null;
    }
  }

  _setupEventHandlers() {
    const bot = this.bot;

    bot.on("login", () => {
      this.sessionContinued = false;
      this._reconnectAttempts = 0;
      console.log(`[${this.id}] Logged in as ${bot.username}`);
    });

    bot.on("spawn", () => {
      console.log(`[${this.id}] Spawned in the world`);
    });

    bot.on("kicked", (reason, loggedIn) => {
      console.log(
        `[${this.id}] Kicked from server (loggedIn=${loggedIn}):`,
        reason
      );
    });

    bot.on("end", (reason) => {
      console.log(`[${this.id}] Disconnected from server. Reason:`, reason);
      console.log(
        `[${this.id}] Last known server: ${this.currentServer || "unknown"}`
      );
      console.log(
        `[${this.id}] Last position:`,
        bot.entity ? bot.entity.position : "unknown"
      );

      this._handleDisconnect();
    });

    bot.on("error", (err) => {
      console.error(`[${this.id}] Error:`, err);
    });

    // Catch all chat-like messages (system, plugin, etc.)
    bot.on("message", (msg) => {
      const text = msg.toString();
      this._handleChatText(text);
    });
  }

  _startEnsureSurvivalLoop() {
    if (this._ensureSurvivalInterval) return;

    const intervalMs = 3 * 60 * 1000; // every 3 minutes
    this._ensureSurvivalInterval = setInterval(() => {
      this._ensureOnSurvival();
    }, intervalMs);

    console.log(
      `[${this.id}] Started ensure-on-survival loop (every ${intervalMs / 1000}s)`
    );
  }

  _ensureOnSurvival() {
    if (!this.bot || !this.bot.player) {
      console.log(
        `[${this.id}] ensureOnSurvival: bot not fully connected (no player); skipping`
      );
      return;
    }

    if (this.currentServer === "survival") {
      // Already where we want to be.
      return;
    }

    console.log(
      `[${this.id}] ensureOnSurvival: currentServer=${
        this.currentServer || "unknown"
      }; re-running join/setup sequence`
    );

    this._runJoinSequence();
  }

  _runJoinSequence() {
    if (!this.bot) return;

    // Try to mimic the normal lobby->survival flow used on first join
    if (this.currentServer === "lobby") {
      if (this.sessionContinued) {
        console.log(
          `[${this.id}] In lobby with continued session; sending '/server survival'`
        );
        setTimeout(() => {
          this.bot.chat("/server survival");
        }, 500);
      } else {
        console.log(
          `[${this.id}] In lobby, sending '/l <password>' then '/server survival' (ensureOnSurvival)`
        );
        this.bot.chat(`/l ${this.password || process.env.BOT_PASSWORD || "password"}`);

        setTimeout(() => {
          this.bot.chat("/server survival");
        }, 1000);
      }
    } else {
      console.log(
        `[${this.id}] On server '${
          this.currentServer || "unknown"
        }'; trying '/server survival' directly`
      );
      this.bot.chat("/server survival");
    }
  }

  _handleDisconnect() {
    // Stop any shop automation tied to the old bot
    if (this.shopAutomation) {
      try {
        this.shopAutomation.dispose();
      } catch (err) {
        console.error(`[${this.id}] Error disposing ShopAutomation on disconnect:`, err);
      }
    }

    if (this.geminiChat) {
      try {
        this.geminiChat.dispose();
      } catch (err) {
        console.error(`[${this.id}] Error disposing GeminiChat on disconnect:`, err);
      }
      this.geminiChat = null;
    }

    if (this._reconnectScheduled) {
      return;
    }

    this._reconnectScheduled = true;
    this._reconnectAttempts += 1;

    if (this._reconnectAttempts >= 5) {
      console.error(
        `[${this.id}] Reconnect failed ${this._reconnectAttempts} times; exiting process for external restart.`
      );
      // Let an external supervisor (PM2/systemd/etc.) restart the app.
      process.exit(1);
    }

    const delayMs = 5000;
    console.log(
      `[${this.id}] Scheduling automatic reconnect in ${delayMs / 1000}s`
    );

    setTimeout(() => {
      this._reconnectScheduled = false;
      this._reconnect();
    }, delayMs);
  }

  _reconnect() {
    console.log(`[${this.id}] Reconnecting bot`);

    // Create a fresh mineflayer bot with the same options
    this.bot = mineflayer.createBot(this.options);
    this.currentServer = null;
    this.sessionContinued = false;

    // Recreate automation for the new bot instance
    this.shopAutomation = new ShopAutomation(this);

    if (this.options.enableGemini) {
      this._setupGeminiChat();
    }

    // Reattach all event handlers to the new bot instance
    this._setupEventHandlers();
  }

  _handleChatText(text) {
    if (!text || typeof text !== "string") return;
    // console.log(`[${this.id}] "${text}"`);

    let detectedServer = null;

    if (text.includes("Welcome to PINOYCRAFT")) {
      detectedServer = "lobby";
    } else if (text.includes("[mcMMO] Overhaul Era")) {
      detectedServer = "survival";
    }

    if (!detectedServer) return;

    const previous = this.currentServer;

    if (previous !== detectedServer) {
      this.currentServer = detectedServer;
      console.log(
        `[${this.id}] Server changed: ${
          previous || "unknown"
        } -> ${detectedServer}`
      );
      console.log(`[${this.id}] Detected from chat message: "${text}"`);

      // Control the periodic /shop loop based on server
      this.shopAutomation.handleServerChange(detectedServer);

      // On first switch into survival, go to /home
      if (detectedServer === "survival") {
        console.log(`[${this.id}] Detected survival server, sending '/home'`);
        this.bot.chat(this.home_cmd);
      }

      // When we detect that we are in the lobby, run the
      // requested commands to login then switch to survival.
      if (detectedServer === "lobby") {
        if (text.includes("has been continued.")) {
          this.sessionContinued = true;
          console.log(
            `[${this.id}] In lobby with continued session; skipping '/l <password>' and going directly to '/server survival'`
          );
          setTimeout(() => {
            this.bot.chat("/server survival");
          }, 500);
          console.log(
            `[${this.id}] Detected continued login session message: "${text}"`
          );
        } else {
          console.log(
            `[${this.id}] In lobby, sending '/l <password>' then '/server survival'`
          );
          this.bot.chat(`/l ${process.env.BOT_PASSWORD || "password"}`);

          // Small delay to let the first command process before switching server
          setTimeout(() => {
            this.bot.chat("/server survival");
          }, 1000);
        }
      }
    } else {
      // Extra debug for repeated detections on same server
      console.log(
        `[${this.id}] Re-detected server '${detectedServer}' from chat message: "${text}"`
      );
    }
  }

}

class BotManager {
  constructor() {
    this.bots = [];
  }

  createBot(id, options) {
    const index = this.bots.length;
    const mergedOptions = {
      ...options,
      enableGemini: options.enableGemini || index === 0,
    };

    const playerBot = new PlayerBot(id, mergedOptions);
    this.bots.push(playerBot);
    return playerBot;
  }

  listBots() {
    return this.bots;
  }
}

module.exports = { PlayerBot, BotManager };
