const mineflayer = require("mineflayer");
const { ShopAutomation } = require("./shopAutomation");
const { GeminiChat } = require("./geminiChat");

class PlayerBot {
  constructor(id, options) {
    this._initStateFromOptions(id, options);
    this._initBotInstance();
    this._initModules();
    this._setupEventHandlers();

    // Ensure GeminiChat instance matches initial flags (currently disabled by default)
    this._ensureGeminiChatInstance();

    this._startEnsureSurvivalLoop();
  }

  _initStateFromOptions(id, options) {
    this.id = id;
    this.options = options;
    this.home_cmd = options.home_cmd || "/home";
    this.password = options.password || process.env.BOT_PASSWORD || "password";
    this.currentServer = null;
    this.sessionContinued = false;

    this._reconnectScheduled = false;
    this._reconnectAttempts = 0;
    this._ensureSurvivalInterval = null;

    // Backoff state for `/server survival` join attempts to avoid chat spam
    this._serverSurvivalTimeout = null;
    this._serverSurvivalScheduled = false;
    this._serverSurvivalAttempts = 0;

    this.geminiChat = null;
    this.geminiConfigEnabled = !!options.enableGemini;
    this.geminiEnabled = false; // will be toggled later via owner commands
  }

  _initBotInstance() {
    this.bot = mineflayer.createBot(this.options);
  }

  _initModules() {
    this.shopAutomation = new ShopAutomation(this);
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

    bot.on("login", this._onLogin.bind(this));
    bot.on("spawn", this._onSpawn.bind(this));
    bot.on("kicked", this._onKicked.bind(this));
    bot.on("end", this._onEnd.bind(this));
    bot.on("error", this._onError.bind(this));

    // Catch all chat-like messages (system, plugin, etc.)
    bot.on("message", this._onMessage.bind(this));
  }

  _onLogin() {
    this.sessionContinued = false;
    this._reconnectAttempts = 0;
    console.log(`[${this.id}] Logged in as ${this.bot.username}`);
  }

  _onSpawn() {
    console.log(`[${this.id}] Spawned in the world`);
  }

  _onKicked(reason, loggedIn) {
    console.log(
      `[${this.id}] Kicked from server (loggedIn=${loggedIn}):`,
      reason
    );
  }

  _onEnd(reason) {
    console.log(`[${this.id}] Disconnected from server. Reason:`, reason);
    console.log(
      `[${this.id}] Last known server: ${this.currentServer || "unknown"}`
    );
    console.log(
      `[${this.id}] Last position:`,
      this.bot.entity ? this.bot.entity.position : "unknown"
    );

    this._handleDisconnect();
  }

  _onError(err) {
    console.error(`[${this.id}] Error:`, err);
  }

