const logger = require('../utils/logger');
const config = require('../utils/config');
const userVerification = require('../filters/adFilter');
const { getInstance: getDatabase } = require('../utils/supabaseDatabase');
const sharp = require('sharp');

/**
 * 消息处理器类
 */
class MessageHandler {
  constructor(bot) {
    this.bot = bot;
    this.ownerId = config.getOwnerId();
    
    // 获取数据库实例
    this.db = getDatabase();
  }

  /**
   * 处理文本消息
   */
  async handleTextMessage(msg) {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || '未知用户';
      const text = msg.text;

      logger.info(`📝 收到文本消息 | 用户: ${username} (${userId}) | 内容: ${text.substring(0, 50)}...`);

      // 如果是主人发送的消息，检查是否是回复消息
      if (userId === this.ownerId) {
        if (msg.reply_to_message) {
          await this.handleOwnerReply(msg);
        } else {
          logger.debug(`👑 主人发送普通消息，跳过处理`);
        }
        return;
      }

      // 检查用户是否被拉黑
      if (await this.db.isUserBlocked(userId)) {
        logger.warn(`🚫 拉黑用户尝试发送消息 | 用户: ${username} (${userId})`);
        await this.bot.sendMessage(
          chatId,
          '❌ 抱歉，您已被拉黑，无法发送消息。'
        );
        return;
      }

      // 检查用户是否已验证
      if (!await userVerification.isVerified(userId)) {
        if (await userVerification.hasPendingVerification(userId)) {
          const result = await userVerification.verifyCaptcha(userId, text, username);
          
          if (result.success) {
            await this.bot.sendMessage(
              chatId,
              '✅ 验证成功！\n\n现在你可以向我发送消息了，我会帮你转发给主人。'
            );
            
            await this.bot.sendMessage(
              this.ownerId,
              `✅ 新用户通过验证\n\n` +
              `👤 用户: ${username}\n` +
              `🆔 ID: ${userId}\n` +
              `⏰ 时间: ${new Date().toLocaleString('zh-CN')}`
            );
          } else {
            if (result.remainingAttempts !== undefined && result.remainingAttempts > 0) {
              await this.bot.sendMessage(
                chatId,
                `❌ ${result.message}\n\n请重新输入验证码：`
              );
            } else {
              await this.bot.sendMessage(
                chatId,
                `❌ ${result.message}`
              );
            }
          }
        } else {
          await this.bot.sendMessage(
            chatId,
            '⚠️ 请先发送 /start 命令开始验证。'
          );
        }
        return;
      }

      // 用户已验证，转发消息给主人
      await this.forwardToOwner(msg, username);

    } catch (error) {
      logger.error(`❌ 处理文本消息失败 | 错误: ${error.message}`, { stack: error.stack });
    }
  }

  /**
   * 处理图片消息
   */
  async handlePhotoMessage(msg) {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || '未知用户';

      logger.info(`📷 收到图片消息 | 用户: ${username} (${userId})`);

      if (userId === this.ownerId) {
        if (msg.reply_to_message) {
          await this.handleOwnerReply(msg);
        } else {
          logger.debug(`👑 主人发送普通图片，跳过处理`);
        }
        return;
      }

      if (await this.db.isUserBlocked(userId)) {
        logger.warn(`🚫 拉黑用户尝试发送图片 | 用户: ${username} (${userId})`);
        await this.bot.sendMessage(
          chatId,
          '❌ 抱歉，您已被拉黑，无法发送消息。'
        );
        return;
      }

      if (!await userVerification.isVerified(userId)) {
        await this.bot.sendMessage(
          chatId,
          '⚠️ 请先完成验证才能发送图片。\n发送 /start 开始验证。'
        );
        return;
      }

      // 用户已验证，转发图片给主人
      await this.forwardPhotoToOwner(msg, username);

    } catch (error) {
      logger.error(`❌ 处理图片消息失败 | 错误: ${error.message}`, { stack: error.stack });
    }
  }

  /**
   * 处理 /start 命令
   */
  async handleStartCommand(msg) {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || '未知用户';

      logger.info(`🚀 /start 命令 | 用户: ${username} (${userId})`);

      if (userId === this.ownerId) {
        const stats = await userVerification.getStats();
        await this.bot.sendMessage(
          chatId,
          '👋 欢迎主人！\n\n' +
          '🤖 机器人状态: 运行中\n' +
          `👥 已验证用户: ${stats.verifiedUsers}\n` +
          `⏳ 待验证用户: ${stats.pendingVerifications}\n` +
          `❌ 验证失败记录: ${stats.failedVerifications}\n` +
          `🚫 拉黑用户: ${stats.blockedUsers}\n\n` +
          '新用户需要通过验证码验证才能向您发送消息。'
        );
      } else {
        if (await this.db.isUserBlocked(userId)) {
          const failCount = await this.db.getFailedVerificationCount(userId);
          if (failCount > 0) {
            await this.bot.sendMessage(
              chatId,
              '❌ 您因多次验证失败已被禁止使用此机器人。\n\n' +
              '如有疑问，请联系管理员。'
            );
          } else {
            await this.bot.sendMessage(
              chatId,
              '❌ 抱歉，您已被拉黑，无法使用此机器人。'
            );
          }
          return;
        }

        if (await userVerification.isVerified(userId)) {
          await this.bot.sendMessage(
            chatId,
            '👋 欢迎回来！\n\n' +
            '你已经通过验证，可以直接向我发送消息或图片。'
          );
        } else {
          await this.sendCaptchaToUser(chatId, userId, username);
        }
      }

    } catch (error) {
      logger.error(`❌ 处理 /start 命令失败 | 错误: ${error.message}`, { stack: error.stack });
    }
  }

  /**
   * 向用户发送验证码
   */
  async sendCaptchaToUser(chatId, userId, username) {
    try {
      const captchaSvg = await userVerification.createVerificationForUser(userId);
      const pngBuffer = await sharp(Buffer.from(captchaSvg)).png().toBuffer();

      await this.bot.sendMessage(
        chatId,
        '👋 你好！\n\n' +
        '🔐 为了防止垃圾消息，请先完成验证。\n\n' +
        '我会发送一张验证码图片给你，请回复图片中的字符（不区分大小写）。\n\n' +
        '⚠️ 注意：\n' +
        '- 验证码有效期 5 分钟\n' +
        '- 最多可尝试 3 次\n' +
        '- 如验证码过期或失败，请重新发送 /start'
      );

      await this.bot.sendPhoto(chatId, pngBuffer, {
        caption: '📷 请回复图片中的验证码：'
      });

      logger.info(`✅ 验证码已发送 | 用户: ${username} (${userId})`);

    } catch (error) {
      logger.error(`❌ 发送验证码失败 | 用户ID: ${userId} | 错误: ${error.message}`, { stack: error.stack });
      await this.bot.sendMessage(chatId, '❌ 验证码发送失败，请稍后重试或联系管理员。');
    }
  }

  /**
   * 转发消息给主人（已修改为自定义格式）
   */
  async forwardToOwner(msg, username) {
    try {
      const userId = msg.from.id;
      // 拼接你要求的格式，ID部分加反引号支持点击复制
      const infoHeader = `📩 来自: ${username}  ID: \`${userId}\`\n\n${msg.text}`;

      const forwardedMsg = await this.bot.sendMessage(
        this.ownerId,
        infoHeader,
        { parse_mode: 'Markdown' }
      );
      
      await this.db.saveMessageMapping(forwardedMsg.message_id, userId, username);
      logger.info(`📤 消息已转发给主人 | 用户: ${username} (${userId})`);

    } catch (error) {
      logger.error(`❌ 转发消息失败 | 用户ID: ${msg.from.id} | 错误: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, '❌ 消息发送失败，请稍后重试。');
    }
  }

  /**
   * 转发图片给主人（已修改为自定义格式）
   */
  async forwardPhotoToOwner(msg, username) {
    try {
      const userId = msg.from.id;
      const photo = msg.photo[msg.photo.length - 1].file_id;
      const caption = msg.caption || '';
      
      const infoHeader = `📩 来自: ${username}  ID: \`${userId}\`\n${caption ? '------------------\n' + caption : ''}`;

      const forwardedMsg = await this.bot.sendPhoto(
        this.ownerId,
        photo,
        { 
          caption: infoHeader,
          parse_mode: 'Markdown' 
        }
      );
      
      await this.db.saveMessageMapping(forwardedMsg.message_id, userId, username);
      logger.info(`📤 图片已转发给主人 | 用户: ${username} (${userId})`);

    } catch (error) {
      logger.error(`❌ 转发图片失败 | 用户ID: ${msg.from.id} | 错误: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, '❌ 图片发送失败，请稍后重试。');
    }
  }

  /**
   * 处理主人的回复消息
   */
  async handleOwnerReply(msg) {
    try {
      const replyToMsgId = msg.reply_to_message.message_id;
      
      if (msg.text && msg.text.trim().toLowerCase() === '/block') {
        await this.handleBlockUser(msg);
        return;
      }

      if (msg.text && msg.text.trim().toLowerCase() === '/unblock') {
        await this.handleUnblockUser(msg);
        return;
      }

      const mapping = await this.db.getMessageMapping(replyToMsgId);
      
      if (!mapping) {
        await this.bot.sendMessage(
          this.ownerId,
          '❌ 无法找到要回复的用户。只能回复用户转发过来的消息。'
        );
        return;
      }

      const targetUserId = mapping.userId;

      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        await this.bot.sendPhoto(targetUserId, photo.file_id, {
          caption: `💬 主人回复：\n\n${msg.caption || ''}`
        });
      } else if (msg.text) {
        await this.bot.sendMessage(
          targetUserId,
          `💬 主人回复：\n\n${msg.text}`
        );
      }

      logger.info(`✅ 主人回复已发送 | 目标用户 ID: ${targetUserId}`);

    } catch (error) {
      logger.error(`❌ 处理主人回复失败 | 错误: ${error.message}`);
      await this.bot.sendMessage(this.ownerId, '❌ 回复发送失败，请稍后重试。');
    }
  }

  /**
   * 处理拉黑用户
   */
  async handleBlockUser(msg) {
    try {
      const replyToMsgId = msg.reply_to_message.message_id;
      const mapping = await this.db.getMessageMapping(replyToMsgId);
      
      if (!mapping) {
        await this.bot.sendMessage(this.ownerId, '❌ 无法找到要拉黑的用户。');
        return;
      }

      const targetUserId = mapping.userId;
      const username = mapping.username || '用户';

      await this.db.blockUser(targetUserId);
      await this.bot.sendMessage(
        this.ownerId,
        `✅ 已拉黑用户 ${username} (ID: ${targetUserId})`
      );

    } catch (error) {
      logger.error(`❌ 拉黑用户失败 | 错误: ${error.message}`);
    }
  }

  /**
   * 通过用户ID直接拉黑用户
   */
  async handleBlockUserById(msg, targetUserId) {
    try {
      const userId = parseInt(targetUserId);
      if (userId === this.ownerId) return;

      await this.db.blockUser(userId);
      await this.bot.sendMessage(this.ownerId, `✅ 已拉黑用户 (ID: ${userId})`);
    } catch (error) {
      logger.error(`❌ ID拉黑失败 | 错误: ${error.message}`);
    }
  }

  /**
   * 处理解除拉黑用户
   */
  async handleUnblockUser(msg) {
    try {
      const replyToMsgId = msg.reply_to_message.message_id;
      const mapping = await this.db.getMessageMapping(replyToMsgId);
      
      if (!mapping) {
        await this.bot.sendMessage(this.ownerId, '❌ 无法找到要解除拉黑的用户。');
        return;
      }

      const targetUserId = mapping.userId;
      await this.db.unblockUser(targetUserId);
      await this.db.clearFailedVerifications(targetUserId);

      await this.bot.sendMessage(this.ownerId, `✅ 已解除拉黑用户 (ID: ${targetUserId})`);
    } catch (error) {
      logger.error(`❌ 解除拉黑失败 | 错误: ${error.message}`);
    }
  }

  /**
   * 通过用户ID直接解除拉黑
   */
  async handleUnblockUserById(msg, targetUserId) {
    try {
      const userId = parseInt(targetUserId);
      await this.db.unblockUser(userId);
      await this.db.clearFailedVerifications(userId);
      await this.bot.sendMessage(this.ownerId, `✅ 已解除拉黑用户 (ID: ${userId})`);
    } catch (error) {
      logger.error(`❌ ID解除拉黑失败 | 错误: ${error.message}`);
    }
  }

  handleError(error) {
    logger.error(`❌ Bot 运行错误 | ${error.message}`, { stack: error.stack });
  }
}

module.exports = MessageHandler;
