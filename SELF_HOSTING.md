# 自架同步伺服器：Cloudflare Workers

這版已把原本 Firebase 同步改成 Cloudflare Workers + Durable Objects + WebSocket。

## 為什麼用 Cloudflare

- 不需要把伺服器架在自己的電腦。
- 電腦更換、關機、換網路都不會影響遊戲同步。
- 每個房間使用獨立 Durable Object，例如 `/room/main`、`/room/class-a`。
- 前端只顯示附近玩家，預設最多 32 位，避免大量玩家互相拖慢。

## 第一次部署

1. 建立或登入 Cloudflare 帳號。
2. 安裝 Node.js。
3. 在專案資料夾執行：

```bash
npm create cloudflare@latest -- --existing-script cloudflare-worker.js
npx wrangler login
npx wrangler deploy
```

部署成功後會得到類似：

```text
https://game-sync.<你的帳號>.workers.dev
```

WebSocket 房間網址就是：

```text
wss://game-sync.<你的帳號>.workers.dev/room/main
```

## 讓遊戲連上伺服器

有兩種方式。

方式一：先用網址參數測試：

```text
https://你的遊戲網址/index.html?sync=wss://game-sync.<你的帳號>.workers.dev/room/main
```

方式二：固定寫進 `index.html`：

```js
const SYNC = {
    endpoint: 'wss://game-sync.<你的帳號>.workers.dev',
    room: 'main',
    maxVisiblePlayers: 32
};
```

## 本機基本測試

這版在沒有 `?sync=`、也沒有設定 `SYNC.endpoint` 時，會自動進入「本機分頁測試模式」。

用法：

```bash
node local-static-server.js
```

然後開：

```text
http://127.0.0.1:8097/index.html
```

再複製一個第二分頁開同一個網址。兩個分頁會透過 `BroadcastChannel` 同步玩家位置，用來確認前端多人同步與動畫邏輯。這只適合同一台電腦測試，不是正式伺服器。

## 分房間

不同房間互不影響：

```text
wss://game-sync.<你的帳號>.workers.dev/room/main
wss://game-sync.<你的帳號>.workers.dev/room/class-a
wss://game-sync.<你的帳號>.workers.dev/room/test
```

## 費用提醒

Cloudflare Durable Objects 可在 Workers Free plan 使用，但多人長時間同步會消耗請求量。大量活動，例如上百人長時間同時移動，可能需要 Workers Paid plan。

目前前端會約每 200ms 上傳一次狀態，伺服器只回傳附近玩家。若要支援長時間 100+ 人活動，建議把上傳間隔調成 300-500ms，或把不同班級/場次拆成多個 room。
