
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ActivityType
} = require('discord.js');
const Database = require('better-sqlite3');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new Database('chilly.sqlite');

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
`);

const commands = [
 new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
 new SlashCommandBuilder().setName('help').setDescription('Show all commands'),

 new SlashCommandBuilder().setName('balance').setDescription('Check coin balance')
  .addUserOption(o=>o.setName('user').setDescription('Member')),
 new SlashCommandBuilder().setName('daily').setDescription('Claim daily coins'),
 new SlashCommandBuilder().setName('work').setDescription('Earn coins by working'),
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
 new SlashCommandBuilder().setName('rps').setDescription('Rock paper scissors')
  .addStringOption(o=>o.setName('choice').setDescription('Choose').setRequired(true)
   .addChoices({name:'Rock',value:'rock'},{name:'Paper',value:'paper'},{name:'Scissors',value:'scissors'})),
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
  .addStringOption(o=>o.setName('id').setDescription('Giveaway ID').setRequired(true))
].map(c=>c.toJSON());

function account(g,u) {
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

client.once('ready', async()=>{
 console.log('Chilly online as '+client.user.tag);
 client.user.setPresence({
  activities:[{name:'Powered by Spidyyy',type:ActivityType.Playing}],
  status:'online'
 });
 try {
  await new REST({version:'10'}).setToken(TOKEN)
   .put(Routes.applicationCommands(CLIENT_ID),{body:commands});
  console.log('Registered '+commands.length+' slash commands.');
 } catch(e) { console.error('Command registration failed:',e); }

 for(const g of db.prepare('SELECT id,ends FROM giveaways WHERE ended=0').all()) {
  setTimeout(()=>endGiveaway(g.id).catch(console.error),Math.max(0,g.ends*1000-Date.now()));
 }
});

client.on('interactionCreate', async i=>{
 try {
  if(i.isButton()&&i.customId.startsWith('chilly_enter:')) {
   const id=i.customId.split(':')[1];
   const g=db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
   if(!g||g.ended||g.ends*1000<Date.now()) return i.reply({content:'Giveaway ended.',ephemeral:true});
   const r=db.prepare('INSERT OR IGNORE INTO entries(giveaway,user) VALUES(?,?)').run(id,i.user.id);
   return i.reply({content:r.changes?'You entered! Good luck!':'You already entered.',ephemeral:true});
  }
  if(!i.isChatInputCommand()) return;

  const c=i.commandName, u=i.user, g=i.guild;
  const target=i.options.getUser('user');
  if(!g&&!['ping','help'].includes(c)) return i.reply({content:'Use this command in a server.',ephemeral:true});

  if(c==='ping') return i.reply('🏓 Pong! '+client.ws.ping+'ms');
  if(c==='help') return i.reply({embeds:[new EmbedBuilder().setColor(0x77DDE7).setTitle('❄️ Chilly Commands')
   .setDescription('**Moderation:** /warn /warnings /clear /timeout /untimeout /kick /ban /unban\n**Economy:** /balance /daily /work /give /leaderboard /shop /buy /inventory\n**Fun:** /8ball /coinflip /dice /rps /joke /ship\n**Utility:** /avatar /userinfo /serverinfo /poll /calculator /remind\n**Giveaways:** /giveaway /giveaway-end /reroll')
   .setFooter({text:'Playing Powered by Spidyyy'})]});

  if(c==='balance') {
   const who=target||u, a=account(g.id,who.id);
   return i.reply('💰 **'+who.username+'** has **'+money(a.coins)+'**.');
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

  if(c==='warn') {
   const to=i.options.getUser('user'), reason=i.options.getString('reason');
   db.prepare('INSERT INTO warnings(guild,user,moderator,reason,created) VALUES(?,?,?,?,?)').run(g.id,to.id,u.id,reason,Date.now());
   return i.reply('⚠️ Warned <@'+to.id+'>. Reason: '+reason);
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
   if(c==='timeout') {
    const mins=i.options.getInteger('minutes'), reason=i.options.getString('reason')||'No reason provided';
    await m.timeout(mins*60000,reason);
    return i.reply('🔇 Timed out <@'+to.id+'> for '+mins+' minutes.');
   }
   await m.timeout(null);
   return i.reply('🔊 Timeout removed for <@'+to.id+'>.');
  }
  if(c==='kick'||c==='ban') {
   const to=i.options.getUser('user'), reason=i.options.getString('reason')||'No reason provided';
   const m=await g.members.fetch(to.id);
   if(to.id===u.id) return i.reply({content:'You cannot moderate yourself.',ephemeral:true});
   if(c==='kick') await m.kick(reason); else await m.ban({reason});
   return i.reply((c==='kick'?'👢 Kicked ':'🔨 Banned ')+'<@'+to.id+'>. Reason: '+reason);
  }
  if(c==='unban') {
   await g.members.unban(i.options.getString('userid'));
   return i.reply('✅ User unbanned.');
  }

  if(c==='8ball') return i.reply('🎱 '+choose(['Definitely!','Yes!','Ask again later.','Probably not.','No way!'],1)[0]);
  if(c==='coinflip') return i.reply('🪙 '+(Math.random()<0.5?'Heads':'Tails')+'!');
  if(c==='dice') return i.reply('🎲 You rolled '+(1+Math.floor(Math.random()*6))+'!');
  if(c==='rps') {
   const a=i.options.getString('choice'), b=choose(['rock','paper','scissors'],1)[0];
   const result=a===b?'Tie!':((a==='rock'&&b==='scissors')||(a==='paper'&&b==='rock')||(a==='scissors'&&b==='paper'))?'You win!':'Chilly wins!';
   return i.reply('You: **'+a+'** | Chilly: **'+b+'**. **'+result+'**');
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
   const embed=new EmbedBuilder().setColor(0x5865F2).setTitle('🎉 Chilly Giveaway!')
    .setDescription('**Prize:** '+prize+'\n**Winners:** '+winners+'\n**Host:** <@'+u.id+'>\n**Ends:** <t:'+ends+':R>\n**ID:** `'+id+'`');
   const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('chilly_enter:'+id).setLabel('Enter Giveaway 🎉').setStyle(ButtonStyle.Primary));
   const msg=await i.reply({embeds:[embed],components:[row],fetchReply:true});
   db.prepare('UPDATE giveaways SET message=? WHERE id=?').run(msg.id,id);
   setTimeout(()=>endGiveaway(id).catch(console.error),mins*60000);
   return;
  }
  if(c==='giveaway-end') {
   const r=await end
