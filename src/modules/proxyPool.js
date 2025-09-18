/**
 * 代理池管理器
 * 负责获取、管理和轮换代理IP
 */

const axios = require('axios');
const { createLogger } = require('../utils/logger');

class ProxyPool {
    constructor(config) {
        this.config = config;
        this.logger = createLogger('proxy');
        this.proxies = [];
        this.currentIndex = 0;
        this.expireTime = null;
        this.refreshTimer = null;
        this.expireCheckTimer = null;
        this.isRefreshing = false;
        this.onExpired = null; // 过期回调函数
    }

    /**
     * 初始化代理池
     */
    async initialize() {
        try {
            this.logger.info('初始化代理池...');
            await this.refreshProxies();
            this.scheduleRefresh();
            this.logger.info(`代理池初始化完成，共 ${this.proxies.length} 个代理`);
            this.startExpireMonitoring();
            return true;
        } catch (error) {
            this.logger.error('代理池初始化失败:', error);
            return false;
        }
    }

    /**
     * 从API获取代理列表
     */
    async fetchProxies() {
        try {
            this.logger.info('正在获取代理列表...');
            
            const response = await axios.get(this.config.apiUrl, {
                timeout: 10000
            });

            const data = response.data;
            
            if (data.status !== "0") {
                throw new Error(`代理API返回错误: ${data.info || '未知错误'}`);
            }

            if (!data.list || !Array.isArray(data.list)) {
                throw new Error('代理API返回数据格式错误');
            }

            // 解析过期时间（直接按照本地时间解析）
            const expireStr = data.expire;
            // 手动解析：2025-09-19 00:51:35 格式，按本地时间创建
            const parts = expireStr.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
            if (parts) {
                this.expireTime = new Date(
                    parseInt(parts[1]), // year
                    parseInt(parts[2]) - 1, // month (0-based)
                    parseInt(parts[3]), // day
                    parseInt(parts[4]), // hour
                    parseInt(parts[5]), // minute
                    parseInt(parts[6])  // second
                );
            } else {
                // 备用解析方式
                this.expireTime = new Date(data.expire);
            }
            
            this.logger.info(`解析过期时间: ${data.expire} -> ${this.expireTime.toLocaleString('zh-CN')} (当前时间: ${new Date().toLocaleString('zh-CN')})`);
            
            // 转换代理格式
            const proxies = data.list.map(proxy => ({
                host: proxy.sever,
                port: proxy.port,
                protocol: 'http',
                enabled: true,
                failCount: 0,
                lastUsed: null,
                maxFails: 3
            }));

            this.logger.info(`获取到 ${proxies.length} 个代理，过期时间: ${data.expire}`);
            return proxies;

        } catch (error) {
            this.logger.error('获取代理失败:', error);
            throw error;
        }
    }

