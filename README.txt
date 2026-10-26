Chilly fake-nuke effect
=======================

Files:
- chilly-fake-nuke-snippet.js: safe `.start` / `.stop` handler for Discord.js v14.

How to use:
1. Back up your current index.js.
2. Open index.js and find where `const client = new Client(...)` is created.
3. Paste the snippet AFTER the client is created and before `client.login(...)`.
4. Do not paste it inside another event handler.
5. Commit and restart your bot.

Behavior:
- `.start` posts a short simulated sequence in the channel where it was invoked.
- `.stop` requests cancellation.
- Requires Server Owner or Manage Server permission.
- Does not create/delete channels, modify server name, ping @everyone, or flood existing channels.
- Requires the Message Content Intent to be enabled in the Discord Developer Portal and in your Client intents.

Important:
This is a snippet, not a replacement for your full index.js. It avoids overwriting your current economy, giveaway, and moderation code.
