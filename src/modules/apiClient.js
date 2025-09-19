/**
 * API客户端
 * 负责HTTP请求和代理管理
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createLogger } = require('../utils/logger');
const apiLogger = require('../utils/apiLogger');

class ApiClient {
    constructor(proxyPool, config) {
        this.proxyPool = proxyPool;
        this.config = config;
        this.logger = createLogger('api');
        this.baseURL = config.apis.baseUrl;
        this.defaultHeaders = config.apis.headers;
        this.timeout = config.requestTimeout || 5000;
    }

    /**
     * 创建HTTP客户端实例
     */
    createClient(account, useProxy = true) {
        const headers = {
            ...this.defaultHeaders,
            'Uid': account.accId,
            'Authorization': `Bearer ${account.grabToken}`
        };

        const clientConfig = {
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers,
            validateStatus: () => true // 不要自动抛出HTTP错误
        };

        // 如果启用代理
        if (useProxy && this.config.proxy.enabled) {
            try {
                const proxy = this.proxyPool.getRandomProxy();
                const proxyUrl = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
                
                if (proxy.auth) {
                    const authProxyUrl = `${proxy.protocol}://${proxy.auth.username}:${proxy.auth.password}@${proxy.host}:${proxy.port}`;
                    clientConfig.httpsAgent = new HttpsProxyAgent(authProxyUrl);
                    clientConfig.httpAgent = new HttpsProxyAgent(authProxyUrl);
                } else {
                    clientConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
                    clientConfig.httpAgent = new HttpsProxyAgent(proxyUrl);
                }

                this.logger.info(`使用代理: ${proxy.host}:${proxy.port}`, {
                    account: account.username,
                    proxy: `${proxy.host}:${proxy.port}`
                });
            } catch (error) {
                this.logger.warn('获取代理失败，使用直连', { 
                    account: account.username,
                    error: error.message 
                });
            }
        }

        return axios.create(clientConfig);
    }

    /**
     * 发送请求并处理重试
     */
    async makeRequest(account, options, retries = 3) {
        let lastError = null;
        let currentProxy = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const client = this.createClient(account, options.useProxy !== false);
                
                // 构建完整的请求配置，包括默认headers
                const fullOptions = {
                    ...options,
                    headers: {
                        ...this.defaultHeaders,
                        'Uid': account.accId,
                        'Authorization': `Bearer ${account.grabToken}`,
                        ...options.headers
                    }
                };
                
                this.logger.info(`请求开始 [${attempt}/${retries}]`, {
                    account: account.username,
                    method: fullOptions.method || 'GET',
                    url: fullOptions.url
                });

                const startTime = Date.now();
                const response = await client.request(fullOptions);
                const duration = Date.now() - startTime;

                this.logger.info(`请求完成`, {
                    account: account.username,
                    status: response.status,
                    duration: `${duration}ms`,
                    attempt
                });

                // 记录API原始回参到专门的日志文件
                await this.logApiResponse(account, fullOptions, response, duration, true);

                // 检查响应
                if (response.status === 200) {
                    return {
                        success: true,
                        data: response.data,
                        status: response.status,
                        duration
                    };
                } else {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

            } catch (error) {
                lastError = error;
                
                // 记录失败的API调用  
                const fullOptions = {
                    ...options,
                    headers: {
                        ...this.defaultHeaders,
                        'Uid': account.accId,
                        'Authorization': `Bearer ${account.grabToken}`,
                        ...options.headers
                    }
                };
                await this.logApiResponse(account, fullOptions, null, 0, false, error);
                
                this.logger.warn(`请求失败 [${attempt}/${retries}]`, {
                    account: account.username,
                    error: error.message,
                    code: error.code
                });

                // 如果是代理相关错误，标记代理失败
                if (currentProxy && this.isProxyError(error)) {
                    this.proxyPool.markProxyFailed(currentProxy);
                }

                // 如果不是最后一次重试，等待一段时间
                if (attempt < retries) {
                    const delay = this.config.retryDelay * attempt;
                    await this.sleep(delay);
                }
            }
        }

        return {
            success: false,
            error: lastError,
            message: lastError ? lastError.message : '请求失败'
        };
    }

    /**
     * 获取补贴档位列表
     */
    async getApplySubsidyPositionList(account) {
        const options = {
            method: 'POST',
            url: this.config.apis.endpoints.getApplySubsidyPositionList,
            data: {}
        };

        return await this.makeRequest(account, options);
    }

    /**
     * 获取票据
     */
    async getTicket(account) {
        const options = {
            method: 'GET',
            url: this.config.apis.endpoints.getTicket
        };

        return await this.makeRequest(account, options);
    }

    /**
     * 校验票据
     */
    async validateTicket(account, ticket) {
        const requestData = {
            ticket: ticket
        };

        // 获取请求头
        const headers = {
            ...this.defaultHeaders,
            'Uid': account.accId,
            'Authorization': `Bearer ${account.grabToken}`
        };

        const options = {
            method: 'POST',
            url: this.config.apis.endpoints.validateTicket,
            data: requestData,
            headers: headers
        };

        this.logger.info(`ticket校验请求详情`, {
            account: account.username,
            accId: account.accId,
            hasGrabToken: !!account.grabToken,
            grabTokenPreview: account.grabToken ? account.grabToken.substring(0, 20) + '...' : 'undefined',
            url: `${this.baseURL}${this.config.apis.endpoints.validateTicket}`,
            method: 'POST',
            headers: headers,
            requestData: requestData
        });

        const result = await this.makeRequest(account, options);

        this.logger.info(`ticket校验响应详情`, {
            account: account.username,
            success: result.success,
            status: result.status || 'unknown',
            responseData: result.data,
            error: result.error?.message || null
        });

        return result;
    }

    /**
     * 提交申请
     */
    async submitApplication(account, ticket, tourismSubsidyId = null, foodSubsidyId = null) {
        const requestData = {
            ticket: ticket,
            uniqueId: account.uniqueId,
            tourismSubsidyId: tourismSubsidyId
        };

        // 只有当foodSubsidyId有值时才添加该属性
        if (foodSubsidyId !== null && foodSubsidyId !== undefined) {
            requestData.foodSubsidyId = foodSubsidyId;
        }

        const options = {
            method: 'POST',
            url: this.config.apis.endpoints.submitApplication,
            data: requestData
        };

        return await this.makeRequest(account, options);
    }

    /**
     * 判断是否为代理相关错误
     */
    isProxyError(error) {
        const proxyErrorCodes = [
            'ECONNREFUSED',
            'ENOTFOUND', 
            'ETIMEDOUT',
            'ECONNRESET',
            'EPROTO'
        ];

        return proxyErrorCodes.includes(error.code) ||
               error.message.includes('proxy') ||
               error.message.includes('SOCKS');
    }

    /**
     * 睡眠函数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 测试连接
     */
    async testConnection(account, useProxy = true) {
        try {
            const client = this.createClient(account, useProxy);
            const response = await client.get('/');
            
            return {
                success: response.status < 400,
                status: response.status,
                proxy: useProxy ? '已启用' : '未启用'
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                proxy: useProxy ? '已启用' : '未启用'
            };
        }
    }

    /**
     * 记录API调用到专门的日志文件
     */
    async logApiResponse(account, options, response, duration, success, error = null) {
        try {
            const requestInfo = {
                url: `${this.baseURL}${options.url}`,
                method: options.method || 'GET',
                headers: options.headers || {},
                data: options.data || null
            };

            const responseInfo = response ? {
                status: response.status,
                headers: response.headers,
                data: response.data,
                duration
            } : null;

            // 根据不同的API端点调用不同的日志方法
            if (options.url.includes('/hyd-queue/core/simple/entry')) {
                await apiLogger.logTicketAcquisition(account, requestInfo, responseInfo, success, error);
            } else if (options.url.includes('/ai-smart-subsidy-approval/api/queue/ticket/check')) {
                await apiLogger.logTicketValidation(account, requestInfo, responseInfo, success, error);
            } else if (options.url.includes('/ai-smart-subsidy-approval/api/apply/submitApply')) {
                await apiLogger.logApplicationSubmission(account, requestInfo, responseInfo, success, error);
            } else if (options.url.includes('/ai-smart-subsidy-approval/api/apply/getApplySubsidyPositionList')) {
                await apiLogger.logPreWork(account, requestInfo, responseInfo, success, error);
            }
        } catch (logError) {
            this.logger.error('记录API日志失败:', logError);
        }
    }
}

module.exports = ApiClient;
