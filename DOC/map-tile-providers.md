# 地圖圖資提供商比較與用量分析

> 分析日期：2026-09-13

---

## 各家提供商比較

| 提供商 | 免費額度 | 超出後費用 | API Key 必要 | 備註 |
|--------|---------|-----------|------------|------|
| **OpenStreetMap** (tile.osm.org) | 無明確數量，僅供低流量測試 | 無付費方案 | 否 | 商業用途或高流量直接封鎖，不保證 SLA |
| **Google Maps** | 100,000 次 tile 請求/月 | 依 SKU 計費 | 是，需綁信用卡 | 每分鐘上限 12,000 QPS |
| **Mapbox** | 50,000 次 map load/月（Web） | $5 / 1,000 次（200K 以上降至 $3） | 是 | 1 次 map load = 12 小時內無限 tile |
| **Esri / ArcGIS** | 2,000,000 tiles/月 | $0.15 / 1,000 tiles | 需帳號（但有免費方案） | 免費額度最大，**目前使用中** |
| **MapTiler** | 100,000 requests/月，5,000 sessions/月 | 付費方案 $29/月起 | 是 | Raster tile 每次 map view 消耗 10–16 requests |
| **Stadia Maps** | 200,000 credits/月（僅非商業） | $20/月起（商業用途） | 是 | 1 vector tile = 1 credit；免費無須信用卡 |

---

## 本專案用量估算

### 單次頁面載入

- 初始 zoom level：14
- 瀏覽器視窗約 1920×1080，每張 tile 256×256 px
  - 寬：1920 ÷ 256 ≈ 8 tiles
  - 高：1080 ÷ 256 ≈ 5 tiles
  - 加上 Leaflet 預載緩衝 → **約 60–80 tiles / 次載入**
- 加上縮放、平移操作 → **約 100–300 tiles / session**

### 月用量情境估算

| 情境 | Sessions/月 | 估計 tiles/月 | Esri 免費額度（200萬）使用率 |
|------|------------|--------------|--------------------------|
| 個人開發測試 | ~100 | ~20,000 | **1%** |
| 小型展示（10人用） | ~500 | ~100,000 | **5%** |
| 課程/會議示範 | ~2,000 | ~400,000 | **20%** |
| 公開部署（100人/天） | ~60,000 | ~12,000,000 | **超過免費額度** |

---

## 結論與建議

- **目前使用 Esri / ArcGIS** 免費 tile（無需 API key），對個人開發或小範圍展示完全足夠。
- 若未來轉為公開部署且日活用戶達數十人以上，需評估付費方案或換用其他提供商。
- 若需要向量圖磚（更清晰、可自訂樣式），**Stadia Maps** 免費 20 萬 credits 且無需信用卡，是不錯的備選。

---

## 參考資料

- [Google Maps Platform Pricing](https://mapsplatform.google.com/pricing/)
- [Google Map Tiles API Usage and Billing](https://developers.google.com/maps/documentation/tile/usage-and-billing)
- [Mapbox Pricing](https://storerocket.io/learn/mapbox-pricing)
- [Esri ArcGIS Map Tiles Pricing](https://apio.sh/apis/arcgis-maps)
- [MapTiler Free Tier](https://freetier.co/directory/products/maptiler)
- [Stadia Maps Pricing](https://stadiamaps.com/pricing)
- [OpenStreetMap Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
