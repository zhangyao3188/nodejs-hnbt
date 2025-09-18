/**
 * Ticket管理器
 * 负责获取和管理抢购票据，控制请求频率
 */

const { createLogger } = require('../utils/logger');

class TicketManager {
    constructor(apiClient, config) {
        this.apiClient = apiClient;
        this.config = config;
        this.logger = createLogger('ticket');
        
        // 频率控制 - 每个账号独立的请求记录
        this.accountRequestTimes = new Map();
        
        // Ticket状态管理
        this.accountTickets = new Map();
        
        // 配置参数
        this.maxRequestsPerSecond = config.ticket?.maxRequestsPerSecond || 2;
        this.retryInterval = config.ticket?.retryInterval || 500;
        this.timeout = config.ticket?.timeout || 180000; // 3分钟超时
    }

    /**
     * 为单个账号获取ticket
     */
    async getTicketForAccount(account) {
        const accountId = account.accId;
        let attempts = 0;
        const startTime = Date.now();

        this.logger.account(account, '开始获取ticket');

        while (true) { // 没有最大重试数限制，只受超时时间控制
            attempts++;
            
            // 检查超时
            if (Date.now() - startTime > this.timeout) {
                const error = new Error(`获取ticket超时 (${this.timeout}ms)`);
                this.logger.account(account, 'ticket获取超时', { 
                    attempts, 
                    duration: Date.now() - startTime 
                });
                throw error;
            }

            try {
                // 频率控制检查
                await this.enforceRateLimit(accountId);

                // 调用API获取ticket
                const result = await this.apiClient.getTicket(account);
                
                if (!result.success) {
                    throw new Error(result.message || 'API调用失败');
                }

                // 检查响应格式和ticket有效性
                const ticket = this.validateTicketResponse(result.data, account);
                
                if (ticket) {
                    // 成功获取ticket
                    this.accountTickets.set(accountId, {
                        ticket,
                        timestamp: Date.now(),
                        account
                    });

                    this.logger.account(account, 'ticket获取成功', {
                        ticket: ticket.substring(0, 8) + '...',
                        attempts,
                        duration: Date.now() - startTime
                    });

                    return {
                        success: true,
                        ticket,
                        attempts,
                        duration: Date.now() - startTime
                    };
                }

                // ticket无效，继续重试
                this.logger.account(account, `ticket无效，重试 [第${attempts}次]`);

            } catch (error) {
                this.logger.account(account, `获取ticket失败 [第${attempts}次]`, {
                    error: error.message,
                    code: error.code
                });

                // 如果是429错误，增加等待时间
                if (error.code === 429 || error.message.includes('429')) {
                    await this.sleep(this.retryInterval * 2);
                } else {
                    await this.sleep(this.retryInterval);
                }
            }
        }

        // 超时失败
        const error = new Error(`获取ticket超时失败，已重试${attempts}次`);
        this.logger.account(account, 'ticket获取超时失败', {
            totalAttempts: attempts,
            totalDuration: Date.now() - startTime
        });
        
        throw error;
    }

    /**
     * 批量获取ticket
     */
    async getTicketsForAccounts(accounts) {
        this.logger.info(`开始为 ${accounts.length} 个账号获取ticket`);
        
        const results = new Map();
        const promises = accounts.map(async (account) => {
            try {
                const result = await this.getTicketForAccount(account);
                results.set(account.accId, {
                    success: true,
                    ...result,
                    account
                });
            } catch (error) {
                results.set(account.accId, {
                    success: false,
                    error,
                    account
                });
            }
        });

        // 等待所有账号完成
        await Promise.allSettled(promises);

        // 统计结果
        const stats = this.calculateTicketStats(results);
        this.logger.info('批量ticket获取完成', stats);

        return {
            results,
            stats
        };
    }

    /**
     * 持续获取ticket直到所有账号成功或超时
     */
    async continuousTicketAcquisition(accounts, globalTimeout = 60000) {
        const startTime = Date.now();
        const pendingAccounts = new Set(accounts.map(acc => acc.accId));
        const successfulAccounts = new Map();
        const failedAccounts = new Map();

        this.logger.info(`开始持续ticket获取模式，全局超时: ${globalTimeout}ms`);

        while (pendingAccounts.size > 0 && (Date.now() - startTime) < globalTimeout) {
            const currentAccounts = accounts.filter(acc => pendingAccounts.has(acc.accId));
            
            const promises = currentAccounts.map(async (account) => {
                try {
                    const result = await this.getTicketForAccount(account);
                    
                    // 成功获取ticket
                    pendingAccounts.delete(account.accId);
                    successfulAccounts.set(account.accId, {
                        ...result,
                        account
                    });

                    this.logger.account(account, '进入下一阶段', {
                        remainingAccounts: pendingAccounts.size
                    });

                } catch (error) {
                    // 这里不移除账号，让它继续尝试
                    this.logger.account(account, '继续等待ticket', {
                        error: error.message,
                        remainingTime: globalTimeout - (Date.now() - startTime)
                    });
                }
            });

            // 等待当前轮次完成
            await Promise.allSettled(promises);

            // 如果还有账号未成功，等待一段时间再继续
            if (pendingAccounts.size > 0) {
                await this.sleep(1000);
            }
        }

        // 处理超时的账号
        pendingAccounts.forEach(accId => {
            const account = accounts.find(acc => acc.accId === accId);
            failedAccounts.set(accId, {
                success: false,
                error: new Error('全局超时'),
                account
            });
        });

        const finalStats = {
            total: accounts.length,
            successful: successfulAccounts.size,
            failed: failedAccounts.size,
            duration: Date.now() - startTime
        };

        this.logger.info('持续ticket获取结束', finalStats);

        return {
            successful: successfulAccounts,
            failed: failedAccounts,
            stats: finalStats
        };
    }

