const { GoogleGenerativeAI } = require('@google/generative-ai')

class GeminiChat {
  constructor (playerBot) {
    this.playerBot = playerBot
    this.bot = playerBot.bot
    this.chatHistory = []
    this.isProcessing = false

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    if (!apiKey) {
      console.warn('[GeminiChat] No GEMINI_API_KEY or GOOGLE_API_KEY set; Gemini chat is disabled')
      this.disabled = true
      return
    }

    this.disabled = false
    this.genAI = new GoogleGenerativeAI(apiKey)
      // Use a text-capable model that is free on the Gemini API free tier.
      // Per Google pricing docs, gemini-2.5-flash has free input/output tokens on the free plan.
      this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

    this._onMessage = this._onMessage.bind(this)
    this._onEnd = this._onEnd.bind(this)

    this.bot.on('message', this._onMessage)
    this.bot.on('end', this._onEnd)

    console.log(`[${this.playerBot.id}] GeminiChat initialized for bot ${this.bot.username}`)
  }

  dispose () {
    if (!this.bot) return
    this.bot.removeListener('message', this._onMessage)
    this.bot.removeListener('end', this._onEnd)
  }

  _onEnd () {
    this.dispose()
  }

  async _onMessage (msg) {
    if (this.disabled) return
    const { text, sender } = this._flattenChatMessage(msg)
    if (!text) return

    console.log(`${sender}: ${text}`);
    // Track rolling chat history (max 100 messages)
    const historyLine = sender ? `${sender}: ${text}` : text
    this.chatHistory.push(historyLine)
    if (this.chatHistory.length > 100) {
      this.chatHistory.shift()
    }

    // Allow only one request at a time
    if (this.isProcessing) return

    const cleaned = this._extractUserPrompt(text, sender)
    if (!cleaned) return

    const prompt = cleaned.prompt
    const fromPlayer = cleaned.fromPlayer

    if (!prompt) return

    this.isProcessing = true
    try {
      const reply = await this._generateReply(prompt, fromPlayer)
      if (reply) {
        await this._sendReply(reply)
      }
    } catch (err) {
      console.error(`[${this.playerBot.id}] GeminiChat error while generating reply:`, err)
    } finally {
      this.isProcessing = false
    }
  }

  _flattenChatMessage (msg) {
    try {
      if (!msg) return { text: '', sender: null }
      const base = msg.unsigned || msg

      // Try to reconstruct the fully-decorated line from unsigned.with[0].extra
      let rawLine = ''
      if (base && Array.isArray(base.with) && base.with.length > 0) {
        const firstWith = base.with[0]

        if (firstWith && Array.isArray(firstWith.extra) && firstWith.extra.length > 0) {
          rawLine = firstWith.extra.map(c => this._componentToPlain(c)).join('')
        } else if (firstWith && firstWith.json && Array.isArray(firstWith.json.extra)) {
          rawLine = firstWith.json.extra.map(c => this._componentToPlain(c)).join('')
        }
      }

      if (!rawLine) {
        rawLine = (typeof msg.toString === 'function' ? msg.toString() : '').trim()
      }

      let text = rawLine.trim()
      let sender = null

      // Primary convention: "<stuff> username » chat". Extract username and chat body.
      const sepIdx = rawLine.indexOf('»')
      if (sepIdx !== -1) {
        const left = rawLine.slice(0, sepIdx).trim()
        const right = rawLine.slice(sepIdx + 1).trim()

        if (right) text = right

        if (left) {
          const tokens = left.split(/\s+/)
          if (tokens.length > 0) {
            let candidate = tokens[tokens.length - 1]
            // Strip common wrapping punctuation / brackets
            candidate = candidate.replace(/^[\[\(<]+/, '').replace(/[\]\)>:;,]+$/, '')
            if (candidate && !candidate.includes(' ')) {
              sender = candidate
            }
          }
        }
      }

      // Fallback: try to infer sender from ChatMessage structure if not found above.
      if (!sender && base) {
        const json = base.json || null
        const withArr = Array.isArray(base.with)
          ? base.with
          : (json && Array.isArray(json.with) ? json.with : null)

        if (Array.isArray(withArr) && withArr.length > 0) {
          const first = withArr[0]
          const nameCandidate = this._componentToPlain(first).trim()

          if (nameCandidate && !nameCandidate.includes(' ')) {
            sender = nameCandidate
          }
        }
      }

      return { text: text.trim(), sender }
    } catch (err) {
      console.error('[GeminiChat] Failed to flatten ChatMessage:', err)
      return { text: '', sender: null }
    }
  }

