const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType,
  PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ActivityType, StringSelectMenuBuilder, Partials, AttachmentBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('node:path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
// Trusted bot owner configured by the user.
const TRUSTED_OWNER_ID = '1312960418288898062';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID.');
  process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent], partials: [Partials.Message, Partials.Channel, Partials.Reaction] });
const db = new Database('chilly.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS chilly_config (guild TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(guild,key))`);
db.exec(`CREATE TABLE IF NOT EXISTS ticket_buttons (guild TEXT NOT NULL, ticket_key TEXT NOT NULL, label TEXT NOT NULL, emoji TEXT, staff_role TEXT NOT NULL, log_channel TEXT NOT NULL, PRIMARY KEY(guild,ticket_key))`);
db.exec(`CREATE TABLE IF NOT EXISTS afk_status (guild TEXT NOT NULL, user TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild,user))`);
// Preserve the legacy single-button ticket setup for existing servers and panels.
db.exec(`INSERT OR IGNORE INTO ticket_buttons(guild,ticket_key,label,emoji,staff_role,log_channel) SELECT c.guild,'default','Create Ticket','🎫',r.value,c.value FROM chilly_config c JOIN chilly_config r ON r.guild=c.guild AND r.key='ticket_role' WHERE c.key='ticket_channel'`);
db.exec(`CREATE TABLE IF NOT EXISTS leveling_xp (guild TEXT NOT NULL, user TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, last_message INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild,user))`);
db.exec(`CREATE TABLE IF NOT EXISTS leveling_rewards (guild TEXT NOT NULL, level INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY(guild,level))`);
db.exec(`CREATE TABLE IF NOT EXISTS whitelist (guild TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, added_by TEXT, created INTEGER, PRIMARY KEY (guild, kind, target))`);
db.exec(`CREATE TABLE IF NOT EXISTS fictional_members (guild TEXT NOT NULL, name TEXT NOT NULL, created INTEGER DEFAULT (strftime('%s','now')), PRIMARY KEY(guild,name))`);
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
CREATE TABLE IF NOT EXISTS autoreactions (guild TEXT NOT NULL, trigger TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(guild,trigger));
CREATE TABLE IF NOT EXISTS reaction_roles (
 guild TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL, emoji_key TEXT NOT NULL, emoji_input TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(guild,message,emoji_key)
);
CREATE TABLE IF NOT EXISTS invite_counts (guild TEXT, user TEXT, invites INTEGER DEFAULT 0, PRIMARY KEY(guild,user));
CREATE TABLE IF NOT EXISTS guild_settings (
 guild TEXT PRIMARY KEY, log_channel TEXT, antinuke INTEGER DEFAULT 0, antiraid INTEGER DEFAULT 0, antilink INTEGER DEFAULT 0, antispam INTEGER DEFAULT 0, antiabuse INTEGER DEFAULT 0
);
`);
// Dedicated AntiNuke / AutoMod configuration. These replace the old one-size-fits-all /security switch.
db.exec(`
CREATE TABLE IF NOT EXISTS antinuke_config (guild TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}', limits TEXT NOT NULL DEFAULT '{}', punishments TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS antinuke_mainroles (guild TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(guild,role));
CREATE TABLE IF NOT EXISTS antibot_config (guild TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS antibot_whitelist (guild TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY(guild,user));
CREATE TABLE IF NOT EXISTS automod_config (guild TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, logging_channel TEXT, punishment TEXT NOT NULL DEFAULT 'timeout');
CREATE TABLE IF NOT EXISTS automod_ignore (guild TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(guild,kind,target));
`);
// Preserve any existing AntiNuke enable state from the former /security command.
db.prepare("INSERT OR IGNORE INTO antinuke_config(guild,enabled) SELECT guild,antinuke FROM guild_settings WHERE antinuke=1").run();
// Global OWO-style economy: one wallet and inventory per Discord user across every server.
db.exec(`
CREATE TABLE IF NOT EXISTS global_users (
 user TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0,
 daily INTEGER NOT NULL DEFAULT 0, worked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS global_inventory (
 user TEXT NOT NULL, item TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user,item)
);
`);
// Server-specific real-money rewards, stored in paise for accurate INR arithmetic.
db.exec(`
CREATE TABLE IF NOT EXISTS real_money_users (
 guild TEXT NOT NULL, user TEXT NOT NULL,
 messages INTEGER NOT NULL DEFAULT 0,
 earned_paise INTEGER NOT NULL DEFAULT 0,
 paid_paise INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(guild,user)
);
`);
// Daily message statistics for the `.m` command. Spam/invalid messages are only added when the reward counter accepts them.
db.exec(`CREATE TABLE IF NOT EXISTS message_daily (guild TEXT NOT NULL, user TEXT NOT NULL, day TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild,user,day))`);
// Cash-out requests are sent to the configured bot owner for manual review.
db.exec(`CREATE TABLE IF NOT EXISTS real_money_withdrawals (
 id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL, user TEXT NOT NULL,
 amount_paise INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL
);`);
// Import existing server-specific balances/items once. Coins and item quantities are summed;
// cooldown timestamps use MAX so switching servers cannot bypass a cooldown.
if (!db.prepare("SELECT 1 FROM chilly_config WHERE guild='__global_economy__' AND key='migration_v1'").get()) {
 db.transaction(() => {
  db.prepare(`INSERT INTO global_users(user,coins,daily,worked)
   SELECT user, SUM(COALESCE(coins,0)), MAX(COALESCE(daily,0)), MAX(COALESCE(worked,0))
   FROM users WHERE user IS NOT NULL GROUP BY user
   ON CONFLICT(user) DO NOTHING`).run();
  db.prepare(`INSERT INTO global_inventory(user,item,quantity)
   SELECT user,item,SUM(COALESCE(quantity,0)) FROM inventory
   WHERE user IS NOT NULL AND item IS NOT NULL GROUP BY user,item
   ON CONFLICT(user,item) DO NOTHING`).run();
  db.prepare("INSERT INTO chilly_config(guild,key,value) VALUES('__global_economy__','migration_v1','done')").run();
 })();
}


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
ensureColumn('global_users', 'bank', 'INTEGER NOT NULL DEFAULT 0');
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
 new SlashCommandBuilder().setName('ticket-setup').setDescription('Configure custom ticket buttons and panels')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub=>sub.setName('add-button').setDescription('Add a custom ticket button')
   .addStringOption(o=>o.setName('key').setDescription('Unique short key, e.g. support').setMaxLength(30).setRequired(true))
   .addStringOption(o=>o.setName('name').setDescription('Text shown on the ticket button').setMaxLength(80).setRequired(true))
   .addRoleOption(o=>o.setName('staff-role').setDescription('Staff role for this ticket type').setRequired(true))
   .addChannelOption(o=>o.setName('log-channel').setDescription('Log channel for this ticket type').addChannelTypes(ChannelType.GuildText).setRequired(true))
   .addStringOption(o=>o.setName('emoji').setDescription('Optional button emoji').setMaxLength(100).setRequired(false)))
  .addSubcommand(sub=>sub.setName('remove-button').setDescription('Remove a ticket button')
   .addStringOption(o=>o.setName('key').setDescription('Button key to remove').setMaxLength(30).setRequired(true)))
  .addSubcommand(sub=>sub.setName('list-buttons').setDescription('List configured ticket buttons'))
  .addSubcommand(sub=>sub.setName('panel').setDescription('Post a panel with all configured ticket buttons')
   .addChannelOption(o=>o.setName('channel').setDescription('Panel channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
   .addStringOption(o=>o.setName('title').setDescription('Panel title').setMaxLength(200).setRequired(true))
   .addStringOption(o=>o.setName('description').setDescription('Panel description').setMaxLength(1000).setRequired(true))),
 new SlashCommandBuilder().setName('welcome-setup').setDescription('Configure welcome messages for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o=>o.setName('channel').setDescription('Welcome channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
  .addStringOption(o=>o.setName('message').setDescription('Use {user} and {server} placeholders').setMaxLength(1000).setRequired(true)),
 new SlashCommandBuilder().setName('jail').setDescription('Jail a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member to jail').setRequired(true))
  .addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('unjail').setDescription('Release a jailed member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member to release').setRequired(true)),
 new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
 new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
 new SlashCommandBuilder().setName('say').setDescription('Send a message in this channel or an optional selected channel')
  .addStringOption(o=>o.setName('message').setDescription('Message to send').setMaxLength(2000).setRequired(true))
  .addChannelOption(o=>o.setName('channel').setDescription('Optional destination channel').addChannelTypes(ChannelType.GuildText).setRequired(false))
 ,
 new SlashCommandBuilder().setName('whitelist').setDescription('Manage security whitelist entries')
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
 new SlashCommandBuilder().setName('slots').setDescription('Bet NexBits on the slot machine')
  .addIntegerOption(o=>o.setName('bet').setDescription('Coins to bet').setMinValue(1).setMaxValue(1000000).setRequired(true)),
 new SlashCommandBuilder().setName('pay').setDescription('Pay NexBits to a member')
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
 new SlashCommandBuilder().setName('autorole').setDescription('Set or update the automatic role')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addRoleOption(o=>o.setName('role').setDescription('Role to give new members').setRequired(true)),
 new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)),
 new SlashCommandBuilder().setName('clone').setDescription('Clone the current text channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
 new SlashCommandBuilder().setName('enlarge').setDescription('Enlarge a custom emoji').addStringOption(o=>o.setName('emoji').setDescription('Custom emoji').setRequired(true)),
 new SlashCommandBuilder().setName('hide').setDescription('Hide a text channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).addChannelOption(o=>o.setName('channel').setDescription('Channel to hide').addChannelTypes(ChannelType.GuildText).setRequired(false)),
 new SlashCommandBuilder().setName('hideall').setDescription('Hide all text channels').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
 new SlashCommandBuilder().setName('lock').setDescription('Lock a text channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).addChannelOption(o=>o.setName('channel').setDescription('Channel to lock').addChannelTypes(ChannelType.GuildText).setRequired(false)),
 new SlashCommandBuilder().setName('lockall').setDescription('Lock all text channels').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
 new SlashCommandBuilder().setName('moderation').setDescription('Open the moderation panel'),
 new SlashCommandBuilder().setName('modguide').setDescription('Show the moderation command guide'),
 new SlashCommandBuilder().setName('modlog').setDescription('Configure moderation logs').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('disable').setDescription('Disable moderation logs'))
  .addSubcommand(sub=>sub.setName('set').setDescription('Set moderation log channel').addChannelOption(o=>o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true))),
 new SlashCommandBuilder().setName('mute').setDescription('Timeout a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addIntegerOption(o=>o.setName('duration').setDescription('Duration in minutes').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason')),
 new SlashCommandBuilder().setName('nick').setDescription('Change a member nickname').setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o=>o.setName('nickname').setDescription('New nickname').setMaxLength(32).setRequired(true)),
 new SlashCommandBuilder().setName('nuke').setDescription('Recreate the current text channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
 new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(sub=>sub.setName('messages').setDescription('Delete recent messages').addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(true)).addUserOption(o=>o.setName('member').setDescription('Only this member')))
  .addSubcommand(sub=>sub.setName('bot').setDescription('Delete bot messages').addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(false)))
  .addSubcommand(sub=>sub.setName('contains').setDescription('Delete messages containing text').addStringOption(o=>o.setName('text').setDescription('Text to match').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(false)))
  .addSubcommand(sub=>sub.setName('embeds').setDescription('Delete messages containing embeds').addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(false)))
  .addSubcommand(sub=>sub.setName('emoji').setDescription('Delete messages containing custom emoji').addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(false)))
  .addSubcommand(sub=>sub.setName('files').setDescription('Delete messages with attachments').addIntegerOption(o=>o.setName('amount').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(false))),
 new SlashCommandBuilder().setName('roleall').setDescription('Give a role to all members').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles).addRoleOption(o=>o.setName('role').setDescription('Role to assign').setRequired(true)),
 new SlashCommandBuilder().setName('role').setDescription('Bulk role assignment').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand(sub=>sub.setName('all').setDescription('Give role to all members').addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true)))
  .addSubcommand(sub=>sub.setName('bots').setDescription('Give role to bots').addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true)))
  .addSubcommand(sub=>sub.setName('humans').setDescription('Give role to human members').addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true)))
  .addSubcommand(sub=>sub.setName('icon').setDescription('Set a role icon using an emoji from this server').addRoleOption(o=>o.setName('role').setDescription('Role to update').setRequired(true)).addStringOption(o=>o.setName('emoji').setDescription('Server emoji (e.g. <:name:id>, :name:, or emoji ID)').setRequired(true))),
 new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addIntegerOption(o=>o.setName('duration').setDescription('Seconds, 0 to disable').setMinValue(0).setMaxValue(21600).setRequired(true)).addChannelOption(o=>o.setName('channel').setDescription('Target text channel').addChannelTypes(ChannelType.GuildText).setRequired(false)),
 new SlashCommandBuilder().setName('snipe').setDescription('Show the latest deleted message'),
 new SlashCommandBuilder().setName('unbanall').setDescription('Unban all currently banned users').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
 new SlashCommandBuilder().setName('unhide').setDescription('Unhide a text channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels).addChannelOption(o=>o.setName('channel').setDescription('Channel to unhide').addChannelTypes(ChannelType.GuildText).setRequired(false)),
 new SlashCommandBuilder().setName('unhideall').setDescription('Unhide all text channels').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
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
 new SlashCommandBuilder().setName('rps').setDescription('Challenge a real member to RPS for NexBits')
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
 new SlashCommandBuilder().setName('servericon').setDescription('Download a server icon using its invite link')
  .addStringOption(o=>o.setName('invite').setDescription('Discord server invite link').setRequired(true)),
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
 new SlashCommandBuilder().setName('gconfig').setDescription('Show giveaway configuration')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('glist').setDescription('List active giveaways')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
 new SlashCommandBuilder().setName('gstaff').setDescription('Configure giveaway staff')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('reset').setDescription('Reset the giveaway staff role'))
  .addSubcommand(sub=>sub.setName('role').setDescription('Set the giveaway staff role').addRoleOption(o=>o.setName('role').setDescription('Staff role').setRequired(true))),
 new SlashCommandBuilder().setName('gstart').setDescription('Start a giveaway')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('duration').setDescription('Duration, e.g. 1m, 1h, 1d').setMaxLength(10).setRequired(true))
  .addIntegerOption(o=>o.setName('winners').setDescription('Winner count').setMinValue(1).setMaxValue(20).setRequired(true))
  .addStringOption(o=>o.setName('prize').setDescription('Prize').setRequired(true)),
 new SlashCommandBuilder().setName('gend').setDescription('End giveaway early')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('id').setDescription('Giveaway ID (optional; latest active if omitted)').setRequired(false)),
 new SlashCommandBuilder().setName('greroll').setDescription('Pick new winners')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o=>o.setName('id').setDescription('Giveaway ID (optional; latest active if omitted)').setRequired(false)),
 new SlashCommandBuilder().setName('steal').setDescription('Add an emoji or sticker from a replied message to this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageEmojisAndStickers)
  .addStringOption(o=>o.setName('message_id').setDescription('ID of the message containing the emoji or sticker').setRequired(true)),
 new SlashCommandBuilder().setName('reaction-role').setDescription('Give a role when members react to a message')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addStringOption(o=>o.setName('message_id').setDescription('ID of the embed/message to add the reaction to').setRequired(true))
  .addStringOption(o=>o.setName('emoji').setDescription('Unicode emoji or custom emoji from this server').setRequired(true))
  .addRoleOption(o=>o.setName('role').setDescription('Role to give/remove when reacting').setRequired(true)),
 new SlashCommandBuilder().setName('autoreact').setDescription('Manage automatic message reactions')
  .addSubcommand(sub=>sub.setName('add').setDescription('Add an automatic reaction for a trigger')
   .addStringOption(o=>o.setName('trigger').setDescription('Exact word or phrase to match').setMaxLength(100).setRequired(true))
   .addStringOption(o=>o.setName('emoji').setDescription('Emoji to react with').setRequired(true)))
  .addSubcommand(sub=>sub.setName('remove').setDescription('Remove an automatic reaction')
   .addStringOption(o=>o.setName('trigger').setDescription('Trigger to remove').setMaxLength(100).setRequired(true)))
  .addSubcommand(sub=>sub.setName('list').setDescription('List automatic reactions'))
  .addSubcommand(sub=>sub.setName('reset').setDescription('Remove all automatic reactions')),
 new SlashCommandBuilder().setName('role-colour').setDescription('Change a role colour using a colour name or hex code')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addRoleOption(o=>o.setName('role').setDescription('Role whose colour should change').setRequired(true))
  .addStringOption(o=>o.setName('colour').setDescription('Colour name (Red, Blue, etc.) or hex code (#FF0000)').setRequired(true)),
 new SlashCommandBuilder().setName('setlogs').setDescription('Set moderation and server log channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o=>o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
 new SlashCommandBuilder().setName('levelup-setup').setDescription('Configure level-up announcements for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(o=>o.setName('channel').setDescription('Announcement channel (omit to use the current channel; use off to disable via message option)').addChannelTypes(ChannelType.GuildText).setRequired(false))
  .addStringOption(o=>o.setName('message').setDescription('Message tags: {user}, {level}, {xp}').setMaxLength(1000).setRequired(false)),
 new SlashCommandBuilder().setName('levelrole').setDescription('Configure level-based role rewards')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand(sub=>sub.setName('add').setDescription('Give a role at a specific level')
   .addIntegerOption(o=>o.setName('level').setDescription('Required level').setMinValue(1).setMaxValue(1000).setRequired(true))
   .addRoleOption(o=>o.setName('role').setDescription('Reward role').setRequired(true)))
  .addSubcommand(sub=>sub.setName('remove').setDescription('Remove a level reward')
   .addIntegerOption(o=>o.setName('level').setDescription('Level reward to remove').setMinValue(1).setMaxValue(1000).setRequired(true)))
  .addSubcommand(sub=>sub.setName('list').setDescription('List configured level rewards')),
 new SlashCommandBuilder().setName('level').setDescription('View your or another member’s level')
  .addUserOption(o=>o.setName('member').setDescription('Member to check').setRequired(false)),
 new SlashCommandBuilder().setName('level-leaderboard').setDescription('Show this server’s top levels'),
 new SlashCommandBuilder().setName('antinuke').setDescription('Configure AntiNuke protection')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('config').setDescription('Configure AntiNuke settings').addStringOption(o=>o.setName('setting').setDescription('Setting name').setRequired(true)).addStringOption(o=>o.setName('value').setDescription('Setting value').setRequired(true)).addChannelOption(o=>o.setName('channel').setDescription('Optional log channel').addChannelTypes(ChannelType.GuildText).setRequired(false)))
  .addSubcommand(sub=>sub.setName('limit').setDescription('Set an AntiNuke event limit').addStringOption(o=>o.setName('event_or_amount').setDescription('Event or amount key').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Limit amount').setMinValue(1).setMaxValue(1000).setRequired(true)))
  .addSubcommand(sub=>sub.setName('punishment').setDescription('Set an AntiNuke punishment').addStringOption(o=>o.setName('event_or_punishment').setDescription('Event or punishment key').setRequired(true)).addStringOption(o=>o.setName('punishment').setDescription('Punishment value').setRequired(true)))
  .addSubcommand(sub=>sub.setName('reset').setDescription('Reset AntiNuke settings')),
 new SlashCommandBuilder().setName('mainrole').setDescription('Manage AntiNuke main roles').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('add').setDescription('Register a main role').addRoleOption(o=>o.setName('role').setDescription('Main role').setRequired(true)))
  .addSubcommand(sub=>sub.setName('list').setDescription('List registered main roles'))
  .addSubcommand(sub=>sub.setName('remove').setDescription('Remove a main role').addRoleOption(o=>o.setName('role').setDescription('Main role').setRequired(true)))
  .addSubcommand(sub=>sub.setName('reset').setDescription('Remove all main roles')),
 new SlashCommandBuilder().setName('antibot').setDescription('Configure AntiBot protection').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('add').setDescription('Add a bot to the whitelist').addUserOption(o=>o.setName('bot_user').setDescription('Bot user').setRequired(true)))
  .addSubcommand(sub=>sub.setName('config').setDescription('View or change AntiBot configuration').addBooleanOption(o=>o.setName('enabled').setDescription('Enable or disable').setRequired(false)))
  .addSubcommand(sub=>sub.setName('remove').setDescription('Remove a bot from the whitelist').addUserOption(o=>o.setName('bot_user').setDescription('Bot user').setRequired(true)))
  .addSubcommand(sub=>sub.setName('reset').setDescription('Reset AntiBot configuration'))
  .addSubcommand(sub=>sub.setName('whitelist').setDescription('Manage AntiBot whitelist').addStringOption(o=>o.setName('action').setDescription('list, add or remove').setRequired(false)).addUserOption(o=>o.setName('bot_user').setDescription('Bot user for add/remove').setRequired(false))),
 new SlashCommandBuilder().setName('automod').setDescription('Configure AutoMod protection').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub=>sub.setName('config').setDescription('View AutoMod configuration'))
  .addSubcommand(sub=>sub.setName('disable').setDescription('Disable AutoMod'))
  .addSubcommand(sub=>sub.setName('enable').setDescription('Enable AutoMod'))
  .addSubcommand(sub=>sub.setName('ignore').setDescription('Manage ignored AutoMod targets').addStringOption(o=>o.setName('action').setDescription('channel, role, reset or show').setRequired(false)).addChannelOption(o=>o.setName('channel').setDescription('Channel to ignore').addChannelTypes(ChannelType.GuildText).setRequired(false)).addRoleOption(o=>o.setName('role').setDescription('Role to ignore').setRequired(false)))
  .addSubcommand(sub=>sub.setName('logging').setDescription('Set AutoMod logging channel').addChannelOption(o=>o.setName('channel').setDescription('Logging channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
  .addSubcommand(sub=>sub.setName('punishment').setDescription('Configure AutoMod punishment').addStringOption(o=>o.setName('punishment').setDescription('Punishment').setRequired(true)))
  .addSubcommand(sub=>sub.setName('unignore').setDescription('Remove ignored AutoMod targets').addStringOption(o=>o.setName('kind').setDescription('channel or role').setRequired(true).addChoices({name:'Channel',value:'channel'},{name:'Role',value:'role'})).addChannelOption(o=>o.setName('channel').setDescription('Ignored channel').addChannelTypes(ChannelType.GuildText).setRequired(false)).addRoleOption(o=>o.setName('role').setDescription('Ignored role').setRequired(false))),

 new SlashCommandBuilder().setName('afk').setDescription('Set, update or remove your AFK status')
  .addStringOption(o=>o.setName('reason').setDescription('AFK reason; omit to remove your AFK').setMaxLength(500).setRequired(false)),
 new SlashCommandBuilder().setName('banner').setDescription("View a user's profile banner")
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(false)),
 new SlashCommandBuilder().setName('devices').setDescription("Show a member's Discord activity")
  .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(false)),
 new SlashCommandBuilder().setName('inviteinfo').setDescription('View information about a Discord invite')
  .addStringOption(o=>o.setName('invite').setDescription('Invite link or code').setRequired(true)),
 new SlashCommandBuilder().setName('list').setDescription('List server members and resources')
  .addSubcommand(sub=>sub.setName('admins').setDescription('List server administrators'))
  .addSubcommand(sub=>sub.setName('boosters').setDescription('List server boosters'))
  .addSubcommand(sub=>sub.setName('bots').setDescription('List bots in the server'))
  .addSubcommand(sub=>sub.setName('early').setDescription('List Early Supporter badge holders'))
  .addSubcommand(sub=>sub.setName('emojis').setDescription('List server emojis'))
  .addSubcommand(sub=>sub.setName('inrole').setDescription('List members who have a role').addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true))),
 new SlashCommandBuilder().setName('fakeperms').setDescription('Preview fake permissions from a role')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true))
  .addStringOption(o=>o.setName('permission').setDescription('Permission to preview').setRequired(false)),
 new SlashCommandBuilder().setName('jailsetup').setDescription('Set up the jail system')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addRoleOption(o=>o.setName('role').setDescription('Jail role').setRequired(true)),
 new SlashCommandBuilder().setName('jailsync').setDescription('Synchronize the jail system')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
 new SlashCommandBuilder().setName('permit').setDescription('Add or remove a permitted jail staff role')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addStringOption(o=>o.setName('action').setDescription('Add or remove').setRequired(true).addChoices({name:'Add',value:'add'},{name:'Remove',value:'remove'}))
  .addRoleOption(o=>o.setName('role').setDescription('Jail staff role').setRequired(true)),
 new SlashCommandBuilder().setName('pjail').setDescription('Permanently jail a member')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(o=>o.setName('user').setDescription('Member to jail').setRequired(true))
  .addStringOption(o=>o.setName('reason').setDescription('Reason').setRequired(false)),
 new SlashCommandBuilder().setName('ticket').setDescription('Manage tickets and active ticket channels')
  .addSubcommand(sub=>sub.setName('claim').setDescription('Claim the current ticket'))
  .addSubcommand(sub=>sub.setName('close').setDescription('Close and lock the current ticket'))
  .addSubcommand(sub=>sub.setName('config').setDescription('View configured ticket buttons'))
  .addSubcommand(sub=>sub.setName('delete').setDescription('Delete the current ticket'))
  .addSubcommand(sub=>sub.setName('edit').setDescription('Show ticket panel editor').addStringOption(o=>o.setName('panel_id').setDescription('Panel/button key').setRequired(true)))
  .addSubcommand(sub=>sub.setName('panel').setDescription('Open the ticket panel manager'))
  .addSubcommand(sub=>sub.setName('rename').setDescription('Rename the current ticket channel').addStringOption(o=>o.setName('new_name').setDescription('New channel name').setRequired(true)))
  .addSubcommand(sub=>sub.setName('send').setDescription('Send a configured ticket panel').addStringOption(o=>o.setName('panel_id').setDescription('Optional button key').setRequired(false)))
  .addSubcommand(sub=>sub.setName('setup').setDescription('Open ticket setup instructions')),
].map(c=>c.toJSON());

function xpForNextLevel(level) { return (level * 100) + 75; }
function levelFromXp(total) {
 let level=0, remaining=Math.max(0,total);
 while(remaining>=xpForNextLevel(level) && level<1000) { remaining-=xpForNextLevel(level); level++; }
 return {level, progress:remaining, required:xpForNextLevel(level)};
}
function getLevelRow(guildId,userId) {
 db.prepare('INSERT OR IGNORE INTO leveling_xp(guild,user,xp,last_message) VALUES(?,?,0,0)').run(guildId,userId);
 return db.prepare('SELECT * FROM leveling_xp WHERE guild=? AND user=?').get(guildId,userId);
}
function account(g,u) {
 db.prepare('INSERT OR IGNORE INTO global_users(user) VALUES(?)').run(u);
 return db.prepare('SELECT * FROM global_users WHERE user=?').get(u);
}

function money(n) { return n.toLocaleString('en-US')+' NexBits'; }

// Dynamic personalized economy cards. A fresh image is rendered on every economy
// action so each user always sees their own balance, reward and live leaderboard rank.
function economyRank(userId) {
 const row = db.prepare(`SELECT COUNT(*) + 1 AS rank FROM global_users WHERE coins > (SELECT coins FROM global_users WHERE user=?)`).get(userId);
 return Number(row?.rank || 1);
}

function economyMemberCount() {
 return Number(db.prepare('SELECT COUNT(*) AS count FROM global_users').get()?.count || 0);
}

async function renderEconomyCard({user, command, reward=0, balance=0, nextClaim=null, note='', opponent=null}) {
 const { createCanvas, loadImage } = require('@napi-rs/canvas');
 const canvas = createCanvas(1500, 650);
 const ctx = canvas.getContext('2d');
 const bg = ctx.createLinearGradient(0, 0, 1500, 650);
 bg.addColorStop(0, '#0a1020'); bg.addColorStop(0.55, '#111b34'); bg.addColorStop(1, '#07101c');
 ctx.fillStyle = bg; ctx.fillRect(0, 0, 1500, 650);
 ctx.fillStyle = '#69d8ff'; ctx.fillRect(0, 0, 520, 10);
 ctx.fillStyle = '#182642'; ctx.fillRect(520, 0, 980, 10);
 ctx.globalAlpha = 0.14; ctx.fillStyle = '#69d8ff';
 ctx.beginPath(); ctx.arc(1370, 100, 210, 0, Math.PI*2); ctx.fill();
 ctx.beginPath(); ctx.arc(100, 610, 190, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;

 try {
  const avatar = await loadImage(user.displayAvatarURL({extension:'png', size:256}));
  ctx.save(); ctx.beginPath(); ctx.arc(108, 112, 64, 0, Math.PI*2); ctx.clip();
  ctx.drawImage(avatar, 44, 48, 128, 128); ctx.restore();
  ctx.strokeStyle = '#69d8ff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(108,112,66,0,Math.PI*2); ctx.stroke();
 } catch {}

 const titles={daily:'DAILY REWARD',work:'WORK COMPLETE',balance:'BALANCE',pay:'COIN TRANSFER',shop:'NEXZU SHOP',buy:'PURCHASE COMPLETE',inventory:'INVENTORY',slots:'NEXZU SLOTS',leaderboard:'NEXBITS LEADERBOARD',money:'NEXBITS UPDATED'};
 ctx.fillStyle='#f5f8ff'; ctx.font='700 34px Sans'; ctx.fillText(titles[command]||'NEXZU ECONOMY',205,90);
 ctx.fillStyle='#8e9bb8'; ctx.font='500 23px Sans'; ctx.fillText('@'+String(user.username).slice(0,32),205,125);

 const rank=economyRank(user.id), total=economyMemberCount();
 const box=(x,y,w,h,label,value,accent='#69d8ff')=>{
  ctx.fillStyle='#111a2b'; ctx.fillRect(x,y,w,h); ctx.strokeStyle='#243858'; ctx.lineWidth=2; ctx.strokeRect(x,y,w,h);
  ctx.fillStyle='#8e9bb8'; ctx.font='600 18px Sans'; ctx.fillText(label.toUpperCase(),x+24,y+34);
  ctx.fillStyle=accent; ctx.font='700 31px Sans'; ctx.fillText(String(value).slice(0,38),x+24,y+76);
 };
 box(55,220,430,135,'Wallet',money(balance));
 box(535,220,430,135,'Leaderboard Rank','#'+rank,'#ffd66b');
 box(1015,220,430,135,'Ranked Members',String(total),'#9bbcff');
 if(command==='daily'||command==='work') {
  box(55,390,430,135,'Reward','+'+money(reward),'#70f0a6');
  if(nextClaim) {
   const remaining=Math.max(0,nextClaim-Math.floor(Date.now()/1000));
   const mins=Math.floor(remaining/60), hrs=Math.floor(mins/60);
   const countdown=hrs>0?`${hrs}h ${mins%60}m`:mins>0?`${mins}m`: `${remaining}s`;
   box(535,390,910,135,'Next Claim',countdown,'#c9a7ff');
  }
 } else if(command==='pay') {
  box(55,390,670,135,'Sent To',opponent?'@'+String(opponent.username).slice(0,26):'Member','#f4f7ff');
  box(775,390,670,135,'Amount',money(reward),'#70f0a6');
 } else if(command==='buy') {
  box(55,390,670,135,'Item',note||'Item','#f4f7ff');
  box(775,390,670,135,'Spent',money(reward),'#ff9e9e');
 } else if(command==='slots') {
  box(55,390,670,135,'Result',note||'Completed','#70f0a6');
  box(775,390,670,135,'Win / Bet',money(reward),'#ffd66b');
 } else if(command==='leaderboard') {
  const rows=db.prepare('SELECT user,coins FROM global_users ORDER BY coins DESC, user ASC LIMIT 5').all();
  ctx.fillStyle='#111a2b'; ctx.fillRect(55,390,1390,135);
  ctx.strokeStyle='#243858'; ctx.strokeRect(55,390,1390,135);
  ctx.fillStyle='#8e9bb8'; ctx.font='600 18px Sans'; ctx.fillText('TOP MEMBERS',79,424);
  ctx.font='600 20px Sans'; ctx.fillStyle='#f4f7ff';
  // Show member names/usernames instead of raw Discord user IDs.
  // Fetch from the guild first when available, then fall back to the global user cache/API.
  for(let n=0;n<rows.length;n++) {
   const r=rows[n];
   let displayName=r.user;
   try {
    const member=await (user.guild?.members?.fetch?.(r.user).catch(()=>null));
    if(member) displayName=member.displayName||member.user.globalName||member.user.username;
    else {
     const fetched=await client.users.fetch(r.user).catch(()=>null);
     if(fetched) displayName=fetched.globalName||fetched.username;
    }
   } catch {}
   displayName=String(displayName).replace(/[\r\n]/g,' ').slice(0,28);
   ctx.fillText(`#${n+1}  ${displayName}  •  ${money(r.coins)}`,79,458+n*20);
  }
 } else if(note) {
  box(55,390,1390,135,'Details',note.slice(0,82),'#c9a7ff');
 }
 ctx.fillStyle='#64728f'; ctx.font='500 18px Sans';
 ctx.fillText('Powered By Nexzu Development™ | Designed By Spidyyy',55,610);
 return canvas.toBuffer('image/png');
}
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
     embeds:[chillyStyledEmbed({title:g.prize,description:`${CHILLY_EMOJI.success} **Giveaway ended successfully.**\n${CHILLY_EMOJI.dot} **Winners:** ${winners.map(x=>'<@'+x+'>').join(', ')||'No entries'}\n${CHILLY_EMOJI.dot} **Giveaway ID:** \`${id}\``,footer:'Nexzu • Giveaways • Giveaway complete'})],
     components:[]
    }).catch(()=>{});
   }
   if(winners.length) {
    await ch.send({
     content:'🎉 '+CHILLY_EMOJI.gift+' Congratulations '+winners.map(x=>'<@'+x+'>').join(', ')+'! You won **'+g.prize+'**!',
     allowedMentions:{users:winners}
    }).catch(()=>{});
   } else {
    await ch.send('Giveaway ended with no entries.').catch(()=>{});
   }
  }
 } else {
  const ch=await client.channels.fetch(g.channel).catch(()=>null);
  if(ch && winners.length) await ch.send({
   content:'🎉 '+CHILLY_EMOJI.gift+' New giveaway winner(s): '+winners.map(x=>'<@'+x+'>').join(', ')+'! Prize: **'+g.prize+'**.',
   allowedMentions:{users:winners}
  }).catch(()=>{});
 }
 return {winners};
}
const deletedMessageCache = new Map();

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
 return chillyStyledEmbed({title, color, footer:'Nexzu • Security Logs'}).addFields(fields);
}