    /**
     * 刷新代理池
     */
    async refreshProxies() {
        if (this.isRefreshing) {
            this.logger.warn('代理池正在刷新中，跳过重复请求');
            return;
        }

        try {
            this.isRefreshing = true;
            const newProxies = await this.fetchProxies();
            
            this.proxies = newProxies;
            this.currentIndex = 0;
            
            this.logger.info(`代理池已刷新，新增 ${newProxies.length} 个代理`);
            this.startExpireMonitoring(); // 重新开始过期监控
        } catch (error) {
            this.logger.error('刷新代理池失败:', error);
            // 如果刷新失败但还有可用代理，继续使用
            if (this.proxies.length === 0) {
                throw error;
            }
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * 调度代理刷新
     */
    scheduleRefresh() {
        // 清除现有定时器
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        // 设置刷新间隔（默认4分钟，比5分钟过期时间提前）
        const refreshInterval = this.config.refreshInterval || 240000;
        
        this.refreshTimer = setInterval(async () => {
            try {
                await this.refreshProxies();
            } catch (error) {
                this.logger.error('定时刷新代理失败:', error);
            }
        }, refreshInterval);

        this.logger.info(`代理池刷新定时器已设置，间隔: ${refreshInterval / 1000}秒`);
    }

    /**
     * 获取下一个可用代理
     */
    getNextProxy() {
        if (this.proxies.length === 0) {
            throw new Error('代理池为空');
        }

        // 检查是否过期
        if (this.expireTime && new Date() > this.expireTime) {
            this.logger.warn('代理已过期，尝试刷新...');
            // 异步刷新，不阻塞当前请求
            this.refreshProxies().catch(err => {
                this.logger.error('异步刷新代理失败:', err);
            });
        }

        // 查找可用代理
        let attempts = 0;
        while (attempts < this.proxies.length) {
            const proxy = this.proxies[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

            if (proxy.enabled && proxy.failCount < proxy.maxFails) {
                proxy.lastUsed = new Date();
                return {
                    host: proxy.host,
                    port: proxy.port,
                    protocol: proxy.protocol,
                    auth: proxy.auth
                };
            }

            attempts++;
        }

        // 如果所有代理都不可用，重置失败计数并返回一个
        this.logger.warn('所有代理都不可用，重置失败计数');
        this.resetFailCounts();
        
        const proxy = this.proxies[0];
        return {
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol,
            auth: proxy.auth
        };
    }

    /**
     * 获取随机代理
     */
    getRandomProxy() {
        if (this.proxies.length === 0) {
            throw new Error('代理池为空');
        }

        const availableProxies = this.proxies.filter(p => 
            p.enabled && p.failCount < p.maxFails
        );

        if (availableProxies.length === 0) {
            this.resetFailCounts();
            return this.getRandomProxy();
        }

        const randomIndex = Math.floor(Math.random() * availableProxies.length);
        const proxy = availableProxies[randomIndex];
        
        proxy.lastUsed = new Date();
        
        return {
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol,
            auth: proxy.auth
        };
    }

    /**
     * 标记代理失败
     */
    markProxyFailed(proxyInfo) {
        const proxy = this.proxies.find(p => 
            p.host === proxyInfo.host && p.port === proxyInfo.port
        );
        
        if (proxy) {
            proxy.failCount++;
            this.logger.warn(`代理 ${proxy.host}:${proxy.port} 失败次数: ${proxy.failCount}`);
            
            if (proxy.failCount >= proxy.maxFails) {
                proxy.enabled = false;
                this.logger.warn(`代理 ${proxy.host}:${proxy.port} 已禁用`);
            }
        }
    }

    /**
     * 重置所有代理的失败计数
     */
    resetFailCounts() {
        this.proxies.forEach(proxy => {
            proxy.failCount = 0;
            proxy.enabled = true;
        });
        this.logger.info('已重置所有代理的失败计数');
    }

    /**
     * 获取代理池状态
     */
    getStatus() {
        const totalProxies = this.proxies.length;
        const availableProxies = this.proxies.filter(p => 
            p.enabled && p.failCount < p.maxFails
        ).length;
        
        return {
            total: totalProxies,
            available: availableProxies,
            expireTime: this.expireTime,
            isExpired: this.expireTime ? new Date() > this.expireTime : false
        };
    }

    /**
     * 开始过期时间监控
     */
    startExpireMonitoring() {
        // 清除之前的监控定时器
        if (this.expireCheckTimer) {
            clearInterval(this.expireCheckTimer);
        }

        if (!this.expireTime) {
            this.logger.warn('没有过期时间，跳过过期监控');
            return;
        }

        const now = new Date();
        const expireTime = new Date(this.expireTime);
        
        if (expireTime <= now) {
            this.logger.error('代理已过期，立即触发过期处理');
            this.handleExpired();
            return;
        }

        // 计算到过期时间的毫秒数
        const timeToExpire = expireTime.getTime() - now.getTime();
        
        this.logger.info(`代理过期监控已启动`, {
            expireTime: this.expireTime,
            timeToExpire: `${Math.round(timeToExpire / 1000)}秒`
        });

        // 设置过期检查定时器，每30秒检查一次
        this.expireCheckTimer = setInterval(() => {
            const currentTime = new Date();
            const expireDateTime = new Date(this.expireTime);
            
            if (currentTime >= expireDateTime) {
                this.logger.error('代理已过期，停止系统运行');
                this.handleExpired();
            } else {
                const remainingTime = Math.round((expireDateTime.getTime() - currentTime.getTime()) / 1000);
                if (remainingTime <= 60) { // 最后1分钟每次都提醒
                    this.logger.warn(`代理将在 ${remainingTime} 秒后过期`);
                }
            }
        }, 30000); // 每30秒检查一次

        // 同时设置一个精确的过期定时器
        setTimeout(() => {
            this.logger.error('代理过期时间到达，强制停止系统');
            this.handleExpired();
        }, timeToExpire);
    }

    /**
     * 处理代理过期
     */
    handleExpired() {
        this.logger.error('🚨 代理已过期，系统将自动停止 🚨');
        
        // 清除所有定时器
        this.stop();
        
        // 调用过期回调函数
        if (this.onExpired && typeof this.onExpired === 'function') {
            this.onExpired();
        } else {
            // 如果没有设置回调，直接退出进程
            this.logger.error('代理过期，程序退出');
            process.exit(1);
        }
    }

    /**
     * 设置过期回调函数
     */
    setExpiredCallback(callback) {
        this.onExpired = callback;
    }

    /**
     * 停止代理池
     */
    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        
        if (this.expireCheckTimer) {
            clearInterval(this.expireCheckTimer);
            this.expireCheckTimer = null;
        }
        
        this.logger.info('代理池已停止');
    }
}

module.exports = ProxyPool;
