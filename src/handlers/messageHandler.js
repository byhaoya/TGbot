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
    this.db = getDatabase();
  }

  // 辅助函数：转义 Markdown 特殊字符，防止发送失败
  escapeMarkdown(text) {
    if (!text) return '未知';
    return text.replace(/[_*`\[]/g, '\\$&');
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

      logger.info(`📝 收到文本消息 | 用户: ${username} (${userId})`);

      // 1. 主人逻辑
      if (userId === this.ownerId) {
        if (msg.reply_to_message) await this.handleOwnerReply(msg);
        return;
      }

      // 2. 黑名单检查
      if (await this.db.isUserBlocked(userId)) {
        await this.bot.sendMessage(chatId, '❌ 抱歉，您已被拉黑。');
        return;
      }

      // 3. 验证逻辑 (核心修复点：确保验证流程优先且独立)
      const isVerified = await userVerification.isVerified(userId);
      if (!isVerified) {
        if (await userVerification.hasPendingVerification(userId)) {
          const result = await userVerification.verifyCaptcha(userId, text, username);
          if (result.success) {
            await this.bot.sendMessage(chatId, '✅ 验证成功！现在可以发送消息了。');
            // 通知主人
            await this.bot.sendMessage(this.ownerId, `✅ 新用户验证通过: ${this.escapeMarkdown(username)} (ID: \`${userId}\`)`, { parse_mode: 'Markdown' });
          } else {
            const reply = result.remainingAttempts > 0 ? `❌ ${result.message}\n请重新输入：` : `❌ ${result.message}`;
            await this.bot.sendMessage(chatId, reply);
          }
        } else {
          await this.bot.sendMessage(chatId, '⚠️ 请先发送 /start 开始验证。');
        }
        return;
      }

      // 4. 已验证用户，执行转发
      await this.forwardToOwner(msg, username);

    } catch (error) {
      logger.error(`❌ 处理文本消息失败: ${error.message}`);
    }
  }

  async handlePhotoMessage(msg) {
    try {
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || '未知用户';
      if (userId === this.ownerId) {
        if (msg.reply_to_message) await this.handleOwnerReply(msg);
        return;
      }
      if (await this.db.isUserBlocked(userId)) return;
      if (!await userVerification.isVerified(userId)) {
        await this.bot.sendMessage(msg.chat.id, '⚠️ 请先完成验证。');
        return;
      }
      await this.forwardPhotoToOwner(msg, username);
    } catch (error) {
      logger.error(`❌ 处理图片失败: ${error.message}`);
    }
  }

  async handleStartCommand(msg) {
    try {
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || '未知用户';
      if (userId === this.ownerId) {
        const stats = await userVerification.getStats();
        await this.bot.sendMessage(msg.chat.id, `👋 欢迎主人！\n👥 已验证: ${stats.verifiedUsers}\n🚫 已拉黑: ${stats.blockedUsers}`);
      } else {
        if (await this.db.isUserBlocked(userId)) return;
        if (await userVerification.isVerified(userId)) {
          await this.bot.sendMessage(msg.chat.id, '👋 欢迎回来！您已通过验证。');
        } else {
          await this.sendCaptchaToUser(msg.chat.id, userId, username);
        }
      }
    } catch (error) {
      logger.error(`❌ Start命令失败: ${error.message}`);
    }
  }

  async sendCaptchaToUser(chatId, userId, username) {
    const captchaSvg = await userVerification.createVerificationForUser(userId);
    const pngBuffer = await sharp(Buffer.from(captchaSvg)).png().toBuffer();
    await this.bot.sendMessage(chatId, '🔐 请输入图片中的验证码：');
    await this.bot.sendPhoto(chatId, pngBuffer);
  }

  // 修改后的转发逻辑，带转义保护
  async forwardToOwner(msg, username) {
    try {
      const safeName = this.escapeMarkdown(username);
      const infoHeader = `📩 来自: ${safeName} 🅥 ID: \`${msg.from.id}\`\n\n${this.escapeMarkdown(msg.text)}`;
      const forwarded = await this.bot.sendMessage(this.ownerId, infoHeader, { parse_mode: 'Markdown' });
      await this.db.saveMessageMapping(forwarded.message_id, msg.from.id, username);
    } catch (e) {
      // 如果 Markdown 解析失败，退回到纯文本发送
      const fallback = `📩 来自: ${username} ID: ${msg.from.id}\n\n${msg.text}`;
      const forwarded = await this.bot.sendMessage(this.ownerId, fallback);
      await this.db.saveMessageMapping(forwarded.message_id, msg.from.id, username);
    }
  }

  async forwardPhotoToOwner(msg, username) {
    try {
      const photo = msg.photo[msg.photo.length - 1].file_id;
      const safeName = this.escapeMarkdown(username);
      const caption = `📩 来自: ${safeName} 🅥 ID: \`${msg.from.id}\`\n${this.escapeMarkdown(msg.caption || '')}`;
      const forwarded = await this.bot.sendPhoto(this.ownerId, photo, { caption, parse_mode: 'Markdown' });
      await this.db.saveMessageMapping(forwarded.message_id, msg.from.id, username);
    } catch (e) {
      const photo = msg.photo[msg.photo.length - 1].file_id;
      const caption = `📩 来自: ${username} ID: ${msg.from.id}\n${msg.caption || ''}`;
      const forwarded = await this.bot.sendPhoto(this.ownerId, photo, { caption });
      await this.db.saveMessageMapping(forwarded.message_id, msg.from.id, username);
    }
  }

  async handleOwnerReply(msg) {
    try {
      const mapping = await this.db.getMessageMapping(msg.reply_to_message.message_id);
      if (!mapping) return;
      if (msg.text === '/block') return this.handleBlockUser(msg);
      if (msg.photo) {
        await this.bot.sendPhoto(mapping.userId, msg.photo[0].file_id, { caption: `💬 主人回复：\n${msg.caption || ''}` });
      } else {
        await this.bot.sendMessage(mapping.userId, `💬 主人回复：\n${msg.text}`);
      }
    } catch (error) {
      logger.error(`❌ 回复失败: ${error.message}`);
    }
  }

  async handleBlockUser(msg) {
    const mapping = await this.db.getMessageMapping(msg.reply_to_message.message_id);
    if (mapping) {
      await this.db.blockUser(mapping.userId);
      await this.bot.sendMessage(this.ownerId, `✅ 已拉黑: ${mapping.username}`);
    }
  }

  handleError(error) {
    logger.error(`❌ Bot 运行错误: ${error.message}`);
  }
}

module.exports = MessageHandler;
