
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder
} = require('discord.js');

const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const db = new Database('chilly.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  wallet INTEGER NOT NULL DEFAULT 0,
  bank INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS giveaways (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  prize TEXT NOT NULL,
  ends_at INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
`);

function account(userId, guildId) {
  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, guild_id)
    VALUES (?, ?)
  `).run(userId, guildId);

  return db.prepare(`
    SELECT * FROM users WHERE user_id = ? AND guild_id = ?
  `).get(userId, guildId);
}

function updateBalance(userId, guildId, wallet, bank) {
  db.prepare(`
    UPDATE users SET wallet = ?, bank = ?
    WHERE user_id = ? AND guild_id = ?
  `).run(wallet, bank, userId, guildId);
}

function isMod(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.ModerateMembers
  ) || interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

const commands = [
  new SlashCommandBuilder().setName('ping')
    .setDescription('Check bot latency'),

  new SlashCommandBuilder().setName('help')
    .setDescription('Show Chilly commands'),

  new SlashCommandBuilder().setName('say')
    .setDescription('Send a message to a channel')
    .addChannelOption(o => o.setName('channel')
      .setDescription('Target text channel')
      .addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('message')
      .setDescription('Message to send').setRequired(true)),

  new SlashCommandBuilder().setName('money')
    .setDescription('Owner-only: manage server economy')
    .addSubcommand(s => s.setName('add')
      .setDescription('Add coins to a member')
      .addUserOption(o => o.setName('user')
        .setDescription('Member').setRequired(true))
      .addIntegerOption(o => o.setName('amount')
        .setDescription('Amount').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('remove')
      .setDescription('Remove coins from a member')
      .addUserOption(o => o.setName('user')
        .setDescription('Member').setRequired(true))
      .addIntegerOption(o => o.setName('amount')
        .setDescription('Amount').setMinValue(1).setRequired(true))),

  new SlashCommandBuilder().setName('balance')
    .setDescription('Check your balance')
    .addUserOption(o => o.setName('user')
      .setDescription('Member to check')),

  new SlashCommandBuilder().setName('daily')
    .setDescription('Claim daily coins'),

  new SlashCommandBuilder().setName('work')
    .setDescription('Work to earn coins'),

  new SlashCommandBuilder().setName('give')
    .setDescription('Give coins to a member')
    .addUserOption(o => o.setName('user')
      .setDescription('Recipient').setRequired(true))
    .addIntegerOption(o => o.setName('amount')
      .setDescription('Amount').setMinValue(1).setRequired(true)),

  new SlashCommandBuilder().setName('leaderboard')
    .setDescription('Show the richest members'),

  new SlashCommandBuilder().setName('shop')
    .setDescription('View the item shop'),

  new SlashCommandBuilder().setName('buy')
    .setDescription('Buy a shop item')
    .addStringOption(o => o.setName('item')
      .setDescription('Item name')
      .setRequired(true)
      .addChoices(
        { name: 'Bronze VIP', value: 'Bronze VIP' },
        { name: 'Silver VIP', value: 'Silver VIP' },
        { name: 'Gold VIP', value: 'Gold VIP' },
        { name: 'Diamond VIP', value: 'Diamond VIP' }
      )),

  new SlashCommandBuilder().setName('inventory')
    .setDescription('View your purchased items'),

  new SlashCommandBuilder().setName('warn')
    .setDescription('Warn a member')
    .addUserOption(o => o.setName('user')
      .setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason')
      .setDescription('Reason').setRequired(true)),

  new SlashCommandBuilder().setName('warnings')
    .setDescription('View member warnings')
    .addUserOption(o => o.setName('user')
      .setDescription('Member').setRequired(true)),

  new SlashCommandBuilder().setName('clear')
    .setDescription('Delete recent messages')
    .addIntegerOption(o => o.setName('amount')
      .setDescription('Number of messages (1–100)')
      .setMinValue(1).setMaxValue(100).setRequired(true)),

  new SlashCommandBuilder().setName('timeout')
    .setDescription('Timeout a member')
    .addUserOption(o => o.setName('user')
      .setDescription('Member').setRequired(true))
    .addIntegerOption(o => o.setName('minutes')
      .setDescription('Duration in minutes')
      .setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName('reason')
      .setDescription('Reason')),

  new SlashCommandBuilder().setName('untimeout')
    .setDescription('Remove member timeout')
    .addUserOption(o => o.setName('user')
      .setDescription('Member').setRequired(true)),

  new SlashCommandBuilder().setName('kick')
    .setDescription('Kick a member')
    .addUserOption(o => o.setName('user')
      .setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason')
      .setDescription('Reason')),

  new SlashCommandBuilder().setName('ban')
    .setDescription('Ban a member')
    .addUserOption(o => o.setName('user')
      .setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason')
      .setDescription('Reason')),

  new SlashCommandBuilder().setName('unban')
    .setDescription('Unban a member')
    .addStringOption(o => o.setName('userid')
      .setDescription('Discord user ID').setRequired(true)),

  new SlashCommandBuilder().setName('8ball')
    .setDescription('Ask the magic 8-ball')
    .addStringOption(o => o.setName('question')
      .setDescription('Your question').setRequired(true)),

  new SlashCommandBuilder().setName('coinflip')
    .setDescription('Flip a coin'),

  new SlashCommandBuilder().setName('dice')
    .setDescription('Roll a six-sided die'),

  new SlashCommandBuilder().setName('rps')
    .setDescription('Play rock paper scissors')
    .addStringOption(o => o.setName('choice')
      .setDescription('Your move').setRequired(true)
      .addChoices(
        { name: 'Rock', value: 'rock' },
        { name: 'Paper', value: 'paper' },
        { name: 'Scissors', value: 'scissors' }
      )),

  new SlashCommandBuilder().setName('joke')
    .setDescription('Get a joke'),

  new SlashCommandBuilder().setName('ship')
    .setDescription('Calculate a fun compatibility score')
    .addUserOption(o => o.setName('user1')
      .setDescription('First member').setRequired(true))
    .addUserOption(o => o.setName('user2')
      .setDescription('Second member').setRequired(true)),

  new SlashCommandBuilder().setName('avatar')
    .setDescription('Show a member avatar')
    .addUserOption(o => o.setName('user')
      .setDescription('Member')),

  new SlashCommandBuilder().setName('userinfo')
    .setDescription('Show member information')
    .addUserOption(o => o.setName('user')
      .setDescription('Member')),

  new SlashCommandBuilder().setName('serverinfo')
    .setDescription('Show server information'),

  new SlashCommandBuilder().setName('poll')
    .setDescription('Create a poll')
    .addStringOption(o => o.setName('question')
      .setDescription('Poll question').setRequired(true)),

  new SlashCommandBuilder().setName('calculator')
    .setDescription('Calculate two numbers')
    .addNumberOption(o => o.setName('a')
      .setDescription('First number').setRequired(true))
    .addStringOption(o => o.setName('operation')
      .setDescription('Operation').setRequired(true)
      .addChoices(
        { name: 'Add', value: 'add' },
        { name: 'Subtract', value: 'subtract' },
        { name: 'Multiply', value: 'multiply' },
        { name: 'Divide', value: 'divide' }
      ))
    .addNumberOption(o => o.setName('b')
      .setDescription('Second number').setRequired(true)),

  new SlashCommandBuilder().setName('remind')
    .setDescription('Set a reminder in seconds')
    .addIntegerOption(o => o.setName('seconds')
      .setDescription('Seconds (5–3600)')
      .setMinValue(5).setMaxValue(3600).setRequired(true))
    .addStringOption(o => o.setName('message')
      .setDescription('Reminder text').setRequired(true)),

  new SlashCommandBuilder().setName('giveaway')
    .setDescription('Create a giveaway')
    .addIntegerOption(o => o.setName('minutes')
      .setDescription('Duration in minutes')
      .setMinValue(1).setMaxValue(10080).setRequired(true))
    .addStringOption(o => o.setName('prize')
      .setDescription('Prize').setRequired(true)),

  new SlashCommandBuilder().setName('giveaway-end')
    .setDescription('End a giveaway early')
    .addStringOption(o => o.setName('messageid')
      .setDescription('Giveaway message ID').setRequired(true)),

  new SlashCommandBuilder().setName('reroll')
    .setDescription('Pick a new giveaway winner')
    .addStringOption(o => o.setName('messageid')
      .setDescription('Giveaway message ID').setRequired(true))
].map(c => c.toJSON());

const shopItems = {
  'Bronze VIP': 10000,
  'Silver VIP': 25000,
  'Gold VIP': 65000,
  'Diamond VIP': 100000
};

async function finishGiveaway(messageId, channel, reroll = false) {
  const giveaway = db.prepare(
    'SELECT * FROM giveaways WHERE message_id = ?'
  ).get(messageId);

  if (!giveaway) {
    throw new Error('Giveaway not found.');
  }

  const entries = db.prepare(
    'SELECT user_id FROM giveaway_entries WHERE message_id = ?'
  ).all(messageId);

  if (!entries.length) {
    if (!reroll) {
      db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?')
        .run(messageId);
    }
    await channel.send(`🎁 **${giveaway.prize}** — no entries.`);
    return;
  }

  const winner = entries[Math.floor(Math.random() * entries.length)];

  if (!reroll) {
    db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?')
      .run(messageId);
  }

  await channel.send(
    `🎉 Congratulations <@${winner.user_id}>! You won **${giveaway.prize}**!`,
    { allowedMentions: { users: [winner.user_id] } }
  );
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setActivity('Powered by Spidyyy');

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Command registration failed:', error);
  }

  const active = db.prepare(
    'SELECT * FROM giveaways WHERE ended = 0'
  ).all();

  for (const giveaway of active) {
    const delay = giveaway.ends_at - Date.now();

    if (delay <= 0) {
      const channel = await client.channels.fetch(giveaway.channel_id)
        .catch(() => null);
      if (channel) {
        await finishGiveaway(giveaway.message_id, channel).catch(console.error);
      }
    } else {
      setTimeout(async () => {
        const channel = await client.channels.fetch(giveaway.channel_id)
          .catch(() => null);
        if (channel) {
          await finishGiveaway(giveaway.message_id, channel)
            .catch(console.error);
        }
      }, Math.min(delay, 2147483647));
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  try {
    if (!guildId && name !== 'ping' && name !== 'help') {
      return interaction.reply({
        content: 'Use this command inside a server.',
        ephemeral: true
      });
    }

    if (name === 'ping') {
      return interaction.reply(`🏓 Pong! ${client.ws.ping}ms`);
    }

    if (name === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('❄️ Chilly Commands')
        .setDescription(
          '**Moderation:** `/warn` `/warnings` `/clear` `/timeout` `/untimeout` `/kick` `/ban` `/unban`\n' +
          '**Economy:** `/money` `/balance` `/daily` `/work` `/give` `/leaderboard` `/shop` `/buy` `/inventory`\n' +
          '**Utility:** `/ping` `/say` `/avatar` `/userinfo` `/serverinfo` `/poll` `/calculator` `/remind`\n' +
          '**Fun & Games:** `/8ball` `/coinflip` `/dice` `/rps` `/joke` `/ship`\n' +
          '**Giveaways:** `/giveaway` `/giveaway-end` `/reroll`\n' +
          '**Prefix:** `.start` `.stop`'
        );

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (name === 'say') {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ content: '❌ Manage Messages permission required.', ephemeral: true });
      }

      const channel = interaction.options.getChannel('channel');
      const content = interaction.options.getString('message');

      await channel.send({
        content,
        allowedMentions: { parse: [] }
      });

      return interaction.reply({ content: '✅ Message sent.', ephemeral: true });
    }

    if (name === 'money') {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({ content: '❌ Server owner only.', ephemeral: true });
      }

      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const sub = interaction.options.getSubcommand();
      const acc = account(target.id, guildId);

      if (sub === 'add') {
        updateBalance(target.id, guildId, acc.wallet + amount, acc.bank);
      } else {
        if (acc.wallet < amount) {
          return interaction.reply({ content: 'Not enough wallet coins to remove.', ephemeral: true });
        }
        updateBalance(target.id, guildId, acc.wallet - amount, acc.bank);
      }

      return interaction.reply(`💰 Updated ${target.username}'s wallet.`);
    }

    if (name === 'balance') {
      const target = interaction.options.getUser('user') || interaction.user;
      const acc = account(target.id, guildId);
      return interaction.reply(
        `💰 **${target.username}**\nWallet: **${acc.wallet}**\nBank: **${acc.bank}**`
      );
    }

    if (name === 'daily') {
      const acc = account(userId, guildId);
      const now = Date.now();

      if (now - acc.last_daily < 86400000) {
        const remaining = Math.ceil((86400000 - (now - acc.last_daily)) / 3600000);
        return interaction.reply({ content: `⏳ Daily already claimed. Try again in about ${remaining} hour(s).`, ephemeral: true });
      }

      db.prepare('UPDATE users SET wallet = wallet + 500, last_daily = ? WHERE user_id = ? AND guild_id = ?')
        .run(now, userId, guildId);

      return interaction.reply('🎁 You claimed **500 coins**!');
    }

    if (name === 'work') {
      const amount = Math.floor(Math.random() * 201) + 100;
      account(userId, guildId);
      db.prepare('UPDATE users SET wallet = wallet + ? WHERE user_id = ? AND guild_id = ?')
        .run(amount, userId, guildId);
      return interaction.reply(`🛠️ You worked and earned **${amount} coins**!`);
    }

    if (name === 'give') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      if (target.bot || target.id === userId) {
        return interaction.reply({ content: 'Choose another human member.', ephemeral: true });
      }

      const acc = account(userId, guildId);
      account(target.id, guildId);

      if (acc.wallet < amount) {
        return interaction.reply({ content: '❌ Not enough wallet coins.', ephemeral: true });
      }

      db.prepare('UPDATE users SET wallet = wallet - ? WHERE user_id = ? AND guild_id = ?')
        .run(amount, userId, guildId);
      db.prepare('UPDATE users SET wallet = wallet + ? WHERE user_id = ? AND guild_id = ?')
        .run(amount, target.id, guildId);

      return interaction.reply(`💸 Sent **${amount} coins** to ${target}.`);
    }

    if (name === 'leaderboard') {
      const rows = db.prepare(
        'SELECT user_id, wallet, bank FROM users WHERE guild_id = ? ORDER BY wallet + bank DESC LIMIT 10'
      ).all(guildId);

      const text = rows.length
        ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.wallet + r.bank} coins`).join('\n')
        : 'No economy accounts yet.';

      return interaction.reply({ content: `🏆 **Economy Leaderboard**\n${text}` });
    }

    if (name === 'shop') {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🛍️ Chilly Shop')
            .setColor(0x57F287)
            .setDescription(Object.entries(shopItems).map(([item, price]) => `**${item}** — ${price.toLocaleString()} coins`).join('\n'))
        ],
        ephemeral: true
      });
    }

    if (name === 'buy') {
      const item = interaction.options.getString('item');
      const price = shopItems[item];
      const acc = account(userId, guildId);

      if (acc.wallet < price) {
        return interaction.reply({ content: '❌ Not enough coins.', ephemeral: true });
      }

      updateBalance(userId, guildId, acc.wallet - price, acc.bank);
      db.prepare('INSERT INTO inventory (guild_id, user_id, item) VALUES (?, ?, ?)')
        .run(guildId, userId, item);

      return interaction.reply(`✅ Purchased **${item}** for ${price.toLocaleString()} coins!`);
    }

    if (name === 'inventory') {
      const rows = db.prepare(
        'SELECT item FROM inventory WHERE guild_id = ? AND user_id = ?'
      ).all(guildId, userId);

      return interaction.reply({
        content: rows.length
          ? `🎒 Your items:\n${rows.map(r => `• ${r.item}`).join('\n')}`
          : 'Your inventory is empty.',
        ephemeral: true
      });
    }

    if (['warn', 'warnings', 'clear', 'timeout', 'untimeout', 'kick', 'ban', 'unban'].includes(name)) {
      if (!isMod(interaction)) {
        return interaction.reply({ content: '❌ You need moderation permissions.', ephemeral: true });
      }

      if (name === 'warn') {
        const target = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');

        db.prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(guildId, target.id, userId, reason, Date.now());

        return interaction.reply(`⚠️ ${target} warned. Reason: ${reason}`);
      }

      if (name === 'warnings') {
        const target = interaction.options.getUser('user');
        const rows = db.prepare(
          'SELECT reason, moderator_id FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10'
        ).all(guildId, target.id);

        return interaction.reply({
          content: rows.length
            ? `⚠️ Warnings for ${target.username}:\n${rows.map((r, i) => `${i + 1}. ${r.reason} — by <@${r.moderator_id}>`).join('\n')}`
            : `${target.username} has no warnings.`,
          ephemeral: true
        });
      }

      if (name === 'clear') {
        const amount = interaction.options.getInteger('amount');
        const channel = interaction.channel;

        if (!channel.bulkDelete) {
          return interaction.reply({ content: 'This channel does not support bulk delete.', ephemeral: true });
        }

        await channel.bulkDelete(amount, true);
        return interaction.reply({ content: `🧹 Deleted ${amount} messages.`, ephemeral: true });
      }

      if (name === 'unban') {
        const id = interaction.options.getString('userid');
        await interaction.guild.members.unban(id);
        return interaction.reply(`✅ Unbanned user ID ${id}.`);
      }

      const target = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(target.id);

      if (name === 'timeout') {
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await member.timeout(minutes * 60000, reason);
        return interaction.reply(`⏳ Timed out ${target} for ${minutes} minute(s).`);
      }

      if (name === 'untimeout') {
        await member.timeout(null);
        return interaction.reply(`✅ Timeout removed for ${target}.`);
      }

      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (name === 'kick') {
        await member.kick(reason);
        return interaction.reply(`👢 Kicked ${target}. Reason: ${reason}`);
      }

      if (name === 'ban') {
        await member.ban({ reason });
        return interaction.reply(`🔨 Banned ${target}. Reason: ${reason}`);
      }
    }

    if (name === '8ball') {
      const answers = [
        'Absolutely!', 'Definitely not.', 'Maybe!', 'Ask again later.',
        'It looks promising.', 'I do not think so.', 'Without a doubt!'
      ];
      return interaction.reply(`🎱 ${answers[Math.floor(Math.random() * answers.length)]}`);
    }

    if (name === 'coinflip') {
      return interaction.reply(`🪙 It's **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**!`);
    }

    if (name === 'dice') {
      return interaction.reply(`🎲 You rolled **${Math.floor(Math.random() * 6) + 1}**.`);
    }

    if (name === 'rps') {
      const userChoice = interaction.options.getString('choice');
      const choices = ['rock', 'paper', 'scissors'];
      const botChoice = choices[Math.floor(Math.random() * choices.length)];

      let result = 'It is a draw!';
      if (
        (userChoice === 'rock' && botChoice === 'scissors') ||
        (userChoice === 'paper' && botChoice === 'rock') ||
        (userChoice === 'scissors' && botChoice === 'paper')
      ) result = 'You win!';
      else if (userChoice !== botChoice) result = 'I win!';

      return interaction.reply(`You chose **${userChoice}**. I chose **${botChoice}**. ${result}`);
    }

    if (name === 'joke') {
      const jokes = [
        'Why do programmers prefer dark mode? Because light attracts bugs.',
        'Why did the computer get cold? It left its Windows open.',
        'Why was the math book sad? It had too many problems.'
      ];
      return interaction.reply(jokes[Math.floor(Math.random() * jokes.length)]);
    }

    if (name === 'ship') {
      const a = interaction.options.getUser('user1');
      const b = interaction.options.getUser('user2');
      const score = Math.floor(Math.random() * 101);
      return interaction.reply(`💞 **${a.username} + ${b.username} = ${score}%** compatibility! Just for fun.`);
    }

    if (name === 'avatar') {
      const user = interaction.options.getUser('user') || interaction.user;
      const embed = new EmbedBuilder()
        .setTitle(`${user.username}'s Avatar`)
        .setImage(user.displayAvatarURL({ size: 1024 }))
        .setColor(0x5865F2);

      return interaction.reply({ embeds: [embed] });
    }

    if (name === 'userinfo') {
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`User Info: ${user.username}`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
              { name: 'User ID', value: user.id },
              { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>` },
              { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'Unknown' }
            )
            .setColor(0x5865F2)
        ]
      });
    }

    if (name === 'serverinfo') {
      const guild = interaction.guild;
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(guild.name)
            .setThumbnail(guild.iconURL())
            .addFields(
              { name: 'Members', value: `${guild.memberCount}`, inline: true },
              { name: 'Server ID', value: guild.id, inline: true },
              { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>` }
            )
            .setColor(0x5865F2)
        ]
      });
    }

    if (name === 'poll') {
      const question = interaction.options.getString('question');
      const msg = await interaction.reply({
        content: `📊 **Poll:** ${question}`,
        fetchReply: true,
        allowedMentions: { parse: [] }
      });

      await msg.react('👍');
      await msg.react('👎');
      return;
    }

    if (name === 'calculator') {
      const a = interaction.options.getNumber('a');
      const b = interaction.options.getNumber('b');
      const op = interaction.options.getString('operation');

      if (op === 'divide' && b === 0) {
        return interaction.reply({ content: '❌ Cannot divide by zero.', ephemeral: true });
      }

      const result = {
        add: a + b,
        subtract: a - b,
        multiply: a * b,
        divide: a / b
      }[op];

      return interaction.reply(`🧮 Result: **${result}**`);
    }

    if (name === 'remind') {
      const seconds = interaction.options.getInteger('seconds');
      const reminder = interaction.options.getString('message');

      await interaction.reply(`⏰ I'll remind you in ${seconds} seconds.`);
      setTimeout(() => {
        interaction.user.send(`⏰ Reminder: ${reminder}`).catch(() => {});
      }, seconds * 1000);
      return;
    }

    if (name === 'giveaway') {
      if (!isMod(interaction)) {
        return interaction.reply({ content: '❌ Moderator permission required.', ephemeral: true });
      }

      const minutes = interaction.options.getInteger('minutes');
      const prize = interaction.options.getString('prize');
      const endsAt = Date.now() + minutes * 60000;

      const msg = await interaction.reply({
        content: `🎉 **GIVEAWAY: ${prize}**\nReact with 🎉 to enter!\nEnds <t:${Math.floor(endsAt / 1000)}:R>`,
        fetchReply: true
      });

      await msg.react('🎉');

      db.prepare('INSERT OR REPLACE INTO giveaways (message_id, guild_id, channel_id, prize, ends_at, ended) VALUES (?, ?, ?, ?, ?, 0)')
        .run(msg.id, guildId, interaction.channelId, prize, endsAt);

      const timer = setTimeout(async () => {
        const channel = await client.channels.fetch(interaction.channelId).catch(() => null);
        if (!channel) return;

        const stored = db.prepare('SELECT ended FROM giveaways WHERE message_id = ?').get(msg.id);
        if (!stored || stored.ended) return;

        const original = await channel.messages.fetch(msg.id).catch(() => null);
        const reaction = original?.reactions.cache.get('🎉');
        const users = reaction ? await reaction.users.fetch() : null;
        const participants = users
          ? [...users.values()].filter(u => !u.bot)
          : [];

        if (!participants.length) {
          db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?').run(msg.id);
          await channel.send(`🎁 **${prize}** ended with no entries.`);
          return;
        }

        const winner = participants[Math.floor(Math.random() * participants.length)];
        db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?').run(msg.id);
        await channel.send(`🎉 Congratulations <@${winner.id}>! You won **${prize}**!`, {
          allowedMentions: { users: [winner.id] }
        });
      }, minutes * 60000);

      timer.unref?.();
      return;
    }

    if (name === 'giveaway-end' || name === 'reroll') {
      if (!isMod(interaction)) {
        return interaction.reply({ content: '❌ Moderator permission required.', ephemeral: true });
      }

      const messageId = interaction.options.getString('messageid');
      const giveaway = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(messageId);

      if (!giveaway) {
        return interaction.reply({ content: '❌ Giveaway not found.', ephemeral: true });
      }

      const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
      if (!channel) {
        return interaction.reply({ content: '❌ Giveaway channel not found.', ephemeral: true });
      }

      const original = await channel.messages.fetch(messageId).catch(() => null);
      const reaction = original?.reactions.cache.get('🎉');
      const users = reaction ? await reaction.users.fetch() : null;
      const participants = users
        ? [...users.values()].filter(u => !u.bot)
        : [];

      if (!participants.length) {
        if (name === 'giveaway-end') {
          db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?').run(messageId);
        }
        return interaction.reply({ content: 'No participants found.', ephemeral: true });
      }

      if (name === 'giveaway-end') {
        db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?').run(messageId);
      }

      const winner = participants[Math.floor(Math.random() * participants.length)];

      await channel.send(`🎉 ${name === 'reroll' ? 'New winner' : 'Winner'}: <@${winner.id}> — prize: **${giveaway.prize}**!`, {
        allowedMentions: { users: [winner.id] }
      });

      return interaction.reply({ content: '✅ Done.', ephemeral: true });
    }

  } catch (error) {
    console.error(`Command /${name} failed:`, error);

    const response = {
      content: '❌ Command failed. Check bot permissions and hosting logs.',
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

// Safe, owner-only simulation. No channels are created and no mass pings occur.
const activeDemos = new Map();
const cooldowns = new Map();

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const command = message.content.trim().toLowerCase();
  if (!['.start', '.stop'].includes(command)) return;

  if (message.author.id !== message.guild.ownerId) {
    return message.reply('❌ Only the server owner can use this command.').catch(() => {});
  }

  const guildId = message.guild.id;

  if (command === '.stop') {
    const run = activeDemos.get(guildId);

    if (!run) {
      return message.reply('ℹ️ No simulation is running.').catch(() => {});
    }

    run.cancelled = true;
    return message.reply('🛑 Simulation stop requested.').catch(() => {});
  }

  if (activeDemos.has(guildId)) {
    return message.reply('⚠️ Simulation is already running.').catch(() => {});
  }

  const lastRun = cooldowns.get(guildId) || 0;

  if (Date.now() - lastRun < 60000) {
    return message.reply('⏳ Please wait 60 seconds before starting again.').catch(() => {});
  }

  const run = { cancelled: false };
  activeDemos.set(guildId, run);
  cooldowns.set(guildId, Date.now());

  try {
    await message.reply('❄️ **Chilly simulation started!**');

    const steps = [
      'Initializing simulation...',
      'Checking bot status...',
      'Simulating activity...',
      'Finishing simulation...'
    ];

    for (const step of steps) {
      if (run.cancelled) break;

      await message.channel.send({
        content: `❄️ **NUKED BY SPIDYYY — SIMULATION ONLY**\n@everyone\n${step}`,
        allowedMentions: { parse: [] }
      });

      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    await message.channel.send(
      run.cancelled ? '🛑 Simulation stopped.' : '✅ Simulation finished!'
    ).catch(() => {});

  } catch (error) {
    console.error('Simulation error:', error);
  } finally {
    activeDemos.delete(guildId);
  }
});

client.login(TOKEN);