// Shared Chilly embed style + custom emoji palette from the user's server emoji set.
const CHILLY_EMOJI = {
 dm: '<:Dm:1564590774027558993>',
 arrow: '<:1000022230:1571576478452285621>',
 moderator: '<:1000022230:1571576478452285621>',
 member: '<:1000022232:1571576480946688539>',
 dot: '<:1000022243:1571576512547782718>',
 gift: '<:1000022228:1571576466355781824>',
 success: '<:1000022223:1571576535972839504>',
 rejected: '<:1000022219:157157653362831863>',
 admin: '<:1000022221:1571576542683861244>',
 bot: '<:1000022240:1571576507070030027>',
 money: '<:1000022218:1571576540460752937>',
 bank: '<:1000022215:1571576522895134910>',
 wallet: '<:1000022232:1571576480946688539>',
 security: '<:1000022221:1571576542683861244>',
 settings: '<:1000022238:1571576502292713716>',
 utility: '<:1000022237:1571576499876921487>',
 fun: '<:1000022243:1571576512547782718>',
 level: '<:1000022234:1571576486169809048>',
 crown: '<:1000022226:1571576472857092106>',
 crown2: '<:1000022227:1571576469438599258>',
 music: '<:1000022225:1571576463449137183>',
 sword: '<:1000022224:1571576459720531999>',
 code: '<:1000022237:1571576499876921487>',
 sparkle: '<:1000022243:1571576512547782718>',
 ticket: '<:1000022236:1571576497175789599>',
};

// Resolve a server custom emoji by ID, name, :name:, :id:, or full Discord emoji syntax.
function resolveServerCustomEmoji(guild, input) {
 const value=String(input||'').trim();
 if(!guild || !value) return null;
 const full=value.match(/^<a?:([A-Za-z0-9_~]+):(\d+)>$/);
 const named=value.match(/^:([A-Za-z0-9_~]+):$/);
 const colonId=value.match(/^:(\d+):$/);
 const bareId=value.match(/^(\d{15,22})$/);
 const nameId=value.match(/^([A-Za-z0-9_~]+):(\d+)$/);
 const id=full?.[2]||colonId?.[1]||bareId?.[1]||nameId?.[2];
 const name=full?.[1]||named?.[1]||nameId?.[1];
 return (id && guild.emojis.cache.get(id)) || (name && guild.emojis.cache.find(e=>e.name===name)) || null;
}

function customEmojiMarkup(emoji) {
 if(!emoji) return null;
 return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
}

function chillyStyledEmbed({title, description='', color=0x363640, thumbnail=true, timestamp=true, footer='Nexzu • Powered by Spidyyy'}) {
 const embed = new EmbedBuilder().setColor(color);
 if (title) embed.setTitle(String(title));
 const safeDescription = typeof description === 'string' ? description.trim() : String(description ?? '').trim();
 // Discord rejects empty embed descriptions. Omit the field entirely when there is no text.
 if (safeDescription) embed.setDescription(safeDescription);
 if (thumbnail) embed.setThumbnail(client.user.displayAvatarURL({size:256}));
 if (timestamp) embed.setTimestamp();
 if (footer) embed.setFooter({text:String(footer),iconURL:client.user.displayAvatarURL()});
 return embed;
}

// Convert simple command replies into Nexzu-styled embeds. Replies that already
// contain embeds/files/components are left untouched (for example economy image cards).
function nexzuCommandPayload(payload, commandName='command') {
 if (typeof payload === 'string') payload={content:payload};
 if (!payload || typeof payload !== 'object') return payload;
 if (payload.embeds?.length || payload.files?.length || payload.components?.length) return payload;
 if (!payload.content) return payload;
 const text=String(payload.content).trim();
 let icon=CHILLY_EMOJI.sparkle;
 let color=0x363640;
 if (/^(?:⛔|❌|⚠️|🚫)/.test(text)) { icon=CHILLY_EMOJI.rejected; color=0x4a2028; }
 else if (/^(?:✅|☑️)/.test(text)) { icon=CHILLY_EMOJI.success; color=0x1f4a36; }
 else if (/^(?:ℹ️|📌)/.test(text)) { icon=CHILLY_EMOJI.utility; }
 return {
  ...payload,
  content: undefined,
  embeds:[chillyStyledEmbed({title:`${icon} ${String(commandName).replace(/[-_]/g,' ').replace(/\b\w/g,m=>m.toUpperCase())}`,description:text,color})]
 };
}

function chillyHelpPayload() {
 const categories = [
  {label:'Economy',description:'Coins, rewards and payments',value:'economy',emoji:{id:'1571576540460752937',name:'1000022218'},line:'<:1000022218:1571576540460752937> » **Economy**'},
  {label:'Real Money Rewards',description:'INR rewards and cash-out requests',value:'rewards',emoji:{id:'1571576535972839504',name:'1000022223'},line:'<:1000022223:1571576535972839504> » **Real Money Rewards**'},
  {label:'Moderation',description:'Manage server members',value:'moderation',emoji:{id:'1571576542683861244',name:'1000022221'},line:'<:1000022221:1571576542683861244> » **Moderation**'},
  {label:'AntiNuke',description:'Server anti-nuke protection',value:'antinuke',emoji:{id:'1571576531216629811',name:'1000022220'},line:'<:1000022220:1571576531216629811> » **AntiNuke**'},
  {label:'AutoMod',description:'Automod and bot protection',value:'automod',emoji:{id:'1571576507070030027',name:'1000022240'},line:'<:1000022240:1571576507070030027> » **AutoMod**'},
  {label:'Giveaways',description:'Create and manage giveaways',value:'giveaways',emoji:{id:'1571576497175789599',name:'1000022236'},line:'<:1000022236:1571576497175789599> » **Giveaways**'},
  {label:'Fun',description:'Games and fun commands',value:'fun',emoji:{id:'1571576507070030027',name:'1000022240'},line:'<:1000022240:1571576507070030027> » **Fun**'},
  {label:'Utility',description:'Useful server tools',value:'utility',emoji:{id:'1571576478452285621',name:'1000022230'},line:'<:1000022230:1571576478452285621> » **Utility**'},
  {label:'Server Setup',description:'Configure server features',value:'setup',emoji:{id:'1571576502292713716',name:'1000022238'},line:'<:1000022238:1571576502292713716> » **Server Setup**'},
  {label:'Jail',description:'Jail and permitted jail staff',value:'jail',emoji:{id:'1571576531216629811',name:'1000022220'},line:'<:1000022220:1571576531216629811> » **Jail**'},
  {label:'Misc',description:'AFK, profiles, lists and utilities',value:'misc',emoji:{name:'🔧'},line:'🔧 » **Misc**'},
  {label:'Tickets',description:'Ticket panels and active tickets',value:'tickets',emoji:{id:'1571576497175789599',name:'1000022236'},line:'<:1000022236:1571576497175789599> » **Tickets**'},
  {label:'Music',description:'Music and audio module',value:'music',emoji:{id:'1571576463449137183',name:'1000022225'},line:'<:1000022225:1571576463449137183> » **Music**'},
  {label:'Leveling',description:'XP, levels and rewards',value:'leveling',emoji:{id:'1571576486169809048',name:'1000022234'},line:'<:1000022234:1571576486169809048> » **Leveling**'}
 ];;
 const menu = new StringSelectMenuBuilder().setCustomId('chilly_help_category').setPlaceholder('Home  ›  Choose a category').addOptions(categories.map(({line,...option})=>option));
 const invite = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;
 const description = [
  "**Hey, I'm Nexzu™**",
  'A powerful multipurpose Discord bot for your community.',
  '',
  `<:1000022237:1571576499876921487> **My Prefix is**  \`.\`  •  Every command also works with the dot prefix`,
  `<:1000022243:1571576512547782718> **Total Commands:** \`${commands.length}\``,
  '<:1000022241:1571576510081536081> **Choose a Specific Module of your Desire**',
  '',
  categories.map(x=>x.line).join('\n'),
  '',
  '<:1000022241:1571576510081536081> **Links**',
  `[Invite Me](${invite})  |  [Support Server](https://discord.gg/TFVrsdNWGx)  |  [Website](https://spidyyy09.github.io/portfolio/)`
 ].join('\n');
 const embed = chillyStyledEmbed({title:'<:1000022239:1571576504599712004> Hey, I\'m Nexzu™',description,thumbnail:true,timestamp:false,footer:'Powered By Nexzu Development™ | Designed By Spidyyy'});
 return {embeds:[embed],components:[new ActionRowBuilder().addComponents(menu)]};
}

function moderationEmbed({title, targetLabel='Member', targetName, targetId, moderator, reason, duration, dmDone, avatar}) {
 const lines = [
  `${CHILLY_EMOJI.member} **${targetLabel}:** ${targetName}${targetId ? ` (\`${targetId}\`)` : ''}`,
  `${CHILLY_EMOJI.moderator} **Moderator:** ${moderator}`
 ];
 if (duration) lines.push('', `${CHILLY_EMOJI.dot} **Duration:** ${duration}`);
 if (dmDone !== undefined) lines.push('', `${CHILLY_EMOJI.dm} **DM Done?** ${dmDone ? CHILLY_EMOJI.success : CHILLY_EMOJI.rejected}`);
 lines.push('', `${CHILLY_EMOJI.arrow} **Reason:** ${reason || 'No reason provided'}`);
 const embed = chillyStyledEmbed({title,description:lines.join('\n'),footer:'Nexzu • Moderation'});
 if (avatar) embed.setThumbnail(avatar);
 return embed;
}
const recentMessages = new Map();
const recentJoins = new Map();
const actionCounts = new Map();
const linkPattern = /https?:\/\/|discord\.gg\//i;

client.once('ready', async()=>{
 console.log('Nexzu online as '+client.user.tag);
 // Refresh the known custom emoji markup from the server cache so animated/static
 // status and renamed emoji IDs are always rendered in Discord's valid format.
 for(const guild of client.guilds.cache.values()) {
  const emoji=resolveServerCustomEmoji(guild,'1000022219');
  if(emoji) { CHILLY_EMOJI.rejected=customEmojiMarkup(emoji); break; }
 }
 client.user.setPresence({
  activities:[{name:'Powered by Spidyyy',type:ActivityType.Playing}],
  status:'online'
 });
 try {
  // `commands` are already JSON payloads (serialized at declaration).
  const payload = commands;
  const names = payload.map(command => command.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error('Duplicate slash command names: ' + [...new Set(duplicates)].join(', '));
  if (payload.length > 100) throw new Error(`Discord allows at most 100 global commands; found ${payload.length}.`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const guilds = [...client.guilds.cache.values()];
  if (!guilds.length) {
   console.error('SLASH COMMAND SYNC FAILED: bot is not in any server cache. Check bot invite and DISCORD_TOKEN.');
  }
  // Keep commands GLOBAL only. Registering the same commands as both guild and
  // global commands makes Discord show each command twice in a server.
  // Clear any guild-scoped copies created by earlier versions, then publish globals.
  for (const guild of guilds) {
   try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: [] });
    console.log(`🧹 Cleared old guild-specific slash commands from ${guild.name} (${guild.id}).`);
   } catch (error) {
    console.error(`❌ Could not clear guild-specific commands for ${guild.name} (${guild.id}):`, JSON.stringify(error?.rawError || {message:error?.message, code:error?.code}, null, 2));
   }
  }
  try {
   await rest.put(Routes.applicationCommands(CLIENT_ID), { body: payload });
   console.log(`✅ Synced ${payload.length} global slash commands (global commands may take a little time to refresh in Discord).`);
  } catch (error) {
   console.error('❌ Global slash-command sync failed. Full Discord API details:', JSON.stringify(error?.rawError || {message:error?.message, code:error?.code}, null, 2));
  }
 } catch (e) {
  console.error('❌ Slash-command registration failed before sending to Discord:', e);
 }
 for(const g of db.prepare('SELECT id,ends FROM giveaways WHERE ended=0').all()) {
  setTimeout(()=>endGiveaway(g.id).catch(console.error),Math.max(0,g.ends*1000-Date.now()));
 }
});
function normalizeReactionEmoji(input) {
 const value = String(input || '').trim();
 const custom = value.match(/^<a?:([A-Za-z0-9_~]+):(\d+)>$/) || value.match(/^([A-Za-z0-9_~]+):(\d+)$/);
 if (custom) return { key: custom[2], reactValue: `${custom[1]}:${custom[2]}` };
 if (/^\d{15,22}$/.test(value)) return { key: value, reactValue: value };
 return { key: value, reactValue: value };
}

async function applyReactionRole(reaction, user, addRole) {
 try {
  if (user?.bot || !reaction?.message?.guild) return;
  if (reaction.partial) await reaction.fetch();
  const message = reaction.message;
  if (message.partial) await message.fetch();
  const emojiKey = reaction.emoji.id || reaction.emoji.name;
  const mapping = db.prepare('SELECT role FROM reaction_roles WHERE guild=? AND channel=? AND message=? AND emoji_key=?')
   .get(message.guild.id, message.channelId, message.id, emojiKey);
  if (!mapping) return;
  const member = await message.guild.members.fetch(user.id).catch(()=>null);
  if (!member) return;
  const role = await message.guild.roles.fetch(mapping.role).catch(()=>null);
  if (!role || role.managed || role.position >= message.guild.members.me.roles.highest.position) return;
  if (addRole) await member.roles.add(role, 'Nexzu reaction role').catch(()=>{});
  else await member.roles.remove(role, 'Nexzu reaction role reaction removed').catch(()=>{});
 } catch (error) {
  console.error('Reaction-role event failed:', error?.message || error);
 }
}

client.on('messageReactionAdd', (reaction, user) => applyReactionRole(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => applyReactionRole(reaction, user, false));

const GIVEAWAY_EMOJI_ID = '1564349893907062844';
async function handleGiveawayReaction(reaction, user, add) {
 try {
  if (!user || user.bot) return;
  if (reaction.partial) await reaction.fetch();
  const message = reaction.message;
  if (message.partial) await message.fetch();
  if (!message.guild) return;
  if (reaction.emoji.id !== GIVEAWAY_EMOJI_ID) return;
  const g = db.prepare('SELECT * FROM giveaways WHERE message=? AND guild=?').get(message.id, message.guild.id);
  if (!g || g.ended || g.ends * 1000 <= Date.now()) return;
  if (add) db.prepare('INSERT OR IGNORE INTO entries(giveaway,user) VALUES(?,?)').run(g.id,user.id);
  else db.prepare('DELETE FROM entries WHERE giveaway=? AND user=?').run(g.id,user.id);
 } catch (error) {
  console.error('Giveaway reaction handler error:', error);
 }
}
client.on('messageReactionAdd', (reaction, user) => handleGiveawayReaction(reaction, user, true));
client.on('messageReactionRemove', (reaction, user) => handleGiveawayReaction(reaction, user, false));


async function stealFromSourceMessage(guild, sourceMessage) {
 if(!guild.members.me?.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers)) {
  return {ok:false,message:'I need **Manage Expressions** (Manage Emojis and Stickers) permission.'};
 }
 const customEmojiMatch = sourceMessage.content?.match(/<a?:([A-Za-z0-9_]{2,32}):(\d{17,20})>/);
 if(customEmojiMatch) {
  const [, rawName, id] = customEmojiMatch;
  const animated = sourceMessage.content.includes(`<a:${rawName}:${id}>`);
  const ext = animated ? 'gif' : 'png';
  const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?quality=lossless`;
  const name = rawName.slice(0,32);
  const created = await guild.emojis.create({ attachment:url, name, reason:'Emoji added using Nexzu /steal' });
  return {ok:true,message:`✅ Added emoji ${created} (**${created.name}**) to this server.`};
 }
 const sticker = sourceMessage.stickers?.first();
 if(sticker) {
  const safeName = (sticker.name || 'stolen_sticker').toLowerCase().replace(/[^a-z0-9_]/g,'_').slice(0,30) || 'stolen_sticker';
  const tags = (sticker.tags || sticker.name || 'sticker').slice(0,200);
  const created = await guild.stickers.create({ file:sticker.url, name:safeName, tags, reason:'Sticker added using Nexzu /steal' });
  return {ok:true,message:`✅ Added sticker **${created.name}** to this server.`};
 }
 return {ok:false,message:'❌ I could not find a custom emoji or sticker in that message. Unicode emojis cannot be added as server emojis.'};
}

