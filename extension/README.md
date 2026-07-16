# 好羊毛浏览器插件

这是一个 Chrome/Edge Manifest V3 插件 MVP，用于把当前页面一键投喂到好羊毛。

## 安装方式

1. 打开 Chrome/Edge 扩展管理页面。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本目录：`D:\AS\Projects\haoyangmao\extension`。

## 使用方式

1. 打开优惠页面。
2. 可选：选中页面里的关键价格文本。
3. 点击插件图标。
4. 点击“发送到好羊毛”。

插件会打开：

```text
D:\AS\Projects\haoyangmao\index.html
```

并把页面标题、链接、选中文本作为线索传入。

如果你的项目目录变化，修改 `popup.js` 里的 `APP_URL`。
