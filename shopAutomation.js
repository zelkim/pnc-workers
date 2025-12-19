class ShopAutomation {
  constructor (playerBot) {
    this.playerBot = playerBot
    this.bot = playerBot.bot
    this.shopInterval = null
    this._isSellingCactus = false
    this._chatCaptureRemaining = 0
    this._onMessage = this._onMessage.bind(this)

    this._onWindowOpen = this._onWindowOpen.bind(this)
    this.bot.on('windowOpen', this._onWindowOpen)

    this._onEnd = this._onEnd.bind(this)
    this.bot.on('end', this._onEnd)
  }

  handleServerChange (detectedServer) {
    if (detectedServer === 'survival') {
      this._startShopLoop()
    } else {
      this._stopShopLoop()
    }
  }

  dispose () {
    this._stopShopLoop()
    if (this.bot) {
      this.bot.removeListener('windowOpen', this._onWindowOpen)
      this.bot.removeListener('end', this._onEnd)
      this.bot.removeListener('message', this._onMessage)
    }
  }

  _onEnd () {
    this._stopShopLoop()
  }

  _onMessage (msg) {
    if (this._chatCaptureRemaining <= 0) return

    const text = msg.toString()
    console.log(`[${this.playerBot.id}] [capture] chat: "${text}"`)

    this._chatCaptureRemaining--
    if (this._chatCaptureRemaining <= 0) {
      console.log(`[${this.playerBot.id}] Finished capturing 5 chat messages after cactus click`)
      if (this.bot) this.bot.removeListener('message', this._onMessage)
    }
  }

  _startShopLoop () {
    if (this.shopInterval) return

    console.log(`[${this.playerBot.id}] Starting sellAllCactus loop (every 5s on survival)`)

    this.shopInterval = setInterval(async () => {
      try {
        if (this.playerBot.currentServer !== 'survival') return

        if (this._isSellingCactus) {
          console.log(`[${this.playerBot.id}] sellAllCactus already running; skipping this tick`)
          return
        }

        this._isSellingCactus = true
        await this.sellAllCactus()
      } catch (err) {
        console.error(`[${this.playerBot.id}] Error in sellAllCactus loop:`, err)
      } finally {
        this._isSellingCactus = false
      }
    }, 60000 * 5)
        // }, 10000)

  }

  _stopShopLoop () {
    // No-op kept for backwards compatibility.
    if (this.shopInterval) {
      clearInterval(this.shopInterval)
      this.shopInterval = null
    }
  }

  _parseBalance (text) {
    if (!text || typeof text !== 'string') {
      return { raw: text || '', value: NaN }
    }

    const match = text.match(/([0-9][0-9,]*\.?[0-9]*)/)
    if (!match) {
      return { raw: text, value: NaN }
    }

    const numeric = match[1].replace(/,/g, '')
    const value = parseFloat(numeric)
    if (Number.isNaN(value)) {
      return { raw: text, value: NaN }
    }

    return { raw: text, value }
  }

  async _getCurrentBalance () {
    const bot = this.bot

    return new Promise((resolve) => {
      const timeoutMs = 5000
      let resolved = false

      const handler = (msg) => {
        if (resolved) return
        const text = msg.toString()
        resolved = true
        console.log(`[${this.playerBot.id}] Captured /bal response: "${text}"`)
        bot.removeListener('message', handler)
        resolve(this._parseBalance(text))
      }

      bot.on('message', handler)
      bot.chat('/bal')

      setTimeout(() => {
        if (resolved) return
        resolved = true
        bot.removeListener('message', handler)
        resolve({ raw: 'unknown', value: NaN })
      }, timeoutMs)
    })
  }

  async sellAllCactus () {
    const bot = this.bot

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

    const isCactusItem = (item) => {
      if (!item) return false
      const name = item.name || ''
      const display = item.displayName || ''
      return name === 'cactus' || /cactus/i.test(display)
    }

    const countCactusInInventory = () => {
      return (bot.inventory.items() || [])
        .filter(isCactusItem)
        .reduce((sum, item) => sum + (item.count || 0), 0)
    }

    const findNextCactusSlot = () => {
      const slots = bot.inventory.slots || []
      for (let i = 0; i < slots.length; i++) {
        const item = slots[i]
        if (isCactusItem(item)) {
          return { slot: i, count: item.count || 0 }
        }
      }
      return { slot: -1, count: 0 }
    }

    const ensureFirstHotbarSelected = () => {
      if (bot.quickBarSlot !== 0) {
        console.log(`[${this.playerBot.id}] Setting quickBarSlot to 0 (first hotbar slot)`)
        bot.setQuickBarSlot(0)
      }
    }

    console.log(`[${this.playerBot.id}] Starting sellAllCactus workflow`)

    // Initial cactus count snapshot
    let remainingCactus = countCactusInInventory()
    const initialCactus = remainingCactus

    if (remainingCactus <= 0) {
      console.log(`[${this.playerBot.id}] No cactus found in inventory; aborting sellAllCactus`)
      return
    }

    // Capture balance before selling
    const beforeBalance = await this._getCurrentBalance()

    ensureFirstHotbarSelected()

    const firstHotbarSlot = 36 // internal slot index for hotbar slot 1

    while (remainingCactus > 0) {
      const { slot, count } = findNextCactusSlot()
      if (slot === -1) {
        // console.log(`[${this.playerBot.id}] No more cactus stacks found while ${remainingCactus} remaining; stopping.`)
        break
      }

      // console.log(`[${this.playerBot.id}] Moving cactus stack from slot ${slot} (count=${count}) to first hotbar slot (36)`)

      try {
        if (slot !== firstHotbarSlot) {
          await bot.moveSlotItem(slot, firstHotbarSlot)
        }
      } catch (err) {
        console.error(`[${this.playerBot.id}] Error moving cactus stack from slot ${slot} to ${firstHotbarSlot}:`, err)
        break
      }

      ensureFirstHotbarSelected()
      bot.chat('/sell hand')
      remainingCactus -= count
      
      // Small delay to avoid spamming commands and to let
      // the server process the sell.
      await sleep(3000)
    }

    // After selling, capture new balance and report earnings
    const afterBalance = await this._getCurrentBalance()
    let earnedText = 'unknown'

    if (Number.isFinite(beforeBalance.value) && Number.isFinite(afterBalance.value)) {
      const earned = afterBalance.value - beforeBalance.value
      if (Number.isFinite(earned)) {
        earnedText = `$${earned.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      }
    }

    const cactusSold = initialCactus
    const resultWhisper = `/w zlkm_ Cactus sold! - Earned: ${earnedText}`
    console.log(`[${this.playerBot.id}] Finished sellAllCactus. Sending summary whisper: ${resultWhisper}`)
    bot.chat(resultWhisper)

    // After reporting, pay all current balance to zlkm_
    try {
      await this.payAll()
    } catch (err) {
      console.error(`[${this.playerBot.id}] Error while running payAll after cactus sell:`, err)
    }
  }

  async payAll () {
    const bot = this.bot

    console.log(`[${this.playerBot.id}] Starting payAll workflow`)

    const balance = await this._getCurrentBalance()

    if (!Number.isFinite(balance.value) || balance.value <= 0) {
      console.log(
        `[${this.playerBot.id}] Balance is not a positive number (raw="${balance.raw}"); aborting payAll`
      )
      return
    }

    const amountStr = balance.value.toFixed(2)
    const cmd = `/pay zlkm_ ${amountStr}`

    console.log(`[${this.playerBot.id}] Paying all balance to zlkm_: ${cmd}`)
    bot.chat(cmd)
  }

  _onWindowOpen (window) {
    let titleObj = null
    let flatTitle = '<no title>'

    try {
      const raw = window.title

      if (typeof raw === 'string') {
        try {
          titleObj = JSON.parse(raw)
        } catch {
          flatTitle = raw
        }
      } else if (raw && typeof raw === 'object') {
        titleObj = raw
      }

      if (titleObj) {
        const parts = []
        if (typeof titleObj.text === 'string') parts.push(titleObj.text)
        if (Array.isArray(titleObj.extra)) {
          for (const comp of titleObj.extra) {
            if (comp && typeof comp.text === 'string') parts.push(comp.text)
          }
        }
        const combined = parts.join('')
        flatTitle = combined || JSON.stringify(titleObj)
      }
    } catch (e) {
      flatTitle = String(window.title)
    }

    console.log(`[${this.playerBot.id}] windowOpen: title="${flatTitle}", raw=${window.title}`)

    // deprecated
    // if (flatTitle === 'ѕᴇʟᴇᴄᴛ ᴀ ѕʜᴏᴘ ᴄᴀᴛᴇɢᴏʀʏ...') {
    //   this._clickShopCategoryBread(window)
    //   return
    // }

    // Farm & Food page where cactus item is listed
    if (flatTitle === 'ꜰᴀʀᴍ ᴀɴᴅ ꜰᴏᴏᴅ [ᴘᴀɢᴇ 1/5]') {
      this._clickFarmFoodCactus(window)
      return
    }

    // Cactus sell GUI, e.g. a title like "Selling (Cactus)"
    if (flatTitle.includes('Selling (Cactus)') || flatTitle.includes('cactus')) {
      this._clickCactusSellEnderchest(window)
    }
  }

  _logSlots (window) {
    const slots = window.slots || []
    console.log(`[${this.playerBot.id}] Inspecting window slots (total ${slots.length})`)
    // slots.forEach((item, index) => {
    //   if (!item) return
    //   console.log(`[$${this.playerBot.id}]  slot ${index}: name="${item.name}", displayName="${item.displayName}"`)
    // })
    return slots
  }

  _clickFarmFoodCactus (window) {
    const bot = this.bot
    const slots = this._logSlots(window)

    const cactusSlot = slots.findIndex((item) => {
      if (!item) return false
      const name = item.name || ''
      const display = item.displayName || ''
      return name === 'cactus' || /cactus/i.test(display)
    })

    if (cactusSlot === -1) {
      console.log(`[${this.playerBot.id}] Farm & Food window did not contain cactus; not clicking`)
      return
    }

    console.log(`[${this.playerBot.id}] In Farm & Food window, right-clicking cactus at slot ${cactusSlot}, bot.currentWindow id=${bot.currentWindow && bot.currentWindow.id}`)

    // Make sure we're clicking in the currently open window
    if (bot.currentWindow !== window) {
      console.log(
        `[${this.playerBot.id}] Adjusting currentWindow before cactus click (was id=${bot.currentWindow && bot.currentWindow.id}, new id=${window.id})`
      )
      bot.currentWindow = window
    }

    console.log(`[${this.playerBot.id}] Calling bot.clickWindow on cactus slot`)

    try {
      // button=1 (right click), mode=0 (normal right-click)
      bot.simpleClick.rightMouse(cactusSlot, (err) => {
        console.log(
          `[${this.playerBot.id}] bot.clickWindow callback for cactus slot invoked (err=${err || 'none'})`
        )

        if (err) {
          console.log(
            `[${this.playerBot.id}] Error clicking cactus in Farm & Food window:`,
            err
          )
          return
        }

        console.log(
          `[${this.playerBot.id}] Cactus click completed, starting capture of next 5 chat messages`
        )
      })
    } catch (e) {
      console.error(
        `[${this.playerBot.id}] Exception while calling bot.clickWindow on cactus slot:`,
        e
      )
    }
  }

  _clickCactusSellEnderchest (window) {
    const bot = this.bot
    const slots = this._logSlots(window)

    const enderSlot = slots.findIndex((item) => {
      if (!item) return false
      const name = item.name || ''
      const display = item.displayName || ''
      return name === 'ender_chest' || /ender.?chest/i.test(display)
    })

    if (enderSlot === -1) {
      console.log(
        `[${this.playerBot.id}] Cactus sell window did not contain an ender chest; not clicking`
      )
      return
    }

    console.log(
      `[${this.playerBot.id}] In cactus sell window, left-clicking ender2 chest at slot ${enderSlot}, bot.currentWindow id=${bot.currentWindow && bot.currentWindow.id}`
    )

    // // Make sure we're acting on the correct window instance
    // if (bot.currentWindow !== window) {
    //   console.log(
    //     `[${this.playerBot.id}] Adjusting currentWindow before ender-chest click (was id=${bot.currentWindow && bot.currentWindow.id}, new id=${window.id})`
    //   )
    //   bot.currentWindow = window
    // }

    // console.log(`[${this.playerBot.id}] Calling bot.clickWindow on ender chest slot: enderSlot=${enderSlot}, window.id=${window.id}, window=${JSON.stringify(window)}`)

    try {
      // Use simpleClick.leftMouse for consistency with cactus click handling
      bot.simpleClick.leftMouse(enderSlot)

      console.log(
          `[${this.playerBot.id}] Successfully left-clicked ender chest to sell cactus: `
        )

        // Count cactus remaining in inventory
        const cactusCount = (bot.inventory.items() || [])
          .filter(item => {
            if (!item) return false
            const name = item.name || ''
            const display = item.displayName || ''
            return name === 'cactus' || /cactus/i.test(display)
          })
          .reduce((sum, item) => sum + (item.count || 0), 0)

        // After a successful sell, query balance with /bal and then
        // whisper zlkm_ the result along with remaining cactus count.
        const handleBalMessage = (msg) => {
          const text = msg.toString()
          console.log(`[${this.playerBot.id}] /bal response captured: "${text}"`)

          const balanceText = text
          const whisperMessage = `/w zlkm_ Sold cactus. [${balanceText}, inventory cactus: ${cactusCount}]`
          console.log(`[${this.playerBot.id}] Sending whisper: ${whisperMessage}`)
          bot.chat(whisperMessage)
        }

        console.log(`[${this.playerBot.id}] Requesting balance with /bal`)
        bot.once('message', handleBalMessage)
        bot.chat('/bal')
    } catch (e) {
      console.error(
        `[${this.playerBot.id}] Exception while clicking ender chest in cactus sell window:`,
        e
      )
    }
  }
}

module.exports = { ShopAutomation }
