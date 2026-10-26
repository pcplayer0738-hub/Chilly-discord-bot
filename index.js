// Chilly .start / .stop fake-nuke effect
// IMPORTANT: Paste this handler AFTER your existing `const client = new Client(...)`
// and BEFORE `client.login(...)`. Do NOT create a second client.

const fakeNukeRuns = new Map();

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const command = message.content.trim().toLowerCase();
  if (command !== '.start' && command !== '.stop') return;

  const canManage =
    message.author.id === message.guild.ownerId ||
    message.member?.permissions.has('ManageGuild');

  if (!canManage) {
    await message.reply('❌ You need Server Owner or Manage Server permission to use this command.');
    return;
  }

  const guildId = message.guild.id;

  if (command === '.stop') {
    const currentRun = fakeNukeRuns.get(guildId);
    if (currentRun) currentRun.cancelled = true;
    await message.reply('🛑 Fake nuke sequence stopped.');
    return;
  }

  if (fakeNukeRuns.has(guildId)) {
    await message.reply('⚠️ A sequence is already running. Use `.stop` first.');
    return;
  }

  const run = { cancelled: false };
  fakeNukeRuns.set(guildId, run);

  try {
    await message.reply(
      '☢️ **NUKED BY SPIDYYY — SIMULATION** ☢️\n' +
      'Starting fake sequence…\n' +
      'No channels are being created or modified.'
    );

    const steps = [
      '▰▱▱▱▱ Initializing sequence…',
      '▰▰▱▱▱ Scanning channels…',
      '▰▰▰▱▱ Simulating message flood…',
      '▰▰▰▰▱ Finalizing effect…',
      '✅ **Simulation complete.** No server changes were made.'
    ];

    for (const step of steps) {
      if (run.cancelled) break;

      await message.channel.send(
        `☢️ **Nuked by Spidyyy**\n${step}\n` +
        'Join us: https://discord.gg/YADHWbTP7b'
      );

      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    if (run.cancelled) {
      await message.channel.send('🛑 Fake nuke sequence cancelled.');
    }
  } catch (error) {
    console.error('Fake nuke sequence error:', error);
    await message.channel.send('❌ Could not complete the sequence.').catch(() => {});
  } finally {
    fakeNukeRuns.delete(guildId);
  }
});
