/**
 * 申请提交器
 * 负责执行第三步的申请提交，支持多档位同步提交
 */

const { createLogger } = require('../utils/logger');

class ApplicationSubmitter {
    constructor(apiClient, config) {
        this.apiClient = apiClient;
        this.config = config;
        this.logger = createLogger('submitter');
        
        // 提交状态管理
        this.accountStatuses = new Map();
        this.concurrency = config.submitConcurrency || 20;
        
        // 成功和重复提交的账号记录
        this.successfulAccounts = new Set();
        this.duplicateSubmissions = new Set();
    }

    /**
     * 为单个账号提交申请（支持多档位同步提交）
     */
    async submitForAccount(account, ticket) {
        try {
            const accountId = account.accId;
            
            // 检查账号是否已经完成
            if (this.isAccountCompleted(accountId)) {
                this.logger.account(account, '账号已完成，跳过提交');
                return {
                    success: true,
                    completed: true,
                    account
                };
            }

            this.logger.account(account, '开始提交申请');

            // 生成提交任务列表
            const submitTasks = this.generateSubmitTasks(account, ticket);
            
            if (submitTasks.length === 0) {
                this.logger.account(account, '无可提交的档位');
                return {
                    success: false,
                    error: '无可提交的档位',
                    account
                };
            }

            this.logger.account(account, `准备同步提交 ${submitTasks.length} 个档位`, {
                tasks: submitTasks.map(task => task.description)
            });

            // 同步提交所有档位
            const promises = submitTasks.map(task => this.executeSubmitTask(task));
            const results = await Promise.allSettled(promises);

            // 处理提交结果
            return this.processSubmitResults(account, submitTasks, results);

        } catch (error) {
            this.logger.account(account, '提交申请异常', { error: error.message });
            return {
                success: false,
                error,
                account
            };
        }
    }

    /**
     * 生成提交任务列表
     */
    generateSubmitTasks(account, ticket) {
        const tasks = [];

        // 为每个消费档位生成独立任务
        Object.entries(account.tourismSubsidyIds || {}).forEach(([quota, subsidyId]) => {
            tasks.push({
                type: 'tourism',
                quota: quota,
                subsidyId: subsidyId,
                account: account,
                ticket: ticket,
                description: `消费${quota}档`
            });
        });

        // 如果有餐饮档位，生成餐饮任务
        if (account.foodSubsidyId) {
            tasks.push({
                type: 'food',
                subsidyId: account.foodSubsidyId,
                account: account,
                ticket: ticket,
                description: '餐饮档'
            });
        }

        return tasks;
    }

    /**
     * 执行单个提交任务
     */
    async executeSubmitTask(task) {
        try {
            let tourismSubsidyId = null;
            let foodSubsidyId = null;

            if (task.type === 'tourism') {
                tourismSubsidyId = task.subsidyId;
            } else if (task.type === 'food') {
                foodSubsidyId = task.subsidyId;
            }

            this.logger.account(task.account, `提交${task.description}`, {
                tourismSubsidyId,
                foodSubsidyId,
                ticket: task.ticket.substring(0, 8) + '...'
            });

            const result = await this.apiClient.submitApplication(
                task.account,
                task.ticket,
                tourismSubsidyId,
                foodSubsidyId
            );

            // 解析提交结果
            const submitResult = this.parseSubmitResponse(result, task);

            this.logger.account(task.account, `${task.description}提交结果: ${submitResult.status}`, {
                success: submitResult.success,
                message: submitResult.message,
                code: submitResult.code
            });

            return {
                ...submitResult,
                task
            };

        } catch (error) {
            this.logger.account(task.account, `${task.description}提交异常`, {
                error: error.message
            });
            
            return {
                success: false,
                status: 'error',
                error,
                task
            };
        }
    }

