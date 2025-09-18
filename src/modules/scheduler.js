/**
 * 定时调度器
 * 负责管理抢购开始时间和任务调度
 */

const cron = require('node-cron');
const moment = require('moment');
const { createLogger } = require('../utils/logger');

class Scheduler {
    constructor(config) {
        this.config = config;
        this.logger = createLogger('scheduler');
        this.scheduledTasks = new Map();
        this.isRunning = false;
    }

    /**
     * 在指定时间执行任务
     */
    scheduleAt(timeString, callback, allowImmediate = true) {
        try {
            const targetTime = this.parseTimeForSchedule(timeString, allowImmediate);
            const now = moment();
            
            this.logger.info(`调度任务设置`, {
                targetTime: targetTime.format('YYYY-MM-DD HH:mm:ss'),
                currentTime: now.format('YYYY-MM-DD HH:mm:ss'),
                delay: targetTime.diff(now, 'milliseconds') + 'ms'
            });

            // 如果目标时间已过，立即执行
            if (targetTime.isBefore(now) || targetTime.diff(now) <= 1000) {
                this.logger.info('目标时间已到或已过，立即执行任务');
                setTimeout(callback, 100); // 稍微延迟100ms确保日志输出
                return;
            }

            // 计算延迟时间
            const delay = targetTime.diff(now);
            
            // 设置定时器
            const timeoutId = setTimeout(() => {
                this.logger.info('调度时间到达，执行任务');
                callback();
            }, delay);

            // 保存任务引用
            this.scheduledTasks.set('main', timeoutId);

            // 添加倒计时日志
            this.startCountdown(targetTime);

        } catch (error) {
            this.logger.error('调度任务失败:', error);
            throw error;
        }
    }

    /**
     * 开始倒计时日志
     */
    startCountdown(targetTime) {
        const countdownInterval = setInterval(() => {
            const now = moment();
            const diff = targetTime.diff(now);
            
            if (diff <= 0) {
                clearInterval(countdownInterval);
                return;
            }

            const duration = moment.duration(diff);
            const hours = Math.floor(duration.asHours());
            const minutes = duration.minutes();
            const seconds = duration.seconds();

            // 每分钟输出一次倒计时（最后10秒每秒输出）
            if (seconds === 0 || diff < 10000) {
                this.logger.info(`距离开始还有: ${hours}小时${minutes}分钟${seconds}秒`);
            }
        }, 1000);

        this.scheduledTasks.set('countdown', countdownInterval);
    }

    /**
     * 解析时间字符串（用于调度，可选择是否允许立即执行）
     */
    parseTimeForSchedule(timeString, allowImmediate = true) {
        try {
            // 支持多种时间格式
            let targetTime;
            
            if (timeString.includes(':')) {
                // HH:mm:ss 或 HH:mm 格式
                const today = moment().format('YYYY-MM-DD');
                targetTime = moment(`${today} ${timeString}`, 'YYYY-MM-DD HH:mm:ss');
                
                // 如果时间已过，根据allowImmediate决定处理方式
                if (targetTime.isBefore(moment())) {
                    if (allowImmediate) {
                        // 允许立即执行，返回当前时间
                        this.logger.info(`配置时间 ${timeString} 已过，将立即执行`);
                        return moment();
                    } else {
                        // 设置为明天
                        targetTime.add(1, 'day');
                        this.logger.info(`配置时间 ${timeString} 已过，设置为明天执行`);
                    }
                }
            } else {
                // 完整日期时间格式
                targetTime = moment(timeString);
            }

            if (!targetTime.isValid()) {
                throw new Error(`无效的时间格式: ${timeString}`);
            }

            return targetTime;
        } catch (error) {
            this.logger.error('解析时间失败:', error);
            throw error;
        }
    }

    /**
     * 解析时间字符串（保持原有逻辑，用于其他用途）
     */
    parseTime(timeString) {
        return this.parseTimeForSchedule(timeString, false);
    }

    /**
     * 取消所有调度任务
     */
    stop() {
        this.scheduledTasks.forEach((task, name) => {
            if (typeof task === 'number') {
                clearTimeout(task);
            } else {
                clearInterval(task);
            }
            this.logger.info(`取消调度任务: ${name}`);
        });
        
        this.scheduledTasks.clear();
        this.isRunning = false;
        this.logger.info('调度器已停止');
    }

    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            scheduledTasks: Array.from(this.scheduledTasks.keys()),
            currentTime: moment().format('YYYY-MM-DD HH:mm:ss')
        };
    }

    /**
     * 等待指定时间
     */
    async waitUntil(timeString) {
        return new Promise((resolve, reject) => {
            try {
                this.scheduleAt(timeString, resolve);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 延迟执行
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 检查是否到达指定时间
     */
    isTimeReached(timeString) {
        try {
            const targetTime = this.parseTime(timeString);
            return moment().isAfter(targetTime);
        } catch (error) {
            this.logger.error('检查时间失败:', error);
            return false;
        }
    }

    /**
     * 获取距离目标时间的毫秒数
     */
    getTimeUntil(timeString) {
        try {
            const targetTime = this.parseTime(timeString);
            const diff = targetTime.diff(moment());
            return Math.max(0, diff);
        } catch (error) {
            this.logger.error('计算时间差失败:', error);
            return 0;
        }
    }
}

module.exports = Scheduler;
