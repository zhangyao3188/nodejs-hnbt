/**
 * 抢购流程控制器
 * 整合三步抢购流程的完整执行
 */

const { createLogger } = require('../utils/logger');
const PreWork = require('./preWork');
const TicketManager = require('./ticketManager');
const TicketValidator = require('./ticketValidator');
const ApplicationSubmitter = require('./applicationSubmitter');

class PurchaseFlow {
    constructor(proxyPool, apiClient, config) {
        this.proxyPool = proxyPool;
        this.apiClient = apiClient;
        this.config = config;
        this.logger = createLogger('purchase');
        
        // 初始化各个步骤的处理器
        this.preWork = new PreWork(apiClient, null); // accountManager会在执行时传入
        this.ticketManager = new TicketManager(apiClient, config);
        this.ticketValidator = new TicketValidator(apiClient, config);
        this.applicationSubmitter = new ApplicationSubmitter(apiClient, config);
        
        // 流程状态
        this.currentStep = 'idle';
        this.startTime = null;
    }

    /**
     * 执行前置工作
     */
    async executePreWork(account) {
        try {
            this.logger.account(account, '执行前置工作');
            return await this.preWork.executeForAccount(account);
        } catch (error) {
            this.logger.account(account, '前置工作失败', { error: error.message });
            throw error;
        }
    }

    /**
     * 执行完整的抢购流程
     */
    async executePurchase(accounts) {
        this.startTime = Date.now();
        this.currentStep = 'starting';
        
        this.logger.info('=== 开始执行抢购流程 ===', {
            accountCount: accounts.length,
            startTime: new Date().toISOString()
        });

        try {
            // 第一步：获取Ticket
            const ticketResult = await this.executeTicketAcquisition(accounts);
            
            if (ticketResult.successful.size === 0) {
                throw new Error('所有账号都未能获取到ticket');
            }

            this.logger.info(`第一步完成，${ticketResult.successful.size}个账号获得ticket`);

            // 第二步：校验Ticket
            const validationResult = await this.executeTicketValidation(ticketResult.successful);
            
            if (validationResult.validated.size === 0) {
                throw new Error('所有ticket校验都失败');
            }

            this.logger.info(`第二步完成，${validationResult.validated.size}个账号通过校验`);

            // 第三步：提交申请
            const submissionResult = await this.executeApplicationSubmission(validationResult.validated);

            this.logger.info(`第三步完成，${submissionResult.stats.successful}个账号提交成功`);

            // 处理需要重试的账号
            await this.handleRetryFlow(validationResult.retry, submissionResult.retry, submissionResult.ticketRetry);

            // 计算最终结果
            const finalStats = this.calculateFinalStats();
            
            this.logger.info('=== 抢购流程执行完成 ===', {
                duration: Date.now() - this.startTime,
                ...finalStats
            });

            return {
                success: true,
                stats: finalStats
            };

        } catch (error) {
            this.logger.error('抢购流程执行失败:', error);
            return {
                success: false,
                error: error.message,
                stats: this.calculateFinalStats()
            };
        } finally {
            this.currentStep = 'completed';
        }
    }

    /**
     * 第一步：获取Ticket
     */
    async executeTicketAcquisition(accounts) {
        this.currentStep = 'ticket_acquisition';
        this.logger.info('=== 第一步：获取Ticket ===');

        return await this.ticketManager.continuousTicketAcquisition(accounts);
    }

    /**
     * 第二步：校验Ticket
     */
    async executeTicketValidation(accountTicketMap) {
        this.currentStep = 'ticket_validation';
        this.logger.info('=== 第二步：校验Ticket ===');

        return await this.ticketValidator.continuousValidation(accountTicketMap);
    }

    /**
     * 第三步：提交申请
     */
    async executeApplicationSubmission(validatedAccountMap) {
        this.currentStep = 'application_submission';
        this.logger.info('=== 第三步：提交申请 ===');

        return await this.applicationSubmitter.continuousSubmission(validatedAccountMap);
    }

