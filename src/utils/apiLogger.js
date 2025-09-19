/**
 * API原始回参日志记录器
 * 专门用于记录所有API接口的原始请求和响应数据
 */

const fs = require('fs-extra');
const path = require('path');

class ApiLogger {
    constructor() {
        this.logDir = path.join(__dirname, '../../logs');
        this.logFile = path.join(this.logDir, 'api-responses.log');
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
     * 记录API请求和响应
     */
    async logApiCall(apiInfo) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            datetime: new Date().toLocaleString('zh-CN'),
            ...apiInfo
        };

        const logLine = JSON.stringify(logEntry, null, 2) + '\n' + '='.repeat(100) + '\n';

        try {
            await fs.appendFile(this.logFile, logLine);
        } catch (error) {
            console.error('写入API日志失败:', error);
        }
    }

    /**
     * 记录第一步：获取ticket
     */
    async logTicketAcquisition(account, request, response, success, error = null) {
        await this.logApiCall({
            step: '第一步-获取Ticket',
            api: '/hyd-queue/core/simple/entry',
            method: 'GET',
            account: {
                username: account.username,
                phone: account.phone,
                accId: account.accId
            },
            request: {
                url: request.url,
                headers: request.headers,
                params: request.params || {}
            },
            response: {
                status: response?.status,
                headers: response?.headers,
                data: response?.data,
                duration: response?.duration
            },
            success,
            error: error ? {
                message: error.message,
                code: error.code,
                stack: error.stack
            } : null
        });
    }

    /**
     * 记录第二步：校验ticket
     */
    async logTicketValidation(account, request, response, success, error = null) {
        await this.logApiCall({
            step: '第二步-校验Ticket',
            api: '/ai-smart-subsidy-approval/api/queue/ticket/check',
            method: 'POST',
            account: {
                username: account.username,
                phone: account.phone,
                accId: account.accId
            },
            request: {
                url: request.url,
                headers: request.headers,
                data: request.data
            },
            response: {
                status: response?.status,
                headers: response?.headers,
                data: response?.data,
                duration: response?.duration
            },
            success,
            error: error ? {
                message: error.message,
                code: error.code,
                stack: error.stack
            } : null
        });
    }

    /**
     * 记录第三步：提交申请
     */
    async logApplicationSubmission(account, request, response, success, error = null) {
        await this.logApiCall({
            step: '第三步-提交申请',
            api: '/ai-smart-subsidy-approval/api/apply/submitApply',
            method: 'POST',
            account: {
                username: account.username,
                phone: account.phone,
                accId: account.accId
            },
            request: {
                url: request.url,
                headers: request.headers,
                data: request.data
            },
            response: {
                status: response?.status,
                headers: response?.headers,
                data: response?.data,
                duration: response?.duration
            },
            success,
            error: error ? {
                message: error.message,
                code: error.code,
                stack: error.stack
            } : null
        });
    }

    /**
     * 记录前置工作：获取档位列表
     */
    async logPreWork(account, request, response, success, error = null) {
        await this.logApiCall({
            step: '前置工作-获取档位列表',
            api: '/ai-smart-subsidy-approval/api/apply/getApplySubsidyPositionList',
            method: 'POST',
            account: {
                username: account.username,
                phone: account.phone,
                accId: account.accId
            },
            request: {
                url: request.url,
                headers: request.headers,
                data: request.data
            },
            response: {
                status: response?.status,
                headers: response?.headers,
                data: response?.data,
                duration: response?.duration
            },
            success,
            error: error ? {
                message: error.message,
                code: error.code,
                stack: error.stack
            } : null
        });
    }
}

// 创建全局实例
const apiLogger = new ApiLogger();

module.exports = apiLogger;
