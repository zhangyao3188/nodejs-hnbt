/**
 * 补贴抢购系统主入口
 * 
 * 功能：
 * 1. 初始化系统配置
 * 2. 加载账号和代理池
 * 3. 执行前置工作
 * 4. 等待抢购时间
 * 5. 执行并发抢购
 */

const path = require('path');
const { createLogger } = require('./utils/logger');
const ConfigManager = require('./utils/configManager');
const AccountManager = require('./modules/accountManager');
const ProxyPool = require('./modules/proxyPool');
const Scheduler = require('./modules/scheduler');
const PurchaseFlow = require('./modules/purchaseFlow');
const ApiClient = require('./modules/apiClient');

class PurchaseBot {
    constructor() {
        this.logger = createLogger('main');
        this.config = null;
        this.accountManager = null;
        this.proxyPool = null;
        this.scheduler = null;
        this.purchaseFlow = null;
        this.isRunning = false;
    }

    /**
     * 初始化系统
     */
    async initialize() {
        try {
            this.logger.info('=== 补贴抢购系统启动 ===');
            
            // 加载配置
            this.config = new ConfigManager();
            await this.config.load();
            this.logger.info('配置加载完成');

            // 初始化各个模块
            this.accountManager = new AccountManager(this.config.accounts);
            this.proxyPool = new ProxyPool(this.config.settings.proxy);
            this.scheduler = new Scheduler(this.config.settings);
            this.apiClient = new ApiClient(this.proxyPool, this.config.settings);
            this.purchaseFlow = new PurchaseFlow(this.proxyPool, this.apiClient, this.config.settings);

            // 初始化代理池
            if (!await this.proxyPool.initialize()) {
                this.logger.warn('代理池初始化失败，将使用直连模式');
            } else {
                // 设置代理过期回调
                this.proxyPool.setExpiredCallback(() => {
                    this.logger.error('代理已过期，系统自动停止');
                    this.stop();
                    process.exit(0);
                });
            }

            // 设置前置工作模块的账号管理器
            this.purchaseFlow.preWork.accountManager = this.accountManager;

            this.logger.info('所有模块初始化完成');
            return true;
        } catch (error) {
            this.logger.error('系统初始化失败:', error);
            return false;
        }
    }

    /**
     * 执行前置工作
     */
    async executePreWork() {
        try {
            this.logger.info('=== 开始执行前置工作 ===');
            
            const accounts = this.accountManager.getAccounts();
            this.logger.info(`总共 ${accounts.length} 个账号需要处理`);

            // 并发执行前置工作
            const preWorkPromises = accounts.map(account => 
                this.purchaseFlow.executePreWork(account)
            );

            const results = await Promise.allSettled(preWorkPromises);
            
            let successCount = 0;
            let failCount = 0;

            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    successCount++;
                    this.logger.info(`账号 ${accounts[index].username} 前置工作完成`);
                } else {
                    failCount++;
                    this.logger.error(`账号 ${accounts[index].username} 前置工作失败:`, result.reason);
                }
            });

            this.logger.info(`前置工作完成: 成功 ${successCount}, 失败 ${failCount}`);
            return successCount > 0;
        } catch (error) {
            this.logger.error('前置工作执行失败:', error);
            return false;
        }
    }

    /**
     * 等待抢购开始
     */
    async waitForPurchaseTime() {
        const purchaseTime = this.config.settings.purchaseTime;
        this.logger.info(`等待抢购开始时间: ${purchaseTime}`);
        
        return new Promise((resolve) => {
            this.scheduler.scheduleAt(purchaseTime, () => {
                this.logger.info('=== 抢购时间到达，开始执行抢购 ===');
                resolve();
            });
        });
    }

    /**
     * 执行抢购
     */
    async executePurchase() {
        try {
            const accounts = this.accountManager.getReadyAccounts();
            this.logger.info(`开始抢购，共 ${accounts.length} 个就绪账号`);

            if (accounts.length === 0) {
                this.logger.warn('没有就绪的账号可用于抢购');
                return { success: 0, fail: 0 };
            }

            // 执行完整的抢购流程
            const result = await this.purchaseFlow.executePurchase(accounts);

            if (result.success) {
                this.logger.info(`抢购完成: 成功 ${result.stats.totalSuccessful}, 重复 ${result.stats.totalDuplicate}`);
                return { 
                    success: result.stats.totalSuccessful, 
                    duplicate: result.stats.totalDuplicate,
                    fail: accounts.length - result.stats.totalCompleted 
                };
            } else {
                this.logger.error('抢购流程执行失败:', result.error);
                return { success: 0, duplicate: 0, fail: accounts.length };
            }
        } catch (error) {
            this.logger.error('抢购执行失败:', error);
            return { success: 0, duplicate: 0, fail: 0 };
        }
    }

    /**
     * 启动抢购系统
     */
    async start() {
        if (this.isRunning) {
            this.logger.warn('系统已在运行中');
            return;
        }

        this.isRunning = true;

        try {
            // 1. 初始化系统
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error('系统初始化失败');
            }

            // 2. 执行前置工作
            const preWorkDone = await this.executePreWork();
            if (!preWorkDone) {
                throw new Error('前置工作失败');
            }

            // 3. 等待抢购时间
            await this.waitForPurchaseTime();

            // 4. 执行抢购
            const result = await this.executePurchase();

            this.logger.info('=== 抢购系统执行完成 ===');
            this.logger.info(`最终结果: 成功 ${result.success} 个, 重复 ${result.duplicate || 0} 个, 失败 ${result.fail} 个`);

        } catch (error) {
            this.logger.error('系统运行出错:', error);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * 停止系统
     */
    stop() {
        this.logger.info('正在停止抢购系统...');
        this.isRunning = false;
        
        if (this.scheduler) {
            this.scheduler.stop();
        }
        
        if (this.proxyPool) {
            this.proxyPool.stop();
        }
        
        if (this.purchaseFlow) {
            this.purchaseFlow.stop();
        }
    }
}

// 启动应用
if (require.main === module) {
    const bot = new PurchaseBot();
    
    // 处理进程退出
    process.on('SIGINT', () => {
        console.log('\n收到退出信号，正在安全退出...');
        bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n收到终止信号，正在安全退出...');
        bot.stop();
        process.exit(0);
    });

    // 启动系统
    bot.start().catch(error => {
        console.error('启动失败:', error);
        process.exit(1);
    });
}

module.exports = PurchaseBot;
