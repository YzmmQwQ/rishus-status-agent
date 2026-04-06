/**
 * YZMM Server Status Agent
 * 运行在你的服务器上，收集系统状态
 * 并定期推送到 Cloudflare Workers API
 */

const si = require('systeminformation');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// 加载配置
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error('❌ 配置文件不存在！请复制 config.example.json 为 config.json 并填写配置');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// 获取系统状态
async function getSystemStatus() {
    try {
        const [cpuData, cpuLoad, mem, time, loadAvg] = await Promise.all([
            si.cpu(),
            si.currentLoad(),
            si.mem(),
            si.time(),
            si.currentLoad().then(data => data.avgLoad || null).catch(() => null)
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
                coresLoad: coresLoad
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

    const systemData = await getSystemStatus();
    if (systemData) {
        await pushData(systemData);
    }
}

// 启动
main().catch(console.error);
