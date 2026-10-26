
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ActivityType
} = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variable.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new Database('chilly.sqlite');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  guild TEXT NOT NULL, user TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER NOT NULL DEFAULT 0, last_work INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild, user)
);
CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, user TEXT NOT NULL,
  moderator TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS giveaways (
  id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL,
  message TEXT, prize TEXT NOT NULL, winners INTEGER NOT NULL,
  host TEXT NOT NULL, ends INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway TEXT NOT NULL, user TEXT NOT NULL,
  PRIMARY KEY (giveaway, user)
);
CREATE TABLE IF NOT EXISTS inventory (
  guild TEXT NOT NULL, user TEXT NOT NULL, item TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild, user, item)
);
`);

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check Chilly latency'),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),

  new SlashCommandBuilder().setName('balance').setDescription('Check coin balance')
    .addUserOption(o => o.setName('user').setDescription('User to check')),
  new SlashCommandBuilder().setName('daily').setDescription('Claim daily coins'),
  new SlashCommandBuilder().setName('work').setDescription('Work to earn coins'),
  new SlashCommandBuilder().setName('give').setDescription('Give coins to a user')
    .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 richest members'),
  new SlashCommandBuilder().setName('shop').setDescription('View the coin shop'),
  new SlashCommandBuilder().setName('buy').setDescription('Buy an item')
    .addStringOption(o => o.setName('item').setDescription('Item').setRequired(true)
      .addChoices(
        { name: 'Cookie (100 coins)', value: 'Cookie' },
        { name: 'Coffee (250 coins)', value: 'Coffee' },
        { name: 'Golden Crown (1000 coins)', value: 'Golden Crown' }
      )),
  new SlashCommandBuilder().setName('inventory').setDescription('View purchased items')
    .addUserOption(o => o.setName('user').setDescription('User to check')),

  new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('View member warnings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Delete 1–100 messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Minutes').setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('untimeout').setDescription('Remove a timeout')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true)),

  new SlashCommandBuilder().setName('8ball').setDescription('Ask the magic 8-ball')
    .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin'),
  new SlashCommandBuilder().setName('dice').setDescription('Roll a die'),
  new SlashCommandBuilder().setName('rps').setDescription('Rock paper scissors')
    .addStringOption(o => o.setName('choice').setDescription('Your choice').setRequired(true)
      .addChoices(
        { name: 'Rock', value: 'rock' },
        { name: 'Paper', value: 'paper' },
        { name: 'Scissors', value: 'scissors' }
      )),
  new SlashCommandBuilder().setName('joke').setDescription('Get a clean joke'),
  new SlashCommandBuilder().setName('ship').setDescription('Fun compatibility score')
    .addUserOption(o => o.setName('user1').setDescription('First user').setRequired(true))
    .addUserOption(o => o.setName('user2').setDescription('Second user').setRequired(true)),

  new SlashCommandBuilder().setName('avatar').setDescription('Show a user avatar')
    .addUserOption(o => o.setName('user').setDescription('User')),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show user information')
    .addUserOption(o => o.setName('user').setDescription('User')),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show server information'),
  new SlashCommandBuilder().setName('poll').setDescription('Create a yes/no poll')
    .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true)),
  new SlashCommandBuilder().setName('calculator').setDescription('Calculate two numbers')
    .addNumberOption(o => o.setName('a').setDescription('First number').setRequired(true))
    .addStringOption(o => o.setName('operator').setDescription('Operation').setRequired(true)
      .addChoices(
        { name: 'Add (+)', value: '+' },
        { name: 'Subtract (-)', value: '-' },
        { name: 'Multiply (×)', value: '*' },
        { name: 'Divide (÷)', value: '/' }
      ))
    .addNumberOption(o => o.setName('b').setDescription('Second number').setRequired(true)),
  new SlashCommandBuilder().setName('remind').setDescription('Set a reminder')
    .addIntegerOption(o => o.setName('seconds').setDescription('10–86400 seconds').setMinValue(10).setMaxValue(86400).setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Reminder text').setRequired(true)),

  new SlashCommandBuilder().setName('giveaway').setDescription('Start a giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setMinValue(1).setMaxValue(10080).setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(20).setRequired(true)),
  new SlashCommandBuilder().setName('giveaway-end').setDescription('End a giveaway early')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true)),
  new SlashCommandBuilder().setName('reroll').setDescription('Pick new giveaway winners')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))
].map(c => c.toJSON());

const getUser = db.prepare('SELECT * FROM users WHERE guild=? AND user=?');
const ensureUser = db.prepare('INSERT OR IGNORE INTO users (guild,user,coins) VALUES (?,?,0)');

function account(guild, user) {
  ensureUser.run(guild, user);
  return getUser.get(guild, user);
}
function coins(n) {
  return `${n.toLocaleString('en-US')} Chilly Coins`;
}
function pick(arr, n) {
  const a = [...arr], out = [];
  while (a.length && out.length < n) {
    out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0]);
  }
  return out;
}

async function finishGiveaway(id, reroll = false) {
  const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
  if (!g) return { error: 'Giveaway ID not found.' };
  if (g.ended && !reroll) return { error: 'That giveaway has already ended.' };

  const entries = db.prepare('SELECT user FROM giveaway_entries WHERE giveaway=?')
    .all(id).map(x => x.user);
  if (!reroll) db.prepare('UPDATE giveaways SET ended=1 WHERE id=?').run(id);

  const winners = pick(entries, g.winners);
  const channel = await client.channels.fetch(g.channel).catch(() => null);

  if (!reroll && channel && g.message) {
    const msg = await channel.messages.fetch(g.message).catch(() => null);
    if (msg) {
      const embed = new EmbedBuilder().setColor(0x5865F2)
        .setTitle('🎉 Giveaway Ended')
        .setDescription(`**Prize:** ${g.prize}\n**Winners:** ${winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No valid entries'}\n**Giveaway ID:** \`${id}\``)
        .setFooter({ text: 'Chilly Giveaways' });
      await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
    await channel.send(
      winners.length
        ? `🎉 Congratulations ${winners.map(id => `<@${id}>`).join(', ')}! You won **${g.prize}**!`
        : `Giveaway \`${id}\` ended with no entries.`
    ).catch(() => {});
  }
  return { winners };
}

