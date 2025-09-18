/**
 * 前置工作模块
 * 负责获取账号的档位ID信息
 */

const { createLogger } = require('../utils/logger');

class PreWork {
    constructor(apiClient, accountManager) {
        this.apiClient = apiClient;
        this.accountManager = accountManager;
        this.logger = createLogger('prework');
    }

    /**
     * 执行单个账号的前置工作
     */
    async executeForAccount(account) {
        try {
            this.logger.account(account, '开始执行前置工作');
            
            // 更新账号状态
            this.accountManager.updateAccountStatus(account.accId, 'processing');

            // 调用获取档位列表接口
            const result = await this.apiClient.getApplySubsidyPositionList(account);
            
            if (!result.success) {
                throw new Error(`API调用失败: ${result.message}`);
            }

            // 检查响应格式
            if (!this.validateResponse(result.data)) {
                throw new Error('API响应格式不正确');
            }

            // 解析响应数据
            const parsedData = this.parseResponseData(result.data, account);
            
            // 保存结果到账号管理器
            const saved = this.accountManager.setAccountPreWorkResult(
                account.accId, 
                parsedData
            );

            if (!saved) {
                throw new Error('保存前置工作结果失败');
            }

            // 记录详细的前置工作结果
            const resultSummary = this.generateResultSummary(account);
            this.logger.account(account, '前置工作完成', resultSummary);
            
            // 单独记录档位ID映射结果用于监控
            this.logger.info(`前置结果 - ${account.username}`, {
                foodSubsidyId: account.foodSubsidyId || 'null',
                tourismSubsidyIds: Object.entries(account.tourismSubsidyIds || {})
                    .map(([quota, id]) => `${quota}档:${id}`)
                    .join(', ') || 'null'
            });

            return {
                success: true,
                account: account,
                data: parsedData
            };

        } catch (error) {
            this.logger.account(account, '前置工作失败', { error: error.message });
            this.accountManager.updateAccountStatus(account.accId, 'error', error);
            
            return {
                success: false,
                account: account,
                error: error
            };
        }
    }

    /**
     * 批量执行前置工作
     */
    async executeForAllAccounts(accounts, concurrency = 5) {
        this.logger.info(`开始批量前置工作，共 ${accounts.length} 个账号，并发数: ${concurrency}`);
        
        const results = [];
        const chunks = this.chunkArray(accounts, concurrency);
        
        for (const chunk of chunks) {
            const promises = chunk.map(account => this.executeForAccount(account));
            const chunkResults = await Promise.allSettled(promises);
            
            // 处理结果
            chunkResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                } else {
                    const account = chunk[index];
                    this.logger.account(account, '前置工作异常', { 
                        error: result.reason.message 
                    });
                    results.push({
                        success: false,
                        account: account,
                        error: result.reason
                    });
                }
            });

            // 批次间间隔
            if (chunks.indexOf(chunk) < chunks.length - 1) {
                await this.sleep(1000);
            }
        }

        // 统计结果
        const stats = this.calculateStats(results);
        this.logger.info('批量前置工作完成', stats);

        return {
            results,
            stats
        };
    }

    /**
     * 验证API响应格式
     */
    validateResponse(data) {
        // 检查基本结构
        if (!data || typeof data !== 'object') {
            this.logger.error('响应数据不是对象格式');
            return false;
        }

        if (!data.success) {
            this.logger.error('API返回失败状态', { code: data.code, message: data.message });
            return false;
        }

        if (!data.data) {
            this.logger.error('响应中缺少data字段');
            return false;
        }

        return true;
    }

    /**
     * 解析响应数据
     */
    parseResponseData(apiResponse, account) {
        const responseData = apiResponse.data;
        
        this.logger.account(account, '解析API响应', {
            tourismPositions: responseData.tourismSubsidyPositions?.length || 0,
            foodPositions: responseData.foodSubsidyPositions?.length || 0
        });

        // 记录详细的档位信息用于调试
        if (responseData.tourismSubsidyPositions) {
            responseData.tourismSubsidyPositions.forEach(position => {
                this.logger.account(account, '消费档位详情', {
                    id: position.id,
                    targetAmount: position.targetAmount,
                    subsidyAmount: position.subsidyAmount,
                    ifHasQuota: position.ifHasQuota
                });
            });
        }

        if (responseData.foodSubsidyPositions) {
            responseData.foodSubsidyPositions.forEach(position => {
                this.logger.account(account, '餐饮档位详情', {
                    id: position.id,
                    targetAmount: position.targetAmount,
                    subsidyAmount: position.subsidyAmount,
                    ifHasQuota: position.ifHasQuota
                });
            });
        }

        return responseData;
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
     * 计算统计信息
     */
    calculateStats(results) {
        const stats = {
            total: results.length,
            success: 0,
            failed: 0,
            tourismMatched: 0,
            foodMatched: 0
        };

        results.forEach(result => {
            if (result.success) {
                stats.success++;
                
                // 统计匹配的档位数量
                const account = result.account;
                stats.tourismMatched += Object.keys(account.tourismSubsidyIds || {}).length;
                if (account.foodSubsidyId) {
                    stats.foodMatched++;
                }
            } else {
                stats.failed++;
            }
        });

        return stats;
    }

    /**
     * 获取前置工作摘要
     */
    getPreWorkSummary() {
        const accounts = this.accountManager.getAccounts();
        const summary = {
            total: accounts.length,
            completed: 0,
            pending: 0,
            failed: 0,
            details: []
        };

        accounts.forEach(account => {
            const detail = {
                username: account.username,
                status: account.preWorkCompleted ? 'completed' : 
                       account.lastError ? 'failed' : 'pending',
                tourismCount: Object.keys(account.tourismSubsidyIds || {}).length,
                hasFood: !!account.foodSubsidyId,
                error: account.lastError?.message || null
            };

            summary.details.push(detail);

            if (account.preWorkCompleted) {
                summary.completed++;
            } else if (account.lastError) {
                summary.failed++;
            } else {
                summary.pending++;
            }
        });

        return summary;
    }

    /**
     * 生成前置工作结果摘要
     */
    generateResultSummary(account) {
        const summary = {
            tourismPositions: Object.keys(account.tourismSubsidyIds || {}).length,
            foodPositions: account.foodSubsidyId ? 1 : 0,
            tourismDetails: account.tourismSubsidyIds || {},
            foodDetail: account.foodSubsidyId
        };

        return summary;
    }

    /**
     * 睡眠函数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = PreWork;
