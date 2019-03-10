const Discord = require('discord.js');

const config = require('./config/config.js');
const Validate = require('./validations.js');
const DbFun = require('./dbfuns.js');
const SheetApi = require('./sheetapi.js');

// Initiate all external classes
const bot = new Discord.Client();
const sheetApi = new SheetApi();
const dbFun = new DbFun();

// Create function to log errors and add to google sheets
async function errorHandler(e) {
  // Log error
  console.error(e);

  // Try adding error to google sheets (and catch to stop recursive errors)
  try {
    await sheetApi.writeError(e.stack);
  } catch (err) {
    console.error('Unable to write error to Google Sheets', err);
  }
}

// Build unhandled rejection and exception error handlers
process.on('unhandledRejection', errorHandler);
process.on('uncaughtException', errorHandler);

// Helper function for handling score commands (since it is done twice)
async function handleScoreCommand(msg) {
  // Re-parse the new message
  const result = await Validate.parseMsg(msg, config.bigAdmins);

  // Send error message to user if not valid
  if (result.success === 0) {
    await msg.reply(`${result.error}:\n${msg.content}\nPlease repost the corrected score.`);
    await msg.delete();
    return;
  }

  // Insert scores in database
  await dbFun.insertScores(result.data, msg.author.id);

  // Send validation request to all included users
  for (const field of result.data.fields) {
    if (msg.author.id === field.userId) continue;

    const dmText = `You've been tagged as having participated in a League Match. Please validate this match's occurrence by adding a Reaction emoji of your choice (:thumbsup: :rocket: :ok_hand:) to this match report. https://discordapp.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`;
    const guildMember = await msg.guild.fetchMember(field.userId);
    if (guildMember !== null && guildMember !== undefined) await guildMember.send(dmText);
  }
}

// Provide notice and set status on ready
bot.on('ready', () => {
  console.log(`Logged in! Serving in ${bot.guilds.array().length} servers for ${bot.users.array().length} users`);
  if (config.nowPlaying !== null) bot.user.setActivity(config.nowPlaying);
});

bot.on('messageReactionAdd', async (reaction, user) => {
  // Ignore non-configured channel
  if (reaction.message.channel.name !== config.channelName) return;

  // remove meaningless emojis..so make it clean for the admin
  if (!config.scoreCommands.includes(reaction.message.content.split(' ')[0])) {
    await reaction.remove(user);
    return;
  }

  // Don't handle emojis added by the bot
  if (user.id === bot.user.id) {
    return;
  }

  // Remove uses of the certified emoji, so you can clearly tell what has been certified by the bot
  if ([config.certifiedEmoji, config.errorEmoji].includes(reaction.emoji.name)) {
    await reaction.remove(user);
    return;
  }

  // Remove non-admin uses of the verify emoji
  if (!config.admins.includes(user.id) && reaction.emoji.name === config.verifyEmoji) {
    await reaction.remove(user);
    return;
  }

  // If is admin trying to certify
  if (config.admins.includes(user.id) && reaction.emoji.name === config.verifyEmoji) {
    const game = await dbFun.game(reaction.message.id);

    // Proceed if validated, otherwise remove reaction and cancel
    if (game && game.validated === 1) {
      // Parse the message reacted to
      // TODO: it's possible to skip this if we use data stored in the DB already
      const result = await Validate.parseMsg(reaction.message, config.bigAdmins);

      // Send error message and remove emoji if not valid
      if (result.success === 0) {
        await reaction.remove(user);
        await reaction.message.reply(result.error);
        return;
      }

      // Add to google sheets, certify game in DB, and add certified emoji
      await sheetApi.writeSheet(result.data, reaction.message.member.displayName);
      await dbFun.certifyGame(reaction.message.id);
      await reaction.message.react(config.certifiedEmoji);
    } else if (game && game.certified === 1) {
      await reaction.message.reply('Game is already certified');
    } else {
      await reaction.remove(user);
    }

    return;
  }

  // Validate game if valid reaction, otherwise remove reaction and cancel
  if (config.bigAdmins.includes(user.id) || Validate.reactionValidation(reaction, user)) {
    await dbFun.validateGame(reaction.message.id);
  } else {
    await reaction.remove(user);
  }
});

bot.on('messageUpdate', async (oldMsg, newMsg) => {
  // Ignore non-configured channel
  if (newMsg.channel.name !== config.channelName) return;

  // Ignore if updated message is not a scoring command
  if (!config.scoreCommands.includes(newMsg.content.split(' ')[0])) return;

  const game = await dbFun.game(newMsg.id);

  // If message does not have a game entry, create a new one
  if (!game) {
    // Handle score command
    await handleScoreCommand(newMsg);
  }

  // Error if attempting to modify a certified s core
  if (game && game.certified) {
    newMsg.reply('Certified scores cannot be modified, please contact an admin if you wish to edit the score');
    return;
  }

  // Clear google sheets row, database entries, and reactions
  await sheetApi.delRow(newMsg.id);
  await dbFun.clear(newMsg.id);
  await newMsg.clearReactions();

  // Handle score command
  await handleScoreCommand(newMsg);
});

bot.on('message', async (msg) => {
  // Ignore non-configured channel
  if (msg.channel.name !== config.channelName) return;

  if (config.scoreCommands.includes(msg.content.split(' ')[0])) {
    // Handle score command
    await handleScoreCommand(msg);
  }
});

bot.on('error', (err) => {
  errorHandler(err);
});

bot.on('reconnecting', () => {
  console.log('Reconnecting to Discord...');
});

bot.login(config.botToken);
