# RFID Attendance Website (v2)

ESP32 + RC522 দিয়ে হাজিরা, অভিভাবককে SMS, পরীক্ষার রেজাল্ট। Render-এ ফ্রিতে চলে।

## ফাইল
- `server.js` : সার্ভার
- `admin.html` : ওয়েবসাইটের পেজ
- `login.html` : লগইন পেজ
- `package.json` : Render-কে বলে কী লাগবে

## Render-এ Environment Variables

| নাম | কী দেবেন | লাগবেই? |
|---|---|---|
| `API_KEY` | ESP32 কোডের `API_KEY`-এর হুবহু একই লেখা | হ্যাঁ |
| `DATABASE_URL` | Neon থেকে পাওয়া connection string | হ্যাঁ |
| `VIEW_USER` | ওয়েবসাইটে ঢোকার ইউজারনেম | না (না দিলে যেকোনো ইউজারনেম চলবে) |
| `VIEW_PASSWORD` | ওয়েবসাইটে ঢোকার পাসওয়ার্ড | হ্যাঁ |
| `SMS_URL` | SMS কোম্পানির লিংক, `{to}` আর `{msg}` সহ | না (না দিলে টেস্ট মোড) |
| `SMS_METHOD` | `GET` বা `POST` | না (ডিফল্ট GET) |
| `SMS_BODY` | POST হলে body, যেমন `api_key=XXX&number={to}&message={msg}` | না |
| `SMS_OK_TEXT` | SMS গেলে কোম্পানির উত্তরে যে লেখা থাকে | না |

`SMS_URL` উদাহরণ (আসল ফরম্যাট কোম্পানির API ডকুমেন্ট দেখে বসাবেন):
```
https://api.example.com/send?api_key=তোমার_KEY&to={to}&msg={msg}
```
- `{to}` → 8801XXXXXXXXX
- `{to11}` → 01XXXXXXXXX
- `{msg}` → মেসেজ

## অটো SMS
- প্রতিদিন সেটিংসের সময়ের পরে একবার চেক হয়।
- কেউ টানা N ক্লাসের দিন অনুপস্থিত থাকলে অভিভাবককে SMS যায়, একই অনুপস্থিতির জন্য একবারই।
- Render ঘুমিয়ে থাকলে চেক হয় না। তাই cron-job.org-এ প্রতি ১০ মিনিটে এই লিংক খোলার কাজ দিন:
  `https://তোমার-app.onrender.com/cron?key=তোমার_API_KEY`

## ESP32-এর সাথে
- `/api/scan`, `/api/roster`, `/health` আগের মতোই। ESP32 কোড বদলাতে হবে না।
- ওয়েবসাইটে ছাত্র যোগ করলে ESP32 সেই কার্ডকে "অচেনা" বললেও সার্ভার উপস্থিত ধরবে।
  তবে ESP32-এ লাল বাতি/৩ বিপ হবে, তাই কার্ডের UID ESP32 কোডেও যোগ করে রাখুন।
