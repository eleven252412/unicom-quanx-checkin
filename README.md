# 中国联通 QuanX 自动签到

## 功能
- 自动抓取联通登录态 cookie
- 定时调用当前可用签到接口签到
- cookie 更新后自动覆盖本地存储
- cookie 失效时提示重新打开联通 App 抓取

## 建议抓取方式
- 打开中国联通 App 登录后的首页、积分页、签到页
- 或打开会访问以下域名的联通活动页：
  - `m.client.10010.com`
  - `img.client.10010.com`
  - `activity.10010.com`

## QuanX 片段

```ini
[rewrite_local]
^https?:\/\/(m\.client\.10010\.com|img\.client\.10010\.com|activity\.10010\.com)\/.*$ url script-request-header https://raw.githubusercontent.com/eleven252412/unicom-quanx-checkin/main/unicom-checkin-quanx.js?v=20260614-once
^https?:\/\/(m\.client\.10010\.com|img\.client\.10010\.com|activity\.10010\.com)\/.*$ url script-response-header https://raw.githubusercontent.com/eleven252412/unicom-quanx-checkin/main/unicom-checkin-quanx.js?v=20260614-once

[task_local]
35 8 * * * https://raw.githubusercontent.com/eleven252412/unicom-quanx-checkin/main/unicom-checkin-quanx.js?v=20260614-once, tag=中国联通签到, enabled=true

[mitm]
hostname = m.client.10010.com, img.client.10010.com, activity.10010.com
```

## 当前实测接口
- `https://activity.10010.com/sixPalaceGridTurntableLottery/signin/daySign`

## 说明
- 旧接口 `act.10010.com/SigninApp/signin/daySign` 已失效，不再使用。
- 远程脚本若放在 GitHub 私有仓库，QuanX 无法直接通过 raw 链接拉取；用于 QuanX 远程订阅时必须提供可公开访问链接。
