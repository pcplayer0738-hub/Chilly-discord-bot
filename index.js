const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType,
  PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ActivityType, StringSelectMenuBuilder
} = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
// Trusted bot owner configured by the user.
const TRUSTED_OWNER_ID = '1312960418288898062';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID.');
  process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const db = new Database('chilly.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS whitelist (guild TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, added_by TEXT, created INTEGER, PRIMARY KEY (guild, kind, target))`);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 guild TEXT, user TEXT, coins INTEGER DEFAULT 0,
 daily INTEGER DEFAULT 0, worked INTEGER DEFAULT 0,
 PRIMARY KEY(guild,user)
);
CREATE TABLE IF NOT EXISTS warnings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 guild TEXT, user TEXT, moderator TEXT, reason TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS inventory (
 guild TEXT, user TEXT, item TEXT, quantity INTEGER DEFAULT 0,
 PRIMARY KEY(guild,user,item)
);
CREATE TABLE IF NOT EXISTS giveaways (
 id TEXT PRIMARY KEY, guild TEXT, channel TEXT, message TEXT,
 prize TEXT, winners INTEGER, ends INTEGER, ended INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entries (
 giveaway TEXT, user TEXT, PRIMARY KEY(giveaway,user)
);
CREATE TABLE IF NOT EXISTS invite_counts (guild TEXT, user TEXT, invites INTEGER DEFAULT 0, PRIMARY KEY(guild,user));
CREATE TABLE IF NOT EXISTS guild_settings (
 guild TEXT PRIMARY KEY, log_channel TEXT, antinuke INTEGER DEFAULT 0, antiraid INTEGER DEFAULT 0, antilink INTEGER DEFAULT 0, antispam INTEGER DEFAULT 0, antiabuse INTEGER DEFAULT 0
);
`);

// Migration for older SQLite databases. Keep existing rows; add columns only when missing.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(col => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('users', 'guild', 'TEXT');
ensureColumn('users', 'user', 'TEXT');
ensureColumn('users', 'coins', 'INTEGER DEFAULT 0');
ensureColumn('users', 'daily', 'INTEGER DEFAULT 0');
ensureColumn('users', 'worked', 'INTEGER DEFAULT 0');
ensureColumn('warnings', 'guild', 'TEXT');
ensureColumn('warnings', 'user', 'TEXT');
ensureColumn('warnings', 'moderator', 'TEXT');
ensureColumn('warnings', 'reason', 'TEXT');
ensureColumn('warnings', 'created', 'INTEGER');
ensureColumn('inventory', 'guild', 'TEXT');
ensureColumn('inventory', 'user', 'TEXT');
ensureColumn('inventory', 'item', 'TEXT');
ensureColumn('inventory', 'quantity', 'INTEGER DEFAULT 0');
ensureColumn('giveaways', 'guild', 'TEXT');
ensureColumn('giveaways', 'channel', 'TEXT');
ensureColumn('giveaways', 'message', 'TEXT');
ensureColumn('giveaways', 'prize', 'TEXT');
ensureColumn('giveaways', 'winners', 'INTEGER');
ensureColumn('giveaways', 'ends', 'INTEGER');
ensureColumn('giveaways', 'ended', 'INTEGER DEFAULT 0');
ensureColumn('entries', 'giveaway', 'TEXT');
ensureColumn('entries', 'user', 'TEXT');

const commands = [
 new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
 new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
 new SlashCommandBuilder().setName('say').setDescription('Send a message in this channel or an optional selected channel')
  .addChannelOption(o=>o.setName('channel').setDescription('Optional destination channel').addChannelTypes(ChannelType.GuildText).setRequired(false))
  .addStringOption(o=>o.setName('message').setDescription('Message to send').setMaxLength(2000).setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('whitelist').setDescription('Manage security whitelist entries')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('add_user').setDescription('Add user to whitelist')
   .addUserOption(o=>o.setName('user').setDescription('User to whitelist').setRequired(true)))
  .addSubcommand(sub=>sub.setName('add_channel').setDescription('Add channel to whitelist')
   .addChannelOption(o=>o.setName('channel').setDescription('Channel to whitelist').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand(sub=>sub.setName('add_role').setDescription('Add role to whitelist')
   .addRoleOption(o=>o.setName('role').setDescription('Role to whitelist').setRequired(true)))
  .addSubcommand(sub=>sub.setName('remove_channel').setDescription('Remove channel from whitelist')
   .addChannelOption(o=>o.setName('channel').setDescription('Channel to remove').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand(sub=>sub.setName('remove_role').setDescription('Remove role from whitelist')
   .addRoleOption(o=>o.setName('role').setDescription('Role to remove').setRequired(true)))
  .addSubcommand(sub=>sub.setName('remove_user').setDescription('Remove user from whitelist')
   .addUserOption(o=>o.setName('user').setDescription('User to remove').setRequired(true)))
  .addSubcommand(sub=>sub.setName('view_channels').setDescription('Show whitelisted channels'))
  .addSubcommand(sub=>sub.setName('view_roles').setDescription('Show whitelisted roles'))
  .addSubcommand(sub=>sub.setName('view_users').setDescription('Show whitelisted users')),
 new SlashCommandBuilder().setName('money').setDescription('Add coins to a member (server owner only)')
  .addUserOption(o=>o.setName('user').setDescription('Member receiving coins').setRequired(true))
  .addIntegerOption(o=>o.setName('amount').setDescription('Coins to add').setMinValue(1).setMaxValue(1000000000).setRequired(true)),
 new SlashCommandBuilder().setName('balance').setDescription('Check coin balance')
  .addUserOption(o=>o.setName('user').setDescription('Member')),
 new SlashCommandBuilder().setName('daily').setDescription('Claim daily coins'),
 new SlashCommandBuilder().setName('work').setDescription('Earn coins by working'),
 new SlashCommandBuilder().setName('slots').setDescription('Bet Chilly Coins on the slot machine')
  .addIntegerOption(o=>o.setName('bet').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true)),
 new SlashCommandBuilder().setName('invites').setDescription('Check your tracked invites')
  .addUserOption(o=>o.setName('user').setDescription('Member to check')),
 new SlashCommandBuilder().setName('invites-leaderboard').setDescription('Top inviters in this server'),
 new SlashCommandBuilder().setName('give').setDescription('Give coins to a member')
  .addUserOption(o=>o.setName('user').setDescription('Recipient').setRequired(true))
  .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setMinValue(1).setRequired(true)),
 new SlashCommandBuilder().setName('leaderboard').setDescription('Richest members'),
 new SlashCommandBuilder().setName('shop').setDescription('View the coin shop'),
 new SlashCommandBuilder().setName('buy').setDescription('Buy an item')
  .addStringOption(o=>o.setName('item').setDescription('Item').setRequired(true)
   .addChoices(
    {name:'Cookie - 100 coins',value:'Cookie'},
    {name:'Coffee - 250 coins',value:'Coffee'},
    {name:'Golden Crown - 1000 coins',value:'Golden Crown'}
   )),
 new SlashCommandBuilder().setName('inventory').setDescription('View inventory')
  .addUserOption(o=>o.setName('user').setDescription('Member')),
 new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(true)),
 new SlashCommandBuilder().setName('warnings').setDescription('View member warnings')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('clear').setDescription('Delete recent messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(true)),
 new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
  .addIntegerOption(o=>o.setName('minutes').setDescription('Minutes').setMinValue(1).setMaxValue(40320).setRequired(true))
  .addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('untimeout').setDescription('Remove timeout')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('unban').setDescription('Unban by user ID')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption(o=>o.setName('userid').setDescription('User ID').setRequired(true)),
 new SlashCommandBuilder().setName('8ball').setDescription('Ask the magic 8-ball')
  .addStringOption(o=>o.setName('question').setDescription('Question').setRequired(true)),
 new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin'),
 new SlashCommandBuilder().setName('dice').setDescription('Roll a dice'),
 new SlashCommandBuilder().setName('rps').setDescription('Challenge a real member to RPS for Chilly Coins')
  .addUserOption(o=>o.setName('opponent').setDescription('Member to challenge').setRequired(true))
  .addIntegerOption(o=>o.setName('bet').setDescription('Coins each player bets').setMinValue(1).setMaxValue(1000000).setRequired(true)),
 new SlashCommandBuilder().setName('joke').setDescription('Get a clean joke'),
 new SlashCommandBuilder().setName('ship').setDescription('Compatibility score')
  .addUserOption(o=>o.setName('user1').setDescription('First member').setRequired(true))
  .addUserOption(o=>o.setName('user2').setDescription('Second member').setRequired(true)),
 new SlashCommandBuilder().setName('avatar').setDescription('Show avatar')
  .addUserOption(o=>o.setName('user').setDescription('Member')),
 new SlashCommandBuilder().setName('userinfo').setDescription('Show user information')
  .addUserOption(o=>o.setName('user').setDescription('Member')),
 new SlashCommandBuilder().setName('serverinfo').setDescription('Show server information'),
 new SlashCommandBuilder().setName('poll').setDescription('Create yes/no poll')
  .addStringOption(o=>o.setName('question').setDescription('Question').setRequired(true)),
 new SlashCommandBuilder().setName('calculator').setDescription('Calculate two numbers')
  .addNumberOption(o=>o.setName('a').setDescription('First number').setRequired(true))
  .addStringOption(o=>o.setName('operator').setDescription('Operation').setRequired(true)
   .addChoices({name:'Add',value:'+'},{name:'Subtract',value:'-'},{name:'Multiply',value:'*'},{name:'Divide',value:'/'}))
  .addNumberOption(o=>o.setName('b').setDescription('Second number').setRequired(true)),
 new SlashCommandBuilder().setName('remind').setDescription('Set a reminder')
  .addIntegerOption(o=>o.setName('seconds').setDescription('10 to 86400 seconds').setMinValue(10).setMaxValue(86400).setRequired(true))
  .addStringOption(o=>o.setName('message').setDescription('Reminder').setRequired(true)),
 new SlashCommandBuilder().setName('giveaway').setDescription('Start a giveaway')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('prize').setDescription('Prize').setRequired(true))
  .addIntegerOption(o=>o.setName('minutes').setDescription('Duration').setMinValue(1).setMaxValue(10080).setRequired(true))
  .addIntegerOption(o=>o.setName('winners').setDescription('Winner count').setMinValue(1).setMaxValue(20).setRequired(true)),
 new SlashCommandBuilder().setName('giveaway-end').setDescription('End giveaway early')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('id').setDescription('Giveaway ID').setRequired(true)),
 new SlashCommandBuilder().setName('reroll').setDescription('Pick new winners')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('id').setDescription('Giveaway ID').setRequired(true)),
 new SlashCommandBuilder().setName('setlogs').setDescription('Set moderation and server log channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o=>o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
 new SlashCommandBuilder().setName('security').setDescription('Enable or disable Chilly security protections')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('feature').setDescription('Protection feature').setRequired(true).addChoices(
   {name:'Anti-nuke alerts',value:'antinuke'},{name:'Anti-raid alerts',value:'antiraid'},
   {name:'Anti-link',value:'antilink'},{name:'Anti-spam',value:'antispam'},{name:'Anti-abuse',value:'antiabuse'}))
  .addBooleanOption(o=>o.setName('enabled').setDescription('Enable or disable').setRequired(true))
].map(c=>c.toJSON());

function account(g,u) {
 // If an older database had no guild column, attach that user's legacy row
 // to the server they first use the economy in, preserving their coin values.
 db.prepare('UPDATE users SET guild=? WHERE user=? AND guild IS NULL').run(g,u);
 db.prepare('INSERT OR IGNORE INTO users(guild,user) VALUES(?,?)').run(g,u);
 return db.prepare('SELECT * FROM users WHERE guild=? AND user=?').get(g,u);
}
function money(n) { return n.toLocaleString('en-US')+' Chilly Coins'; }
function choose(a,n) {
 const x=[...a], r=[];
 while(x.length&&r.length<n) r.push(x.splice(Math.floor(Math.random()*x.length),1)[0]);
 return r;
}
async function endGiveaway(id, reroll=false) {
 const g=db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
 if(!g) return {error:'Giveaway not found.'};
 if(g.ended&&!reroll) return {error:'Giveaway already ended.'};
 const entries=db.prepare('SELECT user FROM entries WHERE giveaway=?').all(id).map(x=>x.user);
 const winners=choose(entries,g.winners);
 if(!reroll) db.prepare('UPDATE giveaways SET ended=1 WHERE id=?').run(id);
 if(!reroll) {
  const ch=await client.channels.fetch(g.channel).catch(()=>null);
  if(ch) {
   if(g.message) {
    const m=await ch.messages.fetch(g.message).catch(()=>null);
    if(m) await m.edit({
     embeds:[new EmbedBuilder().setTitle('🎉 Giveaway Ended')
      .setDescription('Prize: '+g.prize+'\nWinners: '+(winners.map(x=>'<@'+x+'>').join(', ')||'No entries')+'\nID: '+id)],
     components:[]
    }).catch(()=>{});
   }
   await ch.send(winners.length?'🎉 Congratulations '+winners.map(x=>'<@'+x+'>').join(', ')+'! You won **'+g.prize+'**!':'Giveaway ended with no entries.').catch(()=>{});
  }
 }
 return {winners};
}
function settings(guildId) {
 db.prepare('INSERT OR IGNORE INTO guild_settings(guild) VALUES(?)').run(guildId);
 return db.prepare('SELECT * FROM guild_settings WHERE guild=?').get(guildId);
}
async function logAction(guild, embed) {
 try {
  const cfg=settings(guild.id);
  if(!cfg.log_channel) return;
  const channel=await guild.channels.fetch(cfg.log_channel).catch(()=>null);
  if(channel && channel.isTextBased()) await channel.send({embeds:[embed]}).catch(()=>{});
 } catch(e) { console.error('Log delivery error:',e); }
}
function auditEmbed(title, color, fields) {
 return new EmbedBuilder().setColor(color).setTitle(title).addFields(fields).setTimestamp();
}

// Shared Chilly moderation embed style. Custom emoji IDs are from the user's server.
const CHILLY_EMOJI = {
 dm: '<:Dm:1564590774027558993>',
 arrow: '<:Arrow:1564590038396833812>',
 moderator: '<:Admin:1564349896402669708>',
 member: '<:Members:1564349878472015984>',
 dot: '<:Bluebot:1564349873363361892>',
 gift: '<:Bluegift:1564349870385406062>',
 success: '<:Whitetick:1564349880766304456>',
 rejected: '<:Rejected:1564349876068688032>',
 admin: '<:Admin:1564349896402669708>',
 bot: '<:Bot:1564349898709540974>'
};
function moderationEmbed({title, targetLabel='Member', targetName, targetId, moderator, reason, duration, dmDone, avatar}) {
 const lines = [
  `${CHILLY_EMOJI.member} **${targetLabel}:** ${targetName}${targetId ? ` (\`${targetId}\`)` : ''}`,
  `${CHILLY_EMOJI.moderator} **Moderator:** ${moderator}`
 ];
 if (duration) lines.push('', `${CHILLY_EMOJI.dot} **Duration:** ${duration}`);
 if (dmDone !== undefined) lines.push('', `${CHILLY_EMOJI.dm} **DM Done?** ${dmDone ? CHILLY_EMOJI.success : CHILLY_EMOJI.rejected}`);
 lines.push('', `${CHILLY_EMOJI.arrow} **Reason:** ${reason || 'No reason provided'}`);
 const embed = new EmbedBuilder()
  .setColor(0x36CFC7)
  .setTitle(title)
  .setDescription(lines.join('\n'))
  .setFooter({text:'Chilly Moderation'});
 if (avatar) embed.setThumbnail(avatar);
 return embed;
}
const recentMessages = new Map();
const recentJoins = new Map();
const actionCounts = new Map();
const linkPattern = /https?:\/\/|discord\.gg\//i;

client.once('ready', async()=>{
 console.log('Chilly online as '+client.user.tag);
 client.user.setPresence({
  activities:[{name:'Powered by Spidyyy',type:ActivityType.Playing}],
  status:'online'
 });
 try {
  // Register commands directly to every server the bot is currently in.
  // Guild-scoped commands appear much faster than global commands.
  const guilds = [...client.guilds.cache.values()];
  if (!guilds.length) console.warn('Bot is not in any cached guild; cannot register guild slash commands.');
  for (const guild of guilds) {
   await guild.commands.set(commands);
   console.log(`Registered ${commands.length} guild slash commands in ${guild.name} (${guild.id}).`);
  }
  // Also keep global commands available as a fallback for servers not currently cached.
  await new REST({version:'10'}).setToken(TOKEN)
   .put(Routes.applicationCommands(CLIENT_ID),{body:commands});
  console.log('Registered '+commands.length+' global slash commands.');
 } catch(e) { console.error('Command registration failed:',e); }
 for(const g of db.prepare('SELECT id,ends FROM giveaways WHERE ended=0').all()) {
  setTimeout(()=>endGiveaway(g.id).catch(console.error),Math.max(0,g.ends*1000-Date.now()));
 }
});
client.on('interactionCreate', async i=>{
 try {
  if(i.isButton()&&i.customId.startsWith('chilly_rps:')) {
   const [,gameId,choice]=i.customId.split(':'); const game=rpsGames.get(gameId);
   if(!game) return i.reply({content:'This RPS game is no longer active.',ephemeral:true});
   if(![game.challenger,game.opponent].includes(i.user.id)) return i.reply({content:'You are not part of this RPS game.',ephemeral:true});
   game.picks[i.user.id]=choice;
   await i.reply({content:'Your choice is locked in: **'+choice+'**.',ephemeral:true});
   if(game.picks[game.challenger]&&game.picks[game.opponent]) {
    const a=game.picks[game.challenger], b=game.picks[game.opponent];
    const win=(a==='rock'&&b==='scissors')||(a==='paper'&&b==='rock')||(a==='scissors'&&b==='paper');
    if(a===b) {
     db.transaction(()=>{db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(game.bet,game.guild,game.challenger);db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(game.bet,game.guild,game.opponent);})();
    } else if(win) db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(game.bet*2,game.guild,game.challenger);
    else db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(game.bet*2,game.guild,game.opponent);
    const result=a===b?'It is a tie! Both bets were refunded.':'Winner: <@'+(win?game.challenger:game.opponent)+'> wins **'+money(game.bet*2)+'**!';
    const channel=await client.channels.fetch(game.channel).catch(()=>null);
    if(channel) await channel.send({content:'✊ **RPS Result**\n<@'+game.challenger+'> chose **'+a+'**\n<@'+game.opponent+'> chose **'+b+'**\n'+result}).catch(()=>{});
    rpsGames.delete(gameId);
   }
   return;
  }
  if(i.isButton()&&i.customId.startsWith('chilly_enter:')) {
   const id=i.customId.split(':')[1];
   const g=db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
   if(!g||g.ended||g.ends*1000<Date.now()) return i.reply({content:'Giveaway ended.',ephemeral:true});
   const r=db.prepare('INSERT OR IGNORE INTO entries(giveaway,user) VALUES(?,?)').run(id,i.user.id);
   if(r.changes && g.message) {
    const count=db.prepare('SELECT COUNT(*) AS n FROM entries WHERE giveaway=?').get(id).n;
    const ch=await client.channels.fetch(g.channel).catch(()=>null);
    const m=ch?await ch.messages.fetch(g.message).catch(()=>null):null;
    if(m&&m.embeds[0]) {
     const old=m.embeds[0];
     const description=(old.description||'').replace(/(\*\*Participants:\*\* )\d+/, '$1'+count);
     const updated=EmbedBuilder.from(old).setDescription(description);
     await m.edit({embeds:[updated],components:m.components}).catch(()=>{});
    }
   }
   return i.reply({content:r.changes?'You entered! Good luck!':'You already entered.',ephemeral:true});
  }
  if(i.isStringSelectMenu() && i.customId==='chilly_help_category') {
   const pages = {
    index: {title:'❄️ Chilly Help — Index', body:'Welcome to Chilly! Select a category from the menu to explore the bot commands and features.'},
    invite: {title:'<:Invite:1564649286476505298> Invite Logging', body:'Invite tracking is not currently available in this build.'},
    messages: {title:'<:Message:1564649367120642188> Messages', body:'Message-counting commands are not currently available in this build.'},
    giveaways: {title:'<:Bluegift:1564349870385406062> Giveaways', body:'`/giveaway` — Create a giveaway\n`/giveaway-end` — End a giveaway using its ID\n`/reroll` — Reroll giveaway winners\n\nUse the Giveaway ID shown in the giveaway embed.'},
    timer: {title:'<:Timer:1564649373025959957> Timer', body:'Event timer commands are not currently available in this build.'},
    moderation: {title:'<:Moderation:1564649370169905282> Moderation', body:'`/warn` · `/warnings` · `/clear` · `/timeout` · `/untimeout` · `/kick` · `/ban` · `/unban`\n\nRequires the appropriate Discord permissions.'},
    poll: {title:'<:Poll:1564649357871947956> Polls', body:'`/poll` — Create a poll in your server.'},
    utility: {title:'<:Utility:1564649360858550323> Utilities', body:'`/ping` · `/avatar` · `/userinfo` · `/serverinfo` · `/calculator` · `/remind`\n`/balance` · `/daily` · `/work` · `/slots` · `/give` · `/leaderboard` · `/shop` · `/buy` · `/inventory` · `/invites` · `/invites-leaderboard`\nText aliases: `Chilly daily`, `Chilly balance`, `Chilly work`, `Chilly slots 100` (also `c daily`, `c bal`, `c work`)\nFun: `/8ball` · `/coinflip` · `/dice` · `/rps` · `/joke` · `/ship`'},
    contact: {title:'<:Contact:1564649364050415686> Contact', body:'Need help with Chilly? Contact the bot/server staff for support.'}
   };
   const page=pages[i.values[0]]||pages.index;
   return i.update({embeds:[new EmbedBuilder().setColor(0x77DDE7).setTitle(page.title).setDescription(page.body).setFooter({text:'Playing Powered by Spidyyy'})]});
  }
  if(!i.isChatInputCommand()) return;
  const c=i.commandName, u=i.user, g=i.guild;
  const target=i.options.getUser('user', false);
  if(!g&&!['ping','help'].includes(c)) return i.reply({content:'Use this command in a server.',ephemeral:true});
  const isTrustedOwner = u.id === TRUSTED_OWNER_ID;
  const isGuildOwner = g && u.id === g.ownerId;
  const hasAdminAccess = isTrustedOwner || isGuildOwner || !!i.memberPermissions?.has(PermissionFlagsBits.Administrator) || !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const moderationPermissions = {
   warn: PermissionFlagsBits.ModerateMembers,
   warnings: PermissionFlagsBits.ModerateMembers,
   clear: PermissionFlagsBits.ManageMessages,
   timeout: PermissionFlagsBits.ModerateMembers,
   untimeout: PermissionFlagsBits.ModerateMembers,
   kick: PermissionFlagsBits.KickMembers,
   ban: PermissionFlagsBits.BanMembers,
   unban: PermissionFlagsBits.BanMembers
  };
  if(moderationPermissions[c] && !isGuildOwner && !i.memberPermissions?.has(PermissionFlagsBits.Administrator) && !i.memberPermissions?.has(moderationPermissions[c])) {
   return i.reply({content:`⛔ You need the appropriate Discord permission to use /${c}.`,ephemeral:true});
  }
  if(c==='say') {
   if(!hasAdminAccess) return i.reply({content:'⛔ /say is limited to the bot owner, server owner, or members with Manage Server / Administrator permission.',ephemeral:true});
   const channel=i.options.getChannel('channel') || i.channel;
   const message=i.options.getString('message');
   if(!channel || !channel.isTextBased() || !channel.send) return i.reply({content:'Please use this command in a text channel or select a text channel.',ephemeral:true});
   const botMember = g.members.me;
   if(!botMember || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) return i.reply({content:'I cannot send messages in that channel. Check my permissions.',ephemeral:true});
   await channel.send({content:message, allowedMentions:{parse:[]}});
   return i.reply({content:'✅ Message sent in '+channel+'.',ephemeral:true});
  }
  if(c==='whitelist') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Whitelist commands are limited to the bot owner, server owner, or members with Manage Server / Administrator permission.',ephemeral:true});
   const sub=i.options.getSubcommand();
   const viewKinds={view_users:'user',view_channels:'channel',view_roles:'role'};
   if(viewKinds[sub]) {
    const kind=viewKinds[sub];
    const rows=db.prepare('SELECT kind,target FROM whitelist WHERE guild=? AND kind=? ORDER BY created ASC').all(g.id,kind);
    const label={user:'Users',channel:'Channels',role:'Roles'}[kind];
    const list=rows.map(r=>r.kind==='user'?`<@${r.target}> — \`${r.target}\``:r.kind==='role'?`<@&${r.target}> — \`${r.target}\``:`<#${r.target}> — \`${r.target}\``);
    return i.reply({content:`**Whitelist • ${label}**\\n${list.length?list.join('\\n').slice(0,1850):'No entries yet.'}`,ephemeral:true});
   }
   const actions={
    add_user:{kind:'user',action:'add'},add_channel:{kind:'channel',action:'add'},add_role:{kind:'role',action:'add'},
    remove_user:{kind:'user',action:'remove'},remove_channel:{kind:'channel',action:'remove'},remove_role:{kind:'role',action:'remove'}
   };
   const config=actions[sub];
   if(!config) return i.reply({content:'Unknown whitelist action.',ephemeral:true});
   let target;
   if(config.kind==='user') target=i.options.getUser('user',true).id;
   if(config.kind==='channel') target=i.options.getChannel('channel',true).id;
   if(config.kind==='role') target=i.options.getRole('role',true).id;
   if(config.action==='add') {
    const result=db.prepare('INSERT OR IGNORE INTO whitelist (guild,kind,target,added_by,created) VALUES (?,?,?,?,?)').run(g.id,config.kind,target,u.id,Date.now());
    return i.reply({content:result.changes?'✅ Added to whitelist.':'ℹ️ This item is already whitelisted.',ephemeral:true});
   }
   const result=db.prepare('DELETE FROM whitelist WHERE guild=? AND kind=? AND target=?').run(g.id,config.kind,target);
   return i.reply({content:result.changes?'✅ Removed from whitelist.':'ℹ️ This item was not in the whitelist.',ephemeral:true});
  }
  if(c==='money') {
   if(u.id!==g.ownerId) return i.reply({content:'⛔ Only the server owner can use /money.',ephemeral:true});
   const to=i.options.getUser('user');
   const amount=i.options.getInteger('amount');
   if(to.bot) return i.reply({content:'You cannot add coins to a bot.',ephemeral:true});
   account(g.id,to.id);
   db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(amount,g.id,to.id);
   const updated=account(g.id,to.id);
   return i.reply('💰 Added **'+money(amount)+'** to <@'+to.id+'>. New balance: **'+money(updated.coins)+'**.');
  }
  if(c==='ping') return i.reply('🏓 Pong! '+client.ws.ping+'ms');
  if(c==='help') {
   const menu=new StringSelectMenuBuilder().setCustomId('chilly_help_category').setPlaceholder('Select a category...').addOptions(
    {label:'Index',description:'The help page showing how to use the bot',value:'index',emoji:'<:Index:1564649376138399805>'},
    {label:'Invite logging',description:'Shows information about invite tracking',value:'invite',emoji:'<:Invite:1564649286476505298>'},
    {label:'Messages',description:'Shows information about message counting',value:'messages',emoji:'<:Message:1564649367120642188>'},
    {label:'Giveaways',description:'Shows information about giveaway features',value:'giveaways',emoji:'<:Bluegift:1564349870385406062>'},
    {label:'Moderation',description:'Shows information about moderation features',value:'moderation',emoji:'<:Moderation:1564649370169905282>'},
    {label:'Timer',description:'Shows information about event timers',value:'timer',emoji:'<:Timer:1564649373025959957>'},
    {label:'Polls',description:'Shows information about polls',value:'poll',emoji:'<:Poll:1564649357871947956>'},
    {label:'Utilities',description:'Shows information about utility commands',value:'utility',emoji:'<:Utility:1564649360858550323>'},
    {label:'Contact',description:'Contact staff if you need support',value:'contact',emoji:'<:Contact:1564649364050415686>'}
   );
   return i.reply({embeds:[new EmbedBuilder().setColor(0x77DDE7).setTitle('❄️ Chilly Help').setDescription('Choose a category below to explore Chilly commands and features.').setFooter({text:'Playing Powered by Spidyyy'})],components:[new ActionRowBuilder().addComponents(menu)]});
  }
  if(c==='balance') {
   const who=target||u, a=account(g.id,who.id);
   return i.reply('💰 **'+who.username+'** has **'+money(a.coins)+'**.');
  }
  if(c==='slots') {
   const bet=i.options.getInteger('bet'), a=account(g.id,u.id);
   if(a.coins<bet) return i.reply({content:'Not enough Chilly Coins for that bet.',ephemeral:true});
   const symbols=['🍒','🍋','🍇','⭐','🔔']; const roll=[0,1,2].map(()=>symbols[Math.floor(Math.random()*symbols.length)]);
   let multiplier=roll[0]===roll[1]&&roll[1]===roll[2]? (roll[0]==='⭐'?5:3) : (roll[0]===roll[1]||roll[1]===roll[2]||roll[0]===roll[2]?1:0);
   const delta=multiplier?bet*multiplier: -bet;
   db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(delta,g.id,u.id);
   return i.reply('🎰 **Chilly Slots**\n'+roll.join(' | ')+'\n'+(multiplier?'🎉 You won **'+money(bet*multiplier)+'**!':'😢 You lost **'+money(bet)+'**.')+'\nBalance: **'+money(account(g.id,u.id).coins)+'**');
  }
  if(c==='invites') {
   const who=target||u, row=db.prepare('SELECT invites FROM invite_counts WHERE guild=? AND user=?').get(g.id,who.id);
   return i.reply('📨 **'+who.username+'** has **'+(row?.invites||0)+'** tracked invites.\nNote: tracking starts after this version is online; old invite history cannot be recovered.');
  }
  if(c==='invites-leaderboard') {
   const rows=db.prepare('SELECT user,invites FROM invite_counts WHERE guild=? ORDER BY invites DESC LIMIT 10').all(g.id);
   return i.reply({embeds:[new EmbedBuilder().setColor(0x77DDE7).setTitle('📨 Invite Leaderboard').setDescription(rows.map((r,n)=>(n+1)+'. <@'+r.user+'> — **'+r.invites+'** invites').join('\n')||'No tracked invites yet.')]});
  }
  if(c==='daily'||c==='work') {
   const a=account(g.id,u.id), now=Math.floor(Date.now()/1000);
   const col=c==='daily'?'daily':'worked', cd=c==='daily'?86400:3600;
   const amount=c==='daily'?500:Math.floor(Math.random()*201)+100;
   if(now-a[col]<cd) return i.reply({content:'Try again in '+Math.ceil((cd-(now-a[col]))/60)+' minutes.',ephemeral:true});
   db.prepare('UPDATE users SET coins=coins+?, '+col+'=? WHERE guild=? AND user=?').run(amount,now,g.id,u.id);
   return i.reply('❄️ You earned **'+money(amount)+'**!');
  }
  if(c==='give') {
   const to=i.options.getUser('user'), amount=i.options.getInteger('amount');
   if(to.bot||to.id===u.id) return i.reply({content:'Choose another non-bot member.',ephemeral:true});
   const a=account(g.id,u.id); account(g.id,to.id);
   if(a.coins<amount) return i.reply({content:'Not enough coins.',ephemeral:true});
   db.transaction(()=>{
    db.prepare('UPDATE users SET coins=coins-? WHERE guild=? AND user=?').run(amount,g.id,u.id);
    db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(amount,g.id,to.id);
   })();
   return i.reply('💸 <@'+u.id+'> gave <@'+to.id+'> **'+money(amount)+'**.');
  }
  if(c==='leaderboard') {
   const rows=db.prepare('SELECT user,coins FROM users WHERE guild=? ORDER BY coins DESC LIMIT 10').all(g.id);
   return i.reply({embeds:[new EmbedBuilder().setTitle('🏆 Coin Leaderboard')
    .setDescription(rows.map((r,n)=>(n+1)+'. <@'+r.user+'> — '+money(r.coins)).join('\n')||'No users yet.') ]});
  }
  if(c==='shop') return i.reply('🛍️ **Chilly Shop**\n🍪 Cookie: 100\n☕ Coffee: 250\n👑 Golden Crown: 1000 coins\nUse `/buy`.');
  if(c==='buy') {
   const item=i.options.getString('item'), price={'Cookie':100,'Coffee':250,'Golden Crown':1000}[item], a=account(g.id,u.id);
   if(a.coins<price) return i.reply({content:'Not enough coins.',ephemeral:true});
   db.transaction(()=>{
    db.prepare('UPDATE users SET coins=coins-? WHERE guild=? AND user=?').run(price,g.id,u.id);
    db.prepare('INSERT INTO inventory(guild,user,item,quantity) VALUES(?,?,?,1) ON CONFLICT(guild,user,item) DO UPDATE SET quantity=quantity+1').run(g.id,u.id,item);
   })();
   return i.reply('✅ Purchased **'+item+'**!');
  }
  if(c==='inventory') {
   const who=target||u, rows=db.prepare('SELECT item,quantity FROM inventory WHERE guild=? AND user=?').all(g.id,who.id);
   return i.reply('🎒 **'+who.username+'**: '+(rows.map(x=>x.item+' × '+x.quantity).join(', ')||'Empty'));
  }
  if(c==='setlogs') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({content:'You need Manage Server permission to set the log channel.',ephemeral:true});
   }
   const channel=i.options.getChannel('channel');
   if(!channel || !channel.isTextBased()) {
    return i.reply({content:'Please select a text channel.',ephemeral:true});
   }
   const botPerms=channel.permissionsFor(client.user);
   if(!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms?.has(PermissionFlagsBits.SendMessages) || !botPerms?.has(PermissionFlagsBits.EmbedLinks)) {
    return i.reply({content:'I need View Channel, Send Messages, and Embed Links permissions in that channel.',ephemeral:true});
   }
   settings(g.id);
   db.prepare('UPDATE guild_settings SET log_channel=? WHERE guild=?').run(channel.id,g.id);
   return i.reply({content:'✅ Moderation and server logs will be sent to '+channel+'.',ephemeral:true});
  }
  if(c==='security') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({content:'You need Manage Server permission to change security settings.',ephemeral:true});
   }
   const feature=i.options.getString('feature');
   const enabled=i.options.getBoolean('enabled');
   const allowedFeatures=['antinuke','antiraid','antilink','antispam','antiabuse'];
   if(!allowedFeatures.includes(feature) || typeof enabled!=='boolean') {
    return i.reply({content:'Invalid security feature or setting.',ephemeral:true});
   }
   settings(g.id);
   db.prepare(`UPDATE guild_settings SET ${feature}=? WHERE guild=?`).run(enabled?1:0,g.id);
   const names={antinuke:'Anti-nuke alerts',antiraid:'Anti-raid alerts',antilink:'Anti-link',antispam:'Anti-spam',antiabuse:'Anti-abuse'};
   return i.reply({embeds:[new EmbedBuilder().setColor(enabled?0x2ECC71:0xE74C3C).setTitle('❄️ Chilly Security Settings').setDescription(`${enabled?'✅ Enabled':'❌ Disabled'} **${names[feature]}**.`).setFooter({text:'Chilly Security'}).setTimestamp()],ephemeral:true});
  }
  if(c==='warn') {
   const to=i.options.getUser('user'), reason=i.options.getString('reason')||'No reason provided';
   let dmDone=false;
   try { await to.send({embeds:[moderationEmbed({title:'You have been warned!',targetName:`${to.tag}`,targetId:to.id,moderator:`${u.tag}`,reason,avatar:to.displayAvatarURL()})]}); dmDone=true; } catch {}
   db.prepare('INSERT INTO warnings(guild,user,moderator,reason,created) VALUES(?,?,?,?,?)').run(g.id,to.id,u.id,reason,Date.now());
   const embed=moderationEmbed({title:'User has been warned!',targetName:`<@${to.id}>`,targetId:to.id,moderator:`<@${u.id}>`,reason,dmDone,avatar:to.displayAvatarURL()});
   await logAction(g,embed);
   return i.reply({embeds:[embed]});
  }
  if(c==='warnings') {
   const to=i.options.getUser('user');
   const rows=db.prepare('SELECT reason,moderator,created FROM warnings WHERE guild=? AND user=? ORDER BY id DESC LIMIT 10').all(g.id,to.id);
   return i.reply({embeds:[new EmbedBuilder().setTitle('Warnings: '+to.username)
    .setDescription(rows.map((x,n)=>(n+1)+'. '+x.reason+' — <@'+x.moderator+'>').join('\n')||'No warnings found.')]});
  }
  if(c==='clear') {
   const n=i.options.getInteger('amount'), deleted=await i.channel.bulkDelete(n,true);
   return i.reply({content:'🧹 Deleted '+deleted.size+' messages.',ephemeral:true});
  }
  if(c==='timeout'||c==='untimeout') {
   const to=i.options.getUser('user'), m=await g.members.fetch(to.id);
   if(to.id===u.id) return i.reply({content:'You cannot moderate yourself.',ephemeral:true});
   if(c==='timeout') {
    const mins=i.options.getInteger('minutes'), reason=i.options.getString('reason')||'No reason provided';
    let dmDone=false;
    try { await to.send({embeds:[moderationEmbed({title:'You have been timed out!',targetName:to.tag,targetId:to.id,moderator:u.tag,reason,duration:`${mins} minute(s)`,avatar:to.displayAvatarURL()})]}); dmDone=true; } catch {}
    await m.timeout(mins*60000,reason);
    const embed=moderationEmbed({title:'User has been timed out!',targetName:`<@${to.id}>`,targetId:to.id,moderator:`<@${u.id}>`,reason,duration:`${mins} minute(s)`,dmDone,avatar:to.displayAvatarURL()});
    await logAction(g,embed);
    return i.reply({embeds:[embed]});
   }
   const reason='Timeout removed';
   let dmDone=false;
   try { await to.send({embeds:[moderationEmbed({title:'Your timeout has been removed!',targetName:to.tag,targetId:to.id,moderator:u.tag,reason,avatar:to.displayAvatarURL()})]}); dmDone=true; } catch {}
   await m.timeout(null,reason);
   const embed=moderationEmbed({title:'User has been unmuted!',targetName:`<@${to.id}>`,targetId:to.id,moderator:`<@${u.id}>`,reason,dmDone,avatar:to.displayAvatarURL()});
   await logAction(g,embed);
   return i.reply({embeds:[embed]});
  }
  if(c==='kick'||c==='ban') {
   const to=i.options.getUser('user'), reason=i.options.getString('reason')||'No reason provided';
   const m=await g.members.fetch(to.id);
   if(to.id===u.id) return i.reply({content:'You cannot moderate yourself.',ephemeral:true});
   let dmDone=false;
   try { await to.send({embeds:[moderationEmbed({title:c==='kick'?'You have been kicked!':'You have been banned!',targetName:to.tag,targetId:to.id,moderator:u.tag,reason,avatar:to.displayAvatarURL()})]}); dmDone=true; } catch {}
   if(c==='kick') await m.kick(reason); else await m.ban({reason});
   const embed=moderationEmbed({title:c==='kick'?'User has been kicked!':'User has been banned!',targetName:`<@${to.id}>`,targetId:to.id,moderator:`<@${u.id}>`,reason,dmDone,avatar:to.displayAvatarURL()});
   await logAction(g,embed);
   return i.reply({embeds:[embed]});
  }
  if(c==='unban') {
   const id=i.options.getString('userid'), reason='Unban command used';
   let to=null;
   try { to=await client.users.fetch(id); } catch {}
   await g.members.unban(id,reason);
   let dmDone=false;
   if(to) { try { await to.send({embeds:[moderationEmbed({title:'You have been unbanned!',targetName:to.tag,targetId:to.id,moderator:u.tag,reason,avatar:to.displayAvatarURL()})]}); dmDone=true; } catch {} }
   const embed=moderationEmbed({title:'User has been unbanned!',targetLabel:'User',targetName:to ? to.tag : `\`${id}\``,targetId:id,moderator:`<@${u.id}>`,reason,dmDone,avatar:to?.displayAvatarURL()});
   await logAction(g,embed);
   return i.reply({embeds:[embed]});
  }
  if(c==='8ball') return i.reply('🎱 '+choose(['Definitely!','Yes!','Ask again later.','Probably not.','No way!'],1)[0]);
  if(c==='coinflip') return i.reply('🪙 '+(Math.random()<0.5?'Heads':'Tails')+'!');
  if(c==='dice') return i.reply('🎲 You rolled '+(1+Math.floor(Math.random()*6))+'!');
  if(c==='rps') {
   const opponent=i.options.getUser('opponent'), bet=i.options.getInteger('bet');
   if(!opponent||opponent.bot||opponent.id===u.id) return i.reply({content:'Choose another real server member (not yourself or a bot).',ephemeral:true});
   const opponentMember=await g.members.fetch(opponent.id).catch(()=>null);
   if(!opponentMember) return i.reply({content:'The opponent must be a member of this server.',ephemeral:true});
   const a=account(g.id,u.id), b=account(g.id,opponent.id);
   if(a.coins<bet||b.coins<bet) return i.reply({content:'Both players must have at least **'+money(bet)+'** to play.',ephemeral:true});
   db.transaction(()=>{db.prepare('UPDATE users SET coins=coins-? WHERE guild=? AND user=?').run(bet,g.id,u.id);db.prepare('UPDATE users SET coins=coins-? WHERE guild=? AND user=?').run(bet,g.id,opponent.id);})();
   const gameId=Date.now().toString(36)+Math.random().toString(36).slice(2,6);
   rpsGames.set(gameId,{guild:g.id,channel:i.channelId,challenger:u.id,opponent:opponent.id,bet,picks:{}});
   const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('chilly_rps:'+gameId+':rock').setLabel('🪨 Rock').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('chilly_rps:'+gameId+':paper').setLabel('📄 Paper').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('chilly_rps:'+gameId+':scissors').setLabel('✂️ Scissors').setStyle(ButtonStyle.Primary));
   return i.reply({content:'✊ **RPS Coin Duel**\n<@'+u.id+'> challenged <@'+opponent.id+'>. Both players have wagered **'+money(bet)+'**.\nBoth players: choose your move below. Each player can choose once.',components:[row]});
  }
  if(c==='joke') return i.reply(choose(['Why did the computer get cold? It left its Windows open!','Why was the math book sad? Too many problems!','What do you call a sleeping dinosaur? A dino-snore!'],1)[0]);
  if(c==='ship') {
   const a=i.options.getUser('user1'), b=i.options.getUser('user2');
   return i.reply('💞 '+a.username+' + '+b.username+': **'+Math.floor(Math.random()*101)+'%** compatibility!');
  }
  if(c==='avatar') {
   const who=target||u;
   return i.reply({embeds:[new EmbedBuilder().setTitle(who.username+"'s Avatar").setImage(who.displayAvatarURL({size:1024}))]});
  }
  if(c==='userinfo') {
   const who=target||u, m=await g.members.fetch(who.id).catch(()=>null);
   const e=new EmbedBuilder().setTitle('👤 '+who.username).setThumbnail(who.displayAvatarURL())
    .addFields({name:'User ID',value:who.id},{name:'Account created',value:'<t:'+Math.floor(who.createdTimestamp/1000)+':F>'});
   if(m&&m.joinedTimestamp) e.addFields({name:'Joined server',value:'<t:'+Math.floor(m.joinedTimestamp/1000)+':F>'});
   return i.reply({embeds:[e]});
  }
  if(c==='serverinfo') return i.reply({embeds:[new EmbedBuilder().setTitle('🏠 '+g.name)
   .addFields({name:'Members',value:String(g.memberCount),inline:true},{name:'Server ID',value:g.id})]});
  if(c==='poll') {
   const m=await i.reply({content:'📊 **Poll:** '+i.options.getString('question')+'\nReact ✅ for Yes or ❌ for No.',fetchReply:true});
   await m.react('✅'); await m.react('❌'); return;
  }
  if(c==='calculator') {
   const a=i.options.getNumber('a'), b=i.options.getNumber('b'), op=i.options.getString('operator');
   if(op==='/'&&b===0) return i.reply({content:'Cannot divide by zero.',ephemeral:true});
   const r=op==='+'?a+b:op==='-'?a-b:op==='*'?a*b:a/b;
   return i.reply('🧮 `'+a+' '+op+' '+b+' = '+r+'`');
  }
  if(c==='remind') {
   const seconds=i.options.getInteger('seconds'), msg=i.options.getString('message');
   await i.reply({content:'⏰ Reminder set for '+seconds+' seconds.',ephemeral:true});
   setTimeout(()=>i.followUp({content:'⏰ <@'+u.id+'> Reminder: '+msg,allowedMentions:{users:[u.id]}}).catch(()=>{}),seconds*1000);
   return;
  }
  if(c==='giveaway') {
   const prize=i.options.getString('prize'), mins=i.options.getInteger('minutes'), winners=i.options.getInteger('winners');
   const id='CH-'+Date.now().toString(36).toUpperCase(), ends=Math.floor(Date.now()/1000)+mins*60;
   db.prepare('INSERT INTO giveaways(id,guild,channel,prize,winners,ends) VALUES(?,?,?,?,?,?)').run(id,g.id,i.channelId,prize,winners,ends);
   const embed=new EmbedBuilder().setColor(0x36CFC7).setTitle(`${CHILLY_EMOJI.gift} ${prize} ${CHILLY_EMOJI.gift}`)
    .setDescription(`${CHILLY_EMOJI.dot} **Winners:** ${winners}\n${CHILLY_EMOJI.dot} **Ends:** <t:${ends}:R> (<t:${ends}:f>)\n${CHILLY_EMOJI.dot} **Hosted by:** <@${u.id}>\n${CHILLY_EMOJI.dot} **Participants:** 0\n${CHILLY_EMOJI.dot} **Giveaway ID:** \`${id}\``)
    .setFooter({text:'Ends at'}).setTimestamp(new Date(ends*1000));
   const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('chilly_enter:'+id).setLabel('Enter Giveaway 🎉').setStyle(ButtonStyle.Primary));
   const msg=await i.reply({embeds:[embed],components:[row],fetchReply:true});
   db.prepare('UPDATE giveaways SET message=? WHERE id=?').run(msg.id,id);
   setTimeout(()=>endGiveaway(id).catch(console.error),mins*60000);
   return;
  }
  if(c==='giveaway-end') {
   const r=await endGiveaway(i.options.getString('id'));
   return i.reply(r.error?{content:r.error,ephemeral:true}:{content:'Giveaway ended.'});
  }
  if(c==='reroll') {
   const r=await endGiveaway(i.options.getString('id'),true);
   if(r.error) return i.reply({content:r.error,ephemeral:true});
   return i.reply(r.winners.length?'🎉 New winner(s): '+r.winners.map(x=>'<@'+x+'>').join(', '):'No entries to reroll.');
  }
 } catch(e) {
  console.error('Command error:',e);
  const p={content:'Command failed. Check bot permissions and hosting logs.',ephemeral:true};
  if(i.deferred||i.replied) await i.followUp(p).catch(()=>{});
  else await i.reply(p).catch(()=>{});
 }
});
// Server event logging and configurable protective filters.
client.on('messageDelete', async message => {
 if(!message.guild || message.author?.bot) return;
 const e=auditEmbed('🗑️ Message Deleted',0x95A5A6,[
  {name:'Author',value:message.author?`${message.author.tag} (${message.author.id})`:'Unknown'},
  {name:'Channel',value:`<#${message.channelId}>`},
  {name:'Content',value:(message.content||'[No cached text]').slice(0,1000)}
 ]);
 await logAction(message.guild,e);
});
client.on('channelCreate', async channel => {
 if(!channel.guild) return;
 const e=auditEmbed('📁 Channel Created',0x2ECC71,[{name:'Channel',value:`${channel.name} (${channel.id})`},{name:'Type',value:String(channel.type)}]);
 await logAction(channel.guild,e);
});
client.on('channelDelete', async channel => {
 if(!channel.guild) return;
 const cfg=settings(channel.guild.id);
 const e=auditEmbed('🗑️ Channel Deleted',0xE74C3C,[{name:'Channel',value:`${channel.name} (${channel.id})`}]);
 await logAction(channel.guild,e);
 if(cfg.antinuke) await logAction(channel.guild,auditEmbed('🛡️ Anti-nuke Alert',0xE74C3C,[{name:'Event',value:'A channel was deleted.'},{name:'Channel',value:channel.name},{name:'Action',value:'Alert only; no automatic punishment was applied.'}]));
});
client.on('roleDelete', async role => {
 const cfg=settings(role.guild.id);
 await logAction(role.guild,auditEmbed('🗑️ Role Deleted',0xE74C3C,[{name:'Role',value:`${role.name} (${role.id})`}]));
 if(cfg.antinuke) await logAction(role.guild,auditEmbed('🛡️ Anti-nuke Alert',0xE74C3C,[{name:'Event',value:'A role was deleted.'},{name:'Role',value:role.name},{name:'Action',value:'Alert only; check Audit Log and secure staff permissions.'}]));
});
client.on('guildBanAdd', async ban => {
 const e=auditEmbed('🔨 Member Banned',0xE74C3C,[{name:'Member',value:`${ban.user.tag} (${ban.user.id})`},{name:'Reason',value:ban.reason||'Not provided'}]);
 await logAction(ban.guild,e);
});
client.on('guildMemberRemove', async member => {
 try {
  const logs=await member.guild.fetchAuditLogs({type:20,limit:5});
  const entry=logs.entries.find(x=>x.target?.id===member.id && Date.now()-x.createdTimestamp<10000);
  if(entry) await logAction(member.guild,auditEmbed('👢 Member Kicked',0xE67E22,[{name:'Member',value:`${member.user.tag} (${member.id})`},{name:'Moderator',value:entry.executor?`${entry.executor.tag} (${entry.executor.id})`:'Unknown'},{name:'Reason',value:entry.reason||'Not provided'}]));
 } catch(e) { console.error('Kick audit lookup failed:',e); }
 const cfg=settings(member.guild.id);
 if(cfg.antiraid) {
  const now=Date.now(), list=(recentJoins.get(member.guild.id)||[]).filter(t=>now-t<60000);
  if(list.length>=8) await logAction(member.guild,auditEmbed('🚨 Anti-raid Alert',0xE74C3C,[{name:'Event',value:'High member join/leave activity detected.'},{name:'Action',value:'Alert only; review verification and invite settings.'}]));
 }
});
client.on('guildMemberAdd', async member => {
 const cfg=settings(member.guild.id);
 if(!cfg.antiraid) return;
 const now=Date.now(), list=(recentJoins.get(member.guild.id)||[]).filter(t=>now-t<30000);
 list.push(now); recentJoins.set(member.guild.id,list);
 if(list.length>=6 && list.length%3===0) {
  await logAction(member.guild,auditEmbed('🚨 Anti-raid Alert',0xE74C3C,[{name:'Detection',value:`${list.length} members joined within 30 seconds.`},{name:'Latest join',value:`${member.user.tag} (${member.id})`},{name:'Action',value:'Alert only. Consider enabling verification or temporarily pausing invites.'}]));
 }
});
client.on('guildMemberUpdate', async (oldMember,newMember) => {
 const was=oldMember.communicationDisabledUntilTimestamp, now=newMember.communicationDisabledUntilTimestamp;
 if(was!==now) {
  const e=auditEmbed(now?'🔇 Member Timed Out':'🔊 Member Timeout Removed',now?0xE67E22:0x2ECC71,[{name:'Member',value:`${newMember.user.tag} (${newMember.id})`},{name:'Until',value:now?`<t:${Math.floor(now/1000)}:F>`:'Timeout cleared'}]);
  await logAction(newMember.guild,e);
 }
});
const inviteCache = new Map();
const rpsGames = new Map();
client.on('ready', async () => {
 for (const [, guild] of client.guilds.cache) {
  try { inviteCache.set(guild.id, await guild.invites.fetch()); } catch { /* Manage Guild permission required for invite tracking */ }
 }
});
client.on('inviteCreate', async invite => {
 try { const current=await invite.guild.invites.fetch(); inviteCache.set(invite.guild.id,current); } catch {}
});
client.on('guildMemberAdd', async member => {
 try {
  const old=inviteCache.get(member.guild.id); const current=await member.guild.invites.fetch(); inviteCache.set(member.guild.id,current);
  if(!old) return;
  const used=current.find(inv=>{ const prev=old.get(inv.code); return inv.uses>(prev?.uses||0); });
  if(used?.inviter && used.inviter.id!==member.id) {
   db.prepare('INSERT INTO invite_counts(guild,user,invites) VALUES(?,?,1) ON CONFLICT(guild,user) DO UPDATE SET invites=invites+1').run(member.guild.id,used.inviter.id);
  }
 } catch (e) { console.error('Invite tracking:',e.message); }
});

