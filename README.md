# Uber 收据批量下载（Tampermonkey 用户脚本）

在 `riders.uber.com/trips` 注入一个小面板，按日期范围**一键批量下载**自己的行程收据 PDF，用于报销。
只读操作：不点确认、不提交预约、不调用任何写接口，也不上传任何数据到第三方。

## 安装

1. 先装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge）。
2. Chrome 地址栏打开 `chrome://extensions`，右上角打开 **开发者模式**（Chrome 127+ 必须，否则用户脚本不执行）。
3. 点下面的链接 → Tampermonkey 会弹出安装页 → 点「安装」：

   **https://raw.githubusercontent.com/BEDUSER/uber-receipts-downloader/main/uber_receipts_batch.user.js**

4. 打开 https://riders.uber.com/trips ，页面右上角出现面板即安装成功。

## 使用

1. 选开始 / 结束日期（默认最近 90 天，可点「近30天 / 近3个月 / 今年 / 近1年」）。
2. 点「**预览**」核对能扫到多少条行程。
3. 点「**批量下载**」。首次会弹「是否允许本站下载多个文件」→ 选**允许**。
4. 结束后可点「导出结果CSV」拿到 成功/失败 清单；失败项点「重试失败项」。

## 几点说明

- **串行 + 随机延时**：每笔间隔 3~5 秒，每 10 笔长休息 20~35 秒；遇 429/403 自动冷却 60 秒；
  连续 4 笔失败自动停机。请不要把这些延时改成 0，高频请求会触发风控。
- **数据来源优先级**：Uber 内部 GraphQL（`invoiceFiles` 正式发票 → `getReceipt` 收据 PDF）→
  DOM 兜底（点击卡片上的收据入口抓 PDF 链接），接口改版时仍可用。
- **文件名**：`Uber_<日期>_<行程ID前8位>.pdf`，落在浏览器默认下载目录。
- 每趟行程只取第一份收据；遇到「您尚未完成任何行程」的账号说明该账号没有行程，导出为空属正常。
- 需要登录**你自己的** Uber 账号；脚本不读取、不保存任何凭证。

## 常见问题

**装完没看到面板？** 打开控制台执行 `__uberRC.diag()`：
返回对象说明脚本在跑（看 `isTripsPage` / `panelMounted`）；返回 `undefined` 说明脚本没执行，
检查「开发者模式」与 Tampermonkey 是否启用，然后刷新页面。

**下载的是 0 字节 / 打不开？** 说明登录态失效被重定向到了登录页，脚本会把它判为失败并记录原因，
重新登录后再点「重试失败项」。

## 许可

MIT，见 [LICENSE](./LICENSE)。
