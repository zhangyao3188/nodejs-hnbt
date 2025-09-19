/**
 * 抢购流程控制器
 * 整合三步抢购流程的完整执行
 */

const { createLogger } = require('../utils/logger');
const successLogger = require('../utils/successLogger');
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
        this.isRunning = true;
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
     * 执行完整的抢购流程 - 独立账号流程
     */
    async executePurchase(accounts) {
        this.startTime = Date.now();
        this.currentStep = 'starting';
        
        this.logger.info('=== 开始执行独立账号抢购流程 ===', {
            accountCount: accounts.length,
            startTime: new Date().toISOString()
        });

        try {
            // 为每个账号启动独立的抢购流程
            const accountPromises = accounts.map(account => 
                this.executeIndependentAccountFlow(account)
            );

            // 等待所有账号完成（但各自独立进行）
            const results = await Promise.allSettled(accountPromises);

            // 统计结果
            const finalStats = this.calculateResultStats(results);
            
            this.logger.info('=== 独立账号抢购流程执行完成 ===', {
                duration: Date.now() - this.startTime,
                ...finalStats
            });

            return {
                success: true,
                stats: finalStats
            };

        } catch (error) {
            this.logger.error('抢购流程执行失败:', error);
            
            // 即使出错也尝试统计已完成的结果
            const basicStats = { success: 0, fail: accounts.length, duplicate: 0 };
            return {
                success: false,
                error: error.message,
                stats: basicStats
            };
        } finally {
            this.currentStep = 'completed';
        }
    }

    /**
     * 为单个账号执行独立的完整抢购流程
     */
    async executeIndependentAccountFlow(account) {
        this.logger.account(account, '开始独立抢购流程');
        
        try {
            // 持续执行直到成功、重复提交或系统停止
            while (this.isRunning) {
                try {
                    // 第一步：获取Ticket
                    this.logger.account(account, '步骤1: 获取ticket');
                    const ticketResult = await this.ticketManager.getTicketForAccount(account);
                    
                    if (!ticketResult.success) {
                        this.logger.account(account, '获取ticket失败，继续重试');
                        await this.sleep(1000);
                        continue;
                    }

                    // 第二步：校验Ticket
                    this.logger.account(account, '步骤2: 校验ticket');
                    const validationResult = await this.ticketValidator.validateTicketForAccount(account, ticketResult.ticket);
                    
                    if (!validationResult.valid) {
                        this.logger.account(account, 'ticket校验失败，重新获取ticket');
                        continue; // 回到第一步
                    }

                    // 第三步：提交申请
                    this.logger.account(account, '步骤3: 提交申请');
                    const submissionResult = await this.applicationSubmitter.submitForAccount(account, ticketResult.ticket);
                    
                    if (submissionResult.success && submissionResult.completed) {
                        // 记录成功或重复提交到专门的日志文件
                        await this.logSuccessfulSubmission(account, submissionResult);
                        
                        this.logger.account(account, '✅ 独立流程完成 - 提交成功');
                        return {
                            success: true,
                            account,
                            result: submissionResult,
                            type: submissionResult.result?.status === 'duplicate' ? 'duplicate' : 'submitted'
                        };
                    }
                    
                    if (submissionResult.needNewTicket) {
                        this.logger.account(account, 'ticket过期，重新获取ticket');
                        continue; // 回到第一步
                    }
                    
                    // 提交失败但可以重试，继续第三步（applicationSubmitter内部已经处理无限重试）
                    this.logger.account(account, '提交申请失败，继续重试');
                    
                } catch (stepError) {
                    this.logger.account(account, '步骤执行异常', { error: stepError.message });
                    await this.sleep(2000); // 异常时等待2秒
                }
            }
            
            // 系统停止
            this.logger.account(account, '系统停止，独立流程中断');
            return {
                success: false,
                account,
                error: '系统停止',
                type: 'interrupted'
            };
            
        } catch (error) {
            this.logger.account(account, '独立流程异常', { error: error.message });
            return {
                success: false,
                account,
                error: error.message,
                type: 'error'
            };
        }
    }

    /**
     * 计算结果统计
     */
    calculateResultStats(results) {
        let success = 0;
        let duplicate = 0;
        let fail = 0;
        
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value.success) {
                if (result.value.type === 'duplicate') {
                    duplicate++;
                } else {
                    success++;
                }
            } else {
                fail++;
            }
        });
        
        return { success, duplicate, fail, total: results.length };
    }

    /**
     * 设置运行状态
     */
    stop() {
        this.isRunning = false;
        this.logger.info('停止抢购流程');
        
        // 停止各个组件
        if (this.ticketManager) {
            this.ticketManager.stop && this.ticketManager.stop();
        }
        if (this.ticketValidator) {
            this.ticketValidator.stop && this.ticketValidator.stop();
        }
        if (this.applicationSubmitter) {
            this.applicationSubmitter.stop && this.applicationSubmitter.stop();
        }
    }

    /**
     * 记录成功提交到专门的日志文件
     */
    async logSuccessfulSubmission(account, submissionResult) {
        try {
            // 从submissionResult中提取提交的档位信息
            const result = submissionResult.result;
            if (!result) return;

            // 构建档位信息
            const quotaInfo = {
                type: 'unknown',
                quota: 'unknown',
                subsidyId: 'unknown',
                description: '提交成功'
            };

            // 尝试从账号信息中推断档位
            if (account.tourismSubsidyIds) {
                const quotas = Object.keys(account.tourismSubsidyIds);
                if (quotas.length > 0) {
                    quotaInfo.type = 'tourism';
                    quotaInfo.quota = quotas[0]; // 取第一个档位作为代表
                    quotaInfo.subsidyId = account.tourismSubsidyIds[quotas[0]];
                    quotaInfo.description = `消费${quotas[0]}档`;
                }
            }

            // 判断是成功还是重复提交
            if (result.status === 'duplicate') {
                await successLogger.logDuplicateUser(account, quotaInfo, result);
            } else {
                await successLogger.logSuccessUser(account, quotaInfo, result);
            }
        } catch (error) {
            this.logger.error('记录成功提交日志失败:', error);
        }
    }

    /**
     * 睡眠函数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
