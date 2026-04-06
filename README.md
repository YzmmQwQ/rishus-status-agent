# YZMM Status - Agent

运行在服务器上，收集系统状态并推送到 Workers API。

## 安装

```bash
npm install
cp config.example.json config.json
```

## 配置

编辑 `config.json`：

```json
{
  "apiEndpoint": "https://你的worker地址/api/update",
  "updateToken": "安全令牌",
  "intervalMs": 10000
}
```

## 运行

```bash
npm start
```

推荐使用 PM2：

```bash
npm install -g pm2
pm2 start index.js --name status-agent
pm2 save
pm2 startup
```

## 数据采集

- CPU 使用率 (总览 + 每核心)
- 内存使用率
- 系统运行时间
- 系统负载 (1m/5m/15m)

## License

MIT