client.on('messageCreate', async message => {
 if(message.author.bot) return;

 // !setup: create the Horizons RP: Worldwide channel structure.
 const setupUserId = '1312960418288898062';
 const isServerManager = message.guild && (message.author.id === message.guild.ownerId || message.author.id === setupUserId);

 if (message.content.trim().toLowerCase() === '!setup') {
  if (!message.guild) return message.reply('❌ Use `!setup` inside your Discord server.').catch(()=>{});
  if (!isServerManager) return message.reply('❌ Only the server owner or bot owner can use `!setup`.').catch(()=>{});
  const botMember = message.guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
   return message.reply('❌ I need the **Manage Channels** permission to create categories and channels.').catch(()=>{});
  }

  // Categories and channels transcribed from the provided screenshots.
  // Announcement channels fall back to regular text channels if Community is not enabled.
  const layout = [
   { category: '🔒｜ADMIN MANAGEMENT', channels: [
    {name:'🔒｜administrator', type:ChannelType.GuildText},
    {name:'🖼️｜server-picture', type:ChannelType.GuildText},
    {name:'📢｜admin-voice-high-rank', type:ChannelType.GuildVoice}
   ]},
   { category: '🛠️｜SERVER MANAGEMENT', channels: [
    {name:'📢｜administrator-announcement', type:ChannelType.GuildAnnouncement},
    {name:'📢｜game-news-admin', type:ChannelType.GuildAnnouncement},
    {name:'📢｜staff-update', type:ChannelType.GuildAnnouncement},
    {name:'📋｜staff-infos', type:ChannelType.GuildText},
    {name:'📚｜important-guideline', type:ChannelType.GuildText},
    {name:'💬｜team-chat', type:ChannelType.GuildText},
    {name:'🟢｜helper-chat', type:ChannelType.GuildText},
    {name:'📕｜penalty-list', type:ChannelType.GuildText},
    {name:'⛔｜player-report', type:ChannelType.GuildText},
    {name:'📝｜offline-announcement', type:ChannelType.GuildText},
    {name:'⚠️｜admin-warning', type:ChannelType.GuildText},
    {name:'🤖｜bot-command', type:ChannelType.GuildText},
    {name:'🛡️｜head-of-factions', type:ChannelType.GuildText},
    {name:'💳｜staff-salary', type:ChannelType.GuildText}
   ]},
   { category: '🛟｜SUPPORT LINE', channels: [
    {name:'🌟｜suggested-idea', type:ChannelType.GuildText},
    {name:'📩｜ticket-support', type:ChannelType.GuildText},
    {name:'🐞｜report-bugs', type:ChannelType.GuildText}
   ]},
   { category: '📚｜RULES', channels: [
    {name:'🗃️｜general-terms-of-use', type:ChannelType.GuildText},
    {name:'📚｜server-rules', type:ChannelType.GuildText},
    {name:'📜｜game-rules', type:ChannelType.GuildText},
    {name:'📁｜factions-rules', type:ChannelType.GuildText}
   ]},
   { category: 'ℹ️｜INFORMATION ZONE', channels: [
    {name:'🔔｜announcement', type:ChannelType.GuildAnnouncement},
    {name:'🎉｜event', type:ChannelType.GuildAnnouncement},
    {name:'🎮｜game-news', type:ChannelType.GuildAnnouncement},
    {name:'🎮｜youtube-channel', type:ChannelType.GuildAnnouncement},
    {name:'🌟｜influencer-update', type:ChannelType.GuildAnnouncement},
    {name:'📜｜influencer-form', type:ChannelType.GuildAnnouncement},
    {name:'📚｜official-media-accounts', type:ChannelType.GuildAnnouncement},
    {name:'📚｜official-servers', type:ChannelType.GuildAnnouncement},
    {name:'🔔｜faction-announcement', type:ChannelType.GuildAnnouncement},
    {name:'⚙️｜server-update', type:ChannelType.GuildAnnouncement}
   ]},
   { category: '👑｜VIP ZONE', channels: [
    {name:'👑｜VIP-Announcement', type:ChannelType.GuildAnnouncement},
    {name:'🎁｜VIP-Gift', type:ChannelType.GuildAnnouncement},
    {name:'💬｜VIP-Chat', type:ChannelType.GuildText},
    {name:'📸｜VIP-Media', type:ChannelType.GuildText},
    {name:'👑｜Vip-Game-Testing', type:ChannelType.GuildText},
    {name:'🎧｜VIP-Support-Voice', type:ChannelType.GuildVoice},
    {name:'📢｜VIP-Voice-1', type:ChannelType.GuildVoice},
    {name:'📢｜VIP-Voice-2', type:ChannelType.GuildVoice}
   ]},
   { category: '🏛️｜CITIZEN CORNER', channels: [
    {name:'🌐｜global-chat', type:ChannelType.GuildText},
    {name:'📸｜global-media', type:ChannelType.GuildText},
    {name:'🎥｜influencer-video', type:ChannelType.GuildText},
    {name:'📢｜Global Voice 1', type:ChannelType.GuildVoice},
    {name:'📢｜Global Voice 2', type:ChannelType.GuildVoice},
    {name:'🎵｜Music Voice', type:ChannelType.GuildVoice},
    {name:'🌟｜Influencer Voice', type:ChannelType.GuildVoice},
    {name:'🌟｜Admin Free Time', type:ChannelType.GuildVoice},
    {name:'🌟｜Admin Free Time 2', type:ChannelType.GuildVoice},
    {name:'📢｜Admin Meeting', type:ChannelType.GuildVoice},
    {name:'📢｜Admin Meeting 2', type:ChannelType.GuildVoice}
   ]},
   { category: '🌍｜ASIAN ZONE', channels: [
    {name:'📸｜asia-media', type:ChannelType.GuildText},
    {name:'😂｜asia-fun', type:ChannelType.GuildText},
    {name:'🎤｜Asia-Voice-1', type:ChannelType.GuildVoice},
    {name:'🎤｜Asia-Voice-2', type:ChannelType.GuildVoice},
    {name:'🎤｜Asia-Voice-3', type:ChannelType.GuildVoice}
   ]},
   { category: '🌍｜EUROPEAN ZONE', channels: [
    {name:'🎤｜Europe-Voice-1', type:ChannelType.GuildVoice}
   ]},
   { category: '🌍｜MIDDLE EAST ZONE', channels: [
    {name:'📸｜middle-east-media', type:ChannelType.GuildText},
    {name:'😂｜middle-east-fun', type:ChannelType.GuildText}
   ]},
   { category: '🎙️｜INTERVIEW ZONE', channels: [
    {name:'🚨｜interview-announcement', type:ChannelType.GuildAnnouncement},
    {name:'📝｜chat', type:ChannelType.GuildText},
    {name:'📋｜project-rules', type:ChannelType.GuildText},
    {name:'⏳｜Waiting-Room-1', type:ChannelType.GuildVoice},
    {name:'⏳｜Waiting-Room-2', type:ChannelType.GuildVoice},
    {name:'🎤｜Interview-Room', type:ChannelType.GuildVoice}
   ]}
  ];

  await message.reply('⏳ Setting up **Horizons RP: Worldwide**. Existing channels will not be deleted.').catch(()=>{});
  let categoriesCreated = 0, channelsCreated = 0, skipped = 0, announcementFallbacks = 0;
  try {
   for (const group of layout) {
    let category = message.guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === group.category);
    if (!category) {
     category = await message.guild.channels.create({name:group.category, type:ChannelType.GuildCategory, reason:'Horizons RP: Worldwide server setup'});
     categoriesCreated++;
    }
    for (const item of group.channels) {
     const exists = message.guild.channels.cache.find(ch => ch.parentId === category.id && ch.name === item.name && (ch.type === item.type || (item.type === ChannelType.GuildAnnouncement && ch.type === ChannelType.GuildText)));
     if (exists) { skipped++; continue; }
     const options = {name:item.name, type:item.type, parent:category.id, reason:'Horizons RP: Worldwide server setup'};
     try {
      await message.guild.channels.create(options);
     } catch (err) {
      if (item.type !== ChannelType.GuildAnnouncement) throw err;
      await message.guild.channels.create({...options, type:ChannelType.GuildText});
      announcementFallbacks++;
     }
     channelsCreated++;
    }
   }
   return message.channel.send('✅ **Horizons RP: Worldwide setup complete!**\n📂 Categories created: **'+categoriesCreated+'**\n📝 Channels created: **'+channelsCreated+'**\n⏭️ Already existed: **'+skipped+'**'+(announcementFallbacks?'\nℹ️ Announcement channels created as text channels (Community may not be enabled): **'+announcementFallbacks+'**':'')+'\nNothing existing was deleted.').catch(()=>{});
  } catch (e) {
   console.error('!setup error:', e);
   return message.channel.send('⚠️ Setup stopped because of an error. Created so far: **'+categoriesCreated+'** categories and **'+channelsCreated+'** channels. Error: `'+String(e.message || e).slice(0,300)+'`. Check Manage Channels permission and server settings.').catch(()=>{});
  }
 }

 // !dltall is intentionally two-step because it permanently deletes channels.
 if (message.content.trim().toLowerCase() === '!dltall') {
  if (!message.guild) return message.reply('❌ Use `!dltall` inside your Discord server.').catch(()=>{});
  if (!isServerManager) return message.reply('❌ Only the server owner or bot owner can use `!dltall`.').catch(()=>{});
  return message.reply('⚠️ This will permanently delete **every channel and category** in this server. To confirm, type `!dltall confirm`. Roles and members will not be deleted.').catch(()=>{});
 }
 if (message.content.trim().toLowerCase() === '!dltall confirm') {
  if (!message.guild) return message.reply('❌ Use this command inside your Discord server.').catch(()=>{});
  if (!isServerManager) return message.reply('❌ Only the server owner or bot owner can use `!dltall confirm`.').catch(()=>{});
  const botMember = message.guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply('❌ I need the **Manage Channels** permission to delete channels.').catch(()=>{});
  await message.reply('🗑️ Confirmed. Deleting all channels and categories now...').catch(()=>{});
  let deleted = 0, failed = 0;
  // Delete non-category channels first, then categories.
  const channels = [...message.guild.channels.cache.values()].sort((a,b) => (a.type === ChannelType.GuildCategory ? 1 : 0) - (b.type === ChannelType.GuildCategory ? 1 : 0));
  for (const channel of channels) {
   try { await channel.delete('Owner confirmed !dltall for Horizons RP: Worldwide'); deleted++; }
   catch (err) { failed++; console.error('!dltall failed for '+channel.name+':', err.message); }
  }
  return message.author.send('🗑️ **Delete-all finished for '+message.guild.name+'.** Deleted: **'+deleted+'** channels/categories. Failed: **'+failed+'**.').catch(()=>{});
 }

 // Owner-only .dm command: sends the bot advertisement to one explicitly selected user.
 if(message.content.trim().toLowerCase().startsWith('.dm')) {
  if(message.author.id !== '1312960418288898062') {
   if(message.guild) await message.reply('❌ Only the bot owner can use this command.').catch(()=>{});
   return;
  }
  if(!message.guild) return message.reply('Use this command in a server: `.dm @user`').catch(()=>{});
  const target = message.mentions.users.first() || (message.content.trim().split(/\s+/)[1] ? await client.users.fetch(message.content.trim().split(/\s+/)[1].replace(/[<@!>]/g,'' )).catch(()=>null) : null);
  if(!target) return message.reply('Usage: `.dm @user` or `.dm USER_ID`').catch(()=>{});
  if(target.bot) return message.reply('❌ You cannot send the advertisement to a bot account.').catch(()=>{});
  const ad = new EmbedBuilder()
   .setColor(0xF1B735)
   .setDescription(`Hey <@1312960418288898062>, I am **Chilly**, a multipurpose Discord bot.


You have just added me to **𓂃𐙚 Coffee & Chill™ | Gwys • Fun • Social • Community • Chill** to enjoy moderation, giveaways, economy, utility and more.


To get started, invite Chilly to your server and use **/help** to explore the available commands.


🌐 **Support Server:** https://discord.gg/zFMWXFC25R


~ Powered by Spidyyy`)
   .setFooter({text:'Chilly • Powered by Spidyyy'});
  try {
   await target.send({embeds:[ad]});
   await message.reply(`✅ Advertisement DM sent to ${target.tag}.`).catch(()=>{});
  } catch {
   await message.reply(`❌ I couldn't DM ${target.tag}. Their DMs may be closed or they may have blocked the bot.`).catch(()=>{});
  }
  return;
 }
 if(!message.guild) return;
 // Short text aliases: Chilly daily/balance/work/slots, plus c daily/bal/work.
 const raw=message.content.trim();
 const match=raw.match(/^(?:chilly|c)\s+(daily|bal|balance|work|coin|coins|slots)(?:\s+(\d+))?$/i);
 if(match) {
  const cmd=match[1].toLowerCase(), amount=Number(match[2]||0), guildId=message.guild.id, userId=message.author.id;
  const getAccount=()=>account(guildId,userId);
  if(['bal','balance','coin','coins'].includes(cmd)) return message.reply('💰 **'+message.author.username+'** has **'+money(getAccount().coins)+'**.');
  if(cmd==='daily'||cmd==='work') {
   const a=getAccount(), now=Math.floor(Date.now()/1000), col=cmd==='daily'?'daily':'worked', cd=cmd==='daily'?86400:3600;
   if(now-a[col]<cd) return message.reply('⏳ Try again in '+Math.ceil((cd-(now-a[col]))/60)+' minute(s).');
   const earned=cmd==='daily'?500:Math.floor(Math.random()*201)+100;
   db.prepare('UPDATE users SET coins=coins+?, '+col+'=? WHERE guild=? AND user=?').run(earned,now,guildId,userId);
   return message.reply('❄️ You earned **'+money(earned)+'**! Balance: **'+money(getAccount().coins)+'**');
  }
  if(cmd==='slots') {
   if(!amount) return message.reply('Usage: `Chilly slots 100`');
   const a=getAccount(); if(a.coins<amount) return message.reply('❌ Not enough Chilly Coins.');
   const symbols=['🍒','🍋','🍇','⭐','🔔'], roll=[0,1,2].map(()=>symbols[Math.floor(Math.random()*symbols.length)]);
   const mult=roll[0]===roll[1]&&roll[1]===roll[2]?(roll[0]==='⭐'?5:3):(roll[0]===roll[1]||roll[1]===roll[2]||roll[0]===roll[2]?1:0);
   const delta=mult?amount*mult:-amount; db.prepare('UPDATE users SET coins=coins+? WHERE guild=? AND user=?').run(delta,guildId,userId);
   return message.reply('🎰 '+roll.join(' | ')+'\n'+(mult?'🎉 Won **'+money(amount*mult)+'**!':'😢 Lost **'+money(amount)+'**.')+' Balance: **'+money(getAccount().coins)+'**');
  }
 }
 const cfg=settings(message.guild.id);
 if(cfg.antilink && linkPattern.test(message.content) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
  await message.delete().catch(()=>{});
  await message.channel.send({content:`${message.author}, links are disabled in this server.`,allowedMentions:{users:[message.author.id]}}).then(m=>setTimeout(()=>m.delete().catch(()=>{}),5000)).catch(()=>{});
  await logAction(message.guild,auditEmbed('🔗 Link Blocked',0xF1C40F,[{name:'Member',value:`${message.author.tag} (${message.author.id})`},{name:'Channel',value:`${message.channel}`},{name:'Content',value:message.content.slice(0,900)}]));
  return;
 }
 if(cfg.antispam) {
  const key=`${message.guild.id}:${message.author.id}`, now=Date.now();
  const arr=(recentMessages.get(key)||[]).filter(t=>now-t<7000); arr.push(now); recentMessages.set(key,arr);
  if(arr.length>=6 && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
   await message.delete().catch(()=>{});
   await logAction(message.guild,auditEmbed('🚫 Anti-spam Triggered',0xE67E22,[{name:'Member',value:`${message.author.tag} (${message.author.id})`},{name:'Channel',value:`${message.channel}`},{name:'Detection',value:'6 messages within 7 seconds.'}]));
   recentMessages.set(key,[]);
  }
 }
 if(cfg.antiabuse && /\b(?:idiot|stupid)\b/i.test(message.content) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
  await message.delete().catch(()=>{});
  await logAction(message.guild,auditEmbed('⚠️ Anti-abuse Filter',0xF1C40F,[{name:'Member',value:`${message.author.tag} (${message.author.id})`},{name:'Channel',value:`${message.channel}`},{name:'Action',value:'Message removed by configured word filter.'}]));
 }
});

client.login(TOKEN);