async function handleChatInputCommand(i){
  const c=i.commandName, u=i.user, g=i.guild;
  // All normal text replies become branded embeds. Image/card replies remain untouched.
  const _reply=i.reply?.bind(i), _followUp=i.followUp?.bind(i), _editReply=i.editReply?.bind(i);
  if (_reply) i.reply=(payload)=>_reply(nexzuCommandPayload(payload,c));
  if (_followUp) i.followUp=(payload)=>_followUp(nexzuCommandPayload(payload,c));
  if (_editReply) i.editReply=(payload)=>_editReply(nexzuCommandPayload(payload,c));
  const isTrustedOwner = u.id === TRUSTED_OWNER_ID;
  const isGuildOwner = g && u.id === g.ownerId;
  const target=i.options.getUser('user', false);
  if(c==='levelup-setup') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !isTrustedOwner && !isGuildOwner) return i.reply({content:'⛔ You need Manage Server permission.',flags:MessageFlags.Ephemeral});
   const channel=i.options.getChannel('channel');
   const message=i.options.getString('message');
   if(channel) db.prepare("INSERT INTO chilly_config(guild,key,value) VALUES(?, 'levelup_channel', ?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value").run(g.id,channel.id);
   if(message) db.prepare("INSERT INTO chilly_config(guild,key,value) VALUES(?, 'levelup_message', ?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value").run(g.id,message);
   if(!channel&&!message) return i.reply({content:'ℹ️ Provide a channel and/or message to update the level-up setup. Use `{user}`, `{level}`, and `{xp}` in the message.',flags:MessageFlags.Ephemeral});
   return i.reply({content:`✅ Level-up setup updated.${channel?`
Channel: ${channel}`:''}${message?`
Message: ${message}`:''}`,flags:MessageFlags.Ephemeral});
  }
  if(c==='levelrole') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageRoles) && !isTrustedOwner && !isGuildOwner) return i.reply({content:'⛔ You need Manage Roles permission.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand();
   if(sub==='add') {
    const level=i.options.getInteger('level',true), role=i.options.getRole('role',true);
    if(role.id===g.id||role.managed||role.position>=g.members.me.roles.highest.position) return i.reply({content:'❌ I cannot assign that role. Move Nexzu’s highest role above the reward role.',flags:MessageFlags.Ephemeral});
    db.prepare('INSERT INTO leveling_rewards(guild,level,role) VALUES(?,?,?) ON CONFLICT(guild,level) DO UPDATE SET role=excluded.role').run(g.id,level,role.id);
    return i.reply({content:`✅ ${role} will be awarded when a member reaches **Level ${level}**.`,flags:MessageFlags.Ephemeral});
   }
   if(sub==='remove') { const level=i.options.getInteger('level',true); const r=db.prepare('DELETE FROM leveling_rewards WHERE guild=? AND level=?').run(g.id,level); return i.reply({content:r.changes?`✅ Removed the Level ${level} reward.`:'No reward was configured for that level.',flags:MessageFlags.Ephemeral}); }
   const rows=db.prepare('SELECT level,role FROM leveling_rewards WHERE guild=? ORDER BY level').all(g.id);
   return i.reply({content:rows.length?rows.map(r=>`**Level ${r.level}:** <@&${r.role}>`).join('\n'):'No level rewards configured yet.',flags:MessageFlags.Ephemeral});
  }
  if(c==='level') {
   const member=i.options.getUser('member')||u, row=getLevelRow(g.id,member.id), info=levelFromXp(row.xp);
   const rank=db.prepare('SELECT COUNT(*)+1 AS rank FROM leveling_xp WHERE guild=? AND xp>?').get(g.id,row.xp).rank;
   const embed=chillyStyledEmbed({title:`${CHILLY_EMOJI.level} ${member.username} • Level ${info.level}`,description:`${CHILLY_EMOJI.level} **XP:** ${row.xp.toLocaleString()} total\n${CHILLY_EMOJI.dot} **Progress:** ${info.progress} / ${info.required} XP\n${CHILLY_EMOJI.crown} **Server Rank:** #${rank}`,footer:'Nexzu • Leveling'}).setThumbnail(member.displayAvatarURL());
   return i.reply({embeds:[embed]});
  }
  if(c==='level-leaderboard') {
   const rows=db.prepare('SELECT user,xp FROM leveling_xp WHERE guild=? ORDER BY xp DESC LIMIT 10').all(g.id);
   if(!rows.length) return i.reply({content:'No one has earned XP yet.',flags:MessageFlags.Ephemeral});
   const lines=rows.map((r,index)=>{const lv=levelFromXp(r.xp).level;return `**${index+1}.** <@${r.user}> — Level **${lv}** (${r.xp.toLocaleString()} XP)`;});
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.crown} Level Leaderboard`,description:lines.map(x=>`${CHILLY_EMOJI.dot} ${x}`).join('\n'),footer:'Nexzu • Leveling'})]});
  }
  if(c==='servericon') {
   const raw=i.options.getString('invite',true).trim();
   const match=raw.match(/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([A-Za-z0-9-]+)/i) || (/^[A-Za-z0-9-]+$/.test(raw)?[raw,raw]:null);
   if(!match) return i.reply({content:'Please provide a valid Discord invite link or invite code.',flags:MessageFlags.Ephemeral});
   await i.deferReply();
   try {
    const code=match[1];
    const metaRes=await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`);
    if(!metaRes.ok) return i.editReply('❌ I could not read that invite. It may be invalid, expired, or unavailable.');
    const meta=await metaRes.json();
    if(!meta.guild?.id || !meta.guild?.icon) return i.editReply('❌ This invite did not provide a server icon.');
    const hash=meta.guild.icon;
    const ext=hash.startsWith('a_')?'gif':'png';
    const iconUrl=`https://cdn.discordapp.com/icons/${meta.guild.id}/${hash}.${ext}?size=1024`;
    const iconRes=await fetch(iconUrl);
    if(!iconRes.ok) return i.editReply('❌ I found the server, but could not download its icon.');
    const file=new AttachmentBuilder(Buffer.from(await iconRes.arrayBuffer()),{name:`${meta.guild.id}-icon.${ext}`});
    const embed=chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} ${meta.guild.name||'Server Icon'}`,description:`${CHILLY_EMOJI.dot} **Server ID:** \`${meta.guild.id}\`\n${CHILLY_EMOJI.code} **Icon Hash:** \`${hash}\``,thumbnail:false,footer:'Nexzu • Utility'}).setImage(`attachment://${meta.guild.id}-icon.${ext}`);
    return i.editReply({embeds:[embed],files:[file]});
   } catch(error) { console.error('/servericon failed:',error); return i.editReply('❌ Something went wrong while fetching that server icon.'); }
  }
  if(!g&&!['ping','help'].includes(c)) return i.reply({content:'Use this command in a server.',flags:MessageFlags.Ephemeral});
  if(c==='steal') {
   if(!g) return i.reply({content:'Use /steal inside a server.',flags:MessageFlags.Ephemeral});
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageEmojisAndStickers) && !isTrustedOwner && u.id!==g.ownerId) return i.reply({content:'⛔ You need Manage Expressions permission to use /steal.',flags:MessageFlags.Ephemeral});
   const messageId=i.options.getString('message_id',true).trim();
   if(!/^\d{17,20}$/.test(messageId)) return i.reply({content:'Please provide a valid Discord message ID.',flags:MessageFlags.Ephemeral});
   await i.deferReply({flags:MessageFlags.Ephemeral});
   try { const source=await i.channel.messages.fetch(messageId); const result=await stealFromSourceMessage(g,source); return i.editReply(result.message); }
   catch(error) { console.error('/steal failed:',error); return i.editReply('❌ I could not fetch or add that emoji/sticker. Make sure the message is in this channel and I have Read Message History and Manage Expressions permissions. The server may also have reached its emoji/sticker limit.'); }
  }
  const hasAdminAccess = isTrustedOwner || isGuildOwner || !!i.memberPermissions?.has(PermissionFlagsBits.Administrator) || !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const moderationPermissions = {
   warn: PermissionFlagsBits.ModerateMembers,
   warnings: PermissionFlagsBits.ModerateMembers,
   clear: PermissionFlagsBits.ManageMessages,
   clearwarns: PermissionFlagsBits.ModerateMembers,
   timeout: PermissionFlagsBits.ModerateMembers,
   untimeout: PermissionFlagsBits.ModerateMembers,
   mute: PermissionFlagsBits.ModerateMembers,
   kick: PermissionFlagsBits.KickMembers,
   ban: PermissionFlagsBits.BanMembers,
   unban: PermissionFlagsBits.BanMembers,
   unbanall: PermissionFlagsBits.BanMembers,
   autorole: PermissionFlagsBits.ManageRoles,
   clone: PermissionFlagsBits.ManageChannels,
   hide: PermissionFlagsBits.ManageChannels,
   hideall: PermissionFlagsBits.ManageChannels,
   lock: PermissionFlagsBits.ManageChannels,
   lockall: PermissionFlagsBits.ManageChannels,
   nuke: PermissionFlagsBits.ManageChannels,
   purge: PermissionFlagsBits.ManageMessages,
   roleall: PermissionFlagsBits.ManageRoles,
   role: PermissionFlagsBits.ManageRoles,
   slowmode: PermissionFlagsBits.ManageChannels,
   unhide: PermissionFlagsBits.ManageChannels,
   unhideall: PermissionFlagsBits.ManageChannels,
   nick: PermissionFlagsBits.ManageNicknames
  };
  if(moderationPermissions[c] && !isGuildOwner && !i.memberPermissions?.has(PermissionFlagsBits.Administrator) && !i.memberPermissions?.has(moderationPermissions[c])) {
   return i.reply({content:`⛔ You need the appropriate Discord permission to use /${c}.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='say') {
   if(!hasAdminAccess) return i.reply({content:'⛔ /say is limited to the bot owner, server owner, or members with Manage Server / Administrator permission.',flags:MessageFlags.Ephemeral});
   const channel=i.options.getChannel('channel') || i.channel;
   const message=i.options.getString('message');
   if(!channel || !channel.isTextBased() || !channel.send) return i.reply({content:'Please use this command in a text channel or select a text channel.',flags:MessageFlags.Ephemeral});
   const botMember = g.members.me;
   const botPerms = botMember && channel.permissionsFor(botMember);
   if(!botPerms?.has(PermissionFlagsBits.SendMessages)) return i.reply({content:'I cannot send messages in that channel. Check my permissions.',flags:MessageFlags.Ephemeral});
   if(!botPerms.has(PermissionFlagsBits.MentionEveryone)) return i.reply({content:'I need the Mention Everyone permission in that channel to ping @everyone, @here, or non-mentionable roles.',flags:MessageFlags.Ephemeral});
   await channel.send({content:message, allowedMentions:{parse:['everyone','roles','users']}});
   return i.reply({content:'✅ Message sent in '+channel+'.',flags:MessageFlags.Ephemeral});
  }
  if(c==='whitelist') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Whitelist commands are limited to the bot owner, server owner, or members with Manage Server / Administrator permission.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand();
   const viewKinds={view_users:'user',view_channels:'channel',view_roles:'role'};
   if(viewKinds[sub]) {
    const kind=viewKinds[sub];
    const rows=db.prepare('SELECT kind,target FROM whitelist WHERE guild=? AND kind=? ORDER BY created ASC').all(g.id,kind);
    const label={user:'Users',channel:'Channels',role:'Roles'}[kind];
    const list=rows.map(r=>r.kind==='user'?`<@${r.target}> — \`${r.target}\``:r.kind==='role'?`<@&${r.target}> — \`${r.target}\``:`<#${r.target}> — \`${r.target}\``);
    return i.reply({content:`**Whitelist • ${label}**\\n${list.length?list.join('\\n').slice(0,1850):'No entries yet.'}`,flags:MessageFlags.Ephemeral});
   }
   const actions={
    add_user:{kind:'user',action:'add'},add_channel:{kind:'channel',action:'add'},add_role:{kind:'role',action:'add'},
    remove_user:{kind:'user',action:'remove'},remove_channel:{kind:'channel',action:'remove'},remove_role:{kind:'role',action:'remove'}
   };
   const config=actions[sub];
   if(!config) return i.reply({content:'Unknown whitelist action.',flags:MessageFlags.Ephemeral});
   let target;
   if(config.kind==='user') target=i.options.getUser('user',true).id;
   if(config.kind==='channel') target=i.options.getChannel('channel',true).id;
   if(config.kind==='role') target=i.options.getRole('role',true).id;
   if(config.action==='add') {
    const result=db.prepare('INSERT OR IGNORE INTO whitelist (guild,kind,target,added_by,created) VALUES (?,?,?,?,?)').run(g.id,config.kind,target,u.id,Date.now());
    return i.reply({content:result.changes?'✅ Added to whitelist.':'ℹ️ This item is already whitelisted.',flags:MessageFlags.Ephemeral});
   }
   const result=db.prepare('DELETE FROM whitelist WHERE guild=? AND kind=? AND target=?').run(g.id,config.kind,target);
   return i.reply({content:result.changes?'✅ Removed from whitelist.':'ℹ️ This item was not in the whitelist.',flags:MessageFlags.Ephemeral});
  }
  if(c==='money') {
   if(u.id!==g.ownerId) return i.reply({content:'⛔ Only the server owner can use /money.',flags:MessageFlags.Ephemeral});
   const to=i.options.getUser('user');
   const amount=i.options.getInteger('amount');
   if(to.bot) return i.reply({content:'You cannot add coins to a bot.',flags:MessageFlags.Ephemeral});
   account(g.id,to.id);
   db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(amount,to.id);
   const updated=account(g.id,to.id);
   const buffer=await renderEconomyCard({user:to,command:'money',reward:amount,balance:updated.coins,note:'Coins added by the server owner'});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'money.png'})]});
  }
  if(c==='ticket-setup') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'⛔ Only members with Administrator permission can configure tickets.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand();
   if(sub==='add-button') {
    const key=i.options.getString('key').toLowerCase().replace(/[^a-z0-9_-]/g,'-');
    const label=i.options.getString('name'), role=i.options.getRole('staff-role'), log=i.options.getChannel('log-channel'), emoji=i.options.getString('emoji');
    db.prepare('INSERT INTO ticket_buttons(guild,ticket_key,label,emoji,staff_role,log_channel) VALUES(?,?,?,?,?,?) ON CONFLICT(guild,ticket_key) DO UPDATE SET label=excluded.label,emoji=excluded.emoji,staff_role=excluded.staff_role,log_channel=excluded.log_channel').run(g.id,key,label,emoji,role.id,log.id);
    return i.reply({content:`✅ Ticket button **${label}** saved. Key: \`${key}\`
Staff: <@&${role.id}>
Logs: <#${log.id}>`,flags:MessageFlags.Ephemeral});
   }
   if(sub==='remove-button') {
    const key=i.options.getString('key').toLowerCase(); const result=db.prepare('DELETE FROM ticket_buttons WHERE guild=? AND ticket_key=?').run(g.id,key);
    return i.reply({content:result.changes?'✅ Ticket button removed.':'No button found with that key.',flags:MessageFlags.Ephemeral});
   }
   if(sub==='list-buttons') {
    const rows=db.prepare('SELECT * FROM ticket_buttons WHERE guild=? ORDER BY ticket_key').all(g.id);
    return i.reply({content:rows.length?rows.map(x=>`• **${x.label}** (\`${x.ticket_key}\`) — Staff: <@&${x.staff_role}> — Logs: <#${x.log_channel}>`).join('\n'):'No ticket buttons configured yet.',flags:MessageFlags.Ephemeral});
   }
   if(sub==='panel') {
    const buttons=db.prepare('SELECT * FROM ticket_buttons WHERE guild=? ORDER BY ticket_key').all(g.id);
    if(!buttons.length) return i.reply({content:'Add at least one button first using `/ticket-setup add-button`.',flags:MessageFlags.Ephemeral});
    if(buttons.length>25) return i.reply({content:'Discord panels support up to 25 ticket buttons. Remove some buttons first.',flags:MessageFlags.Ephemeral});
    const rows=[];
    for(let n=0;n<buttons.length;n+=5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(n,n+5).map(b=>{const btn=new ButtonBuilder().setCustomId(`chilly_ticket_open:${b.ticket_key}`).setLabel(b.label).setStyle(ButtonStyle.Primary); if(b.emoji) btn.setEmoji(b.emoji); return btn;})));
    const channel=i.options.getChannel('channel');
    await channel.send({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.ticket} ${i.options.getString('title')}`,description:`${CHILLY_EMOJI.dot} ${i.options.getString('description')}`,footer:'Nexzu • Tickets'})],components:rows});
    return i.reply({content:`✅ Ticket panel posted in ${channel} with ${buttons.length} custom button(s).`,flags:MessageFlags.Ephemeral});
   }
  }
  if(c==='welcome-setup') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server required.',flags:MessageFlags.Ephemeral});
   for(const [k,v] of Object.entries({welcome_channel:i.options.getChannel('channel').id,welcome_message:i.options.getString('message')})) db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(g.id,k,v);
   return i.reply({content:'✅ Welcome message configured for this server.',flags:MessageFlags.Ephemeral});
  }
  if(c==='jail'||c==='unjail') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) && !isGuildOwner && !isTrustedOwner && !i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'⛔ Moderate Members permission required.',flags:MessageFlags.Ephemeral});
   const user=i.options.getUser('user'), member=await g.members.fetch(user.id).catch(()=>null), roleId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(g.id,'jail_role')?.value;
   if(!member||!roleId) return i.reply({content:'Set a jail role first with /jailsetup.',flags:MessageFlags.Ephemeral});
   const role=g.roles.cache.get(roleId); if(!role) return i.reply({content:'Saved jail role no longer exists. Run /jailsetup again.',flags:MessageFlags.Ephemeral});
   if(c==='jail') { await member.roles.add(role, i.options.getString('reason')||'Jailed by moderator'); return i.reply('🔒 '+user.tag+' has been jailed.'); }
   await member.roles.remove(role,'Released from jail'); return i.reply('🔓 '+user.tag+' has been released.');
  }
  if(c==='afk') {
   const reason=i.options.getString('reason',false);
   const row=db.prepare('SELECT * FROM afk_status WHERE guild=? AND user=?').get(g.id,u.id);
   if(!reason && row) { db.prepare('DELETE FROM afk_status WHERE guild=? AND user=?').run(g.id,u.id); return i.reply(`${CHILLY_EMOJI.success} Your AFK status has been removed.`); }
   if(!reason && !row) return i.reply({content:'Provide a reason to set AFK, or use the command again after setting AFK to remove it.',flags:MessageFlags.Ephemeral});
   db.prepare('INSERT INTO afk_status(guild,user,reason,created) VALUES(?,?,?,?) ON CONFLICT(guild,user) DO UPDATE SET reason=excluded.reason,created=excluded.created').run(g.id,u.id,reason,Date.now());
   return i.reply(`${CHILLY_EMOJI.success} You are now AFK: **${reason}**`);
  }
  if(c==='banner') {
   const member=i.options.getUser('user',false)||u; const full=await client.users.fetch(member.id,{force:true}).catch(()=>member); const url=full.bannerURL?.({size:4096})||null;
   if(!url) return i.reply({content:`${CHILLY_EMOJI.rejected} ${full.username} does not have a profile banner.`,flags:MessageFlags.Ephemeral});
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.member} ${full.username}'s Banner`,description:`[Open Banner](${url})`,thumbnail:false}).setImage(url)]});
  }
  if(c==='devices') {
   const member=i.options.getUser('user',false)||u; const m=await g.members.fetch(member.id).catch(()=>null); const acts=m?.presence?.activities||[];
   const desc=acts.length?acts.map(a=>`• **${a.name}**${a.state?` — ${a.state}`:''}`).join('\n'):'No active Discord activity detected.';
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} ${member.username}'s Activity`,description:desc})]});
  }
  if(c==='inviteinfo') {
   const raw=i.options.getString('invite',true).trim(); const match=raw.match(/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)?([A-Za-z0-9-]+)/i); const code=match?.[1];
   if(!code) return i.reply({content:'Please provide a valid Discord invite link or code.',flags:MessageFlags.Ephemeral});
   const inv=await client.fetchInvite(code,{withCounts:true}).catch(()=>null); if(!inv) return i.reply({content:`${CHILLY_EMOJI.rejected} Invalid or unavailable invite.`,flags:MessageFlags.Ephemeral});
   const desc=[`**Server:** ${inv.guild?.name||'Unknown'}`,`**Invite:** ${inv.code}`,`**Members:** ${inv.memberCount??'Unknown'}`,`**Online:** ${inv.presenceCount??'Unknown'}`,`**Channel:** ${inv.channel?.name?`#${inv.channel.name}`:'Unknown'}`].join('\n');
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} Invite Information`,description:desc})]});
  }
  if(c==='list') {
   const sub=i.options.getSubcommand(false)||'members'; let members=[...g.members.cache.values()];
   if(sub==='admins') members=members.filter(m=>m.permissions.has(PermissionFlagsBits.Administrator));
   else if(sub==='boosters') members=members.filter(m=>!!m.premiumSince);
   else if(sub==='bots') members=members.filter(m=>m.user.bot);
   else if(sub==='early') members=members.filter(m=>m.user.flags?.has?.('EarlySupporter'));
   else if(sub==='emojis') { const em=[...g.emojis.cache.values()]; return i.reply({embeds:[chillyStyledEmbed({title:'😀 Server Emojis',description:em.length?em.map(e=>String(e)+' '+e.name).join('\n').slice(0,4000):'No server emojis.'})]}); }
   else if(sub==='inrole') { const role=i.options.getRole('role',true); members=members.filter(m=>m.roles.cache.has(role.id)); }
   const shown=members.slice(0,50).map(m=>`• ${m} — ${m.user.tag}`).join('\n')||'No matching members.';
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} List ${sub}`,description:shown+(members.length>50?`\n\n…and ${members.length-50} more.`:'' )})]});
  }
  if(c==='fakeperms') {
   const role=i.options.getRole('role',true), perm=i.options.getString('permission',false)||'ViewChannel';
   return i.reply({embeds:[chillyStyledEmbed({title:'@ fakeperms',description:`Role: ${role}\nPermission preview: ${perm}\n\nThis command is a safe preview; Discord permissions are not actually modified.`})]});
  }
  if(c==='jailsetup') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageRoles) && !isGuildOwner && !isTrustedOwner) return i.reply({content:'⛔ Manage Roles permission required.',flags:MessageFlags.Ephemeral});
   const role=i.options.getRole('role',true); db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(g.id,'jail_role',role.id); return i.reply(`${CHILLY_EMOJI.success} Jail role set to ${role}.`);
  }
  if(c==='jailsync') {
   const roleId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(g.id,'jail_role')?.value; if(!roleId) return i.reply({content:'Set the jail role first with /jailsetup.',flags:MessageFlags.Ephemeral});
   const role=g.roles.cache.get(roleId); if(!role) return i.reply({content:'Saved jail role no longer exists. Run /jailsetup again.',flags:MessageFlags.Ephemeral}); return i.reply(`${CHILLY_EMOJI.success} Jail system synchronized. Configured role: ${role}.`);
  }
  if(c==='permit') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageRoles) && !i.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) && !isGuildOwner && !isTrustedOwner) return i.reply({content:'⛔ Manage Roles or Moderate Members permission required.',flags:MessageFlags.Ephemeral});
   const action=i.options.getString('action',true), role=i.options.getRole('role',true), key='jail_permit_role'; const current=(db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(g.id,key)?.value||'').split(',').filter(Boolean); const set=new Set(current); action==='add'?set.add(role.id):set.delete(role.id);
   db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(g.id,key,[...set].join(',')); return i.reply(`${CHILLY_EMOJI.success} ${action==='add'?'Added':'Removed'} ${role} ${action==='add'?'as':'from'} permitted jail staff.`);
  }
  if(c==='pjail') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) && !isGuildOwner && !isTrustedOwner) return i.reply({content:'⛔ Moderate Members permission required.',flags:MessageFlags.Ephemeral});
   const user=i.options.getUser('user',true), target=await g.members.fetch(user.id).catch(()=>null), roleId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(g.id,'jail_role')?.value;
   if(!target||!roleId) return i.reply({content:'Set a jail role first with /jailsetup.',flags:MessageFlags.Ephemeral}); const role=g.roles.cache.get(roleId); if(!role) return i.reply({content:'Saved jail role no longer exists. Run /jailsetup again.',flags:MessageFlags.Ephemeral});
   await target.roles.add(role,i.options.getString('reason',false)||'Permanently jailed'); return i.reply(`🔒 ${user.tag} has been permanently jailed.`);
  }
  if(c==='ticket') {
   const sub=i.options.getSubcommand(); const topic=i.channel?.topic||''; const match=topic.match(/^chilly-ticket:(\d+):([^:]+):(\d+):?(\d*)$/);
   if(sub==='claim') { if(!match) return i.reply({content:'This channel is not a Nexzu ticket.',flags:MessageFlags.Ephemeral}); const [,opener,key,role,claimer]=match; if(claimer) return i.reply({content:`Already claimed by <@${claimer}>.`,flags:MessageFlags.Ephemeral}); if(!i.member.roles.cache.has(role)&&!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'Only assigned ticket staff can claim this ticket.',flags:MessageFlags.Ephemeral}); await i.channel.setTopic(`chilly-ticket:${opener}:${key}:${role}:${u.id}`); return i.reply(`Ticket claimed by ${u}.`); }
   if(sub==='close') { if(!match||!match[5]) return i.reply({content:'This is not a claimed Nexzu ticket.',flags:MessageFlags.Ephemeral}); if(match[5]!==u.id&&!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'Only the claiming staff member or an Administrator can close it.',flags:MessageFlags.Ephemeral}); await i.channel.permissionOverwrites.edit(match[1],{SendMessages:false}).catch(()=>{}); return i.reply('🔒 Ticket closed and locked.'); }
   if(sub==='delete') { if(!match&&!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'Only an Administrator can delete a non-ticket channel.',flags:MessageFlags.Ephemeral}); await i.reply('🗑️ Deleting ticket…').catch(()=>{}); return i.channel.delete('Ticket deleted by command').catch(()=>{}); }
   if(sub==='rename') { if(!match) return i.reply({content:'This channel is not a Nexzu ticket.',flags:MessageFlags.Ephemeral}); const name=i.options.getString('new_name',true).trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,90); if(!name) return i.reply({content:'Invalid channel name.',flags:MessageFlags.Ephemeral}); await i.channel.setName(name); return i.reply(`${CHILLY_EMOJI.success} Ticket renamed to **${name}**.`); }
   if(['config','panel','send','setup','edit'].includes(sub)) { const rows=db.prepare('SELECT * FROM ticket_buttons WHERE guild=? ORDER BY ticket_key').all(g.id); const desc=rows.length?rows.map(x=>`• **${x.label}** — key \`${x.ticket_key}\` — Staff <@&${x.staff_role}> — Logs <#${x.log_channel}>`).join('\n'):'No ticket buttons configured.'; return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.ticket} Ticket Manager`,description:`${desc}\n\nUse **/ticket-setup** to create/edit panels and buttons.`})],flags:MessageFlags.Ephemeral}); }
  }
  if(c==='ping') {
   const dbStarted=process.hrtime.bigint();
   db.prepare('SELECT 1').get();
   const dbLatency=Number(process.hrtime.bigint()-dbStarted)/1e6;
   const apiLatency=Math.max(0,Date.now()-(i.createdTimestamp||Date.now()));
   const wsLatency=Math.max(0,client.ws.ping);
   const embed=chillyStyledEmbed({title:'Ping',description:'',thumbnail:true,timestamp:false,footer:'Powered by Spidyyy'})
    .addFields(
     {name:'API Latency',value:`\`${apiLatency.toFixed(0)}ms\``,inline:false},
     {name:'Database Latency',value:`\`${dbLatency.toFixed(2)}ms\``,inline:false},
     {name:'WebSocket Latency',value:`\`${wsLatency}ms\``,inline:false}
    );
   return i.reply({embeds:[embed]});
  }
  if(c==='help') return i.reply(chillyHelpPayload());
  if(c==='balance') {
   const who=target||u, a=account(g.id,who.id);
   const buffer=await renderEconomyCard({user:who,command:'balance',balance:a.coins,note:`Rank #${economyRank(who.id)} on the global Nexzu economy`});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'balance.png'})]});
  }
  if(c==='slots') {
   const bet=i.options.getInteger('bet'), a=account(g.id,u.id);
   if(a.coins<bet) return i.reply({content:'Not enough NexBits for that bet.',flags:MessageFlags.Ephemeral});
   const symbols=['🍒','🍋','🍇','⭐','🔔']; const roll=[0,1,2].map(()=>symbols[Math.floor(Math.random()*symbols.length)]);
   let multiplier=roll[0]===roll[1]&&roll[1]===roll[2]? (roll[0]==='⭐'?5:3) : (roll[0]===roll[1]||roll[1]===roll[2]||roll[0]===roll[2]?1:0);
   const delta=multiplier?bet*multiplier:-bet;
   db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(delta,u.id);
   const updated=account(g.id,u.id), win=multiplier?bet*multiplier:0;
   const buffer=await renderEconomyCard({user:u,command:'slots',balance:updated.coins,reward:win||bet,note:roll.join(' | ')});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'slots.png'})]});
  }
  if(c==='daily'||c==='work') {
   const a=account(g.id,u.id), now=Math.floor(Date.now()/1000);
   const col=c==='daily'?'daily':'worked', cd=c==='daily'?86400:3600;
   const amount=c==='daily'?500:Math.floor(Math.random()*201)+100;
   if(now-a[col]<cd) {
    const next=now+(cd-(now-a[col]));
    const buffer=await renderEconomyCard({user:u,command:c,reward:0,balance:a.coins,nextClaim:next,note:'Cooldown active'});
    return i.reply({files:[new AttachmentBuilder(buffer,{name:c+'-cooldown.png'})],flags:MessageFlags.Ephemeral});
   }
   db.prepare('UPDATE global_users SET coins=coins+?, '+col+'=? WHERE user=?').run(amount,now,u.id);
   const updated=account(g.id,u.id);
   const buffer=await renderEconomyCard({user:u,command:c,reward:amount,balance:updated.coins,nextClaim:now+cd});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:c+'-economy.png'})]});
  }
  if(c==='pay') {
   const to=i.options.getUser('user'), amount=i.options.getInteger('amount');
   if(to.bot||to.id===u.id) return i.reply({content:'Choose another non-bot member.',flags:MessageFlags.Ephemeral});
   const a=account(g.id,u.id); account(g.id,to.id);
   if(a.coins<amount) return i.reply({content:'Not enough coins.',flags:MessageFlags.Ephemeral});
   db.transaction(()=>{
    db.prepare('UPDATE global_users SET coins=coins-? WHERE user=?').run(amount,u.id);
    db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(amount,to.id);
   })();
   const updated=account(g.id,u.id);
   const buffer=await renderEconomyCard({user:u,command:'pay',reward:amount,balance:updated.coins,opponent:to,note:`Transfer completed to ${to.username}`});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'pay.png'})]});
  }
  if(c==='leaderboard') {
   const rows=db.prepare('SELECT user,coins FROM global_users ORDER BY coins DESC, user ASC LIMIT 10').all();
   const buffer=await renderEconomyCard({user:u,command:'leaderboard',balance:account(g.id,u.id).coins,note:(rows.some(r=>r.user===u.id)?`You are #${rows.findIndex(r=>r.user===u.id)+1} in the top 10`:`Your current rank is #${economyRank(u.id)}`)});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'leaderboard.png'})]});
  }
  if(c==='shop') {
   const buffer=await renderEconomyCard({user:u,command:'shop',balance:account(g.id,u.id).coins,note:'Cookie 100 • Coffee 250 • Golden Crown 1000'});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'shop.png'})]});
  }
  if(c==='buy') {
   const item=i.options.getString('item'), price={'Cookie':100,'Coffee':250,'Golden Crown':1000}[item], a=account(g.id,u.id);
   if(a.coins<price) return i.reply({content:'Not enough coins.',flags:MessageFlags.Ephemeral});
   db.transaction(()=>{
    db.prepare('UPDATE global_users SET coins=coins-? WHERE user=?').run(price,u.id);
    db.prepare('INSERT INTO global_inventory(user,item,quantity) VALUES(?,?,1) ON CONFLICT(user,item) DO UPDATE SET quantity=quantity+1').run(u.id,item);
   })();
   const updated=account(g.id,u.id);
   const buffer=await renderEconomyCard({user:u,command:'buy',reward:price,balance:updated.coins,note:item});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'buy.png'})]});
  }
  if(c==='inventory') {
   const who=target||u, rows=db.prepare('SELECT item,quantity FROM global_inventory WHERE user=?').all(who.id);
   const buffer=await renderEconomyCard({user:who,command:'inventory',balance:account(g.id,who.id).coins,note:rows.map(x=>x.item+' × '+x.quantity).join(' • ')||'Inventory is empty'});
   return i.reply({files:[new AttachmentBuilder(buffer,{name:'inventory.png'})]});
  }
  if(c==='setlogs') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({content:'You need Manage Server permission to set the log channel.',flags:MessageFlags.Ephemeral});
   }
   const channel=i.options.getChannel('channel');
   if(!channel || !channel.isTextBased()) {
    return i.reply({content:'Please select a text channel.',flags:MessageFlags.Ephemeral});
   }
   const botPerms=channel.permissionsFor(client.user);
   if(!botPerms?.has(PermissionFlagsBits.ViewChannel) || !botPerms?.has(PermissionFlagsBits.SendMessages) || !botPerms?.has(PermissionFlagsBits.EmbedLinks)) {
    return i.reply({content:'I need View Channel, Send Messages, and Embed Links permissions in that channel.',flags:MessageFlags.Ephemeral});
   }
   settings(g.id);
   db.prepare('UPDATE guild_settings SET log_channel=? WHERE guild=?').run(channel.id,g.id);
   return i.reply({content:'✅ Moderation and server logs will be sent to '+channel+'.',flags:MessageFlags.Ephemeral});
  }
  if(c==='antinuke') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({content:'You need Manage Server permission to configure AntiNuke.',flags:MessageFlags.Ephemeral});
   db.prepare('INSERT OR IGNORE INTO antinuke_config(guild) VALUES(?)').run(g.id);
   const row=db.prepare('SELECT * FROM antinuke_config WHERE guild=?').get(g.id), sub=i.options.getSubcommand();
   const json=(v)=>{try{return JSON.parse(v||'{}')}catch{return {}}};
   if(sub==='config') { const setting=i.options.getString('setting'), value=i.options.getString('value'), channel=i.options.getChannel('channel'); const cfg=json(row.config); cfg[setting]=channel?channel.id:value; const enabled=/^(on|enable|enabled|true)$/i.test(value); db.prepare('UPDATE antinuke_config SET enabled=?,config=? WHERE guild=?').run((setting.toLowerCase()==='enabled'||setting.toLowerCase()==='state')?(enabled?1:0):row.enabled,JSON.stringify(cfg),g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🛡️ AntiNuke',description:`**${setting}** → **${channel||value}**\nAntiNuke configuration updated.`,footer:'Nexzu • AntiNuke'})]}); }
   if(sub==='limit') { const event=i.options.getString('event_or_amount'), amount=i.options.getInteger('amount'); const limits=json(row.limits); limits[event]=amount; db.prepare('UPDATE antinuke_config SET limits=? WHERE guild=?').run(JSON.stringify(limits),g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🛡️ AntiNuke Limit',description:`**${event}** limit is now **${amount}**.`,footer:'Nexzu • AntiNuke'})]}); }
   if(sub==='punishment') { const event=i.options.getString('event_or_punishment'), punishment=i.options.getString('punishment'); const ps=json(row.punishments); ps[event]=punishment; db.prepare('UPDATE antinuke_config SET punishments=? WHERE guild=?').run(JSON.stringify(ps),g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🛡️ AntiNuke Punishment',description:`**${event}** → **${punishment}**`,footer:'Nexzu • AntiNuke'})]}); }
   db.prepare("UPDATE antinuke_config SET enabled=0,config='{}',limits='{}',punishments='{}' WHERE guild=?").run(g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🛡️ AntiNuke Reset',description:'AntiNuke settings have been reset to their defaults.',footer:'Nexzu • AntiNuke'})]});
  }
  if(c==='mainrole') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({content:'You need Manage Server permission to manage AntiNuke main roles.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand();
   if(sub==='add') { const role=i.options.getRole('role'); const r=db.prepare('INSERT OR IGNORE INTO antinuke_mainroles(guild,role) VALUES(?,?)').run(g.id,role.id); return i.reply({content:r.changes?`✅ Registered ${role} as an AntiNuke main role.`:'ℹ️ That role is already registered.',flags:MessageFlags.Ephemeral}); }
   if(sub==='remove') { const role=i.options.getRole('role'); const r=db.prepare('DELETE FROM antinuke_mainroles WHERE guild=? AND role=?').run(g.id,role.id); return i.reply({content:r.changes?`✅ Removed ${role} from AntiNuke main roles.`:'ℹ️ That role is not registered.',flags:MessageFlags.Ephemeral}); }
   if(sub==='reset') { db.prepare('DELETE FROM antinuke_mainroles WHERE guild=?').run(g.id); return i.reply({content:'✅ All AntiNuke main roles were removed.',flags:MessageFlags.Ephemeral}); }
   const rows=db.prepare('SELECT role FROM antinuke_mainroles WHERE guild=? ORDER BY role').all(g.id); return i.reply({content:`**AntiNuke Main Roles**\n${rows.length?rows.map((r,n)=>`${n+1}. <@&${r.role}>`).join('\n'):'No main roles registered.'}`,flags:MessageFlags.Ephemeral});
  }
  if(c==='antibot') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({content:'You need Manage Server permission to configure AntiBot.',flags:MessageFlags.Ephemeral});
   db.prepare('INSERT OR IGNORE INTO antibot_config(guild) VALUES(?)').run(g.id); const sub=i.options.getSubcommand();
   if(sub==='config') { const enabled=i.options.getBoolean('enabled'); if(enabled!==null) db.prepare('UPDATE antibot_config SET enabled=? WHERE guild=?').run(enabled?1:0,g.id); const row=db.prepare('SELECT enabled FROM antibot_config WHERE guild=?').get(g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🤖 AntiBot',description:`Status: **${row.enabled?'Enabled':'Disabled'}**`,footer:'Nexzu • AntiBot'})]}); }
   if(sub==='add'||sub==='remove') { const bot=i.options.getUser('bot_user'); const r=sub==='add'?db.prepare('INSERT OR IGNORE INTO antibot_whitelist(guild,user) VALUES(?,?)').run(g.id,bot.id):db.prepare('DELETE FROM antibot_whitelist WHERE guild=? AND user=?').run(g.id,bot.id); return i.reply({content:r.changes?(sub==='add'?`✅ Added ${bot} to AntiBot whitelist.`:`✅ Removed ${bot} from AntiBot whitelist.`):'ℹ️ No change was needed.',flags:MessageFlags.Ephemeral}); }
   if(sub==='reset') { db.prepare('UPDATE antibot_config SET enabled=1 WHERE guild=?').run(g.id); db.prepare('DELETE FROM antibot_whitelist WHERE guild=?').run(g.id); return i.reply({content:'✅ AntiBot configuration and whitelist reset.',flags:MessageFlags.Ephemeral}); }
   const action=(i.options.getString('action')||'list').toLowerCase(), bot=i.options.getUser('bot_user'); if(action==='add'&&bot) db.prepare('INSERT OR IGNORE INTO antibot_whitelist(guild,user) VALUES(?,?)').run(g.id,bot.id); else if(action==='remove'&&bot) db.prepare('DELETE FROM antibot_whitelist WHERE guild=? AND user=?').run(g.id,bot.id); const rows=db.prepare('SELECT user FROM antibot_whitelist WHERE guild=?').all(g.id); return i.reply({content:`**AntiBot Whitelist**\n${rows.length?rows.map((r,n)=>`${n+1}. <@${r.user}>`).join('\n'):'No whitelisted bots.'}`,flags:MessageFlags.Ephemeral});
  }
  if(c==='automod') {
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({content:'You need Manage Server permission to configure AutoMod.',flags:MessageFlags.Ephemeral});
   db.prepare('INSERT OR IGNORE INTO automod_config(guild) VALUES(?)').run(g.id); const sub=i.options.getSubcommand();
   if(sub==='enable'||sub==='disable') { db.prepare('UPDATE automod_config SET enabled=? WHERE guild=?').run(sub==='enable'?1:0,g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🤖 AutoMod',description:`AutoMod is now **${sub==='enable'?'Enabled':'Disabled'}**.`,footer:'Nexzu • AutoMod'})]}); }
   if(sub==='config') { const row=db.prepare('SELECT * FROM automod_config WHERE guild=?').get(g.id); return i.reply({embeds:[chillyStyledEmbed({title:'🤖 AutoMod Configuration',description:`Status: **${row.enabled?'Enabled':'Disabled'}**\nLogging: ${row.logging_channel?`<#${row.logging_channel}>`:'Not set'}\nPunishment: **${row.punishment}**`,footer:'Nexzu • AutoMod'})]}); }
   if(sub==='logging') { const ch=i.options.getChannel('channel'); db.prepare('UPDATE automod_config SET logging_channel=? WHERE guild=?').run(ch.id,g.id); return i.reply({content:`✅ AutoMod logging channel set to ${ch}.`,flags:MessageFlags.Ephemeral}); }
   if(sub==='punishment') { const punishment=i.options.getString('punishment'); db.prepare('UPDATE automod_config SET punishment=? WHERE guild=?').run(punishment,g.id); return i.reply({content:`✅ AutoMod punishment set to **${punishment}**.`,flags:MessageFlags.Ephemeral}); }
   if(sub==='ignore'||sub==='unignore') { const action=i.options.getString('action')||i.options.getString('kind')||'show', ch=i.options.getChannel('channel'), role=i.options.getRole('role'), kind=action.includes('role')?'role':'channel', target=kind==='role'?role?.id:ch?.id; if(action==='reset'){db.prepare('DELETE FROM automod_ignore WHERE guild=?').run(g.id);return i.reply({content:'✅ AutoMod ignored channels and roles reset.',flags:MessageFlags.Ephemeral});} if(action==='show'){const rows=db.prepare('SELECT kind,target FROM automod_ignore WHERE guild=?').all(g.id);return i.reply({content:`**AutoMod Ignored Targets**\n${rows.length?rows.map((r,n)=>`${n+1}. ${r.kind==='role'?`<@&${r.target}>`:`<#${r.target}>`}`).join('\n'):'None'}`,flags:MessageFlags.Ephemeral});} if(!target)return i.reply({content:'Select the channel/role to configure.',flags:MessageFlags.Ephemeral}); if(sub==='ignore')db.prepare('INSERT OR IGNORE INTO automod_ignore(guild,kind,target) VALUES(?,?,?)').run(g.id,kind,target);else db.prepare('DELETE FROM automod_ignore WHERE guild=? AND kind=? AND target=?').run(g.id,kind,target); return i.reply({content:sub==='ignore'?`✅ Ignoring this ${kind} for AutoMod.`:`✅ AutoMod will no longer ignore this ${kind}.`,flags:MessageFlags.Ephemeral}); }
  }
  if(c==='autorole' || c==='auto-role') {
   if(!g) return i.reply({content:'Use this command inside a server.',flags:MessageFlags.Ephemeral});
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageRoles) && !isGuildOwner && !isTrustedOwner && !i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'⛔ Manage Roles permission required.',flags:MessageFlags.Ephemeral});
   const role=i.options.getRole('role',true);
   if(role.id===g.id || role.managed || role.position>=g.members.me.roles.highest.position) return i.reply({content:'⛔ Move my bot role above the selected role and choose a normal role.',flags:MessageFlags.Ephemeral});
   db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(g.id,'autorole',role.id);
   return i.reply({content:`${CHILLY_EMOJI.success} New members will automatically receive ${role}.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='clearwarns') {
   const to=i.options.getUser('user',true), result=db.prepare('DELETE FROM warnings WHERE guild=? AND user=?').run(g.id,to.id);
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.success} Warnings Cleared`,description:`Cleared **${result.changes}** warning(s) for <@${to.id}>.`,footer:'Nexzu • Moderation'})]});
  }
  if(c==='clone' || c==='nuke') {
   if(!i.channel?.isTextBased() || !i.channel.clone) return i.reply({content:'This command can only be used in a text channel.',flags:MessageFlags.Ephemeral});
   await i.deferReply({flags:MessageFlags.Ephemeral});
   const oldChannel=i.channel, cloned=await oldChannel.clone({reason:c==='clone'?'Channel cloned by Nexzu':'Channel nuked by Nexzu'});
   await cloned.setPosition(oldChannel.position).catch(()=>{});
   if(c==='nuke') await oldChannel.delete('Channel nuked by Nexzu').catch(()=>{});
   return i.editReply(`${CHILLY_EMOJI.success} ${c==='nuke'?'Channel nuked and recreated':'Channel cloned'}: ${cloned}.`);
  }
  if(c==='enlarge') {
   const raw=i.options.getString('emoji',true).trim(), match=raw.match(/^<a?:([A-Za-z0-9_~]+):(\d{15,22})>$/);
   if(!match) return i.reply({content:'Please provide a valid custom emoji like `<:name:id>`.',flags:MessageFlags.Ephemeral});
   const animated=raw.startsWith('<a:'), url=`https://cdn.discordapp.com/emojis/${match[2]}.${animated?'gif':'png'}?size=4096`;
   return i.reply({embeds:[chillyStyledEmbed({title:'🔍 Enlarged Emoji',description:`${match[1]}`,footer:'Nexzu • Utility'}).setImage(url)]});
  }
  if(c==='hide' || c==='unhide') {
   const channel=i.options.getChannel('channel')||i.channel;
   if(!channel?.permissionOverwrites) return i.reply({content:'Please use this in or select a text channel.',flags:MessageFlags.Ephemeral});
   await channel.permissionOverwrites.edit(g.roles.everyone,{ViewChannel:c==='unhide'?true:false});
   return i.reply({content:`${CHILLY_EMOJI.success} ${channel} is now **${c==='hide'?'hidden':'visible'}** for @everyone.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='hideall' || c==='unhideall') {
   await i.deferReply({flags:MessageFlags.Ephemeral}); let changed=0;
   for(const ch of g.channels.cache.values()) if([ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type)) await ch.permissionOverwrites.edit(g.roles.everyone,{ViewChannel:c==='unhideall'?true:false}).then(()=>changed++).catch(()=>{});
   return i.editReply(`${CHILLY_EMOJI.success} ${c==='hideall'?'Hidden':'Unhidden'} **${changed}** text channels for @everyone.`);
  }
  if(c==='lock') {
   const channel=i.options.getChannel('channel')||i.channel;
   if(!channel?.permissionOverwrites) return i.reply({content:'Please use this in or select a text channel.',flags:MessageFlags.Ephemeral});
   await channel.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false});
   return i.reply({content:`${CHILLY_EMOJI.success} ${channel} is now **locked** for @everyone.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='lockall') {
   await i.deferReply({flags:MessageFlags.Ephemeral}); let changed=0;
   for(const ch of g.channels.cache.values()) if([ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(ch.type)) await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false}).then(()=>changed++).catch(()=>{});
   return i.editReply(`${CHILLY_EMOJI.success} Locked **${changed}** text channels for @everyone.`);
  }
  if(c==='moderation' || c==='modguide') {
   const lines=['`.autorole [role]` — Set the automatic member role.','`.ban <member> [reason]` — Ban a member.','`.clearwarns <member>` — Clear all warnings.','`.clone` — Clone the current text channel.','`.enlarge <emoji>` — Enlarge a custom emoji.','`.hide [channel]` — Hide a channel from @everyone.','`.hideall` — Hide all text channels from @everyone.','`.kick <member> [reason]` — Kick a member.','`.lock [channel]` — Lock a channel.','`.lockall` — Lock all text channels.','`.modlog` — Configure moderation logging.','`.mute <member> [duration] [reason]` — Mute a member.','`.nick <member> <nickname>` — Change a nickname.','`.nuke` — Recreate the current text channel.','`.purge ...` — Bulk-delete filtered messages.','`.roleall <role>` — Give a role to all members.','`.role all|bots|humans <role>` — Bulk role assignment.','`.slowmode <duration> [channel]` — Set slowmode.','`.snipe` — Show the latest deleted message.','`.unbanall` — Unban all banned users.','`.unhide [channel]` — Unhide a channel.','`.unhideall` — Unhide all text channels.'];
   return i.reply({embeds:[chillyStyledEmbed({title:'🛠️ Moderation',description:lines.join('\n'),footer:'Nexzu • Moderation Guide'})]});
  }
  if(c==='modlog') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand(); settings(g.id);
   if(sub==='disable') { db.prepare('UPDATE guild_settings SET log_channel=NULL WHERE guild=?').run(g.id); return i.reply({content:'✅ Moderation logs disabled.',flags:MessageFlags.Ephemeral}); }
   const channel=i.options.getChannel('channel',true); db.prepare('UPDATE guild_settings SET log_channel=? WHERE guild=?').run(channel.id,g.id);
   return i.reply({content:`${CHILLY_EMOJI.success} Moderation log channel set to ${channel}.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='mute') {
   const to=i.options.getUser('user',true); if(to.id===TRUSTED_OWNER_ID||to.id===u.id) return i.reply({content:'⛔ You cannot mute that member.',flags:MessageFlags.Ephemeral});
   const member=await g.members.fetch(to.id).catch(()=>null); if(!member) return i.reply({content:'Member not found.',flags:MessageFlags.Ephemeral});
   const mins=i.options.getInteger('duration',true), reason=i.options.getString('reason')||'No reason provided'; await member.timeout(mins*60000,reason);
   return i.reply({embeds:[moderationEmbed({title:'User has been muted!',targetName:`<@${to.id}>`,targetId:to.id,moderator:`<@${u.id}>`,reason,duration:`${mins} minute(s)`,avatar:to.displayAvatarURL()})]});
  }
  if(c==='nick') {
   const to=i.options.getUser('user',true), nickname=i.options.getString('nickname',true), member=await g.members.fetch(to.id).catch(()=>null);
   if(!member) return i.reply({content:'Member not found.',flags:MessageFlags.Ephemeral});
   if(member.id===g.members.me.id || member.roles.highest.position>=g.members.me.roles.highest.position) return i.reply({content:'⛔ I cannot change that member’s nickname.',flags:MessageFlags.Ephemeral});
   await member.setNickname(nickname,'Nickname changed by Nexzu'); return i.reply({content:`${CHILLY_EMOJI.success} Nickname for ${to} changed to **${nickname}**.`});
  }
  if(c==='purge') {
   const sub=i.options.getSubcommand(), amount=i.options.getInteger('amount')||50, fetched=await i.channel.messages.fetch({limit:100}); let filtered=[...fetched.values()];
   if(sub==='bot') filtered=filtered.filter(m=>m.author?.bot);
   if(sub==='contains') filtered=filtered.filter(m=>m.content?.toLowerCase().includes((i.options.getString('text',true)||'').toLowerCase()));
   if(sub==='embeds') filtered=filtered.filter(m=>m.embeds?.length);
   if(sub==='emoji') filtered=filtered.filter(m=>/<a?:\w+:\d+>/.test(m.content||''));
   if(sub==='files') filtered=filtered.filter(m=>m.attachments?.size);
   if(sub==='messages' && i.options.getUser('member')) filtered=filtered.filter(m=>m.author?.id===i.options.getUser('member').id);
   const deleted=await i.channel.bulkDelete(filtered.slice(0,amount),true); return i.reply({content:`🧹 Deleted **${deleted.size}** message(s).`,flags:MessageFlags.Ephemeral});
  }
  if(c==='roleall' || c==='role') {
   const type=c==='roleall'?'all':i.options.getSubcommand();
   if(c==='role' && type==='icon') {
    const role=i.options.getRole('role',true), emojiInput=i.options.getString('emoji',true);
    const actor=i.member;
    const allowed=actor?.id===TRUSTED_OWNER_ID || actor?.id===g.ownerId || actor?.permissions.has(PermissionFlagsBits.Administrator) || actor?.permissions.has(PermissionFlagsBits.ManageGuild) || actor?.permissions.has(PermissionFlagsBits.ManageRoles);
    if(!allowed) return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Permission Denied`,description:'Only the server owner, bot owner, Administrators, or members with role-management permissions can use this command.',color:0x4a2028})],flags:MessageFlags.Ephemeral});
    const botMember=g.members.me || await g.members.fetchMe().catch(()=>null);
    if(!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Missing Permission`,description:'I need **Manage Roles** permission to change role icons.',color:0x4a2028})],flags:MessageFlags.Ephemeral});
    if(!role || role.id===g.id || role.managed || role.position>=botMember.roles.highest.position) return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Role Hierarchy`,description:'Move my highest role above the selected role and choose a normal, non-managed role.',color:0x4a2028})],flags:MessageFlags.Ephemeral});
    const emoji=resolveServerCustomEmoji(g,emojiInput);
    if(!emoji) return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Invalid Server Emoji`,description:'Use a custom emoji that already exists in this server. Examples: `:emoji_name:`, `<:emoji_name:id>`, or the emoji ID.',color:0x4a2028})],flags:MessageFlags.Ephemeral});
    try {
     const url=emoji.imageURL({extension:emoji.animated?'gif':'png',size:128});
     const response=await fetch(url);
     if(!response.ok) throw new Error(`Emoji CDN returned ${response.status}`);
     const buffer=Buffer.from(await response.arrayBuffer());
     await role.setIcon(buffer, `Role icon changed by ${actor.user.tag}`);
     const shown=customEmojiMarkup(emoji)||emoji.toString();
     return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.success} Role Icon Updated`,description:`${CHILLY_EMOJI.dot} **Role:** ${role}
${CHILLY_EMOJI.dot} **Icon:** ${shown}

The role icon was updated using a custom emoji from this server.`,color:0x1f4a36,footer:'Nexzu • Role Management'})]});
    } catch(error) {
     console.error('role-icon failed:',error);
     return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Role Icon Failed`,description:'I could not set that server emoji as the role icon. Make sure **Role Icons** are enabled, my role is high enough, and the emoji is available to Nexzu.',color:0x4a2028,footer:'Nexzu • Role Management'})],flags:MessageFlags.Ephemeral});
    }
   }
   const role=i.options.getRole('role',true);
   if(role.id===g.id||role.managed||role.position>=g.members.me.roles.highest.position) return i.reply({content:'⛔ Move my bot role above the selected role and choose a normal role.',flags:MessageFlags.Ephemeral});
   if(!g.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) return i.reply({content:'I need Manage Roles permission.',flags:MessageFlags.Ephemeral});
   await i.deferReply({flags:MessageFlags.Ephemeral}); const members=await g.members.fetch().catch(()=>null); if(!members) return i.editReply('❌ Could not fetch server members.');
   const targets=members.filter(m=>m.id!==g.members.me.id&&(type==='all'||(type==='bots'&&m.user.bot)||(type==='humans'&&!m.user.bot))); let added=0,failed=0;
   for(const member of targets.values()) { if(member.roles.cache.has(role.id)) continue; try{await member.roles.add(role,'Bulk role assignment by Nexzu');added++;}catch{failed++;} }
   return i.editReply(`✅ Added ${role} to **${added}** member(s).${failed?` Failed: **${failed}**.`:''}`);
  }
  if(c==='slowmode') {
   const channel=i.options.getChannel('channel')||i.channel, duration=i.options.getInteger('duration',true); if(!channel.setRateLimitPerUser) return i.reply({content:'Please select a text channel.',flags:MessageFlags.Ephemeral});
   await channel.setRateLimitPerUser(duration,'Slowmode changed by Nexzu'); return i.reply({content:`${CHILLY_EMOJI.success} Slowmode for ${channel} set to **${duration}s**.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='snipe') {
   const data=deletedMessageCache.get(i.channelId); if(!data) return i.reply({content:'No deleted message is cached for this channel.',flags:MessageFlags.Ephemeral});
   return i.reply({embeds:[chillyStyledEmbed({title:'🕵️ Latest Deleted Message',description:`**Author:** ${data.author}\n**Content:** ${data.content.slice(0,3800)}`,footer:'Nexzu • Snipe'})]});
  }
  if(c==='unbanall') {
   await i.deferReply({flags:MessageFlags.Ephemeral}); const bans=await g.bans.fetch().catch(()=>null); if(!bans) return i.editReply('❌ I could not fetch the server ban list.'); let count=0;
   for(const ban of bans.values()) await g.members.unban(ban.user.id,'Unban all by Nexzu').then(()=>count++).catch(()=>{}); return i.editReply(`${CHILLY_EMOJI.success} Unbanned **${count}** user(s).`);
  }
  if(c==='warn') {
   const to=i.options.getUser('user'), reason=i.options.getString('reason')||'No reason provided';
   if(to.id===TRUSTED_OWNER_ID) return i.reply({content:'🛡️ This user is protected. Nexzu cannot warn this account.',flags:MessageFlags.Ephemeral});
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
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.moderator} Warnings • ${to.username}`,description:rows.map((x,n)=>`${CHILLY_EMOJI.dot} **${n+1}.** ${x.reason} — <@${x.moderator}>`).join('\n')||`${CHILLY_EMOJI.success} No warnings found.`,footer:'Nexzu • Moderation'})]});
  }
  if(c==='clear') {
   const n=i.options.getInteger('amount'), deleted=await i.channel.bulkDelete(n,true);
   return i.reply({content:'🧹 Deleted '+deleted.size+' messages.',flags:MessageFlags.Ephemeral});
  }
  if(c==='timeout'||c==='untimeout') {
   const to=i.options.getUser('user');
   if(to.id===TRUSTED_OWNER_ID) return i.reply({content:'🛡️ This user is protected. Nexzu cannot mute or unmute this account.',flags:MessageFlags.Ephemeral});
   const m=await g.members.fetch(to.id);
   if(to.id===u.id) return i.reply({content:'You cannot moderate yourself.',flags:MessageFlags.Ephemeral});
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
   if(to.id===TRUSTED_OWNER_ID) return i.reply({content:'🛡️ This user is protected. Nexzu cannot kick or ban this account.',flags:MessageFlags.Ephemeral});
   const m=await g.members.fetch(to.id);
   if(to.id===u.id) return i.reply({content:'You cannot moderate yourself.',flags:MessageFlags.Ephemeral});
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
   if(!opponent||opponent.bot||opponent.id===u.id) return i.reply({content:'Choose another real server member (not yourself or a bot).',flags:MessageFlags.Ephemeral});
   const opponentMember=await g.members.fetch(opponent.id).catch(()=>null);
   if(!opponentMember) return i.reply({content:'The opponent must be a member of this server.',flags:MessageFlags.Ephemeral});
   const a=account(g.id,u.id), b=account(g.id,opponent.id);
   if(a.coins<bet||b.coins<bet) return i.reply({content:'Both players must have at least **'+money(bet)+'** to play.',flags:MessageFlags.Ephemeral});
   db.transaction(()=>{db.prepare('UPDATE global_users SET coins=coins-? WHERE user=?').run(bet,u.id);db.prepare('UPDATE global_users SET coins=coins-? WHERE user=?').run(bet,opponent.id);})();
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
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.member} ${who.username}'s Avatar`,description:`${CHILLY_EMOJI.dot} High-resolution profile avatar.`,thumbnail:false,footer:'Nexzu • Utility'}).setImage(who.displayAvatarURL({size:1024}))]});
  }
  if(c==='userinfo') {
   const who=target||u, m=await g.members.fetch(who.id).catch(()=>null);
   const e=chillyStyledEmbed({title:`${CHILLY_EMOJI.member} ${who.username}`,description:`${CHILLY_EMOJI.dot} Discord account information.`,footer:'Nexzu • Utility'}).setThumbnail(who.displayAvatarURL())
    .addFields({name:'User ID',value:who.id},{name:'Account created',value:'<t:'+Math.floor(who.createdTimestamp/1000)+':F>'});
   if(m&&m.joinedTimestamp) e.addFields({name:'Joined server',value:'<t:'+Math.floor(m.joinedTimestamp/1000)+':F>'});
   return i.reply({embeds:[e]});
  }
  if(c==='serverinfo') return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} ${g.name}`,description:`${CHILLY_EMOJI.dot} Server information.`,footer:'Nexzu • Utility'})
   .addFields({name:'Members',value:String(g.memberCount),inline:true},{name:'Server ID',value:g.id})]});
  if(c==='poll') {
   const m=await i.reply({content:'📊 **Poll:** '+i.options.getString('question')+'\nReact ✅ for Yes or ❌ for No.',fetchReply:true});
   await m.react('✅'); await m.react('❌'); return;
  }
  if(c==='calculator') {
   const a=i.options.getNumber('a'), b=i.options.getNumber('b'), op=i.options.getString('operator');
   if(op==='/'&&b===0) return i.reply({content:'Cannot divide by zero.',flags:MessageFlags.Ephemeral});
   const r=op==='+'?a+b:op==='-'?a-b:op==='*'?a*b:a/b;
   return i.reply('🧮 `'+a+' '+op+' '+b+' = '+r+'`');
  }
  if(c==='remind') {
   const seconds=i.options.getInteger('seconds'), msg=i.options.getString('message');
   await i.reply({content:'⏰ Reminder set for '+seconds+' seconds.',flags:MessageFlags.Ephemeral});
   setTimeout(()=>i.followUp({content:'⏰ <@'+u.id+'> Reminder: '+msg,allowedMentions:{users:[u.id]}}).catch(()=>{}),seconds*1000);
   return;
  }
  if(c==='autoreact') {
   if(!g) return i.reply({content:'Use this command inside a server.',flags:MessageFlags.Ephemeral});
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({content:'⛔ You need Manage Server permission to use /autoreact.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand();
   if(sub==='add') {
    const trigger=i.options.getString('trigger',true).trim().toLowerCase();
    const emoji=i.options.getString('emoji',true).trim();
    const parsed=normalizeReactionEmoji(emoji);
    try { await i.guild.emojis.resolve(parsed.key) || null; } catch {}
    db.prepare('INSERT INTO autoreactions(guild,trigger,emoji) VALUES(?,?,?) ON CONFLICT(guild,trigger) DO UPDATE SET emoji=excluded.emoji').run(g.id,trigger,emoji);
    return i.reply({content:`✅ Auto-reaction added: **${trigger}** → ${emoji}`,flags:MessageFlags.Ephemeral});
   }
   if(sub==='remove') {
    const trigger=i.options.getString('trigger',true).trim().toLowerCase();
    const result=db.prepare('DELETE FROM autoreactions WHERE guild=? AND trigger=?').run(g.id,trigger);
    return i.reply({content:result.changes?'✅ Auto-reaction removed.':'No matching trigger was found.',flags:MessageFlags.Ephemeral});
   }
   if(sub==='list') {
    const rows=db.prepare('SELECT trigger,emoji FROM autoreactions WHERE guild=? ORDER BY trigger').all(g.id);
    return i.reply({content:rows.length?rows.map(x=>`• **${x.trigger}** → ${x.emoji}`).join('\n'):'No auto-reactions configured.',flags:MessageFlags.Ephemeral});
   }
   if(sub==='reset') {
    const result=db.prepare('DELETE FROM autoreactions WHERE guild=?').run(g.id);
    return i.reply({content:`✅ Removed ${result.changes} auto-reaction(s).`,flags:MessageFlags.Ephemeral});
   }
  }
  if(c==='role-colour') {
   if(!g) return i.reply({content:'This command can only be used inside a server.',flags:MessageFlags.Ephemeral});
   if(!i.memberPermissions?.has(PermissionFlagsBits.ManageRoles) && !isGuildOwner && !isTrustedOwner && !i.memberPermissions?.has(PermissionFlagsBits.Administrator)) return i.reply({content:'⛔ Manage Roles permission required.',flags:MessageFlags.Ephemeral});
   const role=i.options.getRole('role', true);
   const input=i.options.getString('colour', true).trim().toLowerCase();
   const namedColours={red:'#FF0000',blue:'#0000FF',green:'#00FF00',yellow:'#FFFF00',orange:'#FFA500',purple:'#800080',pink:'#FFC0CB',black:'#000000',white:'#FFFFFF',cyan:'#00FFFF',magenta:'#FF00FF',teal:'#008080',gold:'#FFD700',grey:'#808080',gray:'#808080',brown:'#A52A2A',navy:'#000080'};
   const hex=namedColours[input] || (input.startsWith('#')?input:'#'+input);
   if(!/^#[0-9a-f]{6}$/i.test(hex)) return i.reply({content:'Invalid colour. Use a colour name (Red, Blue, Green, etc.) or a 6-digit hex code like `#FF0000`.',flags:MessageFlags.Ephemeral});
   if(role.id===g.id || role.managed) return i.reply({content:'⛔ I cannot change the colour of @everyone or an integration-managed role.',flags:MessageFlags.Ephemeral});
   const botMember=g.members.me;
   if(!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position>=botMember.roles.highest.position) return i.reply({content:'⛔ I need Manage Roles permission and my highest role must be above the selected role.',flags:MessageFlags.Ephemeral});
   try {
    await role.setColor(hex, `Role colour changed by ${u.tag}`);
    return i.reply({content:`✅ Changed ${role} colour to **${hex.toUpperCase()}**.`,flags:MessageFlags.Ephemeral});
   } catch(error) {
    console.error('role-colour failed:', error);
    return i.reply({content:'❌ I could not change that role colour. Check my Manage Roles permission and role hierarchy.',flags:MessageFlags.Ephemeral});
   }
  }
  if(c==='reaction-role') {
   if(!g) return i.reply({content:'This command can only be used inside a server.',flags:MessageFlags.Ephemeral});
   await i.deferReply({flags:MessageFlags.Ephemeral});
   const messageId=i.options.getString('message_id', true).trim();
   const emojiInput=i.options.getString('emoji', true).trim();
   const role=i.options.getRole('role', true);
   if(!/^\d{15,22}$/.test(messageId)) return i.editReply('Please provide a valid Discord message ID.');
   if(role.id===g.id || role.managed || role.position >= g.members.me.roles.highest.position) return i.editReply('I cannot assign that role. Move my bot role above the selected role and choose a non-managed role.');
   const parsed=normalizeReactionEmoji(emojiInput);
   if(!parsed.reactValue) return i.editReply('Please provide a valid emoji.');
   let message=null;
   for(const channel of g.channels.cache.values()) {
    if(!channel.isTextBased() || !channel.messages) continue;
    message=await channel.messages.fetch(messageId).catch(()=>null);
    if(message) break;
   }
   if(!message) return i.editReply('I could not find that message in this server. Check the message ID and make sure I can view its channel.');
   try {
    await message.react(parsed.reactValue);
   } catch (error) {
    return i.editReply('I could not add that emoji reaction. Check the emoji is valid and I have Add Reactions / Read Message History permissions.');
   }
   const emojiKey=parsed.key;
   db.prepare('INSERT INTO reaction_roles(guild,channel,message,emoji_key,emoji_input,role) VALUES(?,?,?,?,?,?) ON CONFLICT(guild,message,emoji_key) DO UPDATE SET channel=excluded.channel,emoji_input=excluded.emoji_input,role=excluded.role')
    .run(g.id,message.channelId,message.id,emojiKey,emojiInput,role.id);
   return i.editReply(`Reaction role set! React with ${emojiInput} on [this message](https://discord.com/channels/${g.id}/${message.channelId}/${message.id}) to get ${role}. Removing the reaction removes the role. Make sure my bot role is above ${role}.`);
  }
  if(c==='gconfig') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const staff=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(g.id,'giveaway_staff_role')?.value;
   const active=db.prepare('SELECT COUNT(*) AS n FROM giveaways WHERE guild=? AND ended=0').get(g.id).n;
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.gift} Giveaway Configuration`,description:`**Staff Role:** ${staff?`<@&${staff}>`:'Not set'}
**Active Giveaways:** **${active}**`,footer:'Nexzu • Giveaways'})]});
  }
  if(c==='glist') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const rows=db.prepare('SELECT id,prize,winners,ends FROM giveaways WHERE guild=? AND ended=0 ORDER BY ends ASC').all(g.id);
   const body=rows.length?rows.map((x,n)=>`**${n+1}.** \`${x.id}\` — **${x.prize}** • ${x.winners} winner(s) • <t:${x.ends}:R>`).join('\n'):'No active giveaways.';
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.gift} Active Giveaways`,description:body,footer:'Nexzu • Giveaways'})]});
  }
  if(c==='gstaff') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const sub=i.options.getSubcommand();
   if(sub==='reset') { db.prepare('DELETE FROM chilly_config WHERE guild=? AND key=?').run(g.id,'giveaway_staff_role'); return i.reply({content:'✅ Giveaway staff role reset.',flags:MessageFlags.Ephemeral}); }
   const role=i.options.getRole('role',true); db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(g.id,'giveaway_staff_role',role.id);
   return i.reply({content:`${CHILLY_EMOJI.success} Giveaway staff role set to ${role}.`,flags:MessageFlags.Ephemeral});
  }
  if(c==='gstart') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const prize=i.options.getString('prize'), duration=i.options.getString('duration').trim().toLowerCase(), winners=i.options.getInteger('winners');
   const match=duration.match(/^([1-9]\d*)(m|h|d)$/);
   if(!match) return i.reply({content:'Invalid duration. Use formats like `1m`, `1h`, or `1d`.',flags:MessageFlags.Ephemeral});
   const amount=Number(match[1]), unit=match[2];
   const durationMs=amount*(unit==='m'?60000:unit==='h'?3600000:86400000);
   if(!Number.isSafeInteger(durationMs) || durationMs<60000 || durationMs>30*86400000)
    return i.reply({content:'Duration must be between `1m` and `30d`.',flags:MessageFlags.Ephemeral});
   const id='CH-'+Date.now().toString(36).toUpperCase(), ends=Math.floor((Date.now()+durationMs)/1000);
   db.prepare('INSERT INTO giveaways(id,guild,channel,prize,winners,ends) VALUES(?,?,?,?,?,?)').run(id,g.id,i.channelId,prize,winners,ends);
   const embed=chillyStyledEmbed({title:prize,description:`${CHILLY_EMOJI.dot} **Winners:** ${winners}\n${CHILLY_EMOJI.dot} **Ends:** <t:${ends}:R> • <t:${ends}:f>\n${CHILLY_EMOJI.dot} **Hosted by:** <@${u.id}>\n${CHILLY_EMOJI.dot} **Giveaway ID:** \`${id}\`\n\n${CHILLY_EMOJI.gift} React with <a:Winner:${GIVEAWAY_EMOJI_ID}> to enter!`,footer:'Nexzu • Giveaways • React to participate'}).setTimestamp(new Date(ends*1000));
   const msg=await i.reply({embeds:[embed],fetchReply:true});
   db.prepare('UPDATE giveaways SET message=? WHERE id=?').run(msg.id,id);
   try { await msg.react(`<a:Winner:${GIVEAWAY_EMOJI_ID}>`); }
   catch(error) {
    console.error('Could not add giveaway entry reaction:', error);
    await msg.reply('I could not add the entry emoji. Please check that I can use external emojis and add reactions.');
   }
   setTimeout(()=>endGiveaway(id).catch(console.error),durationMs);
   return;
  }
  if(c==='gend') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const requested=i.options.getString('id'); const id=requested||db.prepare('SELECT id FROM giveaways WHERE guild=? AND ended=0 ORDER BY ends DESC LIMIT 1').get(g.id)?.id;
   if(!id) return i.reply({content:'No active giveaway found.',flags:MessageFlags.Ephemeral});
   const r=await endGiveaway(id);
   if(r.error) return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Giveaway Error`,description:r.error})],flags:MessageFlags.Ephemeral});
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.success} Giveaway Ended`,description:'The giveaway has been ended successfully.',footer:'Nexzu • Giveaways'})]});
  }
  if(c==='greroll') {
   if(!hasAdminAccess) return i.reply({content:'⛔ Manage Server permission required.',flags:MessageFlags.Ephemeral});
   const requested=i.options.getString('id'); const id=requested||db.prepare('SELECT id FROM giveaways WHERE guild=? AND ended=0 ORDER BY ends DESC LIMIT 1').get(g.id)?.id;
   if(!id) return i.reply({content:'No active giveaway found.',flags:MessageFlags.Ephemeral});
   const r=await endGiveaway(id,true);
   if(r.error) return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.rejected} Giveaway Error`,description:r.error})],flags:MessageFlags.Ephemeral});
   const desc=r.winners.length?`${CHILLY_EMOJI.gift} **New Winner(s):** ${r.winners.map(x=>'<@'+x+'>').join(', ')}`:`${CHILLY_EMOJI.dot} No entries were available to reroll.`;
   return i.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.gift} Giveaway Rerolled`,description:desc,footer:'Nexzu • Giveaways'})]});
  }
}