    /**
     * 解析提交响应
     */
    parseSubmitResponse(apiResult, task) {
        try {
            if (!apiResult.success) {
                return {
                    success: false,
                    status: 'api_error',
                    message: apiResult.message || 'API调用失败',
                    needRetry: false
                };
            }

            const responseData = apiResult.data;
            
            if (!responseData || typeof responseData !== 'object') {
                return {
                    success: false,
                    status: 'invalid_response',
                    message: '响应格式错误',
                    needRetry: true
                };
            }

            // 记录详细响应
            this.logger.account(task.account, `${task.description}响应详情`, {
                success: responseData.success,
                code: responseData.code,
                message: responseData.message,
                requestId: responseData.requestId
            });

            // 提交成功
            if (responseData.success === true) {
                return {
                    success: true,
                    status: 'submitted',
                    message: '提交成功',
                    code: responseData.code,
                    needRetry: false
                };
            }

            // 提交失败，判断具体情况
            if (responseData.success === false) {
                const code = responseData.code;
                const message = responseData.message || '';

                // Ticket过期，需要重新获取ticket
                if (code === 'TICKET_INVALID') {
                    return {
                        success: false,
                        status: 'ticket_invalid',
                        message: 'Ticket过期',
                        code: code,
                        needRetry: false,
                        needNewTicket: true
                    };
                }

                // 重复提交
                if (message.includes('重复提交')) {
                    return {
                        success: true, // 重复提交视为完成
                        status: 'duplicate',
                        message: '重复提交',
                        code: code,
                        needRetry: false
                    };
                }

                // 其他失败情况，可以继续重试
                return {
                    success: false,
                    status: 'failed',
                    message: message,
                    code: code,
                    needRetry: true
                };
            }

            // 未知状态
            return {
                success: false,
                status: 'unknown',
                message: '未知响应状态',
                needRetry: true
            };

        } catch (error) {
            this.logger.account(task.account, `${task.description}解析响应异常`, {
                error: error.message
            });
            
            return {
                success: false,
                status: 'parse_error',
                message: error.message,
                needRetry: true
            };
        }
    }

    /**
     * 处理提交结果
     */
    processSubmitResults(account, tasks, results) {
        const accountId = account.accId;
        let hasSuccess = false;
        let hasDuplicate = false;
        let needNewTicket = false;
        let allFailed = true;
        const errors = [];

        results.forEach((result, index) => {
            const task = tasks[index];
            
            if (result.status === 'fulfilled') {
                const submitResult = result.value;
                
                if (submitResult.success) {
                    allFailed = false;
                    
                    if (submitResult.status === 'submitted') {
                        hasSuccess = true;
                        this.logger.info(`🎉 提交成功 - ${account.username} ${task.description}`, {
                            account: account.username,
                            phone: account.phone,
                            type: task.type,
                            quota: task.quota || 'food'
                        });
                    } else if (submitResult.status === 'duplicate') {
                        hasDuplicate = true;
                        this.logger.info(`⚠️ 重复提交 - ${account.username} ${task.description}`, {
                            account: account.username,
                            phone: account.phone,
                            type: task.type,
                            quota: task.quota || 'food'
                        });
                    }
                } else {
                    if (submitResult.needNewTicket) {
                        needNewTicket = true;
                    }
                    if (submitResult.needRetry) {
                        allFailed = false; // 可以重试，不算彻底失败
                    }
                    errors.push(`${task.description}: ${submitResult.message}`);
                }
            } else {
                errors.push(`${task.description}: ${result.reason.message}`);
            }
        });

        // 更新账号状态
        if (hasSuccess || hasDuplicate) {
            this.markAccountCompleted(accountId, hasSuccess ? 'success' : 'duplicate');
        }

        // 记录成功和重复提交的账号
        if (hasSuccess) {
            this.successfulAccounts.add(accountId);
        }
        if (hasDuplicate) {
            this.duplicateSubmissions.add(accountId);
        }

        return {
            success: hasSuccess || hasDuplicate,
            completed: hasSuccess || hasDuplicate,
            hasSuccess,
            hasDuplicate,
            needNewTicket,
            needRetry: !allFailed && !hasSuccess && !hasDuplicate,
            errors,
            account
        };
    }

