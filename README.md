# Qalam Arabic Academy — Telegram Mini App

Admin / ustoz / o‘quvchi rollari, guruhlar, jadval, davomat, baholar, vazifalar (javob + tekshirish), materiallar (PDF/audio/video), chat, e’lonlar, Telegram bildirishnomalari, audit va zaxira nusxa.
Tashqi kutubxona yo‘q — faqat Node.js ≥ 22.5 (ichki `node:sqlite`).

## Sinab ko‘rish (DEV rejim, Telegram'siz)
    node server.js        # http://localhost:3000 — demo ma'lumotlar va rol tanlash
    PORT=3111 node server.js & node test.js   # API sinovlari

## Ishga tushirish (Telegram bilan)
1. BotFather'da bot yarating → tokenni oling.
2. Ilovani HTTPS domenga joylang (Telegram faqat https qabul qiladi), `.env.example` → `.env` qilib to‘ldiring:
   `BOT_TOKEN`, `WEBAPP_URL`, `ADMIN_TG_IDS` (birinchi admin ID si).
3. `node server.js` — bot `/start` da “Ilovani ochish” tugmasini beradi va menyu tugmasini sozlaydi.
4. Admin ilovada foydalanuvchilarni Telegram ID yoki @username bilan qo‘shadi (ro‘yxatda yo‘q odam kira olmaydi).

Xavfsizlik: initData HMAC imzosi serverda tekshiriladi, rol faqat bazadan olinadi, fayllar ruxsat bilan beriladi (tur/hajm cheklovi), zaxira `data/backups` da har 24 soatda.

## 24/7 serverga joylash (VPS + HTTPS)
1. Ubuntu 22.04/24.04 VPS oling (1 GB RAM yetadi) va domenni (A-yozuv) uning IP siga yo'naltiring.
2. Loyihani serverga ko'chiring: `rsync -av --exclude data --exclude node_modules ./ root@SERVER_IP:/opt/qalam/`
3. Serverda `/opt/qalam/.env` yarating (`BOT_TOKEN`, `WEBAPP_URL=https://domeningiz`, `ADMIN_TG_IDS`, `PORT=3000`).
4. `cd /opt/qalam && DOMAIN=domeningiz.uz bash deploy/setup.sh`
   — Node, Caddy (avtomatik HTTPS), systemd xizmati (qulasa o'zi qayta ishga tushadi), xavfsizlik devori o'rnatiladi.
5. BotFather → `/setmenubutton` yoki bot `/start` yuborganda tugma chiqadi. Tekshirish: `systemctl status qalam`, `journalctl -u qalam -f`.
Yangilash: fayllarni qayta rsync qiling → `systemctl restart qalam`. Ma'lumotlar `/opt/qalam/data` da (zaxira ham shu yerda — uni serverdan tashqariga ham nusxalab turing).