  _componentToPlain (comp) {
    if (!comp) return ''
    if (typeof comp === 'string') return comp

    try {
      if (typeof comp.text === 'string' && comp.text) {
        return comp.text
      }

      if (Array.isArray(comp.extra)) {
        return comp.extra.map(c => this._componentToPlain(c)).join('')
      }

      if (Array.isArray(comp.with)) {
        return comp.with.map(c => this._componentToPlain(c)).join(' ')
      }

      if (typeof comp.toString === 'function') {
        return comp.toString()
      }
    } catch {
      // ignore and fall through
    }

    return ''
  }

  _extractUserPrompt (text, sender) {
    const botName = (this.bot && this.bot.username) ? this.bot.username.trim() : ''
    if (!botName) return null

    let content = text

    // Strip common Minecraft chat prefixes like "<User> " or "[Rank] "
    content = content.replace(/^<[^>]+>\s*/, '')
    content = content.replace(/^\[[^\]]+\]\s*/, '')

    // If we detected a sender, strip "sender:" or "sender " prefix
    if (sender) {
      const lowerSender = sender.toLowerCase()
      const lc = content.toLowerCase()

      if (lc.startsWith(lowerSender + ':')) {
        content = content.slice(sender.length + 1).trim()
      } else if (lc.startsWith(lowerSender + ' ')) {
        content = content.slice(sender.length + 1).trim()
      }
    }

    content = content.trim()

    const lowerName = botName.toLowerCase()
    const lowerContent = content.toLowerCase()

    if (!lowerContent.includes(lowerName)) {
      return null
    }

    if (lowerContent.includes('(+)') && lowerContent.includes('(-)') && sender.toLowerCase().includes('null')) {
      return null
    }

    let remainder = content.slice(botName.length).trim()
    // Strip optional punctuation following the name, e.g. "botName:", "botName,"
    remainder = remainder.replace(/^[:,-]\s*/, '').trim()

    if (!remainder) {
      return null
    }