    /**
     * 批量提交申请
     */
    async submitForAccounts(accountTicketMap) {
        this.logger.info(`开始批量提交申请，共 ${accountTicketMap.size} 个账号`);

        const accounts = Array.from(accountTicketMap.keys());
        const results = new Map();
        
        // 分批并发处理
        const chunks = this.chunkArray(accounts, this.concurrency);
        
        for (const chunk of chunks) {
            const promises = chunk.map(async (account) => {
                const ticketInfo = accountTicketMap.get(account);
                const result = await this.submitForAccount(account, ticketInfo.ticket);
                results.set(account.accId, result);
            });

            await Promise.allSettled(promises);
        }

        // 统计结果
        const stats = this.calculateSubmitStats(results);
        this.logger.info('批量申请提交完成', stats);

        return {
            results,
            stats
        };
    }

    /**
     * 持续提交流程
     */
    async continuousSubmission(accountTicketMap) {
        this.logger.info(`开始持续提交流程，共 ${accountTicketMap.size} 个账号`);

        const completedAccounts = new Map();
        const retryAccounts = new Map();
        const ticketRetryAccounts = new Set();

        const accounts = Array.from(accountTicketMap.keys());
        const promises = accounts.map(async (account) => {
            const ticketInfo = accountTicketMap.get(account);
            const result = await this.submitForAccount(account, ticketInfo.ticket);

            if (result.completed) {
                completedAccounts.set(account.accId, result);
                this.logger.account(account, '账号流程完成');
            } else if (result.needNewTicket) {
                ticketRetryAccounts.add(account);
                this.logger.account(account, '需要重新获取ticket');
            } else if (result.needRetry) {
                retryAccounts.set(account, ticketInfo);
                this.logger.account(account, '继续提交重试');
            }
        });

        await Promise.allSettled(promises);

        const stats = {
            total: accounts.length,
            completed: completedAccounts.size,
            retry: retryAccounts.size,
            ticketRetry: ticketRetryAccounts.size,
            successful: this.successfulAccounts.size,
            duplicate: this.duplicateSubmissions.size
        };

        this.logger.info('持续提交流程完成', stats);

        return {
            completed: completedAccounts,
            retry: retryAccounts,
            ticketRetry: ticketRetryAccounts,
            stats
        };
    }

    /**
     * 检查账号是否已完成
     */
    isAccountCompleted(accountId) {
        return this.accountStatuses.has(accountId);
    }

    /**
     * 标记账号完成
     */
    markAccountCompleted(accountId, status) {
        this.accountStatuses.set(accountId, {
            status,
            completedAt: Date.now()
        });
    }

    /**
     * 计算提交统计
     */
    calculateSubmitStats(results) {
        const stats = {
            total: results.size,
            successful: 0,
            duplicate: 0,
            failed: 0,
            needRetry: 0,
            completed: 0
        };

        results.forEach(result => {
            if (result.completed) {
                stats.completed++;
                if (result.hasSuccess) {
                    stats.successful++;
                }
                if (result.hasDuplicate) {
                    stats.duplicate++;
                }
            } else if (result.needRetry) {
                stats.needRetry++;
            } else {
                stats.failed++;
            }
        });

        return stats;
    }

    /**
     * 将数组分块
     */
    chunkArray(array, chunkSize) {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * 获取成功统计
     */
    getSuccessStats() {
        return {
            totalSuccessful: this.successfulAccounts.size,
            totalDuplicate: this.duplicateSubmissions.size,
            successfulAccounts: Array.from(this.successfulAccounts),
            duplicateAccounts: Array.from(this.duplicateSubmissions)
        };
    }

    /**
     * 重置状态
     */
    reset() {
        this.accountStatuses.clear();
        this.successfulAccounts.clear();
        this.duplicateSubmissions.clear();
        this.logger.info('申请提交器状态已重置');
    }

    /**
     * 获取提交器状态
     */
    getStatus() {
        return {
            completedAccounts: this.accountStatuses.size,
            successfulAccounts: this.successfulAccounts.size,
            duplicateSubmissions: this.duplicateSubmissions.size,
            concurrency: this.concurrency
        };
    }
}

module.exports = ApplicationSubmitter;