    /**
     * 处理重试流程
     */
    async handleRetryFlow(ticketRetryAccounts, submissionRetryAccounts, ticketInvalidAccounts) {
        this.logger.info('=== 处理重试流程 ===', {
            ticketRetry: ticketRetryAccounts.size,
            submissionRetry: submissionRetryAccounts.size,
            ticketInvalid: ticketInvalidAccounts.size
        });

        // 合并需要重新获取ticket的账号
        const needTicketAccounts = new Set([
            ...Array.from(ticketRetryAccounts),
            ...Array.from(ticketInvalidAccounts)
        ]);

        let retryRound = 1;
        const maxRetryRounds = 5; // 最大重试轮次

        while ((needTicketAccounts.size > 0 || submissionRetryAccounts.size > 0) && retryRound <= maxRetryRounds) {
            this.logger.info(`=== 重试轮次 ${retryRound} ===`, {
                needTicket: needTicketAccounts.size,
                needSubmission: submissionRetryAccounts.size
            });

            // 处理需要重新获取ticket的账号
            if (needTicketAccounts.size > 0) {
                const ticketAccounts = Array.from(needTicketAccounts);
                
                // 重新获取ticket
                const ticketResult = await this.ticketManager.continuousTicketAcquisition(ticketAccounts);
                
                if (ticketResult.successful.size > 0) {
                    // 校验新获取的ticket
                    const validationResult = await this.ticketValidator.continuousValidation(ticketResult.successful);
                    
                    if (validationResult.validated.size > 0) {
                        // 提交申请
                        const submissionResult = await this.applicationSubmitter.continuousSubmission(validationResult.validated);
                        
                        // 更新重试队列
                        submissionResult.retry.forEach((ticketInfo, account) => {
                            submissionRetryAccounts.set(account, ticketInfo);
                        });
                        
                        submissionResult.ticketRetry.forEach(account => {
                            needTicketAccounts.add(account);
                        });
                    }
                    
                    // 移除已处理的账号
                    validationResult.retry.forEach(account => {
                        needTicketAccounts.add(account);
                    });
                }
                
                // 清除本轮处理的账号
                needTicketAccounts.clear();
                ticketResult.failed.forEach((result, accountId) => {
                    const account = ticketAccounts.find(acc => acc.accId === accountId);
                    if (account) {
                        needTicketAccounts.add(account);
                    }
                });
            }

            // 处理只需要重新提交的账号
            if (submissionRetryAccounts.size > 0) {
                const submissionResult = await this.applicationSubmitter.continuousSubmission(submissionRetryAccounts);
                
                // 更新重试队列
                submissionRetryAccounts.clear();
                submissionResult.retry.forEach((ticketInfo, account) => {
                    submissionRetryAccounts.set(account, ticketInfo);
                });
                
                submissionResult.ticketRetry.forEach(account => {
                    needTicketAccounts.add(account);
                });
            }

            retryRound++;
            
            // 如果还有待处理的账号，稍作等待
            if (needTicketAccounts.size > 0 || submissionRetryAccounts.size > 0) {
                await this.sleep(1000);
            }
        }

        this.logger.info('重试流程结束', {
            completedRounds: retryRound - 1,
            remainingTicketRetry: needTicketAccounts.size,
            remainingSubmissionRetry: submissionRetryAccounts.size
        });
    }

    /**
     * 计算最终统计
     */
    calculateFinalStats() {
        const submitterStats = this.applicationSubmitter.getSuccessStats();
        
        return {
            totalSuccessful: submitterStats.totalSuccessful,
            totalDuplicate: submitterStats.totalDuplicate,
            totalCompleted: submitterStats.totalSuccessful + submitterStats.totalDuplicate,
            duration: this.startTime ? Date.now() - this.startTime : 0,
            currentStep: this.currentStep
        };
    }

    /**
     * 获取流程状态
     */
    getStatus() {
        return {
            currentStep: this.currentStep,
            startTime: this.startTime,
            duration: this.startTime ? Date.now() - this.startTime : 0,
            ticketManager: this.ticketManager.getStatus(),
            submitter: this.applicationSubmitter.getStatus()
        };
    }

    /**
     * 停止流程
     */
    stop() {
        this.logger.info('停止抢购流程');
        this.currentStep = 'stopped';
        
        // 清理各个组件的状态
        this.ticketManager.clearAllTickets();
        this.applicationSubmitter.reset();
    }

    /**
     * 重置流程
     */
    reset() {
        this.currentStep = 'idle';
        this.startTime = null;
        
        this.ticketManager.clearAllTickets();
        this.applicationSubmitter.reset();
        
        this.logger.info('抢购流程已重置');
    }

    /**
     * 睡眠函数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = PurchaseFlow;
