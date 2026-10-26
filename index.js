const {
  Client,
  GatewayIntentBits,
  PermissionsBitField
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const fakeNukeRuns = new Map();

client.once('ready', () => {
  console.log(`Chilly is online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const command = message.content.trim().toLowerCase();

  if (command !== '.start' && command !== '.stop') return;

  const allowed =
    message.author.id === message.guild.ownerId ||
    message.member?.permissions.has(
      PermissionsBitField.Flags.ManageGuild
    );

  if (!allowed) {
    return message.reply(
      '❌ You need Server Owner or Manage Server permission.'
    );
  }

  if (command === '.stop') {
    const run = fakeNukeRuns.get(message.guild.id);

    if (!run) {
      return message.reply('ℹ️ No simulation is running.');
    }

    run.cancelled = true;
    return message.reply('🛑 Simulation stopped.');
  }

  if (fakeNukeRuns.has(message.guild.id)) {
    return message.reply('⚠️ A simulation is already running.');
  }

  const run = { cancelled: false };
  fakeNukeRuns.set(message.guild.id, run);

  try {
    await message.reply(
      '☢️ **NUKED BY SPIDYYY — SIMULATION** ☢️\n' +
      'Starting sequence… No server changes will be made.'
    );

    const steps = [
      '▰▱▱▱▱ Initializing…',
      '▰▰▱▱▱ Scanning channels…',
      '▰▰▰▱▱ Simulating activity…',
      '▰▰▰▰▱ Finalizing…',
      '✅ Simulation complete!'
    ];

    for (const step of steps) {
      if (run.cancelled) break;

      await message.channel.send(
        `☢️ **Nuked by Spidyyy**\n${step}\n` +
        'Join us: https://discord.gg/YADHWbTP7b'
      );

      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  } catch (error) {
    console.error('Simulation error:', error);
  } finally {
    fakeNukeRuns.delete(message.guild.id);
  }
});

client.login(process.env.DISCORD_TOKEN);