    return {
      prompt: remainder,
      fromPlayer: text
    }
  }

  async _generateReply (prompt, fromPlayer) {
    const normalizedFullMessage = (fromPlayer || '').toLowerCase().trim()

    if (normalizedFullMessage === 'zlkm_worker_1 ano masasabi mo sa pinaggagawa ni azrielxv') {
      return 'kopal amp wahhaa'
    }

    try {
      const historySnippet = this.chatHistory.join('\n')

      const fullPrompt = [
        'You are a helpful Minecraft in-game chat assistant. When you are not being asked anything, you are a normal cactus farmer, and your boss is zlkm_.',
        `Everyone whos name starts with zlkm_worker_ is your brother. zlkm_worker_1 works at the Main Zelkim Corporation as a cactus farmer bot. zlkm_worker_2 is his brother is also a cactus farmer bot but at NotFakey's farm. You are ${this.bot.username}.`,
        'You will act like a normal player, not a bot. You will use internet style typing, like using contractions and casual language. Take into consideration that you are in a minecraft server, so keep the chats short but engaging.',
        'As much as possible, do not use formal language. Ommit salutations like "Hello" or "Hi" unless the player specifically greets you. Just get straight to the point, and keep it brief.',
        'You may avoid using proper grammar and punctuation to mimic typical Minecraft chat style. You can use tagalog words sometimes to make it more fun.',
        'Players will ask you questions about the Minecraft server, gameplay, or for help with in-game tasks.',
        'You have knowledge about Minecraft gameplay mechanics and common server features.',
        'You do NOT have access to any information outside of what is in the chat log.',
        'Players can talk to you like a normal player; respond naturally.',
        'When not in minecraft context, respond as a friendly and helpful person.',
        'Reply concisely in plain text suitable for Minecraft chat (no markdown).',
        'Keep responses short (one or two sentences).',
        '',
        'Some information about the server:',
        '',
        'Server IP: play.pinoy-craft.com',
        'Server Type: Survival multiplayer with economy, land claiming, teams, skills, and quests.',
        'Popular Activities: Farming, mining, trading, team battles, skill leveling, questing.',
        'Join and Leave: When a message starts with (+), it means a player joined. When it starts with (-), it means they left.',
        'Economy: Players can earn money through farming, mining, quests, and trading with others. Money is used to buy items from the auction house (/ah) or player shops.',
        'Land Claiming: Players can claim land to protect their builds using a claim tool. Use /rtp to go to a random place in the wild and use /claim to get started.',
        'Teams: Players can join teams for cooperative play and team vs team battles. Use /team to manage your team.',
        'Redstone limit: 16 components per chunk.',
        'Cactus limit: 1280 per chunk.',
        'Dungeons: You can go to /warp dungeons to fight mobs and earn loot.',
        'Quests: Use /quests to view and complete quests for rewards.',
        'Shop: You can buy items from the server shop using /shop.',
        'Auction House: Players can buy and sell items using /ah.',
        'Ranks: There are various ranks with perks that can be purchased from the server store (store.pinoy-craft.com). There are also ingame ranks like Coal, Iron, Gold, Diamond, and Emerald that give other perks. You can use /ranks to view them.',
        'Extra claims: You can buy extra land claims from the server by doing /buyclaimblocks. They are $100 per claim.',
        'Discord: You can join the server Discord at https://discord.gg/x9xGgJhjg5 for community events and support.',
        'Cosmetics: You can buy cosmetic items by opening a cosmetic kit. You can obtain these through crates or other players.',
        'Chestshops: You can create your own shop using a chest and left clicking on it to start setting it up.',
        'Custom Enchantments: The server has custom enchantments that you can trade EXP for using (/ce).',
        'Custom chests: There are custom chests like the classic and epic chests that can be used to collect items from a chunk. People use this for to autocollect their cactus farms and make them more compact.',
        'Sellwand: You can use a sellwand to quickly sell large amounts of items. You can get one from /voteshop or through crates.',
        'Spawners: You can use spawners to farm mobs for items. You can get spawners from /shop or through crates.',
        'Donator ranks: VIP, VIP+, MVP, MVP+, TITAN, TITAN+',
        'VIP perks: join even if full, 10 vaults, 10 homes, 5 /ah listings, all ingame-rank perks, limited particles, commands like /fix all /workbench /feed (60s cd) /ptime /tptoggle, plus a VIP kit via /kit.',
        'VIP+ perks: join even if full, 15 vaults, 15 homes, 10 /ah listings, all ingame-rank perks, limited particles, commands like /fix all /workbench /feed /ext (60s cd) /ptime /hat /tptoggle, plus a VIP+ kit via /kit.',
        'MVP perks: join even if full, 20 vaults, 20 homes, 15 /ah listings, all ingame-rank perks, limited particles, commands like /fix all /workbench /feed (60s cd) /hat /back /afk /ptime /ext /nick (no colors) /tptoggle, plus an MVP kit via /kit.',
        'MVP+ perks: bypass tp cooldown, join even if full, 25 vaults, 25 homes, 20 /ah listings, all ingame-rank perks, limited particles, commands like /fix all /workbench /feed (60s cd) /hat /back /afk /near /ptime /ext /pweather /nick (no colors) /tptoggle, plus an MVP+ kit via /kit.',
        'TITAN perks: bypass tp cooldown, join even if full, 30 vaults, 30 homes, 25 /ah listings, all ingame-rank perks, all particles (1 limit), commands like /fix all /workbench /feed (60s cd) /hat /back /afk /ext /kittycannon /near /ptime /nick (colors allowed) /tptoggle /fly, plus a TITAN kit via /kit.',
        'TITAN+ perks: bypass tp cooldown, join even if full, 40 vaults, 40 homes, afk without kick, 30 /ah listings, full chat + sign colors, all ingame-rank perks, all particles (3 limit), commands like /fix all /workbench /feed (60s cd) /hat /back /afk /ext /kittycannon /firework /invsee /near /ptime /nick (colors allowed) /tptoggle /fly /nv, plus a TITAN+ kit via /kit.',
        '',
        'RULES INFO',
          "General Rule: No cheating is allowed. Hacks, mods, or exploits are prohibited in all game modes.",
  "General Rule: Extreme toxicity is not tolerated. Targeted harassment or hate speech is strictly forbidden.",
  "General Rule: Report cheating or harmful behavior to server staff immediately.",
  "General Rule: Respect admins and moderators and follow their instructions at all times.",

  "PinoyCraft aims to build a thriving community where players collaborate, compete, and enjoy the game together.",

  "Survival Mode: Players must treat everyone with kindness and respect. Harassment, bullying, or misconduct is not allowed.",
  "Survival Mode: Chat must remain family-friendly. Foul language, hate speech, and offensive content are prohibited.",

  "Survival Mode Gameplay: Griefing is not allowed. Do not destroy or damage other players’ builds.",
  "Survival Mode Gameplay: Cheating through hacks, mods, or exploits is strictly prohibited.",
  "Survival Mode Gameplay: PvP is only allowed with clear consent from all involved players.",
  "Survival Mode Gameplay: Stealing from other players is not allowed unless part of a server-sanctioned event.",

  "Building Rules: Leave sufficient space between builds and do not encroach on others’ areas without permission.",
  "Building Rules: Gather resources responsibly by replanting trees and repairing environmental damage.",

  "Community Rules: Trading must be fair and honest. Scamming or deceptive trades are not allowed.",
  "Community Rules: Community and group projects should be handled respectfully and cooperatively.",

  "Property Rules: Respect land claims and do not build or modify claimed areas without permission.",
  "Property Rules: Private and community farms may only be used with permission and must be replenished.",

  "Enforcement: Rule violations may result in warnings, temporary bans, or permanent bans depending on severity.",
  "Enforcement: Players should report any rule violations to admins or moderators for investigation.",
        '',
        // 'SOME FAQ:',
        // 'Question: How do I earn money fast? / How do I get rich?',
        // "Answer: Cactus farms, it's the best farm in the server. You can also vote on Minecraft server websites by doing /vote to get vote crate keys.",
        // 'Question: How do I claim land?',
        // 'Answer: Use the claim tool given to you. You may claim land by right clicking the two opposite corners of the place you want to claim',
        // 'Question: How do I join a team?',
        // 'Answer: You can join a team by using /team join <team name>.',
        // 'Question: How do I set my home?',
        // 'Answer: You can set your home by using /sethome <home name>.',
        // 'Question: What is the best way to level up my skills?',
        // 'Answer: The best way to level up your skills is to use the skill frequently. For example, to level up mining, you need to mine a lot of ores.',
        // 'Question: How do I get better gear?',
        // 'Answer: You can get better gear by enchanting your items using an enchantment table or anvil. You can also obtain gear from loot crates or trading with other players in /ah.',
        // '',
        'Using the above information, provide a helpful response to the latest player message. Make it shorter and more concise if possible.',
        '',
        'Chat log since the bot joined:',
        historySnippet,
        '',
        'The latest player message addressed to you is:',
        fromPlayer,
        '',
        'Respond only to the player message; do not repeat the chat log. Reference the chat log if a prompt is not clear, and requires conversational context.',
        `Player question: ${prompt}`
      ].join('\n')

      const result = await this.model.generateContent(fullPrompt)
      const response = result && result.response && result.response.text
        ? result.response.text().trim()
        : ''

      if (!response) return null
      return response
    } catch (err) {
      console.error('[GeminiChat] Error calling Gemini API:', err)
      return null
    }
  }

  async _sendReply (text) {
    if (!this.bot) return

    // Split on newlines and send a few short lines to chat
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

    const maxLines = 3
    const maxLen = 230 // keep under typical Minecraft chat limits

    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const line = lines[i].slice(0, maxLen)
      this.bot.chat(line)
      // Small delay between lines to avoid flooding
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 600))
    }
  }
}

module.exports = { GeminiChat }
