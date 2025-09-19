/**
 * 成功用户日志记录器
 * 专门用于记录最终成功和重复提交的用户
 */

const fs = require('fs-extra');
const path = require('path');

class SuccessLogger {
    constructor() {
        this.logDir = path.join(__dirname, '../../logs');
        this.successLogFile = path.join(this.logDir, 'success-users.log');
        this.ensureLogDir();
    }

    /**
     * 确保日志目录存在
     */
    async ensureLogDir() {
        try {
            await fs.ensureDir(this.logDir);
        } catch (error) {
            console.error('创建日志目录失败:', error);
        }
    }

    /**
     * 记录成功用户
     */
    async logSuccessUser(account, quotaInfo, submitResult) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            datetime: new Date().toLocaleString('zh-CN'),
            status: '🎉 提交成功',
            account: {
                username: account.username,
                phone: account.phone,
                accId: account.accId
            },
            quota: quotaInfo,
            result: {
                success: submitResult.success,
                code: submitResult.code,
                message: submitResult.message,
                requestId: submitResult.requestId
            }
        };

        await this.writeLogEntry(logEntry);
    }

    /**
     * 记录重复提交用户
     */
    async logDuplicateUser(account, quotaInfo, submitResult) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            datetime: new Date().toLocaleString('zh-CN'),
            status: '⚠️ 重复提交',
            account: {
                username: account.username,
                phone: account.phone,
                accId: account.accId
            },
            quota: quotaInfo,
            result: {
                success: submitResult.success,
                code: submitResult.code,
                message: submitResult.message,
                requestId: submitResult.requestId
            }
        };

        await this.writeLogEntry(logEntry);
    }

    /**
     * 写入日志条目
     */
    async writeLogEntry(logEntry) {
        const logLine = JSON.stringify(logEntry, null, 2) + '\n' + '='.repeat(80) + '\n';

        try {
            await fs.appendFile(this.successLogFile, logLine);
        } catch (error) {
            console.error('写入成功用户日志失败:', error);
        }
    }

    /**
     * 获取成功用户统计
     */
    async getSuccessStats() {
        try {
            if (!await fs.pathExists(this.successLogFile)) {
                return { successCount: 0, duplicateCount: 0, totalCount: 0 };
            }

            const content = await fs.readFile(this.successLogFile, 'utf8');
            // 按分隔符分割成独立的日志条目
            const entries = content.split('='.repeat(80)).filter(entry => entry.trim());
            
            let successCount = 0;
            let duplicateCount = 0;

            for (const entryText of entries) {
                const trimmedEntry = entryText.trim();
                if (trimmedEntry.startsWith('{')) {
                    try {
                        const entry = JSON.parse(trimmedEntry);
                        if (entry.status === '🎉 提交成功') {
                            successCount++;
                        } else if (entry.status === '⚠️ 重复提交') {
                            duplicateCount++;
                        }
                    } catch (e) {
                        // 忽略解析错误的条目
                        console.error('解析日志条目失败:', e.message);
                    }
                }
            }

            return {
                successCount,
                duplicateCount,
                totalCount: successCount + duplicateCount
            };
        } catch (error) {
            console.error('读取成功用户统计失败:', error);
            return { successCount: 0, duplicateCount: 0, totalCount: 0 };
        }
    }

    /**
     * 清空成功用户日志（通常在新的抢购开始时调用）
     */
    async clearSuccessLog() {
        try {
            if (await fs.pathExists(this.successLogFile)) {
                await fs.unlink(this.successLogFile);
            }
        } catch (error) {
            console.error('清空成功用户日志失败:', error);
        }
    }
}

// 创建全局实例
const successLogger = new SuccessLogger();

module.exports = successLogger;
