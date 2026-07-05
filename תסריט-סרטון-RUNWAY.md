# sole&luna — תסריט פרסומת ל-Runway (Gen-4)

**קונספט:** *"בד אחד. כל הרגעים שלכם."* — יום בחיי זוג, מהבוקר במשרד ועד שקיעה על קו החוף, כשאותו בד לייוסל-פשתן עובר איתם בין כל המצבים. אסתטיקה ים-תיכונית, אור שמש רך, גוון פילם חמים — בדיוק כמו האתר.

---

## הגדרות גלובליות (זהות בכל הסצנות)

| פרמטר | ערך |
|--------|------|
| מודל | **Runway Gen-4** (או Gen-3 Alpha Turbo אם Gen-4 לא זמין) |
| יחס מסך | **16:9** (לאתר ולרשתות אופקי) + גרסת **9:16** לאינסטגרם/טיקטוק |
| משך לקליפ | **5 שניות** לכל סצנה (אפשר להאריך ל-10 עם Extend) |
| FPS | 24 |
| Seed | קבעו seed קבוע אחד לכל הסצנות לעקביות מראה |
| לבוש | sole&luna — פשתן/לייוסל בגווני זית, מרווה, לבן-עצם (olive, sage, bone) |
| גוון צבע | warm sun-bleached Mediterranean, soft film grain, gentle highlights |
| שיטה | **Image-to-Video** (מומלץ) — צרו קודם פריים פתיחה לכל סצנה, ואז הניעו אותו |

> **טיפ:** הפריים של סצנה 1 (חוף) כבר קיים אצלך — `video/scene1-beach-frame.png`. אפשר לגרור אותו ישר כ-Start Image.

---

## 🎬 סצנה 1 — חוף / ריזורט (פתיחה)

**Start image:** `video/scene1-beach-frame.png`

**Prompt (Runway):**
```
A man in an olive linen-lyocell shirt walks slowly along a sunlit Mediterranean
beach, soft morning light, gentle ocean breeze moving the loose fabric, calm
turquoise sea behind him. Cinematic, warm film grain, shallow depth of field.
Camera: slow dolly-in following him. Natural handheld micro-movement.
```
**Camera:** Slow dolly-in · **Motion:** low · **Duration:** 5s

---

## 🎬 סצנה 2 — בר קוקטיילים (ערב)

**Start image:** צרו פריים — זוג יושב בבר חוף בשקיעה, היא בחולצת פשתן לבנה, הוא בחולצת זית, כוסות על השיש.

**Prompt (Runway):**
```
A stylish couple sits at a sunset rooftop cocktail bar overlooking the sea,
wearing breezy linen-lyocell outfits in sage and bone tones. Golden hour light,
warm bokeh of string lights behind them, a light breeze. They smile, raise glasses.
Cinematic, soft film grain, warm color grade. Camera: slow push-in, subtle rack focus.
```
**Camera:** Slow push-in + rack focus · **Motion:** low-medium · **Duration:** 5s

---

## 🎬 סצנה 3 — קמפוס / יום-יום (צהריים)

**Start image:** צרו פריים — בחורה צעירה חוצה רחבת אבן באוניברסיטה/עיר, תיק בד על הכתף, חולצת פשתן אווירירית.

**Prompt (Runway):**
```
A young woman walks confidently across a sunlit stone campus courtyard at midday,
wearing a relaxed airy linen-lyocell shirt and tailored trousers, canvas bag on
shoulder, hair moving lightly in the wind. Bright natural daylight, soft shadows,
effortless and modern. Cinematic, light film grain. Camera: tracking side shot,
steady glide alongside her.
```
**Camera:** Side tracking glide · **Motion:** medium · **Duration:** 5s

---

## 🎬 סצנה 4 — חדר ישיבות / משרד (בוקר)

**Start image:** צרו פריים — גבר בחולצת פשתן מחויטת עומד ליד חלון זכוכית גדול במשרד מודרני, אור בוקר.

**Prompt (Runway):**
```
A man in a tailored linen-lyocell shirt stands by a floor-to-ceiling window in a
bright modern office, morning light streaming in, city skyline softly blurred
behind. He turns slightly toward camera, composed and elegant. Clean minimal
interior, warm neutral palette. Cinematic, subtle film grain. Camera: slow orbit
around him, shallow depth of field.
```
**Camera:** Slow orbit · **Motion:** low · **Duration:** 5s

---

## 🎞️ עריכה והרכבה (אחרי שכל 4 הקליפים מוכנים)

**סדר נרטיבי מומלץ:** 4 (משרד-בוקר) → 3 (קמפוס-צהריים) → 2 (בר-ערב) → 1 (חוף-שקיעה)
— כך הסרטון מספר "יום שלם" בבד אחד.

1. שרשרו את 4 הקליפים (סה"כ ~20 שניות) ב-CapCut / Premiere / Runway.
2. **מעברים:** dissolve רך של 0.4s בין סצנות (לא cut חד).
3. **טקסט סוף:** על רקע לבן-עצם — לוגו sole&luna, ואז הסלוגן *"בד אחד. כל הרגעים שלכם."*, ואז `sole&luna.com`.
4. **מוזיקה:** טראק אקוסטי/בוסה-נובה קליל, חמים (חפשו "warm acoustic mediterranean" בספריית מוזיקה חופשית).
5. **גוון אחיד:** העלו warmth קלות, הורידו saturation מעט, הוסיפו grain עדין — שיתאים לפילם של האתר.

---

## ✅ צ'ק-ליסט הפקה
- [ ] Gen-4, 16:9, seed קבוע
- [ ] פריים פתיחה לכל 4 הסצנות (1 כבר מוכן)
- [ ] 4 קליפים של 5ש' כל אחד
- [ ] גרסת 9:16 לרשתות
- [ ] עריכה + טקסט סוף + מוזיקה + גוון אחיד
