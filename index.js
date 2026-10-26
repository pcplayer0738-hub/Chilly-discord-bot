// Chilly .start / .stop fake-nuke effect
// IMPORTANT: Paste this handler AFTER your existing `const client = new Client(...)`
// and BEFORE `client.login(...)`. Do NOT create a second client.

const fakeNukeRuns = new Map();

// Chilly .start / .stop
const fakeNukeRuns = new Map();

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const command = message.content.trim().toLowerCase();
  if (!['.start', '.stop'].includes(command)) return;

  const allowed =
    message.author.id === message.guild.ownerId ||
    message.member?.permissions.has('ManageGuild');

  if (!allowed) {
    return message.reply(
      '❌ You need Server Owner or Manage Server permission.'
    );
  }

  if (command === '.stop') {
    const run = fakeNukeRuns.get(message.guild.id);
    if (run) run.cancelled = true;
    return message.reply('🛑 Sequence stopped.');
  }

  if (fakeNukeRuns.has(message.guild.id)) {
    return message.reply('⚠️ A sequence is already running.');
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
    console.error('Sequence error:', error);
    await message.channel.send('❌ Sequence failed.').catch(() => {});
  } finally {
    fakeNukeRuns.delete(message.guild.id);
  }
});