  _onMessage(msg) {
    this._handleIncomingMessage(msg);
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

  _handleIncomingMessage(msg) {
    if (!msg) return;
    const text = typeof msg.toString === "function" ? msg.toString() : "";

    if (text) {
      this._handleChatText(text);
    }

    this._handleGeminiTriggerMessage(msg);
  }

  _runJoinSequence() {
    if (!this.bot) return;

    // Try to mimic the normal lobby->survival flow used on first join
    if (this.currentServer === "lobby") {
      this._runJoinFromLobby();
    } else {
      this._runJoinFromOtherServer();
    }
  }

  _runJoinFromLobby() {
    if (this.sessionContinued) {
      console.log(
        `[${this.id}] In lobby with continued session; sending '/server survival'`
      );
      // Use backoff scheduler to avoid spamming `/server survival`
      this._requestServerSurvivalJoin(
        "runJoinFromLobby-continuedSession",
        500
      );
    } else {
      console.log(
        `[${this.id}] In lobby, sending '/l <password>' then '/server survival' (ensureOnSurvival)`
      );
      this.bot.chat(`/l ${this.password || process.env.BOT_PASSWORD || "password"}`);

      // Give login a brief moment, then schedule `/server survival` with backoff
      setTimeout(() => {
        this._requestServerSurvivalJoin(
          "runJoinFromLobby-newLogin",
          0
        );
      }, 1000);
    }
  }

  _runJoinFromOtherServer() {
    console.log(
      `[${this.id}] On server '${
        this.currentServer || "unknown"
      }'; trying '/server survival' directly`
    );
    this._requestServerSurvivalJoin("runJoinFromOtherServer", 0);
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

    const delayMs = 60000 * this._reconnectAttempts; // exponential backoff: 1min, 2min, 3min, etc.
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

    // Ensure GeminiChat instance matches current flags for the new bot
    this._ensureGeminiChatInstance();

    // Reattach all event handlers to the new bot instance
    this._setupEventHandlers();
  }

  _handleChatText(text) {
    if (!text || typeof text !== "string") return;
    // console.log(`[${this.id}] "${text}"`);

    const detectedServer = this._detectServerFromChat(text);
    if (!detectedServer) return;

    const previous = this.currentServer;

    if (previous !== detectedServer) {
      this._handleServerChange(previous, detectedServer, text);
    } else {
      // Extra debug for repeated detections on same server
      console.log(
        `[${this.id}] Re-detected server '${detectedServer}' from chat message: "${text}"`
      );
    }
  }

  _detectServerFromChat(text) {
    if (text.includes("Welcome to PINOYCRAFT")) {
      return "lobby";
    }
    if (text.includes("[mcMMO] Overhaul Era")) {
      return "survival";
    }
    return null;
  }

  _handleServerChange(previous, detectedServer, text) {
    this.currentServer = detectedServer;
    console.log(
      `[${this.id}] Server changed: ${previous || "unknown"} -> ${detectedServer}`
    );
    console.log(`[${this.id}] Detected from chat message: "${text}"`);

    // Control the periodic /shop loop based on server
    this.shopAutomation.handleServerChange(detectedServer);

    if (detectedServer === "survival") {
      // Successful join, reset `/server survival` backoff state
      this._resetServerSurvivalBackoff();
      this._handleSurvivalEnter();
    } else if (detectedServer === "lobby") {
      this._handleLobbyEnter(text);
    }
  }

  _handleSurvivalEnter() {
    console.log(`[${this.id}] Detected survival server, sending '/home'`);
    this.bot.chat(this.home_cmd);
  }

  _handleLobbyEnter(text) {
    // When we detect that we are in the lobby, run the
    // requested commands to login then switch to survival.
    if (this._isContinuedSessionMessage(text)) {
      this.sessionContinued = true;
      console.log(
        `[${this.id}] In lobby with continued session; skipping '/l <password>' and going directly to '/server survival'`
      );
      // Schedule `/server survival` using backoff logic
      this._requestServerSurvivalJoin(
        "lobbyEnter-continuedSession",
        500
      );
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
        this._requestServerSurvivalJoin(
          "lobbyEnter-newLogin",
          0
        );
      }, 1000);
    }
  }

  _isContinuedSessionMessage(text) {
    return text.includes("has been continued.");
  }

  _handleGeminiTriggerMessage(msg) {
    if (!this.geminiConfigEnabled) return;
    if (!msg) return;

    const normalized = this._normalizeControlMessage(msg);
    if (!normalized) return;

    const { sender, text, isPrivate } = normalized;

    if (!sender || !text) return;

    // Framework hook: later this will inspect private messages from the owner
    this._handleGeminiControlMessageFromOwner({ sender, text, isPrivate });
  }

  _normalizeControlMessage(msg) {
    // TODO: Implement parsing of private/whisper messages and extract
    // { sender, text, isPrivate } in a follow-up.
    // For now this is just a placeholder to keep the framework wired.
    return null;
  }

  _handleGeminiControlMessageFromOwner({ sender, text, isPrivate }) {
    // TODO: Implement actual control protocol (e.g. specific commands from
    // owner "zlkm_" to enable/disable Gemini) in a follow-up change.
    console.log(
      `[${this.id}] [GeminiControl] Placeholder handler for control message from ${sender}: "${text}" (isPrivate=${isPrivate})`
    );
  }

  enableGemini(reason) {
    if (!this.geminiConfigEnabled) {
      console.log(
        `[${this.id}] Gemini enable requested (${reason || "no reason"}), but geminiConfigEnabled=false; ignoring.`
      );
      return;
    }

    if (this.geminiEnabled) return;

    this.geminiEnabled = true;
    console.log(
      `[${this.id}] Gemini enabled (reason=${reason || "unspecified"})`
    );
    this._ensureGeminiChatInstance();
  }

  disableGemini(reason) {
    if (!this.geminiEnabled && !this.geminiChat) return;

    this.geminiEnabled = false;
    console.log(
      `[${this.id}] Gemini disabled (reason=${reason || "unspecified"})`
    );
    this._ensureGeminiChatInstance();
  }

  _ensureGeminiChatInstance() {
    // If Gemini is not allowed or not enabled, ensure we have no active instance
    if (!this.geminiConfigEnabled || !this.geminiEnabled) {
      if (this.geminiChat) {
        try {
          this.geminiChat.dispose();
        } catch (err) {
          console.error(
            `[${this.id}] Error disposing GeminiChat in _ensureGeminiChatInstance:`,
            err
          );
        }
        this.geminiChat = null;
      }
      return;
    }

    // Gemini is allowed and enabled but no instance yet
    if (!this.geminiChat) {
      this._setupGeminiChat();
    }
  }

  // =============================
  // `/server survival` backoff
  // =============================

  _requestServerSurvivalJoin(reason, minDelayMs = 0) {
    if (!this.bot) return;

    if (this.currentServer === "survival") {
      return;
    }

    if (this._serverSurvivalScheduled) {
      console.log(
        `[${this.id}] '/server survival' already scheduled; skipping new request (reason=${reason || "unspecified"})`
      );
      return;
    }

    this._serverSurvivalAttempts += 1;
    const attempt = this._serverSurvivalAttempts;

    // Similar to reconnect backoff: 0s, 60s, 120s, 180s, ...
    const backoffMs = attempt === 1 ? 0 : 60000 * attempt;
    const delayMs = Math.max(backoffMs, minDelayMs || 0);

    this._serverSurvivalScheduled = true;

    console.log(
      `[${this.id}] Scheduling '/server survival' attempt #${attempt} in ${delayMs / 1000}s (reason=${
        reason || "unspecified"
      })`
    );

    this._serverSurvivalTimeout = setTimeout(() => {
      this._serverSurvivalScheduled = false;
      this._serverSurvivalTimeout = null;

      if (!this.bot || !this.bot.player) {
        console.log(
          `[${this.id}] Skipping scheduled '/server survival' attempt #${attempt}: bot not fully connected`
        );
        return;
      }

      if (this.currentServer === "survival") {
        console.log(
          `[${this.id}] Skipping scheduled '/server survival' attempt #${attempt}: already on survival`
        );
        return;
      }

      console.log(
        `[${this.id}] Sending '/server survival' attempt #${attempt} now (reason=${
          reason || "unspecified"
        })`
      );
      try {
        this.bot.chat("/server survival");
      } catch (err) {
        console.error(
          `[${this.id}] Error sending '/server survival' attempt #${attempt}:`,
          err
        );
      }
    }, delayMs);
  }

  _resetServerSurvivalBackoff() {
    if (this._serverSurvivalTimeout) {
      clearTimeout(this._serverSurvivalTimeout);
      this._serverSurvivalTimeout = null;
    }
    if (this._serverSurvivalAttempts > 0) {
      console.log(
        `[${this.id}] Resetting '/server survival' backoff after successful join`
      );
    }
    this._serverSurvivalScheduled = false;
    this._serverSurvivalAttempts = 0;
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
      enableGemini: options.enableGemini,
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
