/**
 * 账号管理器
 * 负责管理账号信息和状态
 */

const { createLogger } = require('../utils/logger');

class AccountManager {
    constructor(accounts) {
        this.accounts = accounts || [];
        this.logger = createLogger('account');
        this.initializeAccounts();
    }

    /**
     * 初始化账号状态
     */
    initializeAccounts() {
        this.accounts.forEach(account => {
            // 确保每个账号都有完整的状态信息
            account.status = account.status || 'pending';
            account.levelIds = account.levelIds || {};
            account.lastError = account.lastError || null;
            account.preWorkCompleted = false;
            
            // 初始化档位ID存储
            account.tourismSubsidyIds = {};  // 消费补贴档位ID
            account.foodSubsidyId = null;    // 餐饮补贴档位ID
        });

        this.logger.info(`账号管理器初始化完成，共 ${this.accounts.length} 个账号`);
    }

    /**
     * 获取所有账号
     */
    getAccounts() {
        return this.accounts;
    }

    /**
     * 获取启用的账号
     */
    getEnabledAccounts() {
        return this.accounts.filter(account => account.enabled);
    }

    /**
     * 获取已完成前置工作的账号
     */
    getReadyAccounts() {
        return this.accounts.filter(account => 
            account.enabled && account.preWorkCompleted
        );
    }

    /**
     * 根据accId获取账号
     */
    getAccountByAccId(accId) {
        return this.accounts.find(account => account.accId === accId);
    }

    /**
     * 更新账号状态
     */
    updateAccountStatus(accId, status, error = null) {
        const account = this.getAccountByAccId(accId);
        if (account) {
            account.status = status;
            account.lastError = error;
            
            this.logger.account(account, `状态更新: ${status}`, { 
                error: error ? error.message : null 
            });
        }
    }

    /**
     * 设置账号的前置工作结果
     */
    setAccountPreWorkResult(accId, result) {
        const account = this.getAccountByAccId(accId);
        if (!account) {
            this.logger.error(`未找到账号: ${accId}`);
            return false;
        }

        try {
            // 清空之前的结果
            account.tourismSubsidyIds = {};
            account.foodSubsidyId = null;

            // 处理消费补贴档位
            if (result.tourismSubsidyPositions && Array.isArray(result.tourismSubsidyPositions)) {
                account.quotas.forEach(quota => {
                    const position = result.tourismSubsidyPositions.find(p => 
                        p.subsidyAmount === quota
                    );
                    
                    if (position) {
                        account.tourismSubsidyIds[quota] = position.id;
                        this.logger.account(account, `消费档位匹配成功: ${quota}元 -> ID: ${position.id}`);
                    } else {
                        this.logger.account(account, `消费档位匹配失败: ${quota}元`, { 
                            level: 'warn' 
                        });
                    }
                });
            }

            // 处理餐饮补贴档位
            if (result.foodSubsidyPositions && Array.isArray(result.foodSubsidyPositions)) {
                if (result.foodSubsidyPositions.length > 0) {
                    account.foodSubsidyId = result.foodSubsidyPositions[0].id;
                    this.logger.account(account, `餐饮档位记录: ID: ${account.foodSubsidyId}`);
                }
            }

            // 标记前置工作完成
            account.preWorkCompleted = true;
            account.status = 'ready';

            this.logger.account(account, '前置工作完成', {
                tourismSubsidyIds: account.tourismSubsidyIds,
                foodSubsidyId: account.foodSubsidyId
            });

            return true;
        } catch (error) {
            this.logger.error(`设置账号前置工作结果失败: ${accId}`, error);
            account.lastError = error;
            account.status = 'error';
            return false;
        }
    }

    /**
     * 获取账号的抢购任务列表
     * 每个消费档位生成一个任务
     */
    getAccountPurchaseTasks(accId) {
        const account = this.getAccountByAccId(accId);
        if (!account || !account.preWorkCompleted) {
            return [];
        }

        const tasks = [];

        // 为每个消费档位创建任务
        Object.entries(account.tourismSubsidyIds).forEach(([quota, id]) => {
            tasks.push({
                type: 'tourism',
                quota: parseInt(quota),
                subsidyId: id,
                account: account
            });
        });

        // 如果有餐饮档位，也创建任务
        if (account.foodSubsidyId) {
            tasks.push({
                type: 'food',
                subsidyId: account.foodSubsidyId,
                account: account
            });
        }

        return tasks;
    }

    /**
     * 获取账号统计信息
     */
    getAccountStats() {
        const stats = {
            total: this.accounts.length,
            enabled: 0,
            ready: 0,
            pending: 0,
            error: 0,
            success: 0
        };

        this.accounts.forEach(account => {
            if (account.enabled) stats.enabled++;
            
            switch (account.status) {
                case 'ready':
                    stats.ready++;
                    break;
                case 'pending':
                    stats.pending++;
                    break;
                case 'error':
                    stats.error++;
                    break;
                case 'success':
                    stats.success++;
                    break;
            }
        });

        return stats;
    }

    /**
     * 重置所有账号状态
     */
    resetAccountsStatus() {
        this.accounts.forEach(account => {
            account.status = 'pending';
            account.preWorkCompleted = false;
            account.tourismSubsidyIds = {};
            account.foodSubsidyId = null;
            account.lastError = null;
        });
        
        this.logger.info('所有账号状态已重置');
    }

    /**
     * 验证账号配置完整性
     */
    validateAccounts() {
        const errors = [];

        this.accounts.forEach((account, index) => {
            // 检查必要字段
            const requiredFields = ['accId', 'grabToken', 'uniqueId', 'quotas'];
            requiredFields.forEach(field => {
                if (!account[field]) {
                    errors.push(`账号 ${index + 1} (${account.username || '未知'}) 缺少字段: ${field}`);
                }
            });

            // 检查quotas格式
            if (account.quotas && !Array.isArray(account.quotas)) {
                errors.push(`账号 ${index + 1} (${account.username || '未知'}) quotas必须是数组`);
            }

            // 检查quotas值
            if (account.quotas && Array.isArray(account.quotas)) {
                const validQuotas = [300, 800, 1500, 3000];
                account.quotas.forEach(quota => {
                    if (!validQuotas.includes(quota)) {
                        errors.push(`账号 ${index + 1} (${account.username || '未知'}) 包含无效档位: ${quota}`);
                    }
                });
            }
        });

        if (errors.length > 0) {
            this.logger.error('账号配置验证失败:', errors);
            return { valid: false, errors };
        }

        this.logger.info('账号配置验证通过');
        return { valid: true, errors: [] };
    }
}

module.exports = AccountManager;
