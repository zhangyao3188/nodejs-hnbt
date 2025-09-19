/**
 * 配置管理器
 * 负责加载和管理所有配置文件
 */

const fs = require('fs-extra');
const path = require('path');

class ConfigManager {
    constructor() {
        this.settings = null;
        this.accounts = null;
        this.configDir = path.join(__dirname, '../../config');
        this.dataDir = path.join(__dirname, '../../data');
    }

    /**
     * 加载所有配置
     */
    async load() {
        try {
            // 加载系统设置
            await this.loadSettings();
            
            // 加载账号配置
            await this.loadAccounts();
            
            console.log('所有配置加载完成');
            return true;
        } catch (error) {
            console.error('配置加载失败:', error);
            throw error;
        }
    }

    /**
     * 加载系统设置
     */
    async loadSettings() {
        const settingsPath = path.join(this.configDir, 'settings.json');
        const examplePath = path.join(this.configDir, 'settings.example.json');
        
        if (!await fs.pathExists(settingsPath)) {
            if (await fs.pathExists(examplePath)) {
                await fs.copy(examplePath, settingsPath);
                console.log('已从示例文件创建settings.json，请检查配置');
            } else {
                throw new Error('settings.json和settings.example.json都不存在');
            }
        }
        
        this.settings = await fs.readJson(settingsPath);
        console.log('系统设置加载完成');
    }

    /**
     * 加载账号配置
     */
    async loadAccounts() {
        // 优先从data目录加载accounts.txt
        const accountsTxtPath = path.join(this.dataDir, '../accounts.txt');
        const accountsJsonPath = path.join(this.configDir, 'accounts.json');
        
        if (await fs.pathExists(accountsTxtPath)) {
            // 加载accounts.txt格式
            const accountsData = await fs.readJson(accountsTxtPath);
            this.accounts = this.parseAccountsData(accountsData);
            console.log(`从accounts.txt加载了 ${this.accounts.length} 个账号`);
        } else if (await fs.pathExists(accountsJsonPath)) {
            // 加载accounts.json格式
            this.accounts = await fs.readJson(accountsJsonPath);
            console.log(`从accounts.json加载了 ${this.accounts.length} 个账号`);
        } else {
            throw new Error('找不到任何账号配置文件，请确保项目根目录有 accounts.txt 文件');
        }
    }

    /**
     * 解析accounts.txt格式的数据
     */
    parseAccountsData(data) {
        if (!data.accounts || !Array.isArray(data.accounts)) {
            throw new Error('accounts.txt格式不正确，缺少accounts数组');
        }

        return data.accounts.map(account => {
            // 兼容不同的字段名：token 或 grabToken
            const token = account.grabToken || account.token;
            
            // 验证必要字段
            const required = ['accId', 'uniqueId', 'quotas'];
            for (const field of required) {
                if (!account[field]) {
                    throw new Error(`账号 ${account.name || '未知'} 缺少必要字段: ${field}`);
                }
            }
            
            if (!token) {
                throw new Error(`账号 ${account.name || '未知'} 缺少token字段 (grabToken或token)`);
            }

            return {
                username: account.name || `用户${account.uniqueId}`,
                phone: account.phone || '',
                accId: account.accId,
                grabToken: token,
                uniqueId: account.uniqueId,
                quotas: account.quotas,
                enabled: true,
                // 用于存储运行时状态
                status: 'pending',
                levelIds: {},  // 存储获取到的档位ID
                lastError: null
            };
        });
    }

    /**
     * 获取系统设置
     */
    getSettings() {
        return this.settings;
    }

    /**
     * 获取账号列表
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
     * 根据档位获取账号
     */
    getAccountsByQuota(quota) {
        return this.accounts.filter(account => 
            account.enabled && account.quotas.includes(quota)
        );
    }

    /**
     * 更新账号状态
     */
    updateAccountStatus(accId, status, error = null) {
        const account = this.accounts.find(acc => acc.accId === accId);
        if (account) {
            account.status = status;
            account.lastError = error;
        }
    }

    /**
     * 设置账号的档位ID
     */
    setAccountLevelId(accId, quota, levelId) {
        const account = this.accounts.find(acc => acc.accId === accId);
        if (account) {
            account.levelIds[quota] = levelId;
        }
    }

    /**
     * 获取档位配置
     */
    getLevelConfig(quota) {
        return this.settings.levels[quota.toString()];
    }

    /**
     * 获取API配置
     */
    getApiConfig() {
        return this.settings.apis;
    }

    /**
     * 获取代理配置
     */
    getProxyConfig() {
        return this.settings.proxy;
    }

    /**
     * 获取请求头模板
     */
    getRequestHeaders(account) {
        const baseHeaders = { ...this.settings.apis.headers };
        
        if (account) {
            baseHeaders['Uid'] = account.accId;
            baseHeaders['Authorization'] = `Bearer ${account.grabToken}`;
        }
        
        return baseHeaders;
    }

    /**
     * 保存配置到文件
     */
    async saveAccounts() {
        const accountsPath = path.join(this.configDir, 'accounts.json');
        await fs.writeJson(accountsPath, this.accounts, { spaces: 2 });
    }
}

module.exports = ConfigManager;
