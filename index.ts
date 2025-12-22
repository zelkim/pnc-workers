const { BotManager } = require('./botManager')
const mineflayerViewer = require('prismarine-viewer').mineflayer
require('dotenv').config()

// Basic configuration; you can later extend this or load from a file.
const host = process.env.MC_HOST || 'play.pinoy-craft.com'
const port = parseInt(process.env.MC_PORT || '25565', 10)

// Define as many bot accounts as you like here.
// For online-mode servers, add a password field per account.
const accounts = [
  { username: 'zlkm_worker_1', home_cmd: '/home' },
  { username: 'zlkm_worker_2', home_cmd: '/team home' },
  { username: 'zlkm_worker_3', home_cmd: '/home' },

  // { username: 'zlkm_', home_cmd: '/home', password: process.env.MAIN_PASSWORD }, // example with password
  // { username: 'pnc-bot-2' }
]

const manager = new BotManager()

accounts.forEach((account, index) => {
  const delayMs = index * 5000

  setTimeout(() => {
    manager.createBot(account.username, {
      host,
      port,
      username: account.username,
      home_cmd: account.home_cmd,
      // Enable Gemini chat only for the first bot (index 0)
      enableGemini: false,
      online: false,
      // password: account.password, // uncomment + set when needed
      version: '1.20' // optionally pin a protocol version here
    })

    console.log(`[manager] Requested bot startup #${index + 1} as ${account.username} (delay ${delayMs}ms)`)
  }, delayMs)
})

console.log(`[manager] Scheduled ${accounts.length} bot instance(s) for ${host}:${port} with 3s stagger`) 

const bots = manager.listBots()
if (bots.length > 0) {
  const firstBot = bots[0].bot

  firstBot.once('spawn', () => {
    mineflayerViewer(firstBot, { port: 3007, firstPerson: false })
    console.log('[viewer] Mineflayer viewer started at http://localhost:3007')
  })
}
