/**
 * YZMM Server Status Agent
 * 运行在你的服务器上，收集系统状态
 * 并定期推送到 Cloudflare Workers API
 */

const si = require('systeminformation');
const fetch = require('node-fetch');
const net = require('net');
const fs = require('fs');
const path = require('path');

// 加载配置（优先使用环境变量）
const config = {
    apiEndpoint: process.env.API_ENDPOINT,
    updateToken: process.env.UPDATE_TOKEN,
    intervalMs: parseInt(process.env.INTERVAL_MS) || 30000,
    // 本地服务检测配置
    localServices: (process.env.LOCAL_SERVICES || 'AstrBot:6185').split(',').map(s => {
        const [name, port] = s.split(':');
        return { name, host: 'localhost', port: parseInt(port) };
    })
};

// 如果环境变量未设置，尝试从配置文件加载
if (!config.apiEndpoint || !config.updateToken) {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.apiEndpoint = config.apiEndpoint || fileConfig.apiEndpoint;
        config.updateToken = config.updateToken || fileConfig.updateToken;
        config.intervalMs = config.intervalMs || fileConfig.intervalMs;
    }
}

if (!config.apiEndpoint || !config.updateToken) {
    console.error('❌ 请配置 API_ENDPOINT 和 UPDATE_TOKEN 环境变量，或创建 config.json');
    process.exit(1);
}

// 检测本地服务端口是否在线
async function checkLocalService(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const timeout = 3000;

        socket.setTimeout(timeout);
        socket.on('connect', () => {
            socket.destroy();
            resolve({ online: true });
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ online: false });
        });
        socket.on('error', () => {
            resolve({ online: false });
        });
        socket.connect(port, host);
    });
}

// 检测所有本地服务
async function checkLocalServices() {
    const results = [];
    for (const service of config.localServices) {
        const status = await checkLocalService(service.host, service.port);
        results.push({
            name: service.name,
            host: service.host,
            port: service.port,
            online: status.online
        });
    }
    return results;
}

// 检测大小核信息（仅Linux）
async function detectCoreTypes() {
    try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');

        const cpus = os.cpus();
        const totalCores = cpus.length;

        // 尝试从 /sys/devices/system/cpu/ 读取核心类型
        let performanceCores = 0;
        let efficiencyCores = 0;

        if (process.platform === 'linux') {
            for (let i = 0; i < totalCores; i++) {
                try {
                    // 读取核心的 CPU ID（用于判断是否是同一个物理核心的超线程）
                    const packageId = fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/topology/physical_package_id`, 'utf8').trim();
                    const coreId = fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/topology/core_id`, 'utf8').trim();

                    // 读取核心频率范围
                    const baseFreqPath = `/sys/devices/system/cpu/cpu${i}/cpufreq/base_frequency`;
                    if (fs.existsSync(baseFreqPath)) {
                        const baseFreq = parseInt(fs.readFileSync(baseFreqPath, 'utf8').trim());
                        // 假设高频核心是性能核心
                        if (baseFreq > 2500000) { // 2.5GHz
                            performanceCores++;
                        } else {
                            efficiencyCores++;
                        }
                    }
                } catch (e) {
                    // 忽略读取失败
                }
            }
        }

        // 如果无法检测，回退到估算
        if (performanceCores === 0 && efficiencyCores === 0) {
            // 根据CPU型号估算（常见大小核CPU）
            const model = cpus[0]?.model || '';
            if (model.includes('i9-') || model.includes('i7-')) {
                // Intel 12/13/14代常见配置：假设 P-core 数量
                const match = model.match(/i[579]-(\d+)/);
                if (match) {
                    const modelNum = parseInt(match[1]);
                    // 粗略估算：高端型号通常有8个P-core
                    if (modelNum >= 13700) {
                        performanceCores = 8;
                    } else if (modelNum >= 12700) {
                        performanceCores = modelNum >= 14700 ? 8 : 6;
                    } else {
                        performanceCores = Math.floor(totalCores / 2);
                    }
                }
            }
            if (performanceCores === 0) {
                performanceCores = Math.floor(totalCores / 2);
            }
            efficiencyCores = totalCores - performanceCores;
        }

        return {
            performance: performanceCores,
            efficiency: efficiencyCores,
            hasHybrid: performanceCores > 0 && efficiencyCores > 0
        };
    } catch (e) {
        return { performance: 0, efficiency: 0, hasHybrid: false };
    }
}

// 获取系统状态
async function getSystemStatus() {
    try {
        const [cpuData, cpuLoad, mem, time, coreTypes] = await Promise.all([
            si.cpu(),
            si.currentLoad(),
            si.mem(),
            si.time(),
            detectCoreTypes()
        ]);

        // 获取系统负载（Linux/Mac有，Windows需要用其他方式）
        let load = [0, 0, 0];
        try {
            // Windows 用 wmic 获取，Linux/Mac 用 os.loadavg()
            const os = require('os');
            if (os.loadavg && os.loadavg().length === 3) {
                load = os.loadavg();
            }
        } catch (e) {
            // Windows 或不支持的情况，用CPU使用率估算
            load = [
                cpuLoad.currentLoad / 100 * cpuLoad.cpus.length,
                cpuLoad.currentLoad / 100 * cpuLoad.cpus.length,
                cpuLoad.currentLoad / 100 * cpuLoad.cpus.length
            ];
        }

        // 获取每个核心的使用率
        const coresLoad = cpuLoad.cpus ? cpuLoad.cpus.map(c => c.load || 0) : [];

        return {
            cpu: {
                percent: cpuLoad.currentLoad,
                model: cpuData.brand || 'Unknown',
                speed: cpuData.speed || 0,
                physicalCores: cpuData.physicalCores || cpuLoad.cpus.length,
                threads: cpuLoad.cpus.length,
                coresLoad: coresLoad,
                performanceCores: coreTypes.performance,
                efficiencyCores: coreTypes.efficiency,
                hasHybrid: coreTypes.hasHybrid
            },
            memory: {
                total: mem.total,
                used: mem.used,
                percent: (mem.used / mem.total) * 100
            },
            uptime: time.uptime,
            load: load,
            timestamp: Date.now()
        };
    } catch (error) {
        console.error('获取系统状态失败:', error.message);
        return null;
    }
}

// 推送数据到 API
async function pushData(data) {
    try {
        const response = await fetch(config.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.updateToken}`
            },
            body: JSON.stringify({ data })
        });

        const result = await response.json();

        if (result.success) {
            console.log('✅ 数据推送成功');
        } else {
            console.error('❌ 数据推送失败:', result.error);
        }
    } catch (error) {
        console.error('❌ 数据推送异常:', error.message);
    }
}

// 主循环
async function main() {
    console.log('🚀 YZMM Server Status Agent 启动');
    console.log(`📡 API端点: ${config.apiEndpoint}`);
    console.log(`⏱️ 刷新间隔: ${config.intervalMs / 1000}秒`);
    console.log('');

    // 立即执行一次
    await collectAndPush();

    // 定时执行
    setInterval(collectAndPush, config.intervalMs);
}

async function collectAndPush() {
    console.log(`\n[${new Date().toLocaleTimeString()}] 开始收集数据...`);

    const [systemData, localServices] = await Promise.all([
        getSystemStatus(),
        checkLocalServices()
    ]);

    if (systemData) {
        await pushData({
            ...systemData,
            localServices
        });
    }
}

// 启动
main().catch(console.error);
