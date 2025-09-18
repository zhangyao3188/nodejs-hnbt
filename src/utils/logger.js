/**
 * 日志工具
 * 提供结构化的日志记录功能
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');

// 确保logs目录存在
const logsDir = path.join(__dirname, '../../logs');
fs.ensureDirSync(logsDir);

/**
 * 创建日志实例
 */
function createLogger(module = 'app') {
    const logFormat = winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss.SSS'
        }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
            let log = `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}`;
            
            // 添加额外的元数据
            if (Object.keys(meta).length > 0) {
                log += ` ${JSON.stringify(meta)}`;
            }
            
            // 添加错误堆栈
            if (stack) {
                log += `\n${stack}`;
            }
            
            return log;
        })
    );

    const logger = winston.createLogger({
        level: 'info',
        format: logFormat,
        transports: [
            // 控制台输出
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    logFormat
                )
            }),
            
            // 所有日志文件
            new winston.transports.File({
                filename: path.join(logsDir, 'app.log'),
                maxsize: 10 * 1024 * 1024, // 10MB
                maxFiles: 7,
                tailable: true
            }),
            
            // 错误日志文件
            new winston.transports.File({
                filename: path.join(logsDir, 'error.log'),
                level: 'error',
                maxsize: 10 * 1024 * 1024,
                maxFiles: 7,
                tailable: true
            }),
            
            // 抢购日志文件
            new winston.transports.File({
                filename: path.join(logsDir, 'purchase.log'),
                level: 'info',
                maxsize: 10 * 1024 * 1024,
                maxFiles: 7,
                tailable: true,
                format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.json()
                )
            })
        ]
    });

    // 添加便捷方法
    logger.account = (account, message, extra = {}) => {
        logger.info(message, {
            account: account.username,
            phone: account.phone,
            accId: account.accId,
            ...extra
        });
    };

    logger.purchase = (account, step, result, extra = {}) => {
        const logData = {
            account: account.username,
            phone: account.phone,
            accId: account.accId,
            step,
            result,
            timestamp: new Date().toISOString(),
            ...extra
        };
        
        logger.info(`购买步骤: ${step} - ${result}`, logData);
    };

    logger.proxy = (proxy, message, extra = {}) => {
        logger.info(message, {
            proxy: `${proxy.host}:${proxy.port}`,
            ...extra
        });
    };

    return logger;
}

/**
 * 创建性能日志
 */
function createPerformanceLogger() {
    return createLogger('performance');
}

/**
 * 创建API日志
 */
function createApiLogger() {
    return createLogger('api');
}

module.exports = {
    createLogger,
    createPerformanceLogger,
    createApiLogger
};