    /**
     * 频率控制检查
     */
    async enforceRateLimit(accountId) {
        const now = Date.now();
        
        if (!this.accountRequestTimes.has(accountId)) {
            this.accountRequestTimes.set(accountId, []);
        }

        const requestTimes = this.accountRequestTimes.get(accountId);
        
        // 清除1秒前的请求记录
        const oneSecondAgo = now - 1000;
        const recentRequests = requestTimes.filter(time => time > oneSecondAgo);
        
        // 检查是否超过频率限制
        if (recentRequests.length >= this.maxRequestsPerSecond) {
            const oldestRequest = Math.min(...recentRequests);
            const waitTime = 1000 - (now - oldestRequest);
            
            if (waitTime > 0) {
                this.logger.debug(`账号 ${accountId} 频率限制，等待 ${waitTime}ms`);
                await this.sleep(waitTime);
            }
        }

        // 记录当前请求时间
        requestTimes.push(now);
        this.accountRequestTimes.set(accountId, requestTimes.slice(-this.maxRequestsPerSecond));
    }

    /**
     * 验证ticket响应
     */
    validateTicketResponse(responseData, account) {
        try {
            if (!responseData || typeof responseData !== 'object') {
                return null;
            }

            if (!responseData.success || responseData.code !== "0") {
                this.logger.account(account, 'API返回失败状态', {
                    code: responseData.code,
                    message: responseData.message
                });
                return null;
            }

            if (!responseData.data || !responseData.data.ticket) {
                this.logger.account(account, 'ticket为空', {
                    data: responseData.data
                });
                return null;
            }

            const ticket = responseData.data.ticket;
            
            if (typeof ticket !== 'string' || ticket.trim() === '') {
                this.logger.account(account, 'ticket格式无效', { ticket });
                return null;
            }

            // 记录详细的响应信息
            this.logger.account(account, 'ticket响应详情', {
                beginTime: responseData.data.beginTime,
                begin: responseData.data.begin,
                access: responseData.data.access,
                allNums: responseData.data.allNums
            });

            return ticket;
        } catch (error) {
            this.logger.account(account, 'ticket验证异常', { error: error.message });
            return null;
        }
    }

    /**
     * 计算ticket获取统计
     */
    calculateTicketStats(results) {
        const stats = {
            total: results.size,
            successful: 0,
            failed: 0,
            averageAttempts: 0,
            averageDuration: 0
        };

        let totalAttempts = 0;
        let totalDuration = 0;

        results.forEach(result => {
            if (result.success) {
                stats.successful++;
                totalAttempts += result.attempts || 0;
                totalDuration += result.duration || 0;
            } else {
                stats.failed++;
            }
        });

        if (stats.successful > 0) {
            stats.averageAttempts = Math.round(totalAttempts / stats.successful);
            stats.averageDuration = Math.round(totalDuration / stats.successful);
        }

        return stats;
    }

    /**
     * 获取账号的ticket
     */
    getAccountTicket(accountId) {
        return this.accountTickets.get(accountId);
    }

    /**
     * 清除账号ticket
     */
    clearAccountTicket(accountId) {
        this.accountTickets.delete(accountId);
    }

    /**
     * 获取所有有效ticket
     */
    getAllValidTickets() {
        const validTickets = new Map();
        const now = Date.now();
        
        this.accountTickets.forEach((ticketInfo, accountId) => {
            // 可以添加ticket过期检查逻辑
            validTickets.set(accountId, ticketInfo);
        });

        return validTickets;
    }

    /**
     * 清理所有ticket
     */
    clearAllTickets() {
        this.accountTickets.clear();
        this.accountRequestTimes.clear();
        this.logger.info('已清理所有ticket数据');
    }

    /**
     * 获取管理器状态
     */
    getStatus() {
        return {
            totalTickets: this.accountTickets.size,
            requestCounts: Array.from(this.accountRequestTimes.entries()).map(([accountId, times]) => ({
                accountId,
                recentRequests: times.length
            })),
            config: {
                maxRequestsPerSecond: this.maxRequestsPerSecond,
                retryInterval: this.retryInterval,
                timeout: this.timeout
            }
        };
    }

    /**
     * 睡眠函数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TicketManager;
