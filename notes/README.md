# 笔记

块级富文本笔记模块，参考思源笔记的块编辑体验：段落/标题/列表/引用/代码块等块级排版，笔记本 + 文档列表，自动保存。

## 本地运行

```bash
cd notes
cp config.example.json config.json   # 首次
npm install
npm start
```

默认 `http://127.0.0.1:5001`。经 portal 代理访问：`http://127.0.0.1:8080/notes/`。

## Portal 注册

在 `portal/config.json` 的 `services` 中加入：

```json
{
  "id": "notes",
  "title": "笔记",
  "type": "proxy",
  "path": "/notes",
  "internalUrl": "http://127.0.0.1:5001",
  "injectBar": true,
  "injectBase": false,
  "icon": "📝"
}
```

或执行：`python scripts/add-notes-portal.py`

## ECS 部署

```bash
cd notes && ./deploy-ecs.sh
python /opt/navigation/scripts/add-notes-portal.py
pm2 restart portal
```

## 数据

笔记 JSON 持久化在 `data/notes.json`（gitignore）。内容为 TipTap 文档 JSON（块级结构）。

## 快捷键

- `Ctrl/Cmd + S`：立即保存
