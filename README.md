# Conquer Online — Discord Order Bot

بوت ديسكورد بيتابع طلبات الشراء من MySQL وبيحدث حالتها لما الأدمن يضغط Confirm/Reject.

---

## المتطلبات

- Node.js 18 أو أحدث
- قاعدة بيانات MySQL فيها جدول `orders`
- بوت ديسكورد من [Discord Developer Portal](https://discord.com/developers/applications)

---

## خطوات التشغيل على الهوست

### 1. رفع الملفات

ارفع مجلد `discord-bot` كامل على الهوست.

### 2. تثبيت المكتبات

```bash
cd discord-bot
npm install
```

### 3. إعداد ملف البيئة

```bash
cp .env.example .env
nano .env
```

امله بالبيانات دي:

| المتغير | الشرح | مطلوب |
|---|---|---|
| `DISCORD_TOKEN` | توكن البوت من Discord Developer Portal | ✅ |
| `DISCORD_CHANNEL` | ID القناة اللي هتوصلها الإشعارات | ✅ |
| `DB_HOST` | عنوان سيرفر MySQL | ✅ |
| `DB_PORT` | بورت MySQL (الافتراضي 3306) | ✅ |
| `DB_USER` | اسم مستخدم الداتابيز | ✅ |
| `DB_PASSWORD` | كلمة مرور الداتابيز | ✅ |
| `DB_NAME` | اسم قاعدة البيانات | ✅ |
| `LOG_CHANNEL_ID` | ID قناة اللوج للأدمن (اختياري) | ❌ |
| `POLL_INTERVAL` | الفاصل الزمني بالميللي ثانية (افتراضي 10000) | ❌ |
| `SERVER_NAME` | اسم السيرفر في الإشعارات (افتراضي: Conquer Online) | ❌ |

### 4. تشغيل البوت

#### تشغيل مباشر (للاختبار فقط)
```bash
node index.js
```

#### تشغيل دائم باستخدام PM2 (موصى به للهوست)
```bash
# تثبيت PM2
npm install -g pm2

# تشغيل البوت
pm2 start index.js --name "conquer-bot"

# تشغيل تلقائي عند إعادة تشغيل السيرفر
pm2 startup
pm2 save
```

#### أوامر PM2 المفيدة
```bash
pm2 status            # حالة البوت
pm2 logs conquer-bot  # عرض اللوجز
pm2 restart conquer-bot  # إعادة تشغيل
pm2 stop conquer-bot     # إيقاف
```

---

## بنية جدول orders المطلوبة

الجدول لازم يحتوي على الأعمدة دي كحد أدنى:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_id    VARCHAR(255),
  player_name VARCHAR(255),
  uid         VARCHAR(255),
  title       VARCHAR(500),
  description TEXT,
  image_url   VARCHAR(1000),
  server_name VARCHAR(255),
  embed_color VARCHAR(20),
  status      VARCHAR(50) DEFAULT 'pending',
  sent        TINYINT(1)  NOT NULL DEFAULT 0,
  created_at  DATETIME    DEFAULT CURRENT_TIMESTAMP
);
```

> البوت بيضيف عمود `sent` تلقائياً لو مش موجود.

---

## آلية العمل

```
اللانشر يضيف أوردر في الداتابيز (sent = 0)
        ↓
اللانشر يبعت إشعار الديسكورد مع أزرار Confirm/Reject
        ↓
البوت يشوف الأوردر ويعمله sent = 1 (بدون إرسال رسالة تانية)
        ↓
الأدمن يضغط Confirm أو Reject
        ↓
البوت يحدث status في الداتابيز ويبعت لوج في قناة اللوج
```

---

## صلاحيات البوت في ديسكورد

لازم تفعل الصلاحيات دي في Developer Portal:

- ✅ `Send Messages`
- ✅ `Read Message History`
- ✅ `Embed Links`
- ✅ `View Channels`

وفي **Bot Settings**:
- ✅ `MESSAGE CONTENT INTENT` (مش ضروري لكن مفيد)