client.on('interactionCreate', async i=>{
 try {
  if(i.isButton()&&(i.customId==='chilly_ticket_open'||i.customId.startsWith('chilly_ticket_open:'))) {
   const ticketKey=i.customId==='chilly_ticket_open'?'default':i.customId.slice('chilly_ticket_open:'.length);
   const config=db.prepare('SELECT * FROM ticket_buttons WHERE guild=? AND ticket_key=?').get(i.guild.id,ticketKey);
   if(!config) return i.reply({content:'This ticket button is no longer configured.',flags:MessageFlags.Ephemeral});
   const existing=i.guild.channels.cache.find(ch=>ch.type===ChannelType.GuildText && ch.topic?.startsWith(`chilly-ticket:${i.user.id}:${ticketKey}:`));
   if(existing) return i.reply({content:`You already have this ticket: ${existing}`,flags:MessageFlags.Ephemeral});
   const perms=[{id:i.guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},{id:i.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},{id:config.staff_role,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory],deny:[PermissionFlagsBits.SendMessages]}];
   const ch=await i.guild.channels.create({name:`${ticketKey}-${i.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,90),type:ChannelType.GuildText,topic:`chilly-ticket:${i.user.id}:${ticketKey}:${config.staff_role}:`,permissionOverwrites:perms});
   const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('chilly_ticket_claim').setLabel('Claim Ticket').setEmoji('🙋').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('chilly_ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger));
   await ch.send({content:`🎫 ${i.user} <@&${config.staff_role}>`,embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.ticket} ${config.label} Ticket`,description:`${CHILLY_EMOJI.dot} Please describe your issue. A staff member must claim this ticket before messaging.\n\n${CHILLY_EMOJI.moderator} Only the claiming staff member can chat and close it.`,footer:'Nexzu • Tickets'})],components:[row]});
   return i.reply({content:`Ticket created: ${ch}`,flags:MessageFlags.Ephemeral});
  }
  if(i.isButton()&&i.customId==='chilly_ticket_claim') {
   const topic=i.channel?.topic||'';
   const match=topic.match(/^chilly-ticket:(\d+):([^:]+):(\d+):?(\d*)$/);
   if(!match) return i.reply({content:'This is not a valid Nexzu ticket.',flags:MessageFlags.Ephemeral});
   const [,openerId,ticketKey,roleId,claimerId]=match;
   const isStaff=!!i.memberPermissions?.has(PermissionFlagsBits.Administrator)||!!i.member.roles.cache.has(roleId);
   if(!isStaff) return i.reply({content:'Only this ticket type’s assigned staff members can claim it.',flags:MessageFlags.Ephemeral});
   if(claimerId) return i.reply({content:`This ticket has already been claimed by <@${claimerId}>.`,flags:MessageFlags.Ephemeral});
   await i.channel.permissionOverwrites.edit(i.user.id,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
   await i.channel.permissionOverwrites.edit(roleId,{ViewChannel:true,ReadMessageHistory:true,SendMessages:false});
   await i.channel.setTopic(`chilly-ticket:${openerId}:${ticketKey}:${roleId}:${i.user.id}`);
   const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('chilly_ticket_claim').setLabel('Claimed').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(true),new ButtonBuilder().setCustomId('chilly_ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger));
   await i.update({components:[row]});
   await i.channel.send(`✅ This ticket has been claimed by ${i.user}. Only this staff member can message and close the ticket.`);
   return;
  }
  if(i.isButton()&&i.customId==='chilly_ticket_close') {
   const match=(i.channel?.topic||'').match(/^chilly-ticket:(\d+):([^:]+):(\d+):(\d+)$/);
   if(!match) return i.reply({content:'This is not a valid or claimed Nexzu ticket.',flags:MessageFlags.Ephemeral});
   const [,openerId,ticketKey,roleId,claimerId]=match;
   const isAdmin=!!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
   if(i.user.id!==claimerId&&!isAdmin) return i.reply({content:'Only the staff member who claimed this ticket or a Server Administrator can close it.',flags:MessageFlags.Ephemeral});
   const config=db.prepare('SELECT log_channel FROM ticket_buttons WHERE guild=? AND ticket_key=?').get(i.guild.id,ticketKey);
   await i.reply({content:'🔒 Closing ticket…',flags:MessageFlags.Ephemeral});
   try {
    const messages=await i.channel.messages.fetch({limit:100});
    const transcript=[...messages.values()].reverse().map(m=>`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.cleanContent}`).join('\n');
    const log=i.guild.channels.cache.get(config?.log_channel);
    if(log) await log.send({content:`🔒 Ticket **${ticketKey}** closed by ${i.user} (claimed by <@${claimerId}>; opened by <@${openerId}>).`,files:[new AttachmentBuilder(Buffer.from(transcript||'No messages.'),{name:`ticket-${ticketKey}-${openerId}.txt`})]});
   } catch(err) { console.error('Ticket transcript/log error:',err); }
   setTimeout(()=>i.channel.delete(`Ticket closed by ${i.user.tag}; opened by ${openerId}`).catch(()=>{}),1500);
   return;
  }
  if(i.isButton()&&i.customId.startsWith('chilly_rps:')) {
   const [,gameId,choice]=i.customId.split(':'); const game=rpsGames.get(gameId);
   if(!game) return i.reply({content:'This RPS game is no longer active.',flags:MessageFlags.Ephemeral});
   if(![game.challenger,game.opponent].includes(i.user.id)) return i.reply({content:'You are not part of this RPS game.',flags:MessageFlags.Ephemeral});
   game.picks[i.user.id]=choice;
   await i.reply({content:'Your choice is locked in: **'+choice+'**.',flags:MessageFlags.Ephemeral});
   if(game.picks[game.challenger]&&game.picks[game.opponent]) {
    const a=game.picks[game.challenger], b=game.picks[game.opponent];
    const win=(a==='rock'&&b==='scissors')||(a==='paper'&&b==='rock')||(a==='scissors'&&b==='paper');
    if(a===b) {
     db.transaction(()=>{db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(game.bet,game.challenger);db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(game.bet,game.opponent);})();
    } else if(win) db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(game.bet*2,game.challenger);
    else db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(game.bet*2,game.opponent);
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
   if(!g||g.ended||g.ends*1000<Date.now()) return i.reply({content:'Giveaway ended.',flags:MessageFlags.Ephemeral});
   const r=db.prepare('INSERT OR IGNORE INTO entries(giveaway,user) VALUES(?,?)').run(id,i.user.id);

   return i.reply({content:r.changes?'You entered! Good luck!':'You already entered.',flags:MessageFlags.Ephemeral});
  }
  if(i.isStringSelectMenu() && i.customId==='chilly_help_category') {
   const pages = {
    economy:{title:'<:1000022218:1571576540460752937> Economy Commands',body:[
     '`/balance` — Check a member’s NexBit balance.',
     '`/daily` — Claim your daily NexBit reward.',
     '`/work` — Earn NexBits by working.',
     '`/slots` — Bet NexBits on the slot machine.',
     '`/pay` — Send NexBits to another member.',
     '`/leaderboard` — View the richest members.',
     '`/shop` — View items available in the Nexzu Shop.',
     '`/buy` — Purchase an item from the shop.',
     '`/inventory` — View a member’s inventory.',
     '`/money` — Add NexBits to a member (server owner only).'
    ].join('\n')},
    rewards:{title:'<:1000022223:1571576535972839504> Real Money Rewards Commands',body:[
     '`.bal @user` — View available INR reward balance.',
     '`.prof @user` — View a member’s reward profile and rank.',
     '`.rank @user` — View the member’s reward profile.',
     '`.rich` — View the real-money wealth leaderboard.',
     '`.withdraw [amount]` — Request an INR cash-out for manual review.'
    ].join('\n')},
    moderation:{title:'<:1000022221:1571576542683861244> Moderation Commands',body:[
     '`.autorole [role]` — Set the automatic member role.',
     '`.ban <member> [reason=No reason provided]` — Ban a member.',
     '`.clearwarns <member>` — Clear all warnings.',
     '`.clone` — Clone the current text channel.',
     '`.enlarge <emoji>` — Enlarge a custom emoji.',
     '`.hide [channel]` — Hide a text channel from @everyone.',
     '`.hideall` — Hide all text channels from @everyone.',
     '`.kick <member> [reason=No reason provided]` — Kick a member.',
     '`.lock [channel]` — Lock a text channel.',
     '`.lockall` — Lock all text channels.',
     '`.moderation` — Open the moderation panel.',
     '`.modguide` — Show moderation command guide.',
     '`.modlog disable` — Disable moderation logs.',
     '`.modlog set <channel>` — Set moderation log channel.',
     '`.mute <member> [duration] [reason=No reason provided]` — Mute a member.',
     '`.nick <member> <nickname>` — Change a member nickname.',
     '`.nuke` — Recreate the current text channel.',
     '`.purge messages <amount> [member]` — Delete recent messages.',
     '`.purge bot [amount=50]` — Delete bot messages.',
     '`.purge contains <text> [amount=50]` — Delete matching messages.',
     '`.purge embeds [amount=50]` — Delete messages with embeds.',
     '`.purge emoji [amount=50]` — Delete messages containing custom emoji.',
     '`.purge files [amount=50]` — Delete messages with attachments.',
     '`.roleall <role>` — Give a role to all members.',
     '`.role all <role>` — Give a role to all members.',
     '`.role bots <role>` — Give a role to bots.',
     '`.role humans <role>` — Give a role to humans.',
     '`.slowmode <duration> [channel]` — Set channel slowmode.',
     '`.snipe` — Show the latest deleted message.',
     '`.unbanall` — Unban all banned users.',
     '`.unhide [channel]` — Unhide a text channel.',
     '`.unhideall` — Unhide all text channels.',
     `${CHILLY_EMOJI.moderator} **.staff @user** — Add a member to the Staff team.`,
     `${CHILLY_EMOJI.rejected} **.remove staff @user** — Remove a member from the Staff team.`,
     '`/warn` — Warn a server member.',
     '`/warnings` — View a member’s warnings.',
     '`/clear` — Delete recent messages.',
     '`/timeout` — Temporarily timeout a member.',
     '`/untimeout` — Remove a member’s timeout.',
     '`/kick` — Kick a member from the server.',
     '`/ban` — Ban a member from the server.',
     '`/unban` — Unban a user by ID.',
     '`/jail` — Jail a member using the configured jail role.',
     '`/unjail` — Release a jailed member.'
    ].join('\n')},
    antinuke:{title:'🛡️ AntiNuke Commands',body:[
     '`.antinuke` — Configure AntiNuke protection.',
     '`.antinuke config [setting] [value] [channel]` — Configure AntiNuke settings.',
     '`.antinuke limit [event_or_amount] [amount]` — Configure action limits.',
     '`.antinuke punishment [event_or_punishment] [punishment]` — Set punishment.',
     '`.antinuke reset` — Reset AntiNuke settings.',
     '`.mainrole` — Manage AntiNuke main roles.',
     '`.mainrole add <role>` — Register a main role.',
     '`.mainrole list` — List registered main roles.',
     '`.mainrole remove <role>` — Remove a main role.',
     '`.mainrole reset` — Remove all main roles.',
     '`.whitelist` — Manage action-specific whitelist permissions.'
    ].join('\n')},
    automod:{title:'🤖 AutoMod Commands',body:[
     '`.antibot` — Show AntiBot commands.',
     '`.antibot add <bot_user>` — Add a bot to whitelist.',
     '`.antibot config [enabled]` — View or change AntiBot configuration.',
     '`.antibot remove <bot_user>` — Remove a bot from whitelist.',
     '`.antibot reset` — Reset AntiBot configuration.',
     '`.antibot whitelist` — Manage AntiBot whitelist.',
     '`.automod` — Show AutoMod commands.',
     '`.automod config` — View AutoMod configuration.',
     '`.automod disable` — Disable AutoMod.',
     '`.automod enable` — Enable AutoMod.',
     '`.automod ignore` — Manage ignored AutoMod targets.',
     '`.automod ignore channel <channel>` — Ignore a channel.',
     '`.automod ignore role <role>` — Ignore a role.',
     '`.automod ignore reset` — Reset ignored channels and roles.',
     '`.automod ignore show` — Show ignored channels and roles.',
     '`.automod logging <channel>` — Set AutoMod logging channel.',
     '`.automod punishment <punishment>` — Configure AutoMod punishment.',
     '`.automod unignore channel <channel>` — Unignore a channel.',
     '`.automod unignore role <role>` — Unignore a role.'
    ].join('\n')},
    giveaways:{title:'<:1000022236:1571576497175789599> Giveaway Commands',body:[
     '`.gconfig` — Show giveaway configuration.',
     '`.gend [message_id]` — End a giveaway.',
     '`.glist` — List active giveaways.',
     '`.greroll [message_id]` — Reroll a giveaway.',
     '`.gstaff` — Configure giveaway staff.',
     '`.gstaff reset` — Reset the giveaway staff role.',
     '`.gstaff role <role>` — Set the giveaway staff role.',
     '`.gstart <duration> <winners> <prize>` — Start a giveaway.',
     '`/gstart` — Start a new reaction-based giveaway.',
     '`/gend` — End an active giveaway early.',
     '`/greroll` — Reroll a giveaway winner.'
    ].join('\n')},
    fun:{title:'<:1000022240:1571576507070030027> Fun Commands',body:[
     '`/8ball` — Ask the magic 8-ball a question.',
     '`/coinflip` — Flip a virtual coin.',
     '`/dice` — Roll a six-sided dice.',
     '`/rps` — Challenge a member to a NexBit RPS duel.',
     '`/joke` — Get a clean joke.',
     '`/ship` — Check compatibility between two members.'
    ].join('\n')},
    utility:{title:'<:1000022230:1571576478452285621> Utility Commands',body:[
     '`/ping` — Check Nexzu’s response latency.',
     '`/avatar` — Display a member’s avatar.',
     '`/userinfo` — Show member account information.',
     '`/serverinfo` — Show server information.',
     '`/servericon` — Download a server icon from an invite.',
     '`/poll` — Create a yes/no poll.',
     '`/calculator` — Calculate a basic arithmetic expression.',
     '`/remind` — Set a short in-bot reminder.',
     '`/say` — Send a message through Nexzu.'
    ].join('\n')},
    setup:{title:'<:1000022238:1571576502292713716> Server Setup Commands',body:[
     '`/ticket-setup` — Configure ticket buttons and panels.',
     '`/welcome-setup` — Configure server welcome messages.',
     '`/setlogs` — Set the server log channel.',
     '`/role-colour` — Configure a role’s colour.',
     '`/reaction-role` — Create a reaction-based role.'
    ].join('\n')},
    jail:{title:'🔒 Jail Commands',body:[
     '`.jail <member> [reason=No reason provided]` — Jail a member.',
     '`.jailsetup` — Set up the jail system.',
     '`.jailsync` — Synchronize the jail system.',
     '`.permit <action> <role>` — Add or remove a permitted jail staff role.',
     '`.pjail <member> [reason=No reason provided]` — Permanently jail a member.',
     '`.unjail <member>` — Remove a member from jail.'
    ].join('\n')},
    misc:{title:'🔧 Misc Commands',body:[
     '`.afk [reason]` — Set, update or remove your AFK status.',
     '`.avatar [user]` — View and download a user’s avatar.',
     '`.banner [user]` — View and download a user’s banner.',
     '`.devices [user]` — Show a member’s Discord activity.',
     '`.inviteinfo <invite>` — View information about a Discord invite.',
     '`.list` — List server members and resources.',
     '`.list admins` — List server administrators.',
     '`.list boosters` — List server boosters.',
     '`.list bots` — List bots in the server.',
     '`.list early` — List early supporter badge holders in the server.',
     '`.list emojis` — List server emojis.',
     '`.list inrole <role>` — List members who have a role.',
     '`.fakeperms <role> <permission>` — Preview/manage fake permissions from a role.'
    ].join('\n')},
    music:{title:'<:1000022225:1571576463449137183> Music',body:[
     `${CHILLY_EMOJI.music} Music category is ready. Add your music commands here.`
    ].join('\n')},
    tickets:{title:'🎟️ tickets',body:[
     '`.ticket` — Manage ticket panels and active tickets.',
     '`.ticket claim` — Claim the current ticket.',
     '`.ticket close` — Close and lock the current ticket.',
     '`.ticket config` — View the configuration of a ticket panel.',
     '`.ticket delete` — Delete the current ticket.',
     '`.ticket edit <panel_id>` — Edit an existing ticket panel.',
     '`.ticket panel` — Open the ticket panel manager.',
     '`.ticket rename <new_name>` — Rename the current ticket channel.',
     '`.ticket send [panel_id]` — Send a configured ticket panel.',
     '`.ticket setup` — Start the ticket panel setup wizard.'
    ].join('\n')},
    leveling:{title:'<:1000022234:1571576486169809048> Leveling Commands',body:[
     '`/level` — View a member’s level and XP.',
     '`/level-leaderboard` — View the server XP leaderboard.',
     '`/levelup-setup` — Configure level-up notifications.',
     '`/levelrole` — Manage level-based role rewards.'
    ].join('\n')}
   };
   const page=pages[i.values[0]];
   if(!page || !page.body.trim()) return i.update({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} Nexzu Command Center`,description:'No commands are currently available in this category.'})],components:i.message.components});
   const categoryEmoji={economy:CHILLY_EMOJI.money,rewards:CHILLY_EMOJI.money,moderation:CHILLY_EMOJI.moderator,antinuke:CHILLY_EMOJI.security,automod:CHILLY_EMOJI.fun,giveaways:CHILLY_EMOJI.gift,fun:CHILLY_EMOJI.fun,utility:CHILLY_EMOJI.utility,setup:CHILLY_EMOJI.settings,music:CHILLY_EMOJI.music,leveling:CHILLY_EMOJI.level}[i.values[0]]||CHILLY_EMOJI.dot;
   const commandLines=page.body.split('\n').map(line=>`${categoryEmoji} ${line}`).join('\n');
   const embed=chillyStyledEmbed({title:page.title,description:'Use the commands below to get started.\n\n'+commandLines,footer:'Powered By Nexzu Development™ | Designed By Spidyyy'});
   return i.update({embeds:[embed],components:i.message.components});
  }
  if(i.isChatInputCommand()) return await handleChatInputCommand(i);
 } catch(e) {
  console.error('Command error:',e);
  const p={content:'Command failed. Check bot permissions and hosting logs.',flags:MessageFlags.Ephemeral};
  if(i.deferred||i.replied) await i.followUp(p).catch(()=>{});
  else await i.reply(p).catch(()=>{});
 }
});
// Server event logging and configurable protective filters.
client.on('messageDelete', async message => {
 if(!message.guild || message.author?.bot) return;
 deletedMessageCache.set(message.channelId,{content:message.content||'[No cached text]',author:message.author?message.author.tag:'Unknown',authorId:message.author?.id||'Unknown',channelId:message.channelId,createdTimestamp:message.createdTimestamp||Date.now(),attachments:[...message.attachments.values()].map(a=>a.url)});
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
 if(db.prepare('SELECT enabled FROM antinuke_config WHERE guild=?').get(channel.guild.id)?.enabled) await logAction(channel.guild,auditEmbed('🛡️ Anti-nuke Alert',0xE74C3C,[{name:'Event',value:'A channel was deleted.'},{name:'Channel',value:channel.name},{name:'Action',value:'Alert only; no automatic punishment was applied.'}]));
});
client.on('roleDelete', async role => {
 const cfg=settings(role.guild.id);
 await logAction(role.guild,auditEmbed('🗑️ Role Deleted',0xE74C3C,[{name:'Role',value:`${role.name} (${role.id})`}]));
 if(db.prepare('SELECT enabled FROM antinuke_config WHERE guild=?').get(role.guild.id)?.enabled) await logAction(role.guild,auditEmbed('🛡️ Anti-nuke Alert',0xE74C3C,[{name:'Event',value:'A role was deleted.'},{name:'Role',value:role.name},{name:'Action',value:'Alert only; check Audit Log and secure staff permissions.'}]));
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
 try {
  const roleId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(member.guild.id,'autorole')?.value;
  if(roleId) { const role=await member.guild.roles.fetch(roleId).catch(()=>null); const botMember=member.guild.members.me; if(role && !role.managed && role.position<botMember.roles.highest.position && botMember.permissions.has(PermissionFlagsBits.ManageRoles)) await member.roles.add(role,'Configured Nexzu auto-role'); }
 } catch(error) { console.error('Auto-role failed:',error.message); }
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
client.on('guildMemberAdd', async member => {
 try { const chId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(member.guild.id,'welcome_channel')?.value; const tpl=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(member.guild.id,'welcome_message')?.value; const ch=chId?await member.guild.channels.fetch(chId).catch(()=>null):null; if(ch&&tpl) await ch.send({content:tpl.replaceAll('{user}',`<@${member.id}>`).replaceAll('{server}',member.guild.name),allowedMentions:{users:[member.id]}}); } catch(e) { console.error('Welcome message:',e.message); }
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

// Private, bot-owner-only immediate server channel reset. Members and roles are never modified.

function getStaffRole(guild) {
 return guild.roles.cache.find(r => r.name === 'Staff ✦' || r.name === 'Staff') || null;
}

function isAuthorisedStaffManager(member) {
 if (!member?.guild) return false;
 if (member.id === TRUSTED_OWNER_ID || member.id === member.guild.ownerId) return true;
 if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
 // The existing Lovespot layout includes an Authority role; treat it as an explicit
 // staff-management role while still respecting the role hierarchy below.
 return member.roles.cache.some(r => r.name === 'Authority ⚑' || r.name === 'Authority');
}

async function ensureStaffRole(guild) {
 let role = getStaffRole(guild);
 if (role) return role;
 const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
 if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return null;
 role = await guild.roles.create({
  name: 'Staff ✦',
  color: '#99AAB5',
  reason: 'Create Nexzu Staff role for authorised staff management'
 }).catch(() => null);
 return role;
}

async function sendStaffEmbed(channel, {title, description, target, actor, success=true}) {
 const emoji = success ? CHILLY_EMOJI.success : CHILLY_EMOJI.rejected;
 const embed = chillyStyledEmbed({
  title: `${emoji} ${title}`,
  description,
  footer: 'Nexzu • Staff Management'
 });
 if (target) embed.addFields({name:`${CHILLY_EMOJI.member} Member`,value:`${target} \`${target.id}\``,inline:true});
 if (actor) embed.addFields({name:`${CHILLY_EMOJI.moderator} Authorised By`,value:`${actor}`,inline:true});
 return channel.send({embeds:[embed]}).catch(() => null);
}

// Generic dot-prefix support: every slash command can also be invoked with `.<command>`.
// The parser reads the live slash-command schema, so new commands/options automatically
// become available with the same dot prefix without duplicating command logic.
const prefixCommandSchemas = commands.map(command => {
 const data = typeof command.toJSON === 'function' ? command.toJSON() : command;
 return data;
});

function tokenizePrefixInput(input) {
 const tokens=[]; const re=/(?:"([^"]*)"|'([^']*)'|(\S+))/g; let m;
 while((m=re.exec(input))) tokens.push(m[1] ?? m[2] ?? m[3]);
 return tokens;
}

function prefixOptionSchema(commandData, tokens) {
 const top=(commandData.options||[]);
 let options=top, subcommand=null, group=null, index=0;
 if(top.length && (top[0].type===1 || top[0].type===2)) {
  const first=tokens[0]?.toLowerCase();
  const groupNode=top.find(x=>x.type===2 && x.name===first);
  if(groupNode) {
   group=groupNode.name; index=1;
   const subName=tokens[index]?.toLowerCase();
   const subNode=(groupNode.options||[]).find(x=>x.type===1 && x.name===subName);
   if(!subNode) return {error:`Unknown subcommand. Use \.${commandData.name} ${groupNode.options?.map(x=>x.name).join('|')||''}`.trim()};
   subcommand=subNode.name; index++;
   options=subNode.options||[];
  } else {
   const subNode=top.find(x=>x.type===1 && x.name===first);
   if(!subNode) return {error:`Unknown subcommand for \.${commandData.name}.`};
   subcommand=subNode.name; index=1; options=subNode.options||[];
  }
 }
 return {options,subcommand,group,index};
}

async function resolvePrefixEntity(message, option, token) {
 if(token==null) return null;
 const value=String(token).trim();
 if(option.type===6) {
  const id=(value.match(/^<@!?(\d+)>$/)||value.match(/^(\d{15,22})$/))?.[1];
  if(id) return message.mentions.users.get(id) || await client.users.fetch(id).catch(()=>null);
  const member=message.guild?.members.cache.find(m=>m.user.username.toLowerCase()===value.toLowerCase() || m.displayName.toLowerCase()===value.toLowerCase());
  return member?.user || null;
 }
 if(option.type===8) {
  const id=(value.match(/^<@&(\d+)>$/)||value.match(/^(\d{15,22})$/))?.[1];
  if(id) return message.guild?.roles.cache.get(id) || await message.guild?.roles.fetch(id).catch(()=>null);
  return message.guild?.roles.cache.find(r=>r.name.toLowerCase()===value.toLowerCase()) || null;
 }
 if(option.type===7) {
  const id=(value.match(/^<#(\d+)>$/)||value.match(/^(\d{15,22})$/))?.[1];
  if(id) return message.guild?.channels.cache.get(id) || await message.guild?.channels.fetch(id).catch(()=>null);
  return message.guild?.channels.cache.find(c=>c.name.toLowerCase()===value.toLowerCase()) || null;
 }
 return null;
}

async function parsePrefixCommand(message, raw) {
 const parts=tokenizePrefixInput(raw);
 if(!parts.length || !parts[0].startsWith('.')) return null;
 const name=parts[0].slice(1).toLowerCase();
 const commandData=prefixCommandSchemas.find(c=>c.name===name);
 if(!commandData) return null;
 const schema=prefixOptionSchema(commandData, parts.slice(1));
 if(schema.error) return {error:schema.error, commandData};
 const tokens=parts.slice(1+schema.index);
 const values={}; let cursor=0;
 const named={};
 // Support both natural positional arguments and explicit --option value syntax.
 const positional=[];
 for(let n=0;n<tokens.length;n++) {
  const t=tokens[n];
  if(/^--[\w-]+(?:=|$)/.test(t)) {
   const key=t.slice(2).split('=')[0];
   let value=t.includes('=')?t.slice(t.indexOf('=')+1):tokens[++n];
   named[key]=value;
  } else positional.push(t);
 }
 const takeFor=(opt, index) => {
  if(Object.prototype.hasOwnProperty.call(named,opt.name)) return named[opt.name];
  if(index>=positional.length) return undefined;
  // A final string option (reason/message/description/etc.) naturally consumes the rest.
  const remaining=positional.length-index;
  const remainingOpts=commandData.options||[];
  return (opt.type===3 && opt===schema.options[schema.options.length-1] && remaining>1)
    ? positional.slice(index).join(' ')
    : positional[index];
 };
 for(let oi=0;oi<schema.options.length;oi++) {
  const opt=schema.options[oi];
  const rawValue=takeFor(opt,cursor);
  if(rawValue===undefined) {
   if(opt.required) return {error:`Missing required option **${opt.name}**.`,commandData};
   continue;
  }
  if(!Object.prototype.hasOwnProperty.call(named,opt.name)) cursor += (opt.type===3 && opt===schema.options[schema.options.length-1] ? positional.length-cursor : 1);
  let value=rawValue;
  if(opt.type===6||opt.type===8||opt.type===7) value=await resolvePrefixEntity(message,opt,rawValue);
  else if(opt.type===4) value=Number.parseInt(rawValue,10);
  else if(opt.type===10) value=Number(rawValue);
  else if(opt.type===5) value=/^(true|yes|on|1)$/i.test(String(rawValue));
  else if(opt.type===3) value=String(rawValue);
  if((opt.type===4||opt.type===10) && !Number.isFinite(value)) return {error:`Option **${opt.name}** must be a number.`,commandData};
  if((opt.type===6||opt.type===8||opt.type===7) && !value) return {error:`I couldn't find a valid ${opt.type===6?'user':opt.type===8?'role':'channel'} for **${opt.name}**.`,commandData};
  if(opt.choices?.length) {
   const ok=opt.choices.some(choice=>String(choice.value).toLowerCase()===String(value).toLowerCase() || String(choice.name).toLowerCase()===String(value).toLowerCase());
   if(!ok) return {error:`Invalid value for **${opt.name}**. Choices: ${opt.choices.map(x=>x.name).join(', ')}`,commandData};
   const match=opt.choices.find(choice=>String(choice.value).toLowerCase()===String(value).toLowerCase() || String(choice.name).toLowerCase()===String(value).toLowerCase());
   value=match.value;
  }
  values[opt.name]=value;
 }
 // Extra positional arguments are almost always an accidental typo.
 if(cursor<positional.length && !(schema.options.length && schema.options[schema.options.length-1].type===3)) {
  return {error:'Too many arguments. Use quotes around multi-word text, e.g. `.warn @user "Reason here"`.',commandData};
 }
 return {commandData,subcommand:schema.subcommand,group:schema.group,values};
}

function makePrefixInteraction(message, parsed) {
 const values=parsed.values||{};
 const options={
  getSubcommand:()=>parsed.subcommand,
  getSubcommandGroup:()=>parsed.group,
  getUser:(name)=>values[name] ?? null,
  getRole:(name)=>values[name] ?? null,
  getChannel:(name)=>values[name] ?? null,
  getString:(name)=>values[name] ?? null,
  getInteger:(name)=>values[name] ?? null,
  getNumber:(name)=>values[name] ?? null,
  getBoolean:(name)=>values[name] ?? null,
  getAttachment:(name)=>values[name] ?? null
 };
 let replyMessage=null;
 const sendReply=async payload=>{
  const body=typeof payload==='string'?{content:payload}:({...payload});
  delete body.ephemeral;
  // Some prefix commands (for example .clear) can delete the command message
  // before replying. In that case Discord rejects message_reference as unknown.
  try {
   return await message.reply(body);
  } catch (error) {
   if (error?.code === 10008 || error?.rawError?.errors?.message_reference) {
    return message.channel.send(body);
   }
   throw error;
  }
 };
 return {
  commandName:parsed.commandData.name,
  user:message.author,
  member:message.member,
  guild:message.guild,
  channel:message.channel,
  options,
  memberPermissions:message.member?.permissions,
  createdTimestamp:message.createdTimestamp,
  replied:false,
  deferred:false,
  isChatInputCommand:()=>true,
  reply:async payload=>{ replyMessage=await sendReply(payload); return replyMessage; },
  followUp:async payload=>sendReply(payload),
  deferReply:async payload=>{ replyMessage=await sendReply(typeof payload==='object'&&payload?.content?payload:{content:'Working…'}); return replyMessage; },
  editReply:async payload=>{ if(!replyMessage) replyMessage=await sendReply(payload); else await replyMessage.edit(typeof payload==='string'?{content:payload}:payload); return replyMessage; },
  deleteReply:async()=>{ if(replyMessage) await replyMessage.delete().catch(()=>{}); },
  isButton:()=>false,
  isStringSelectMenu:()=>false,
  isChatInputCommand:()=>true
 };
}


// Image card for the `.m` / `.m @user` message statistics command.
async function renderMessageStatsCard({guild, user, totalMessages, todayMessages}) {
 const { createCanvas, loadImage } = require('@napi-rs/canvas');
 const canvas=createCanvas(1500,650), ctx=canvas.getContext('2d');
 const bg=ctx.createLinearGradient(0,0,1500,650); bg.addColorStop(0,'#0b1020'); bg.addColorStop(.55,'#151b30'); bg.addColorStop(1,'#080d18');
 ctx.fillStyle=bg; ctx.fillRect(0,0,1500,650);
 ctx.fillStyle='#9146d8'; ctx.fillRect(0,0,1500,9);
 ctx.globalAlpha=.12; ctx.fillStyle='#b86cff'; ctx.beginPath(); ctx.arc(1370,90,220,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1;
 const rr=(x,y,w,h,r,fill,stroke)=>{ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}};
 const txt=(t,x,y,size,color,weight='600',align='left')=>{ctx.fillStyle=color;ctx.font=`${weight} ${size}px Sans`;ctx.textAlign=align;ctx.fillText(String(t),x,y);ctx.textAlign='left';};
 try { const avatar=await loadImage(user.displayAvatarURL({extension:'png',size:256})); ctx.save();ctx.beginPath();ctx.arc(110,120,66,0,Math.PI*2);ctx.clip();ctx.drawImage(avatar,44,54,132,132);ctx.restore();ctx.strokeStyle='#b86cff';ctx.lineWidth=4;ctx.beginPath();ctx.arc(110,120,68,0,Math.PI*2);ctx.stroke(); } catch {}
 txt('MESSAGE STATISTICS',215,92,34,'#f7f5ff','700');
 txt('@'+String(user.username).slice(0,30),215,130,23,'#aeb4c8','500');
 txt(guild.name,215,164,20,'#7f879d','500');
 rr(55,230,665,260,24,'#171d31','#313b58'); rr(780,230,665,260,24,'#171d31','#313b58');
 txt('TODAY MESSAGES',95,290,22,'#aeb4c8','700'); txt(Number(todayMessages).toLocaleString('en-IN'),95,375,62,'#b86cff','700'); txt('Valid messages today',95,420,20,'#7f879d','500');
 txt('TOTAL MESSAGES',820,290,22,'#aeb4c8','700'); txt(Number(totalMessages).toLocaleString('en-IN'),820,375,62,'#75e0a6','700'); txt('Valid messages lifetime',820,420,20,'#7f879d','500');
 txt('SPAM MESSAGES ARE NOT COUNTED',750,565,20,'#7f879d','600','center');
 txt('NEXZU • MESSAGE TRACKER',750,610,18,'#9a83b8','600','center');
 return canvas.toBuffer('image/png');
}

client.on('messageCreate', async message => {
 // Prefix command replies use the same branded embed style as slash commands.
 // Existing embed/image replies are preserved by nexzuCommandPayload().
 const _messageReply=message.reply.bind(message);
 message.reply=(payload)=>_messageReply(nexzuCommandPayload(payload, (message.content.trim().match(/^\.([a-z0-9-]+)/i)||[])[1] || 'command'));
 // Staff management: authorised managers only.
 if (!message.author.bot && message.guild) {
  const rawStaff = message.content.trim();
  const staffAdd = rawStaff.match(/^\.staff\s+<@!?([0-9]+)>$/i);
  const staffRemove = rawStaff.match(/^\.remove\s+staff\s+<@!?([0-9]+)>$/i);
  if (staffAdd || staffRemove) {
   const action = staffAdd ? 'add' : 'remove';
   const targetId = (staffAdd || staffRemove)[1];
   const actor = message.member;

   if (!isAuthorisedStaffManager(actor)) {
    await sendStaffEmbed(message.channel, {
     title: 'Access Denied',
     description: `${CHILLY_EMOJI.rejected} You are not authorised to manage the **Staff** role.\n\n${CHILLY_EMOJI.dot} Only the **server owner**, **bot owner**, **Administrators**, or members with the **Authority** role can use this command.`,
     actor: message.author,
     success: false
    });
    return;
   }

   const target = await message.guild.members.fetch(targetId).catch(() => null);
   if (!target) {
    await sendStaffEmbed(message.channel, {
     title: 'Member Not Found',
     description: `${CHILLY_EMOJI.rejected} I couldn't find that member in this server. Please mention a valid server member.`,
     actor: message.author,
     success: false
    });
    return;
   }
   if (target.user.bot) {
    await sendStaffEmbed(message.channel, {
     title: 'Invalid Target',
     description: `${CHILLY_EMOJI.rejected} Bots cannot be added to or removed from the Staff role.`,
     target: target,
     actor: message.author,
     success: false
    });
    return;
   }

   const staffRole = await ensureStaffRole(message.guild);
   if (!staffRole) {
    await sendStaffEmbed(message.channel, {
     title: 'Staff Role Unavailable',
     description: `${CHILLY_EMOJI.rejected} I couldn't access or create the **Staff ✦** role. Make sure Nexzu has **Manage Roles** permission.`,
     actor: message.author,
     success: false
    });
    return;
   }

   const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
   if (!botMember || staffRole.position >= botMember.roles.highest.position) {
    await sendStaffEmbed(message.channel, {
     title: 'Role Hierarchy Error',
     description: `${CHILLY_EMOJI.rejected} I cannot manage the **${staffRole.name}** role because it is above or equal to my highest role. Move the Staff role below Nexzu's role and try again.`,
     actor: message.author,
     success: false
    });
    return;
   }

   if (target.id === message.guild.ownerId || target.roles.highest.position >= botMember.roles.highest.position) {
    await sendStaffEmbed(message.channel, {
     title: 'Member Hierarchy Error',
     description: `${CHILLY_EMOJI.rejected} I cannot change roles for ${target} because that member is the server owner or has a role at/above Nexzu's highest role.`,
     target: target,
     actor: message.author,
     success: false
    });
    return;
   }

   if (action === 'add') {
    if (target.roles.cache.has(staffRole.id)) {
     await sendStaffEmbed(message.channel, {
      title: 'Already Staff',
      description: `${CHILLY_EMOJI.dot} ${target} is already part of the **Staff** team.`,
      target: target,
      actor: message.author,
      success: false
     });
     return;
    }
    const added = await target.roles.add(staffRole, `Staff added by ${message.author.tag} (${message.author.id})`).then(() => true).catch(() => false);
    if (!added) {
     await sendStaffEmbed(message.channel, {
      title: 'Staff Update Failed',
      description: `${CHILLY_EMOJI.rejected} Discord rejected the Staff role update. Check Nexzu's **Manage Roles** permission and role hierarchy.`,
      target: target,
      actor: message.author,
      success: false
     });
     return;
    }
    await sendStaffEmbed(message.channel, {
     title: 'Staff Member Added',
     description: `${CHILLY_EMOJI.success} ${target} has been added to the **Staff** team successfully.\n\n${CHILLY_EMOJI.crown2} **Staff Role:** ${staffRole}\n${CHILLY_EMOJI.dot} The member can now access staff areas protected by this role.`,
     target: target,
     actor: message.author,
     success: true
    });
   } else {
    if (!target.roles.cache.has(staffRole.id)) {
     await sendStaffEmbed(message.channel, {
      title: 'Not a Staff Member',
      description: `${CHILLY_EMOJI.dot} ${target} does not currently have the **Staff** role.`,
      target: target,
      actor: message.author,
      success: false
     });
     return;
    }
    const removed = await target.roles.remove(staffRole, `Staff removed by ${message.author.tag} (${message.author.id})`).then(() => true).catch(() => false);
    if (!removed) {
     await sendStaffEmbed(message.channel, {
      title: 'Staff Update Failed',
      description: `${CHILLY_EMOJI.rejected} Discord rejected the Staff role removal. Check Nexzu's **Manage Roles** permission and role hierarchy.`,
      target: target,
      actor: message.author,
      success: false
     });
     return;
    }
    await sendStaffEmbed(message.channel, {
     title: 'Staff Member Removed',
     description: `${CHILLY_EMOJI.success} ${target} has been removed from the **Staff** team successfully.\n\n${CHILLY_EMOJI.rejected} **Staff Role:** ${staffRole}\n${CHILLY_EMOJI.dot} Staff-only access provided by this role has been revoked.`,
     target: target,
     actor: message.author,
     success: true
    });
   }
   return;
  }
 }
 if(!message.author.bot && message.guild && message.content.trim().toLowerCase() === '.spdy') {
  // Only the configured bot owner may run this destructive command.
  if(message.author.id !== TRUSTED_OWNER_ID) {
   await message.delete().catch(()=>{});
   return;
  }

 const guild = message.guild;
 const botMember = guild.members.me || await guild.members.fetchMe().catch(()=>null);
 if(!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
  await message.reply('❌ Nexzu needs **Manage Channels** permission to remove server channels.').catch(()=>{});
  return;
 }

 await message.delete().catch(()=>{});
 const status = await message.channel.send('🗑️ **.spdy started:** removing all server channels and categories. Members and roles will remain untouched.').catch(()=>null);

 let deleted = 0, failed = 0;
 const channels = await guild.channels.fetch().catch(error => {
  console.error('.spdy could not fetch channels:', error?.message || error);
  return null;
 });
 if(!channels) {
  if(status) await status.edit('❌ I could not fetch the server channels. Nothing was deleted.').catch(()=>{});
  return;
 }

 const ordered = [...channels.values()].sort((a,b) =>
  (a.type === ChannelType.GuildCategory ? 1 : 0) -
  (b.type === ChannelType.GuildCategory ? 1 : 0)
 );
 for(const channel of ordered) {
  try {
   await channel.delete(`Owner-only .spdy channel reset requested by ${TRUSTED_OWNER_ID}`);
   deleted++;
  } catch(error) {
   failed++;
   console.error(`.spdy could not delete ${channel.name}:`, error?.message || error);
  }
 }

 const report = `🗑️ **.spdy finished for ${guild.name}.**\n• Deleted: **${deleted}**\n• Failed: **${failed}**\n• Members and roles: **not changed**`;
 if(status) await status.edit(report).catch(()=>{});
 }

 // Owner-only Coffee & Chill invite event announcement.
 if(message.guild && message.content.trim().toLowerCase() === '.event') {
  if(message.author.id !== TRUSTED_OWNER_ID) {
   return message.reply('⛔ Only the bot owner can use `.event`.').catch(()=>{});
  }
  const eventEmbed = new EmbedBuilder()
   .setColor(0xE53935)
   .setDescription(`<a:ArrowHeart:1563854239326015589> **INVITE AND EARN** <a:Xieron_stolen_emoji_1788513288:1563854359299625010>

***<:f1logo:1563847827329908817> A new event is here! Bring your friends, grow our community and grab exciting rewards ♡

<a:nitro:1567132488382419035> **𝖱𝖤𝖶𝖠𝖱𝖣𝖲**

<:red_dot:1563849526740127814> 5 Invites — ₹40 INR <a:money_sign:1567134006422798406>
<:red_dot:1563849526740127814> 10 Invites — Nitro <a:NITRO:1567132437329223701> Basic Acc (for 1 month)

<:rules:1567132632628727880> **𝖱𝖴𝖫𝖤𝖲**

<a:arrow_7:1566815433191985224> Only genuine invites count.
<a:arrow_7:1566815433191985224> Fake and alt accounts are not allowed.
<a:arrow_7:1566815433191985224> Invites will be verified by staff.
<a:arrow_7:1566815433191985224> Only new invites will be counted! Old invites are not eligible for rewards.

<a:emoji_2:1566500432941949001> **𝖧𝖮𝖶 𝖳𝖮 𝖢𝖫𝖠𝖨𝖬**
Open a ticket to claim your reward after reaching the required invites!

<a:senpai_cutie_walk:1566815080547360950> Start inviting and grab your rewards!

Good luck, everyone! ♡***`);
  try {
   await message.channel.send({embeds:[eventEmbed]});
   const posterPath = path.join(__dirname, 'event-poster.png');
   await message.channel.send({files:[new AttachmentBuilder(posterPath, {name:'coffee-chill-invite-event.png'})]});
  } catch(error) {
   console.error('.event command failed:', error);
   return message.reply('❌ I could not send the event announcement. Check my channel permissions and make sure `event-poster.png` is included with the bot files.').catch(()=>{});
  }
  return;
 }

 if(message.guild && !message.webhookId && message.content.trim().length >= 2) {
  const now=Date.now(), row=getLevelRow(message.guild.id,message.author.id);
  if(now-row.last_message>=60000) {
   const gain=15+Math.floor(Math.random()*11), before=levelFromXp(row.xp), total=row.xp+gain, after=levelFromXp(total);
   db.prepare('UPDATE leveling_xp SET xp=?,last_message=? WHERE guild=? AND user=?').run(total,now,message.guild.id,message.author.id);
   if(after.level>before.level) {
    const reward=db.prepare('SELECT role FROM leveling_rewards WHERE guild=? AND level=?').get(message.guild.id,after.level);
    let rewardText='';
    if(reward) {
     try {
      const role=await message.guild.roles.fetch(reward.role);
      if(role && !role.managed && role.position<message.guild.members.me.roles.highest.position) { await message.member.roles.add(role,'Level reward'); rewardText=` You earned ${role}!`; }
     } catch(error) { console.error('Level reward assignment failed:',error.message); }
    }
    const channelId=db.prepare("SELECT value FROM chilly_config WHERE guild=? AND key='levelup_channel'").get(message.guild.id)?.value;
    const channel=channelId?await message.guild.channels.fetch(channelId).catch(()=>null):message.channel;
    const template=db.prepare("SELECT value FROM chilly_config WHERE guild=? AND key='levelup_message'").get(message.guild.id)?.value || '🎉 {user} reached **Level {level}**!';
    const content=template.replaceAll('{user}',`<@${message.author.id}>`).replaceAll('{level}',String(after.level)).replaceAll('{xp}',String(total))+rewardText;
    if(channel?.isTextBased()) await channel.send({content,allowedMentions:{users:[message.author.id]}}).catch(()=>{});
   }
  }
 }
 // Owner-only display command: these are fictional labels, not Discord accounts or real members.
 if (message.guild && message.content.trim().toLowerCase() === '!add-members') {
  if (message.author.id !== TRUSTED_OWNER_ID) {
   return message.reply('⛔ Only the bot owner can use `!add-members`.').catch(()=>{});
  }
  const defaults = ['Alex', 'Mia', 'Jonny', 'Comtozia', 'Liam', 'Sophia', 'Noah', 'Ava'];
  const addName = db.prepare('INSERT OR IGNORE INTO fictional_members (guild,name) VALUES (?,?)');
  for (const name of defaults) addName.run(message.guild.id, name);
  const names = db.prepare('SELECT name FROM fictional_members WHERE guild=? ORDER BY name COLLATE NOCASE').all(message.guild.id).map(row => `• ${row.name}`);
  const embed = chillyStyledEmbed({title:`${CHILLY_EMOJI.member} Fictional Member List`,description:names.join('\n') || `${CHILLY_EMOJI.dot} No fictional names have been added.`,footer:'Nexzu • Display-only list'});
  return message.reply({ embeds: [embed] }).catch(()=>{});
 }
 if(message.guild && message.content) {
  const lower=message.content.toLowerCase();
  const matches=db.prepare('SELECT trigger,emoji FROM autoreactions WHERE guild=?').all(message.guild.id).filter(row=>lower.includes(row.trigger));
  for(const row of matches.slice(0,3)) { try { const parsed=normalizeReactionEmoji(row.emoji); await message.react(parsed.reactValue); } catch(error) { console.error('Auto-reaction failed:',error.message); } }
 }
 const rawPrefix=message.content.trim().toLowerCase();
 if(message.guild && rawPrefix.startsWith('?steal')) {
  if(!message.member.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers) && message.author.id!==TRUSTED_OWNER_ID && message.author.id!==message.guild.ownerId) return message.reply('⛔ You need **Manage Expressions** permission to use ?steal.').catch(()=>{});
  const source=message.reference?.messageId ? await message.channel.messages.fetch(message.reference.messageId).catch(()=>null) : null;
  if(!source) return message.reply('Reply directly to a message containing a custom emoji or sticker, then type `?steal`.').catch(()=>{});
  try { const result=await stealFromSourceMessage(message.guild,source); return message.reply(result.message).catch(()=>{}); }
  catch(error) { console.error('?steal failed:',error); return message.reply('❌ I could not add that emoji/sticker. Check Manage Expressions permission and your server emoji/sticker limit.').catch(()=>{}); }
 }
 if(message.guild && (rawPrefix==='.hide'||rawPrefix==='.unhide')) {
  const canManage=message.member.permissions.has(PermissionFlagsBits.ManageChannels)||message.member.permissions.has(PermissionFlagsBits.Administrator)||message.author.id===message.guild.ownerId||message.author.id===TRUSTED_OWNER_ID;
  if(!canManage) return message.reply('⛔ You need **Manage Channels** to use this.').catch(()=>{});
  const everyone=message.guild.roles.everyone;
  try { await message.channel.permissionOverwrites.edit(everyone, {ViewChannel:rawPrefix==='.unhide'?true:false}); return message.reply(rawPrefix==='.hide'?'🙈 Channel hidden from @everyone.':'👀 Channel visible to @everyone again.'); }
  catch { return message.reply('❌ I need **Manage Channels** and permission to edit this channel.').catch(()=>{}); }
 }

 // Secret !setup: only the configured bot owner can build the Lovespot layout.
 if (message.content.trim().toLowerCase() === '!setup') {
  if (message.author.id !== TRUSTED_OWNER_ID) return; // Keep this command undiscoverable.
  const guild = message.guild;
  if (!guild) return;

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
   return message.reply('❌ Nexzu needs **Manage Channels** and **Manage Roles** permissions.').catch(() => {});
  }

  // Role colours and suffix symbols are matched to the supplied Lovespot screenshots.
  // Hex colours approximate the coloured dots shown beside each Discord role.
  const roleSpecs = [
   { key: 'Staff', name: 'Staff', color: '#99AAB5', suffix: ' ✦' },
   { key: 'Authority', name: 'Authority', color: '#99AAB5', suffix: ' ⚑' },
   { key: 'VIP', name: 'Vip', color: '#CD853F', suffix: ' · VIP' },
   { key: 'Guest', name: 'Guest', color: '#E67E22', suffix: ' 👑' },
   { key: 'Artist', name: 'Artist', color: '#E67E22', suffix: ' 🎨' },
   { key: 'Specials', name: 'Specials', color: '#ED1C24', suffix: ' 🪅' },
   { key: 'Chairman', name: 'Chairman', color: '#99AAB5', suffix: ' 💢' },
   { key: 'The Decision Maker', name: 'The Decision Maker', color: '#99AAB5', suffix: ' ₿' },
   { key: 'Director of Influence', name: 'Director of Influence', color: '#99AAB5', suffix: ' ☪' },
   { key: 'President', name: 'President', color: '#99AAB5', suffix: ' 💎' },
   { key: 'Captain', name: 'Captain', color: '#99AAB5', suffix: ' ⚔️' },
   { key: 'Overseer', name: 'Overseer', color: '#99AAB5', suffix: ' †' },
   { key: 'Mystics', name: 'Mystics', color: '#99AAB5', suffix: ' 🐺' },
   { key: 'Arcane Oracle 20', name: 'Arcane Oracle 20', color: '#77A37C', suffix: ' 💚' },
   { key: 'Celestial Nomad 10', name: 'Celestial Nomad 10', color: '#8E6CC8', suffix: ' 👹' },
   { key: 'Shadowy Scout 5', name: 'Shadowy Scout 5', color: '#F4B6C2', suffix: ' ❄️' },
   { key: 'Single', name: 'Single', color: '#99AAB5', suffix: ' 🔒' },
   { key: '-18', name: '-18', color: '#99AAB5', suffix: ' 🔞' },
   { key: '18+', name: '18+', color: '#99AAB5', suffix: ' 🔞' },
   { key: 'He // Him', name: 'He // Him', color: '#3498DB', suffix: ' 🩵' },
   { key: 'Hex Red', name: 'hex Red', color: '#ED1C24', suffix: ' ·' },
   { key: 'Lovespot Link', name: 'discord.gg/lovespot', color: '#99AAB5', suffix: '' },
   { key: 'Famzz', name: '/famzz?', color: '#99AAB5', suffix: ' 🦋' }
  ];

  // Match either the original plain role or its styled name. Existing permissions
  // are preserved while the role name and colour are brought in line with the screenshots.
  const roleMap = new Map();
  let rolesCreated = 0, rolesStyled = 0;
  for (const spec of roleSpecs) {
   const styledName = `${spec.name}${spec.suffix}`;
   let role = guild.roles.cache.find(r => r.name === styledName || r.name === spec.name);
   if (!role) {
    role = await guild.roles.create({
     name: styledName,
     color: spec.color,
     reason: 'Owner-only Lovespot role styling setup'
    });
    rolesCreated++;
   } else if (role.name !== styledName || role.hexColor.toLowerCase() !== spec.color.toLowerCase()) {
    await role.edit({
     name: styledName,
     color: spec.color,
     reason: 'Apply Lovespot screenshot role styling'
    });
    rolesStyled++;
   }
   roleMap.set(spec.key, role);
  }

  const layout = [
   { category: '☁️・Click Here ♢‼', channels: [
    ['／lovespot・.', ChannelType.GuildText, 'lovespot']
   ]},
   { category: '🌿・Important ?', channels: [
    ['X・announces・🫧', ChannelType.GuildText, 'X-announces'],
    ['+ 🍁・self・role♡', ChannelType.GuildText, 'self-role'],
    ['+ 🌸・hex・♡', ChannelType.GuildText, 'hex'],
    ['♧・richh・🍨・◦', ChannelType.GuildText, 'richh'],
    ['.・rulebook・🪶', ChannelType.GuildText, 'rulebook'],
    ['🧊・report', ChannelType.GuildText, 'report'],
    ['ѳ・🎁drops・°', ChannelType.GuildText, 'drops']
   ]},
   { category: '🌿・Promotions ?', channels: [
    ['💰・invite-event・▦', ChannelType.GuildText, 'invite-event'],
    ['💰・invite-rules・▦', ChannelType.GuildText, 'invite-rules'],
    ['!!💌・proofs〜・!', ChannelType.GuildText, 'proofs'],
    ['▢・💸vouches : 𝓿', ChannelType.GuildText, 'vouches'],
    ['.・daily・drop”・💰', ChannelType.GuildText, 'daily-drop'],
    ['.・event・rule🧊', ChannelType.GuildText, 'event-rule'],
    [', X・promo-info・🛍️', ChannelType.GuildText, 'promo-info'],
    ['.・promo-1・🍷', ChannelType.GuildText, 'promo-1']
   ]},
   { category: '🌿・Access ?', channels: [
    ['X・giveaway・*・🦋', ChannelType.GuildText, 'giveaway'],
    ['🧊・ticket・°✦', ChannelType.GuildText, 'ticket'],
    ['🧊・staff-apply・◦', ChannelType.GuildText, 'staff-apply']
   ]},
   { category: '💎・pvt Access ? ✦', privateRoles: ['Staff', 'Authority', 'VIP'], channels: [
    ['🦖・Mayank-vc・!', ChannelType.GuildText, 'Mayank-vc'],
    ['🍁・Strofen・Pvt‼・', ChannelType.GuildText, 'Strofen-pvt'],
    ['・team-pvt', ChannelType.GuildText, 'team-pvt']
   ]},
   { category: '🌿・Staff’s pvt!', privateRoles: ['Staff', 'Authority'], channels: [
    ['🔑・staff・vc', ChannelType.GuildText, 'staff-vc']
   ]},
   { category: '🌿・Chatting ?', channels: [
    ['✉️♡・general-chat!・', ChannelType.GuildText, 'general-chat'],
    ['🗣️・lafda・chat', ChannelType.GuildText, 'lafda-chat'],
    ['//+・🕊️・media-chat', ChannelType.GuildText, 'media-chat'],
    ['〜・commands・🥤', ChannelType.GuildText, 'commands'],
    ['zZ・//level-up・', ChannelType.GuildText, 'level-up']
   ]},
   { category: '🌿・Lounge Area ?', channels: [
    ['🍹・verification・★°', ChannelType.GuildText, 'verification']
   ], voice: [
    ['☁️・Toxic VC・☤', 'Toxic VC'], ['🍸・Lounge 1', 'Lounge 1'], ['🍸・Lounge 2', 'Lounge 2'],
    ['🍸・Lounge 3', 'Lounge 3'], ['🍸・Lounge 4', 'Lounge 4']
   ]},
   { category: '🌿・Pvt VC’s ?', channels: [
    ['🪐・vc-controlz・𝓿', ChannelType.GuildText, 'vc-controlz']
   ], voice: [['📞・Create Your VC’s', 'Create Your VC’s']]},
   { category: '🌵・music & Chill ◇‼', voice: [
    ['🥤・Music 1・℮', 'Music 1'], ['🥤・Music 2・℮', 'Music 2'], ['🥤・Music 3・℮', 'Music 3'],
    ['🥤・Music 4・℮', 'Music 4'], ['🥤・Music 5・℮', 'Music 5']
   ]},
   { category: '🍬・Game’s ?', channels: [
    ['ѳ🍭・owo・', ChannelType.GuildText, 'owo'],
    ['.・ship・🧸', ChannelType.GuildText, 'ship'],
    ['.・truth-dare・👛', ChannelType.GuildText, 'truth-dare'],
    ['🎀・pokétwo・૯૯', ChannelType.GuildText, 'poketwo']
   ]},
   { category: '💎・PFPS / BANNERS ? ✦', channels: [
    ['<3・boys・pfp・🖐🏻', ChannelType.GuildText, 'boys-pfp'],
    ['<3・girl・pfp・👚', ChannelType.GuildText, 'girl-pfp'],
    ['<3・couple・pfpz・💌', ChannelType.GuildText, 'couple-pfpz'],
    ['<3・banners・🎀', ChannelType.GuildText, 'banners']
   ]},
   { category: '☁️・Private VCs ✦‼', privateRoles: ['Staff', 'Authority', 'VIP'], voice: [
    ['🍭・Duo 1', 'Duo 1'], ['🍭・Duo 2', 'Duo 2'], ['🥤・Trio 1', 'Trio 1']
   ]}
  ];

  const status = await message.reply('⚙️ **Soulmate setup started.** I’ll create missing roles, categories and channels; existing content will not be deleted.').catch(() => null);
  let categoriesCreated = 0, channelsCreated = 0, channelsStyled = 0, skipped = 0;
  try {
   for (const group of layout) {
    let category = guild.channels.cache.find(ch =>
     ch.type === ChannelType.GuildCategory && ch.name === group.category
    );

    const overwrites = [];
    if (group.privateRoles) {
     overwrites.push({
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
     });
     for (const roleName of group.privateRoles) {
      const role = roleMap.get(roleName);
      if (role) overwrites.push({
       id: role.id,
       allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak
       ]
      });
     }
     // Keep the bot able to manage and report on its private setup channels.
     overwrites.push({
      id: botMember.id,
      allow: [
       PermissionFlagsBits.ViewChannel,
       PermissionFlagsBits.ReadMessageHistory,
       PermissionFlagsBits.SendMessages,
       PermissionFlagsBits.Connect,
       PermissionFlagsBits.Speak,
       PermissionFlagsBits.ManageChannels
      ]
     });
    }

    if (!category) {
     category = await guild.channels.create({
      name: group.category,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
      reason: 'Owner-only Lovespot server setup'
     });
     categoriesCreated++;
    } else if (group.privateRoles) {
     // Apply privacy to an already-existing private category as well.
     await category.permissionOverwrites.set(overwrites, 'Apply Lovespot private-category access');
    }

    const items = [
     ...(group.channels || []).map(([name, type, baseName]) => ({ name, baseName, type })),
     ...(group.voice || []).map(([name, baseName]) => ({ name, baseName, type: ChannelType.GuildVoice }))
    ];

    for (const item of items) {
     const exists = guild.channels.cache.find(ch =>
      ch.parentId === category.id && ch.type === item.type &&
      (ch.name === item.name || (item.baseName && ch.name === item.baseName))
     );
     if (exists) {
      if (exists.name !== item.name) {
       await exists.edit({ name: item.name, reason: 'Apply Lovespot screenshot channel styling' });
       channelsStyled++;
      } else skipped++;
      continue;
     }
     await guild.channels.create({
      name: item.name,
      type: item.type,
      parent: category.id,
      reason: 'Owner-only Lovespot server setup'
     });
     channelsCreated++;
    }
   }

   const summary = `✅ **Lovespot setup completed!**\n` +
    `• Roles created: **${rolesCreated}**\n` +
    `• Existing roles styled: **${rolesStyled}**\n` +
    `• Categories created: **${categoriesCreated}**\n` +
    `• Channels created: **${channelsCreated}**\n` +
    `• Existing channels styled: **${channelsStyled}**\n` +
    `• Already existed: **${skipped}**\n` +
    `• Private categories: **permissions configured**\n` +
    `Nothing existing was deleted.`;
   if (status) await status.edit(summary).catch(() => {});
   else await message.channel.send(summary).catch(() => {});
  } catch (error) {
   console.error('!setup error:', error);
   const failure = `⚠️ **Lovespot setup stopped.** Created so far: ${rolesCreated} roles, ${categoriesCreated} categories and ${channelsCreated} channels.\nError: \`${String(error.message || error).slice(0, 250)}\`\nCheck Manage Roles / Manage Channels and the bot role position.`;
   if (status) await status.edit(failure).catch(() => {});
   else await message.channel.send(failure).catch(() => {});
  }
  return;
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
  const ad = chillyStyledEmbed({title:`${CHILLY_EMOJI.bot} Nexzu • Multipurpose Discord Bot`,description:`Hey <@1312960418288898062>, I am **Nexzu**, a multipurpose Discord bot.


You have just added me to **𓂃𐙚 Coffee & Chill™ | Gwys • Fun • Social • Community • Chill** to enjoy moderation, giveaways, economy, utility and more.


To get started, invite Nexzu to your server and use **/help** to explore the available commands.


🌐 **Support Server:** https://discord.gg/zFMWXFC25R


~ Powered by Spidyyy`,
   footer:'Powered By Nexzu Development™ | Designed By Spidyyy'});
  try {
   await target.send({embeds:[ad]});
   await message.reply(`✅ Advertisement DM sent to ${target.tag}.`).catch(()=>{});
  } catch {
   await message.reply(`❌ I couldn't DM ${target.tag}. Their DMs may be closed or they may have blocked the bot.`).catch(()=>{});
  }
  return;
 }
 if(!message.guild) return;
 const prefixRaw=message.content.trim();

 // `.m` shows valid message statistics as an image. `.m @user` checks another member.
 if(/^\.m(?:\s+([\s\S]+))?$/i.test(prefixRaw)) {
  const arg=prefixRaw.match(/^\.m(?:\s+([\s\S]+))?$/i)?.[1]?.trim()||'';
  const mentioned=message.mentions.users.first();
  const token=arg.replace(/<@!?(\d+)>/,'$1').trim();
  const target=mentioned || (token && /^\d{15,22}$/.test(token) ? await client.users.fetch(token).catch(()=>null) : message.author);
  if(!target) return message.reply(`${CHILLY_EMOJI.rejected} I couldn't find that member.`).catch(()=>{});
  const day=new Date().toISOString().slice(0,10);
  const total=Number(db.prepare('SELECT messages FROM real_money_users WHERE guild=? AND user=?').get(message.guild.id,target.id)?.messages||0);
  const today=Number(db.prepare('SELECT messages FROM message_daily WHERE guild=? AND user=? AND day=?').get(message.guild.id,target.id,day)?.messages||0);
  try {
   const buffer=await renderMessageStatsCard({guild:message.guild,user:target,totalMessages:total,todayMessages:today});
   return message.reply({files:[new AttachmentBuilder(buffer,{name:`message-stats-${target.id}.png`})]}).catch(()=>{});
  } catch(error) {
   console.error('.m card failed:',error);
   return message.reply(`${CHILLY_EMOJI.rejected} Message stats card failed to render.`).catch(()=>{});
  }
 }


 // Every registered slash command is also available with a dot prefix.
 // Examples: `.ping`, `.ban @user`, `.gstart "Nitro" 1h 1`, `.help`.
 if(/^\.(?:antinuke|automod|antibot|mainrole)$/i.test(prefixRaw)) {
  const alias=prefixRaw.slice(1).toLowerCase();
  const usage={
   antinuke:'Use `.antinuke config`, `.antinuke limit`, `.antinuke punishment`, or `.antinuke reset`.',
   automod:'Use `.automod config`, `.automod enable`, `.automod disable`, `.automod ignore`, `.automod logging`, `.automod punishment`, or `.automod unignore`.',
   antibot:'Use `.antibot config`, `.antibot add @bot`, `.antibot remove @bot`, `.antibot reset`, or `.antibot whitelist`.',
   mainrole:'Use `.mainrole list`, `.mainrole add @role`, `.mainrole remove @role`, or `.mainrole reset`.'
  };
  return message.reply(usage[alias]).catch(()=>{});
 }
 // Extra screenshot-style prefix commands (Jail, Misc, Tickets).
 const extra = prefixRaw.match(/^\.([a-z-]+)(?:\s+([\s\S]*))?$/i);
 if(extra) {
  const cmd=extra[1].toLowerCase(), args=(extra[2]||'').trim();
  const mention=message.mentions.members.first();
  const fetchMember=async token=>{
   if(mention) return mention;
   const id=(token||'').replace(/[<@!>]/g,'');
   if(/^\d{15,22}$/.test(id)) return message.guild.members.fetch(id).catch(()=>null);
   return null;
  };
  const isMod=message.member.permissions.has(PermissionFlagsBits.ManageRoles)||message.member.permissions.has(PermissionFlagsBits.ModerateMembers);

  if(cmd==='afk') {
   const row=db.prepare('SELECT * FROM afk_status WHERE guild=? AND user=?').get(message.guild.id,message.author.id);
   if(!args && row) { db.prepare('DELETE FROM afk_status WHERE guild=? AND user=?').run(message.guild.id,message.author.id); return message.reply(`${CHILLY_EMOJI.success} Your AFK status has been removed.`).catch(()=>{}); }
   if(!args && !row) return message.reply('Usage: `.afk [reason]`').catch(()=>{});
   db.prepare('INSERT INTO afk_status(guild,user,reason,created) VALUES(?,?,?,?) ON CONFLICT(guild,user) DO UPDATE SET reason=excluded.reason,created=excluded.created').run(message.guild.id,message.author.id,args,Date.now());
   return message.reply(`${CHILLY_EMOJI.success} You are now AFK: **${args}**`).catch(()=>{});
  }
  if(cmd==='avatar') {
   const u=mention?.user || message.author;
   return message.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.member} ${u.username}'s Avatar`,description:`[Open Avatar](${u.displayAvatarURL({size:4096})})`,thumbnail:false}).setImage(u.displayAvatarURL({size:4096}))]}).catch(()=>{});
  }
  if(cmd==='banner') {
   const token=args.replace(/[<@!>]/g,'').split(/\s+/)[0];
   const u=(mention?.user)||(/^\d{15,22}$/.test(token)?await client.users.fetch(token).catch(()=>null):null)||message.author;
   const full=await client.users.fetch(u.id,{force:true}).catch(()=>u);
   const url=full.bannerURL?.({size:4096})||null;
   if(!url) return message.reply(`${CHILLY_EMOJI.rejected} ${full.username} does not have a profile banner.`).catch(()=>{});
   return message.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.member} ${full.username}'s Banner`,description:`[Open Banner](${url})`,thumbnail:false}).setImage(url)]}).catch(()=>{});
  }
  if(cmd==='devices') {
   const m=mention||message.member; const acts=m?.presence?.activities||[];
   const text=acts.length?acts.map(a=>`• **${a.name}**${a.state?` — ${a.state}`:''}`).join('\n'):'No active Discord activity detected.';
   return message.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} ${m.user.username}'s Activity`,description:text})]}).catch(()=>{});
  }
  if(cmd==='list') {
   const sub=args.split(/\s+/)[0]?.toLowerCase()||'members'; let members=[...message.guild.members.cache.values()];
   if(sub==='admins') members=members.filter(m=>m.permissions.has(PermissionFlagsBits.Administrator));
   else if(sub==='boosters') members=members.filter(m=>!!m.premiumSince);
   else if(sub==='bots') members=members.filter(m=>m.user.bot);
   else if(sub==='early') members=members.filter(m=>m.user.flags?.has?.('EarlySupporter'));
   else if(sub==='emojis') { const em=[...message.guild.emojis.cache.values()]; return message.reply({embeds:[chillyStyledEmbed({title:'😀 Server Emojis',description:em.length?em.map(e=>String(e)+' '+e.name).join('\n').slice(0,4000):'No server emojis.'})]}).catch(()=>{}); }
   else if(sub==='inrole') { const role=message.mentions.roles.first(); if(!role) return message.reply('Usage: `.list inrole @role`').catch(()=>{}); members=members.filter(m=>m.roles.cache.has(role.id)); }
   const shown=members.slice(0,50).map(m=>`• ${m} — ${m.user.tag}`).join('\n')||'No matching members.';
   return message.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} List ${sub}`,description:shown+(members.length>50?`\n\n…and ${members.length-50} more.`:'' )})]}).catch(()=>{});
  }
  if(cmd==='inviteinfo') {
   const code=(args.match(/(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)?([A-Za-z0-9-]+)/)||[])[1];
   if(!code) return message.reply('Usage: `.inviteinfo <invite>`').catch(()=>{});
   const inv=await client.fetchInvite(code,{withCounts:true}).catch(()=>null);
   if(!inv) return message.reply(`${CHILLY_EMOJI.rejected} Invalid or unavailable invite.`).catch(()=>{});
   const desc=[`**Server:** ${inv.guild?.name||'Unknown'}`,`**Invite:** ${inv.code}`,`**Members:** ${inv.memberCount??'Unknown'}`,`**Online:** ${inv.presenceCount??'Unknown'}`,`**Channel:** ${inv.channel?.name?`#${inv.channel.name}`:'Unknown'}`].join('\n');
   return message.reply({embeds:[chillyStyledEmbed({title:`${CHILLY_EMOJI.utility} Invite Information`,description:desc})]}).catch(()=>{});
  }
  if(cmd==='fakeperms') {
   if(!isMod) return message.reply('⛔ You need Manage Roles or Moderate Members to use this command.').catch(()=>{});
   const role=message.mentions.roles.first(); const perm=args.replace(/<@&\d+>/,'').trim()||'ViewChannel';
   if(!role) return message.reply('Usage: `.fakeperms @role <permission>`').catch(()=>{});
   return message.reply({embeds:[chillyStyledEmbed({title:'@ fakeperms',description:`Role: ${role}\nPermission preview: ${perm}\n\nThis command is a safe preview; Discord permissions are not actually modified.`})]}).catch(()=>{});
  }
  if(cmd==='jailsetup') {
   if(!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('⛔ Manage Roles permission required.').catch(()=>{});
   const role=message.mentions.roles.first(); if(!role) return message.reply('Usage: `.jailsetup @JailRole`').catch(()=>{});
   db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(message.guild.id,'jail_role',role.id);
   return message.reply(`${CHILLY_EMOJI.success} Jail role set to ${role}.`).catch(()=>{});
  }
  if(cmd==='jailsync') {
   const roleId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(message.guild.id,'jail_role')?.value;
   if(!roleId) return message.reply('Set the jail role first with `.jailsetup @role`.').catch(()=>{});
   const role=message.guild.roles.cache.get(roleId); if(!role) return message.reply('Saved jail role no longer exists.').catch(()=>{});
   return message.reply(`${CHILLY_EMOJI.success} Jail system synchronized. Configured role: ${role}.`).catch(()=>{});
  }
  if(cmd==='permit') {
   if(!isMod) return message.reply('⛔ Manage Roles or Moderate Members permission required.').catch(()=>{});
   const role=message.mentions.roles.first(); const action=args.split(/\s+/)[0]?.toLowerCase();
   if(!role||!['add','remove'].includes(action)) return message.reply('Usage: `.permit <add|remove> @role`').catch(()=>{});
   const key='jail_permit_role'; const current=(db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(message.guild.id,key)?.value||'').split(',').filter(Boolean);
   const set=new Set(current); action==='add'?set.add(role.id):set.delete(role.id);
   db.prepare('INSERT INTO chilly_config(guild,key,value) VALUES(?,?,?) ON CONFLICT(guild,key) DO UPDATE SET value=excluded.value').run(message.guild.id,key,[...set].join(','));
   return message.reply(`${CHILLY_EMOJI.success} ${action==='add'?'Added':'Removed'} ${role} ${action==='add'?'as':'from'} permitted jail staff.`).catch(()=>{});
  }
  if(cmd==='pjail') {
   if(!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('⛔ Moderate Members permission required.').catch(()=>{});
   const target=await fetchMember(args); const roleId=db.prepare('SELECT value FROM chilly_config WHERE guild=? AND key=?').get(message.guild.id,'jail_role')?.value;
   if(!target||!roleId) return message.reply('Usage: `.pjail @member [reason]` — configure jail first.').catch(()=>{});
   const role=message.guild.roles.cache.get(roleId); if(!role) return message.reply('Saved jail role no longer exists.').catch(()=>{});
   const reason=args.replace(/<@!?\d+>/,'').trim()||'No reason provided'; await target.roles.add(role,reason).catch(()=>null);
   return message.reply(`🔒 ${target.user.tag} has been permanently jailed.`).catch(()=>{});
  }
  if(cmd==='ticket') {
   const sub=args.split(/\s+/)[0]?.toLowerCase()||''; const rest=args.replace(/^\S+\s*/,'');
   if(!sub) return message.reply('Use `.ticket claim`, `.ticket close`, `.ticket config`, `.ticket delete`, `.ticket rename`, `.ticket panel`, `.ticket send`, or `.ticket setup`.').catch(()=>{});
   const topic=message.channel?.topic||''; const match=topic.match(/^chilly-ticket:(\d+):([^:]+):(\d+):?(\d*)$/);
   if(sub==='claim') { if(!match) return message.reply('This channel is not a Nexzu ticket.').catch(()=>{}); const [,opener,key,role,claimer]=match; if(claimer) return message.reply(`Already claimed by <@${claimer}>.`).catch(()=>{}); if(!message.member.roles.cache.has(role)&&!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('Only assigned ticket staff can claim this ticket.').catch(()=>{}); await message.channel.setTopic(`chilly-ticket:${opener}:${key}:${role}:${message.author.id}`); return message.reply(`Ticket claimed by ${message.author}.`).catch(()=>{}); }
   if(sub==='close') { if(!match||!match[4]) return message.reply('This is not a claimed Nexzu ticket.').catch(()=>{}); if(match[4]!==message.author.id&&!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('Only the claiming staff member or an Administrator can close it.').catch(()=>{}); await message.channel.permissionOverwrites.edit(match[1],{SendMessages:false}).catch(()=>{}); return message.reply('🔒 Ticket closed and locked.').catch(()=>{}); }
   if(sub==='delete') { if(!match&&!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('Only an Administrator can delete a non-ticket channel.').catch(()=>{}); await message.channel.delete('Ticket deleted by command').catch(()=>{}); return; }
   if(sub==='rename') { if(!match) return message.reply('This channel is not a Nexzu ticket.').catch(()=>{}); const name=rest.trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,90); if(!name) return message.reply('Usage: `.ticket rename <new_name>`').catch(()=>{}); await message.channel.setName(name); return message.reply(`${CHILLY_EMOJI.success} Ticket renamed to **${name}**.`).catch(()=>{}); }
   if(['config','panel','send','setup','edit'].includes(sub)) return message.reply('Ticket configuration is managed with `/ticket-setup`. Existing configured panels remain available.').catch(()=>{});
  }
 }
 if(prefixRaw.startsWith('.') && !/^\.(?:dm|staff|remove|withdraw|withdraw-paid|rich|bal|prof|rank)\b/i.test(prefixRaw)) {
  const parsed=await parsePrefixCommand(message,prefixRaw);
  if(parsed) {
   if(parsed.error) return message.reply(`${CHILLY_EMOJI.rejected} ${parsed.error}`).catch(()=>{});
   try { return await handleChatInputCommand(makePrefixInteraction(message,parsed)); }
   catch(error) { console.error('Dot-prefix command failed:',error); return message.reply(`${CHILLY_EMOJI.rejected} Command failed. Check the bot permissions and command arguments.`).catch(()=>{}); }
  }
 }


 // Owner-only command to mark a manually paid real-money withdrawal request.
 if(prefixRaw.toLowerCase().startsWith('.withdraw-paid ')) {
  if(message.author.id!==TRUSTED_OWNER_ID) return message.reply('This command is restricted to the bot owner.');
  const id=Number(prefixRaw.split(/\s+/)[1]); if(!Number.isInteger(id)||id<1) return message.reply('Usage: `.withdraw-paid REQUEST_ID`');
  const req=db.prepare("SELECT * FROM real_money_withdrawals WHERE id=? AND status='pending'").get(id);
  if(!req) return message.reply('Pending withdrawal request not found.');
  db.transaction(()=>{db.prepare('UPDATE real_money_users SET paid_paise=paid_paise+? WHERE guild=? AND user=?').run(req.amount_paise,req.guild,req.user);db.prepare("UPDATE real_money_withdrawals SET status='paid' WHERE id=?").run(id);})();
  const requester=await client.users.fetch(req.user).catch(()=>null); if(requester) await requester.send(`Your Nexzu withdrawal request **#${id}** for **₹${(req.amount_paise/100).toFixed(2)}** has been marked as paid. Thank you!`).catch(()=>{});
  return message.reply(`Marked request #${id} as paid: ₹${(req.amount_paise/100).toFixed(2)}.`);
 }

 // Real-money withdrawal requests are sent privately to the bot owner.
 if(/^\.withdraw(?:\s+\d+(?:\.\d{1,2})?)?$/i.test(prefixRaw)) {
  const accountRow=db.prepare('SELECT * FROM real_money_users WHERE guild=? AND user=?').get(message.guild.id,message.author.id) || {earned_paise:0,paid_paise:0};
  const pending=db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS total FROM real_money_withdrawals WHERE guild=? AND user=? AND status='pending'").get(message.guild.id,message.author.id).total;
  const available=Math.max(0,accountRow.earned_paise-accountRow.paid_paise-pending);
  const rawAmount=prefixRaw.split(/\s+/)[1];
  const requested=rawAmount?Math.round(Number(rawAmount)*100):available;
  if(!Number.isSafeInteger(requested)||requested<10000) return message.reply(`Minimum withdrawal is **₹100**. Your available balance is **₹${(available/100).toFixed(2)}**.`);
  if(requested>available) return message.reply(`You only have **₹${(available/100).toFixed(2)}** available (including pending requests).`);
  const owner=await client.users.fetch(TRUSTED_OWNER_ID).catch(()=>null);
  if(!owner) return message.reply('I could not contact the bot owner. Please try again later.');
  const requestEmbed=chillyStyledEmbed({title:`${CHILLY_EMOJI.money} New Nexzu Withdrawal Request`,description:`**Status:** Pending\n**Member:** ${message.author.tag} (<@${message.author.id}>)\n**User ID:** \`${message.author.id}\`\n**Server:** ${message.guild.name}\n**Server ID:** \`${message.guild.id}\`\n**Amount:** **₹${(requested/100).toFixed(2)}**\n**Available before request:** ₹${(available/100).toFixed(2)}\n\nUse \`.withdraw-paid REQUEST_ID\` after manually sending the reward.`,footer:'Nexzu • Real Money Rewards • Manual Review'});
  let sent; try { sent=await owner.send({embeds:[requestEmbed]}); } catch { return message.reply('I could not DM the bot owner. Please make sure the owner allows DMs, then try again.'); }
  const info=db.prepare("INSERT INTO real_money_withdrawals(guild,user,amount_paise,status,created) VALUES(?,?,?,'pending',?)").run(message.guild.id,message.author.id,requested,Date.now());
  await sent.edit({embeds:[EmbedBuilder.from(requestEmbed).addFields({name:'Request ID',value:String(info.lastInsertRowid)})]}).catch(()=>{});
  return message.reply(`${CHILLY_EMOJI.success} Your withdrawal request **#${info.lastInsertRowid}** for **₹${(requested/100).toFixed(2)}** has been sent to the bot owner by DM. It is pending manual review; no payment is automatic.`);
 }

 // Real-money reward commands: .rich, .bal [@member], .prof/.rank [@member].
 const rewardCommand = message.content.trim().match(/^\.(rich|bal|prof|rank)(?:\s+(.+))?$/i);
 if(rewardCommand) {
  const requestedCommand = rewardCommand[1].toLowerCase();
  const command = requestedCommand === 'rank' ? 'prof' : requestedCommand;
  const target = message.mentions.users.first() ||
   (rewardCommand[2] && /^\d{15,22}$/.test(rewardCommand[2].trim())
    ? await client.users.fetch(rewardCommand[2].trim()).catch(() => null)
    : null) || message.author;
  const guildId = message.guild.id;
  const ensureRewardAccount = userId => {
   db.prepare('INSERT OR IGNORE INTO real_money_users(guild,user) VALUES(?,?)').run(guildId,userId);
   return db.prepare('SELECT * FROM real_money_users WHERE guild=? AND user=?').get(guildId,userId);
  };
  const rupee = paise => '₹' + (paise / 100).toFixed(2);
  const accountRow = ensureRewardAccount(target.id);
  const pendingPaise = db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS total FROM real_money_withdrawals WHERE guild=? AND user=? AND status='pending'").get(guildId,target.id).total;
  const available = Math.max(0, accountRow.earned_paise - accountRow.paid_paise - pendingPaise);
  const progress = Math.min(100, Math.floor(available / 10000 * 100));

  // Render a fresh PNG for every command so the username, avatar, rank and INR
  // figures are always taken from the member's current account.
  const renderRewardCard = async (kind, data) => {
   const { createCanvas, loadImage } = require('@napi-rs/canvas');
   const canvas = createCanvas(kind === 'rich' ? 1500 : 1500, kind === 'rich' ? 1050 : 650);
   const ctx = canvas.getContext('2d');
   const W=canvas.width, H=canvas.height;
   // Use the basic Canvas fillRect API for maximum compatibility with
   // @napi-rs/canvas versions on Linux hosts. Avoid roundRect/strokeStyle,
   // which caused InvalidArg in the hosted renderer.
   const rr=(x,y,w,h,r,fill,stroke=null,lw=2)=>{
    ctx.fillStyle=String(fill || '#25252d');
    ctx.fillRect(Number(x),Number(y),Math.max(0,Number(w)),Math.max(0,Number(h)));
   };
   const txt=(value,x,y,size=28,color='#f4f2fa',weight='600',align='left')=>{
    ctx.font=`${weight} ${size}px Arial`;ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(String(value),x,y);
   };
   const avatar=async (user,x,y,size)=>{
    try{
     const im=await loadImage(user.displayAvatarURL({extension:'png',size:256}));
     ctx.save();ctx.beginPath();ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2);ctx.clip();
     ctx.drawImage(im,x,y,size,size);ctx.restore();
     ctx.beginPath();ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2);
     ctx.lineWidth=7;ctx.strokeStyle='#9146e8';ctx.stroke();
    }catch{rr(x,y,size,size, size/2, '#393143','#9146e8',5);txt('?',x+size/2,y+size*.68,42,'#fff','700','center');}
   };
   // Background and signature purple corner geometry.
   ctx.fillStyle='#17181e';ctx.fillRect(0,0,W,H);
   ctx.fillStyle='#6426a8';ctx.beginPath();ctx.moveTo(1040,0);ctx.lineTo(W,0);ctx.lineTo(W,300);ctx.lineTo(1220,300);ctx.closePath();ctx.fill();
   ctx.fillStyle='#8138c8';ctx.beginPath();ctx.moveTo(1240,0);ctx.lineTo(W,0);ctx.lineTo(W,120);ctx.closePath();ctx.fill();
   rr(6,6,W-12,H-12,34,'rgba(0,0,0,0)','#51405f',3);

   if(kind==='rich'){
    txt('WEALTH BOARD',62,65,25,'#c28be8','700');
    txt('Top Ranked Members',62,132,52,'#f7f5fa','700');
    txt(`Server economy  |  ${data.rows.length} ranked members`,64,174,23,'#aaa7b4','400');
    rr(62,210,1376,86,24,'#30213e','#70429a',2);
    txt('RANK',95,263,20,'#c8a3e6','700');
    txt('MEMBER',230,263,20,'#c8a3e6','700');
    txt('MESSAGES',1190,263,20,'#c8a3e6','700','right');
    txt('INR',1405,263,20,'#c8a3e6','700','right');
    for(let i=0;i<data.rows.length;i++){
     const row=data.rows[i], y=318+i*91;
     const fills=['#37301f','#2b2c34','#382a23'];
     rr(62,y,1376,78,22,fills[i]||'#25252d',i===0?'#e6c64d':(i===1?'#b9b9c4':(i===2?'#c58a5a':'#393943')),i<3?3:1);
     rr(84,y+13,76,52,15,'#494250');
     txt(`#${i+1}`,122,y+48,24,i===0?'#f1d25b':i===1?'#dedee8':i===2?'#dba477':'#c69be6','700','center');
     await avatar(row.user,178,y+7,64);
     txt(row.name,270,y+34,25,'#f5f3f7','700');
     txt('@'+row.username,270,y+59,17,'#aaa7b2','400');
     txt(row.messages.toLocaleString('en-IN'),1190,y+48,24,'#d8c4ee','700','right');
     txt(rupee(row.balance),1405,y+48,24,'#f2f0f6','700','right');
    }
    rr(62,955,1376,64,18,'#30213e','#8746c5',3);
    txt(`YOUR POSITION  #${data.viewerRank}`,88,996,22,'#c89be8','700');
    txt('300 MESSAGES = ₹0.50',1405,996,20,'#c89be8','700','right');
   } else if(kind==='bal'){
    txt('MEMBER BALANCE',62,65,25,'#c28be8','700');
    await avatar(data.user,88,128,210);
    txt(data.name,350,180,43,'#f7f5fa','700');
    txt('@'+data.username,352,220,23,'#aaa7b4','400');
    txt('LIFETIME CREDITED',850,150,20,'#aaa7c0','700');
    txt(rupee(data.lifetime),850,205,38,'#f6f3fa','700');
    rr(350,270,1080,230,28,'#242943','#414768',2);
    txt('AVAILABLE BALANCE',390,330,23,'#aeb6d1','700');
    txt(rupee(data.balance),390,425,72,'#75e0a6','700');
    txt('WITHDRAWAL PROGRESS',900,330,23,'#aeb6d1','700');
    txt(`${data.progress}% reached`,900,385,34,'#75e0a6','700');
    rr(900,415,470,18,9,'#41465e');
    rr(900,415,470*data.progress/100,18,9,'#df3e73');
    txt('Minimum withdrawal: ₹100.00',900,465,18,'#aeb2c5','400');
    txt(`${data.messages.toLocaleString('en-IN')} valid messages  •  ${data.remaining} to next ₹0.50`,350,565,22,'#c8c2d2','600');
   } else {
    txt('MEMBER WEALTH',62,65,25,'#c28be8','700');
    await avatar(data.user,75,130,220);
    txt(data.name,340,190,47,'#f7f5fa','700');
    txt('@'+data.username,345,235,25,'#aaa7b4','400');
    rr(345,270,240,58,14,'#7130ad');
    txt(`RANK #${data.rank}`,465,308,24,'#fff','700','center');
    rr(610,270,260,58,14,'#30303a');
    txt(`${data.memberCount.toLocaleString('en-IN')} MEMBERS`,740,308,22,'#e4e0eb','700','center');
    rr(75,410,1350,145,25,'#27262f','#3e3d49',2);
    txt('TOTAL MESSAGES',115,455,20,'#aaa7b4','700');
    txt(data.messages.toLocaleString('en-IN'),115,515,39,'#f6f3fa','700');
    txt('INR BALANCE',575,455,20,'#aaa7b4','700');
    txt(rupee(data.balance),575,515,39,'#f6f3fa','700');
    txt('LIFETIME CREDITED',1030,455,20,'#aaa7b4','700');
    txt(rupee(data.lifetime),1030,515,39,'#f6f3fa','700');
    txt('MESSAGE MILESTONE',85,610,18,'#aaa7b4','700');
    txt(`${data.messages.toLocaleString('en-IN')} / ${data.nextMilestone.toLocaleString('en-IN')} MSG`,1410,610,18,'#c7a2e6','700','right');
    rr(85,625,1325,10,5,'#eeeaf2');
    rr(85,625,1325*Math.min(1,data.messages/data.nextMilestone),5,'#9146d8');
   }
   return canvas.toBuffer('image/png');
  };

  try {
   if(command === 'bal' || command === 'prof') {
    const member = await message.guild.members.fetch(target.id).catch(()=>null);
    const rank = db.prepare('SELECT COUNT(*) + 1 AS rank FROM real_money_users WHERE guild=? AND earned_paise>?')
     .get(guildId,accountRow.earned_paise).rank;
    const data = {
     user:target, name:member?.displayName || target.username, username:target.username,
     messages:accountRow.messages, balance:available, lifetime:accountRow.earned_paise,
     progress, remaining:300-(accountRow.messages%300), rank,
     memberCount:message.guild.memberCount,
     nextMilestone:(Math.floor(accountRow.messages/300)+1)*300
    };
    const buffer=await renderRewardCard(command,data);
    const attachment=new AttachmentBuilder(buffer,{name:`${command}-${target.id}.png`});
    return message.reply({files:[attachment]}).catch(()=>{});
   }

   const rows=db.prepare('SELECT user,messages,earned_paise,paid_paise FROM real_money_users WHERE guild=? ORDER BY earned_paise DESC,messages DESC LIMIT 7').all(guildId);
   const ranked=[];
   for(const row of rows){
    const user=await client.users.fetch(row.user).catch(()=>null);
    if(!user) continue;
    const member=await message.guild.members.fetch(row.user).catch(()=>null);
    ranked.push({user,name:member?.displayName||user.username,username:user.username,messages:row.messages,balance:Math.max(0,row.earned_paise-row.paid_paise)});
   }
   const viewerRank=db.prepare('SELECT COUNT(*) + 1 AS rank FROM real_money_users WHERE guild=? AND earned_paise>?')
    .get(guildId,accountRow.earned_paise).rank;
   const buffer=await renderRewardCard('rich',{rows:ranked,viewerRank});
   const attachment=new AttachmentBuilder(buffer,{name:'wealth-board.png'});
   return message.reply({files:[attachment]}).catch(()=>{});
  } catch(error) {
   console.error('Real-money card render failed:',error);
   return message.reply('❌ Reward card failed to render. Check the FadeHost install log for `@napi-rs/canvas` and confirm the package installed successfully.').catch(()=>{});
  }
 }

 // Short text aliases: Nexzu daily/balance/work/slots, plus c daily/bal/work.
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
   db.prepare('UPDATE global_users SET coins=coins+?, '+col+'=? WHERE user=?').run(earned,now,userId);
   return message.reply('❄️ You earned **'+money(earned)+'**! Balance: **'+money(getAccount().coins)+'**');
  }
  if(cmd==='slots') {
   if(!amount) return message.reply('Usage: `.slots 100`');
   const a=getAccount(); if(a.coins<amount) return message.reply('❌ Not enough NexBits.');
   const symbols=['🍒','🍋','🍇','⭐','🔔'], roll=[0,1,2].map(()=>symbols[Math.floor(Math.random()*symbols.length)]);
   const mult=roll[0]===roll[1]&&roll[1]===roll[2]?(roll[0]==='⭐'?5:3):(roll[0]===roll[1]||roll[1]===roll[2]||roll[0]===roll[2]?1:0);
   const delta=mult?amount*mult:-amount; db.prepare('UPDATE global_users SET coins=coins+? WHERE user=?').run(delta,userId);
   return message.reply('🎰 '+roll.join(' | ')+'\n'+(mult?'🎉 Won **'+money(amount*mult)+'**!':'😢 Lost **'+money(amount)+'**.')+' Balance: **'+money(getAccount().coins)+'**');
  }
 }
 // Count ordinary, non-command chat messages for INR rewards.
 // Bots, webhooks, very short messages and bot commands do not earn rewards.
 const cfg = settings(message.guild.id);
 const rewardText = message.content.trim();
 const rewardSpamKey = `${message.guild.id}:${message.author.id}`;
 const rewardNow = Date.now();
 const rewardHistory = (recentMessages.get(rewardSpamKey)||[]).filter(x=>rewardNow-x.time<7000);
 const rewardRepeated = rewardHistory.filter(x=>x.content===rewardText.toLowerCase()).length >= 2;
 const rewardRapid = rewardHistory.length >= 5;
 const isSpamForReward = Boolean(cfg.antispam && !message.member.permissions.has(PermissionFlagsBits.ManageMessages) && (rewardRepeated || rewardRapid));
 if(!message.author.bot && !message.webhookId && rewardText.length >= 3 && !isSpamForReward &&
    !/^(?:[.!/?]|chilly\s|c\s)/i.test(rewardText)) {
  db.prepare('INSERT OR IGNORE INTO real_money_users(guild,user) VALUES(?,?)').run(message.guild.id,message.author.id);
  const before = db.prepare('SELECT messages FROM real_money_users WHERE guild=? AND user=?').get(message.guild.id,message.author.id);
  const newCount = before.messages + 1;
  const reward = (Math.floor(newCount / 300) - Math.floor(before.messages / 300)) * 50;
  db.prepare('UPDATE real_money_users SET messages=?, earned_paise=earned_paise+? WHERE guild=? AND user=?')
   .run(newCount,reward,message.guild.id,message.author.id);
  const messageDay=new Date().toISOString().slice(0,10);
  db.prepare('INSERT INTO message_daily(guild,user,day,messages) VALUES(?,?,?,1) ON CONFLICT(guild,user,day) DO UPDATE SET messages=messages+1').run(message.guild.id,message.author.id,messageDay);
  if(reward > 0) {
   await message.channel.send(`💜 ${message.author}, you reached **${newCount.toLocaleString('en-IN')} messages** and earned **₹${(reward/100).toFixed(2)}**!`).catch(()=>{});
  }
 }

 if(cfg.antilink && linkPattern.test(message.content) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
  await message.delete().catch(()=>{});
  await message.channel.send({content:`${message.author}, links are disabled in this server.`,allowedMentions:{users:[message.author.id]}}).then(m=>setTimeout(()=>m.delete().catch(()=>{}),5000)).catch(()=>{});
  await logAction(message.guild,auditEmbed('🔗 Link Blocked',0xF1C40F,[{name:'Member',value:`${message.author.tag} (${message.author.id})`},{name:'Channel',value:`${message.channel}`},{name:'Content',value:message.content.slice(0,900)}]));
  return;
 }
 if(cfg.antispam) {
  const key=`${message.guild.id}:${message.author.id}`, now=Date.now();
  const arr=(recentMessages.get(key)||[]).filter(x=>now-(typeof x==='number'?x:x.time)<7000);
  arr.push({time:now,content:message.content.trim().toLowerCase()}); recentMessages.set(key,arr);
  const repeated=arr.filter(x=>typeof x!=='number' && x.content===message.content.trim().toLowerCase()).length>=3;
  if((arr.length>=6 || repeated) && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
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

// DM a welcome embed to the member who added Chilly to a server.
client.on('guildCreate', async guild => {
 try {
  // Discord records the person who added the bot in the server audit log.
  const audit = await guild.fetchAuditLogs({ type: 28, limit: 8 }).catch(() => null); // AuditLogEvent.BotAdd
  const entry = audit?.entries.find(e =>
   e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 120000
  );
  // If audit-log access is unavailable, the server owner is the safest fallback recipient.
  const recipient = entry?.executor || await guild.fetchOwner().then(m => m.user).catch(() => null);
  if (!recipient || recipient.bot) return;

  const embed = chillyStyledEmbed({title:`${CHILLY_EMOJI.gift} Welcome to Nexzu`,description:
    `Hi, I'm **${client.user.username}**! Thanks for adding me to your server.\n\n` +
    `${CHILLY_EMOJI.dot} I can help with your server's **leveling, global economy, moderation, security, giveaways, tickets, welcome messages, autoroles, reaction roles, invite tracking, and utility commands**.\n\n` +
    `${CHILLY_EMOJI.success} Use **/help** to explore my commands and get started!`,footer:`${guild.name} • Nexzu • Powered by Spidyyy`})
   .addFields({ name: `${CHILLY_EMOJI.utility} Need help?`, value: '[Join the Nexzu Support Server](https://discord.gg/TFVrsdNWGx)' });

  const row = new ActionRowBuilder().addComponents(
   new ButtonBuilder()
    .setLabel('Join Support Server')
    .setStyle(ButtonStyle.Link)
    .setURL('https://discord.gg/TFVrsdNWGx')
  );
  await recipient.send({ embeds: [embed], components: [row] });
 } catch (error) {
  console.error(`Could not send Nexzu welcome DM for ${guild.id}:`, error.message);
 }
});

client.login(TOKEN);
