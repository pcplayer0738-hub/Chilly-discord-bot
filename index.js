// Chilly: harmless fake-nuke effect (.start / .stop)
// Discord.js v14. Add this handler once in index.js, after `client` is created.
// It only posts a short simulated sequence in the channel where .start is used.
// It does NOT create/delete channels, ping @everyone, or spam other channels.

const fakeNukeRuns = new Map();

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const command = message.content.trim().toLowerCase();
  if (command !== '.start' && command !== '.stop') return;

  // Server owner or a member with Manage Guild can run/stop the effect.
  const canManage = message.author.id === message.guild.ownerId ||
    message.member?.permissions.has('ManageGuild');

  if (!canManage) {
    await message.reply('❌ You need Server Owner or Manage Server permission to run this effect.');
    return;
  }

  const guildId = message.guild.id;

  if (command === '.stop') {
    const run = fakeNukeRuns.get(guildId);
    if (run) run.cancelled = true;
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
    await message.reply({
      content:
        '☢️ **NUKED BY SPIDYYY — SIMULATION** ☢️\n' +
        'Starting fake sequence…\n' +
        'No channels are being created or modified.'
    });

    const steps = [
      '▰▱▱▱▱  Initializing sequence…',
      '▰▰▱▱▱  Scanning channels…',
      '▰▰▰▱▱  Simulating message flood…',
      '▰▰▰▰▱  Finalizing effect…',
      '✅ **Simulation complete.** No server changes were made.'
    ];

    for (const step of steps) {
      if (run.cancelled) break;
      await message.channel.send({
        content:
          `☢️ **Nuked by Spidyyy**\n${step}\n` +
          'Join us: https://discord.gg/YADHWbTP7b'
      });
      // Short pause so the sequence looks animated without flooding the channel.
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
