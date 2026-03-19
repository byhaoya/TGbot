const TelegramBot = require('node-telegram-bot-api');
const config = require('./utils/config');
const logger = require('./utils/logger');
const MessageHandler = require('./handlers/messageHandler');

/**
 * Bot 主类
 */
class Bot {
  constructor() {
    this.token = config.getBotToken();
    this.bot = null;
    this.messageHandler = null;
  }

  /**
   * 初始化机器人
   */
  initialize() {
    try {
      // 创建 bot 实例
      this.bot = new TelegramBot(this.token, { polling: true });

      // 创建消息处理器
      this.messageHandler = new MessageHandler(this.bot);

      // 注册事件监听器
      this.registerListeners();

      logger.info(`✅ 机器人初始化成功`);
      logger.info(`👑 主人ID: ${config.getOwnerId()}`);

    } catch (error) {
      logger.error(`❌ 机器人初始化失败 | ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  /**
   * 注册 Bot 快捷命令（区分管理员与普通用户）
   */
  async registerBotCommands() {
    try {
      const ownerId = config.getOwnerId();

      // 1. 定义通用命令（所有人可见）
      const publicCommands = [
        {
          command: 'start',
          description: '🚀 开始使用机器人 / 获取验证码'
        }
      ];

      // 2. 定义管理员专用命令（仅主人可见）
      const adminCommands = [
        ...publicCommands,
        {
          command: 'block',
          description: '🚫 拉黑用户 (仅主人可用)'
        },
        {
          command: 'unblock',
          description: '✅ 解除拉黑 (仅主人可用)'
        }
      ];

      // 设置全局默认命令（普通用户视角）
      await this.bot.setMyCommands(publicCommands);

      // 设置特定聊天范围的命令（管理员视角）
      // 注意：只有当管理员在私聊窗口打开菜单时，才会看到这些额外命令
      await this.bot.setMyCommands(adminCommands, {
        scope: {
          type: 'chat',
          chat_id: ownerId
        }
      });

      logger.info(`✅ 快捷命令注册成功 | 普通: ${publicCommands.length} | 管理员: ${adminCommands.length}`);
      
      return true;
    } catch (error) {
      logger.error(`❌ 注册快捷命令失败 | ${error.message}`);
      return false;
    }
  }

  /**
   * 注册事件监听器
   */
  registerListeners() {
    // 监听 /start 命令
    this.bot.onText(/\/start/, (msg) => {
      this.messageHandler.handleStartCommand(msg);
    });

    // 监听 /block 命令
    this.bot.onText(/\/block(?:\s+(\d+))?/, (msg, match) => {
      const userId = msg.from.id;
      const ownerId = config.getOwnerId();
      
      if (userId === ownerId) {
        const targetUserId = match[1];
        if (targetUserId) {
          this.messageHandler.handleBlockUserById(msg, targetUserId);
        } else if (msg.reply_to_message) {
          this.messageHandler.handleBlockUser(msg);
        } else {
          this.bot.sendMessage(
            ownerId,
            '❌ 使用方法：\n' +
            '1. 回复用户消息并发送 /block\n' +
            '2. 直接发送 /block 用户ID'
          );
        }
      }
    });

    // 监听 /unblock 命令
    this.bot.onText(/\/unblock(?:\s+(\d+))?/, (msg, match) => {
      const userId = msg.from.id;
      const ownerId = config.getOwnerId();
      
      if (userId === ownerId) {
        const targetUserId = match[1];
        if (targetUserId) {
          this.messageHandler.handleUnblockUserById(msg, targetUserId);
        } else if (msg.reply_to_message) {
          this.messageHandler.handleUnblockUser(msg);
        } else {
          this.bot.sendMessage(
            ownerId,
            '❌ 使用方法：\n' +
            '1. 回复用户消息并发送 /unblock\n' +
            '2. 直接发送 /unblock 用户ID'
          );
        }
      }
    });

    // 监听文本消息
    this.bot.on('message', (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        this.messageHandler.handleTextMessage(msg);
      }
    });

    // 监听图片消息
    this.bot.on('photo', (msg) => {
      this.messageHandler.handlePhotoMessage(msg);
    });

    // 监听错误
    this.bot.on('polling_error', (error) => {
      logger.error(`❌ 轮询错误 | Code: ${error.code} | ${error.message}`);
    });

    this.bot.on('webhook_error', (error) => {
      logger.error(`❌ Webhook 错误 | ${error.message}`, { stack: error.stack });
    });

    logger.info(`✅ 事件监听器注册完成`);
  }

  /**
   * 启动机器人
   */
  async start() {
    try {
      this.initialize();
      
      // 注册快捷命令
      await this.registerBotCommands();
      
      logger.info('='.repeat(50));
      logger.info('🤖 Telegram 消息转发机器人已启动');
      logger.info('='.repeat(50));

      // 向主人发送启动通知
      this.bot.sendMessage(
        config.getOwnerId(),
        '🤖 机器人已启动！\n\n' +
        '✅ 状态: 运行中\n' +
        '👑 权限: 管理员菜单已激活'
      ).catch(error => {
        logger.warn(`⚠️ 无法向主人发送启动通知 | ${error.message}`);
      });

    } catch (error) {
      logger.error(`❌ 机器人启动失败 | ${error.message}`, { stack: error.stack });
      process.exit(1);
    }
  }

  /**
   * 停止机器人
   */
  stop() {
    if (this.bot) {
      this.bot.stopPolling();
      logger.info(`⏹️ 机器人已停止`);
    }
  }
}

module.exports = Bot;
