/**
 * Ticket校验器
 * 负责校验获得的ticket是否有效
 */

const { createLogger } = require('../utils/logger');

class TicketValidator {
    constructor(apiClient, config) {
        this.apiClient = apiClient;
        this.config = config;
        this.logger = createLogger('validator');
    }

    /**
     * 校验单个账号的ticket
     */
    async validateTicketForAccount(account, ticket) {
        try {
            this.logger.account(account, '开始校验ticket', {
                ticket: ticket.substring(0, 8) + '...'
            });

            const result = await this.apiClient.validateTicket(account, ticket);

            if (!result.success) {
                throw new Error(`校验API调用失败: ${result.message}`);
            }

            // 检查校验结果
            const isValid = this.parseValidationResponse(result.data, account);

            if (isValid) {
                this.logger.account(account, 'ticket校验通过');
                return {
                    success: true,
                    valid: true,
                    account,
                    ticket
                };
            } else {
                this.logger.account(account, 'ticket校验失败，需要重新获取ticket');
                return {
                    success: true,
                    valid: false,
                    account,
                    ticket,
                    needRetry: true
                };
            }

        } catch (error) {
            this.logger.account(account, 'ticket校验异常', {
                error: error.message
            });
            
            return {
                success: false,
                valid: false,
                account,
                ticket,
                error,
                needRetry: true
            };
        }
    }

    /**
     * 批量校验ticket
     */
    async validateTicketsForAccounts(accountTicketMap) {
        const accounts = Array.from(accountTicketMap.keys());
        this.logger.info(`开始批量校验ticket，共 ${accounts.length} 个账号`);

        const results = new Map();
        const promises = accounts.map(async (account) => {
            const ticketInfo = accountTicketMap.get(account);
            const result = await this.validateTicketForAccount(account, ticketInfo.ticket);
            results.set(account.accId, result);
        });

        await Promise.allSettled(promises);

        // 统计结果
        const stats = this.calculateValidationStats(results);
        this.logger.info('批量ticket校验完成', stats);

        return {
            results,
            stats
        };
    }

    /**
     * 持续校验流程
     * 校验失败的账号返回获取ticket步骤，成功的进入下一步
     */
    async continuousValidation(accountTicketMap) {
        this.logger.info(`开始ticket校验流程，共 ${accountTicketMap.size} 个账号`);

        const validatedAccounts = new Map(); // 校验通过的账号
        const retryAccounts = new Set(); // 需要重新获取ticket的账号

        // accountTicketMap的key是accId，value是{ticket, account, ...}
        const accountIds = Array.from(accountTicketMap.keys());
        const promises = accountIds.map(async (accId) => {
            const ticketInfo = accountTicketMap.get(accId);
            const account = ticketInfo.account;
            const result = await this.validateTicketForAccount(account, ticketInfo.ticket);

            if (result.valid) {
                // 校验通过，进入下一步
                validatedAccounts.set(account.accId, {
                    account,
                    ticket: ticketInfo.ticket,
                    validatedAt: Date.now()
                });
                
                this.logger.account(account, '进入提交申请阶段');
            } else {
                // 校验失败，重新获取ticket
                retryAccounts.add(account);
                this.logger.account(account, '返回ticket获取阶段');
            }
        });

        await Promise.allSettled(promises);

        const stats = {
            total: accountIds.length,
            validated: validatedAccounts.size,
            retry: retryAccounts.size
        };

        this.logger.info('ticket校验流程完成', stats);

        return {
            validated: validatedAccounts,
            retry: retryAccounts,
            stats
        };
    }

    /**
     * 解析校验响应
     */
    parseValidationResponse(responseData, account) {
        try {
            if (!responseData || typeof responseData !== 'object') {
                this.logger.account(account, '校验响应格式错误', { responseData });
                return false;
            }

            // 记录完整的响应用于调试
            this.logger.account(account, '校验响应解析', {
                success: responseData.success,
                code: responseData.code,
                message: responseData.message,
                data: responseData.data,
                requestId: responseData.requestId,
                debugMessage: responseData.debugMessage
            });

            // 判断校验是否通过
            // success === true 表示校验通过，success === false 表示校验失败
            if (responseData.success === true) {
                this.logger.account(account, '✅ ticket校验通过');
                return true;
            } else if (responseData.success === false) {
                this.logger.account(account, '❌ ticket校验失败', {
                    code: responseData.code,
                    message: responseData.message
                });
                return false;
            } else {
                // success字段不是boolean，可能是其他状态
                this.logger.account(account, '⚠️ ticket校验响应异常', {
                    success: responseData.success,
                    type: typeof responseData.success
                });
                return false;
            }

        } catch (error) {
            this.logger.account(account, '解析校验响应异常', {
                error: error.message
            });
            return false;
        }
    }

    /**
     * 计算校验统计
     */
    calculateValidationStats(results) {
        const stats = {
            total: results.size,
            valid: 0,
            invalid: 0,
            error: 0
        };

        results.forEach(result => {
            if (result.success) {
                if (result.valid) {
                    stats.valid++;
                } else {
                    stats.invalid++;
                }
            } else {
                stats.error++;
            }
        });

        return stats;
    }

    /**
     * 获取校验器状态
     */
    getStatus() {
        return {
            isActive: true,
            apiEndpoint: this.config.apis.endpoints.validateTicket
        };
    }
}

module.exports = TicketValidator;