client.once('ready', async () => {
  console.log(`Chilly is online as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'Powered by Spidyyy', type: ActivityType.Playing }],
    status: 'online'
  });

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`Registered ${commands.length} slash commands.`);
  } catch (e) {
    console.error('Command registration failed:', e);
  }

  const pending = db.prepare('SELECT id,ends FROM giveaways WHERE ended=0').all();
  for (const g of pending) {
    const delay = Math.max(0, g.ends * 1000 - Date.now());
    setTimeout(() => finishGiveaway(g.id).catch(console.error), Math.min(delay, 2147483647));
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('chilly_enter:')) {
      const id = interaction.customId.split(':')[1];
      const g = db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
      if (!g || g.ended || g.ends * 1000 < Date.now()) {
        return interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
      }
      const result = db.prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway,user) VALUES (?,?)')
        .run(id, interaction.user.id);
      return interaction.reply({
        content: result.changes ? 'You entered the giveaway! Good luck!' : 'You already entered this giveaway.',
        ephemeral: true
      });
    }

    if (!interaction.isChatInputCommand()) return;

    const i = interaction.commandName;
    const guild = interaction.guild;
    const user = interaction.user;
    const target = interaction.options.getUser('user');

    if (!guild && !['ping', 'help'].includes(i)) {
      return interaction.reply({ content: 'Use this command inside a server.', ephemeral: true });
    }

    if (i === 'ping') return interaction.reply(`🏓 Pong! ${client.ws.ping}ms`);

    if (i === 'help') {
      const embed = new EmbedBuilder().setColor(0x77DDE7)
        .setTitle('❄️ Chilly Commands')
        .setDescription(
          '**Moderation:** /warn /warnings /clear /timeout /untimeout /kick /ban /unban\n' +
          '**Economy:** /balance /daily /work /give /leaderboard /shop /buy /inventory\n' +
          '**Fun:** /8ball /coinflip /dice /rps /joke /ship\n' +
          '**Utility:** /avatar /userinfo /serverinfo /poll /calculator /remind\n' +
          '**Giveaways:** /giveaway /giveaway-end /reroll\n' +
          '**General:** /ping /help'
        )
        .setFooter({ text: 'Chilly • Powered by Spidyyy' });
      return interaction.reply({ embeds: [embed] });
    }

    if (i === 'balance') {
      const who = target || user;
      const a = account(guild.id, who.id);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x77DDE7)
          .setAuthor({ name: `${who.username}'s balance`, iconURL: who.displayAvatarURL() })
          .setDescription(`💰 ${coins(a.coins)}`)]
      });
    }

    if (i === 'daily' || i === 'work') {
      const a = account(guild.id, user.id);
      const now = Math.floor(Date.now() / 1000);
      const col = i === 'daily' ? 'last_daily' : 'last_work';
      const cooldown = i === 'daily' ? 86400 : 3600;
      const amount = i === 'daily' ? 500 : Math.floor(Math.random() * 201) + 100;

      if (now - a[col] < cooldown) {
        return interaction.reply({
          content: `Try again in ${Math.ceil((cooldown - (now - a[col])) / 60)} minute(s).`,
          ephemeral: true
        });
      }

      db.prepare(`UPDATE users SET coins=coins+?, ${col}=? WHERE guild=? AND user=?`)
        .run(amount, now, guild.id, user.id);
      return interaction.reply(`❄️ You earned **${coins(amount)}**!`);
    }

    if (i === 'give') {
      const to = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      if (to.bot || to.id === user.id) {
        return interaction.reply({ content: 'Choose another non-bot member.', ephemeral: true });
      }
      const from = account(guild.id, user.id);
      account(guild.id, to.id);
      if (from.coins < amount) {
        return interaction.reply({ content: 'You do not have enough coins.', ephemeral: true });
      }
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET coins=coins-? WHERE guild=? AND user=?')
          .run(amount, guild.id, user.id);
        db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?')
          .run(amount, guild.id, to.id);
      });
      tx();
      return interaction.reply(`💸 <@${user.id}> gave <@${to.id}> **${coins(amount)}**.`);
    }

    if (i === 'leaderboard') {
      const rows = db.prepare('SELECT user,coins FROM users WHERE guild=? ORDER BY coins DESC LIMIT 10')
        .all(guild.id);
      const desc = rows.length
        ? rows.map((r, n) => `**${n + 1}.** <@${r.user}> — ${coins(r.coins)}`).join('\n')
        : 'No balances yet. Use /daily!';
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFFD700)
          .setTitle('🏆 Chilly Coin Leaderboard').setDescription(desc)]
      });
    }

    if (i === 'shop') {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x77DDE7)
          .setTitle('🛍️ Chilly Shop')
          .setDescription('🍪 **Cookie** — 100 coins\n☕ **Coffee** — 250 coins\n👑 **Golden Crown** — 1,000 coins\nUse `/buy` to purchase.')]
      });
    }

    if (i === 'buy') {
      const item = interaction.options.getString('item');
      const prices = { Cookie: 100, Coffee: 250, 'Golden Crown': 1000 };
      const price = prices[item];
      const a = account(guild.id, user.id);
      if (a.coins < price) {
        return interaction.reply({ content: `You need ${coins(price - a.coins)} more.`, ephemeral: true });
      }
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET coins=coins-? WHERE guild=? AND user=?')
          .run(price, guild.id, user.id);
        db.prepare('INSERT INTO inventory (guild,user,item,quantity) VALUES (?,?,?,1) ON CONFLICT(guild,user,item) DO UPDATE SET quantity=quantity+1')
          .run(guild.id, user.id, item);
      });
      tx();
      return interaction.reply(`✅ You bought **${item}** for ${coins(price)}!`);
    }

    if (i === 'inventory') {
      const who = target || user;
      const rows = db.prepare('SELECT item,quantity FROM inventory WHERE guild=? AND user=? AND quantity>0')
        .all(guild.id, who.id);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x77DDE7)
          .setTitle(`🎒 ${who.username}'s Inventory`)
          .setDescription(rows.length ? rows.map(r => `• ${r.item} × ${r.quantity}`).join('\n') : 'Inventory is empty.')]
      });
    }

    if (i === 'warn') {
      const to = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      if (to.bot || to.id === user.id) {
        return interaction.reply({ content: 'Choose another member.', ephemeral: true });
      }
      db.prepare('INSERT INTO warnings (guild,user,moderator,reason,created) VALUES (?,?,?,?,?)')
        .run(guild.id, to.id, user.id, reason, Date.now());
      return interaction.reply(`⚠️ <@${to.id}> was warned. Reason: ${reason}`);
    }

    if (i === 'warnings') {
      const to = interaction.options.getUser('user');
      const rows = db.prepare('SELECT moderator,reason,created FROM warnings WHERE guild=? AND user=? ORDER BY id DESC LIMIT 10')
        .all(guild.id, to.id);
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFFA500)
          .setTitle(`Warnings for ${to.username}`)
          .setDescription(rows.length ? rows.map((r, n) =>
            `${n + 1}. ${r.reason} — <@${r.moderator}> • <t:${Math.floor(r.created / 1000)}:R>`
          ).join('\n') : 'No warnings found.')]
      });
    }

    if (i === 'clear') {
      const amount = interaction.options.getInteger('amount');
      const deleted = await interaction.channel.bulkDelete(amount, true);
      return interaction.reply({ content: `🧹 Deleted ${deleted.size} message(s).`, ephemeral: true });
    }

    if (i === 'timeout' || i === 'untimeout') {
      const to = interaction.options.getUser('user');
      const member = await guild.members.fetch(to.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });

      if (i === 'timeout') {
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await member.timeout(minutes * 60000, reason);
        return interaction.reply(`🔇 Timed out <@${to.id}> for ${minutes} minute(s).`);
      }

      await member.timeout(null);
      return interaction.reply(`🔊 Removed timeout for <@${to.id}>.`);
    }

    if (i === 'kick' || i === 'ban') {
      const to = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reas
