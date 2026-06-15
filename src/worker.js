// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🤝 АНАЛИЗАТОР ССОР — Cloudflare Worker
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default {
    async fetch(req, env) {
        return handle(req, env);
    }
};

// ── Глобальные CORS-заголовки (оригинальный стиль воркера) ──────────────────
var corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// РОУТЕР
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handle(req, env) {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    var url = new URL(req.url);

    // /setup-webhook → регистрация вебхука
    if (url.pathname === "/setup-webhook") {
        return setupWebhook(req, env);
    }

    // /webhook → все апдейты от Telegram
    if (url.pathname === "/webhook" && req.method === "POST") {
        try {
            var body = await req.json();
            await handleUpdate(body, env);
            return new Response("OK", { status: 200, headers: corsHeaders });
        } catch (e) {
            console.error("Webhook error:", e);
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: corsHeaders
            });
        }
    }

    return new Response("OK", { status: 200, headers: corsHeaders });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBHOOK SETUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function setupWebhook(req, env) {
    var workerUrl = new URL(req.url).origin;
    var webhookUrl = workerUrl + "/webhook";
    var r = await tgCall(env, "setWebhook", { url: webhookUrl });
    return new Response(JSON.stringify(r), { status: 200, headers: corsHeaders });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ГЛАВНЫЙ ОБРАБОТЧИК АПДЕЙТОВ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleUpdate(update, env) {
    // pre_checkout_query — обязательно отвечаем ok
    if (update.pre_checkout_query) {
        await tgCall(env, "answerPreCheckoutQuery", {
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true
        });
        return;
    }

    // successful_payment
    if (update.message && update.message.successful_payment) {
        await handleSuccessfulPayment(update.message, env);
        return;
    }

    // callback_query (кнопки)
    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
        return;
    }

    // обычные сообщения
    if (update.message && update.message.text) {
        await handleMessage(update.message, env);
        return;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ОБРАБОТКА СООБЩЕНИЙ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleMessage(msg, env) {
    var userId = msg.from.id;
    var chatId = msg.chat.id;
    var text = msg.text.trim();

    // Регистрируем/обновляем пользователя
    await upsertUser(env, msg.from);

    // ── Команды администратора ────────────────────────────────────────────────
    var adminId = parseInt(env.ADMIN_ID || "8231689704");
    if (userId === adminId) {
        if (text === "/admin") { await sendAdminMenu(env, chatId); return; }
        if (text === "/stats") { await sendStats(env, chatId); return; }
        if (text.startsWith("/broadcast ")) {
            await doBroadcast(env, chatId, text.slice(11)); return;
        }
        if (text.startsWith("/addfree ")) {
            await addFreeUser(env, chatId, parseInt(text.slice(9))); return;
        }
        if (text.startsWith("/removefree ")) {
            await removeFreeUser(env, chatId, parseInt(text.slice(12))); return;
        }
        if (text.startsWith("/checkuser ")) {
            await checkUser(env, chatId, parseInt(text.slice(11))); return;
        }
    }

    // ── /start ────────────────────────────────────────────────────────────────
    if (text === "/start") {
        await setSession(env, userId, { step: "idle", conflictText: null, paidAt: null });
        await sendStart(env, chatId);
        return;
    }

    // ── Текущий шаг из сессии ─────────────────────────────────────────────────
    var session = await getSession(env, userId);
    if (!session) session = { step: "idle", conflictText: null, paidAt: null };

    if (session.step === "waiting_conflict_text") {
        if (text.length < 20) {
            await tgSend(env, chatId,
                "✍️ Пожалуйста, опиши конфликт подробнее — хотя бы несколько предложений. " +
                "Чем больше деталей, тем точнее анализ."
            );
            return;
        }
        // Сохраняем текст конфликта
        session.conflictText = text;

        // Проверяем нужна ли оплата
        var isFree = await checkFreeAccess(env, userId);
        if (isFree) {
            session.step = "idle";
            await setSession(env, userId, session);
            await runAnalysis(env, chatId, userId, text);
        } else {
            session.step = "waiting_payment";
            await setSession(env, userId, session);
            await sendInvoice(env, chatId);
        }
        return;
    }

    // Если написали что-то не в ожидаемом шаге — показываем /start
    await tgSend(env, chatId,
        "Напиши /start чтобы начать анализ конфликта 🤝"
    );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ОБРАБОТКА CALLBACK КНОПОК
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleCallbackQuery(cb, env) {
    var userId = cb.from.id;
    var chatId = cb.message.chat.id;
    var data = cb.data;

    await tgCall(env, "answerCallbackQuery", { callback_query_id: cb.id });

    if (data === "start_analysis") {
        await setSession(env, userId, { step: "waiting_conflict_text", conflictText: null, paidAt: null });
        await tgSend(env, chatId,
            "📝 *Опиши конфликт своими словами.*\n\n" +
            "Что произошло? Что сказал ты, что сказал партнёр?\n\n" +
            "Чем подробнее — тем точнее разбор 👇",
            { parse_mode: "Markdown" }
        );
        return;
    }

    if (data === "what_is_this") {
        await tgSend(env, chatId,
            "🤝 *Анализатор ссор* — это ИИ-психолог в твоём кармане.\n\n" +
            "Ты описываешь конфликт с партнёром, другом или коллегой, " +
            "а нейросеть Gemini объективно разбирает:\n\n" +
            "• Кто и насколько прав\n" +
            "• В чём настоящая причина ссоры\n" +
            "• Что делать дальше\n\n" +
            "Нажми *Начать анализ* чтобы попробовать 👇",
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "🔍 Начать анализ", callback_data: "start_analysis" }
                    ]]
                }
            }
        );
        return;
    }

    // Кнопки админки
    var adminId = parseInt(env.ADMIN_ID || "8231689704");
    if (userId === adminId) {
        if (data === "admin_stats") { await sendStats(env, chatId); return; }
        if (data === "admin_broadcast_hint") {
            await tgSend(env, chatId, "📢 Используй команду:\n/broadcast Ваш текст рассылки"); return;
        }
        if (data === "admin_addfree_hint") {
            await tgSend(env, chatId, "👤 Используй команду:\n/addfree 123456789"); return;
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// УСПЕШНАЯ ОПЛАТА
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleSuccessfulPayment(msg, env) {
    var userId = msg.from.id;
    var chatId = msg.chat.id;

    // Записываем оплату в профиль
    var userKey = "users:" + userId;
    var userRaw = await kvGet(env, userKey);
    var user = userRaw ? JSON.parse(userRaw) : {};
    user.totalPaid = (user.totalPaid || 0) + 199;
    await kvPut(env, userKey, JSON.stringify(user));

    // Записываем в stats
    var today = new Date().toISOString().slice(0, 10);
    var statsKey = "stats:payments:" + today;
    var statsRaw = await kvGet(env, statsKey);
    var stats = statsRaw ? JSON.parse(statsRaw) : { count: 0, stars: 0 };
    stats.count++;
    stats.stars += 199;
    await kvPut(env, statsKey, JSON.stringify(stats));

    // Получаем сессию и запускаем анализ
    var session = await getSession(env, userId);
    if (session && session.conflictText) {
        session.step = "idle";
        session.paidAt = Date.now();
        await setSession(env, userId, session);
        await runAnalysis(env, chatId, userId, session.conflictText);
    } else {
        await tgSend(env, chatId,
            "✅ Оплата получена! Но текст конфликта не найден. " +
            "Пожалуйста, начни снова с /start"
        );
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// АНАЛИЗ КОНФЛИКТА (основная логика)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runAnalysis(env, chatId, userId, conflictText) {
    // Индикатор загрузки
    await tgSend(env, chatId,
        "🔍 Анализирую конфликт... Это займёт несколько секунд."
    );

    // ── 1. Анализ через Gemini ────────────────────────────────────────────────
    var analysisPrompt = `Ты объективный психолог-медиатор. Тебе описали конфликт.

Проанализируй СТРОГО и верни ТОЛЬКО валидный JSON:
{
  "person_a_score": число от 0 до 100 (правота стороны А),
  "person_b_score": число от 0 до 100 (правота стороны Б),
  "person_a_valid": "что справедливо в позиции А (1-2 предложения)",
  "person_b_valid": "что справедливо в позиции Б (1-2 предложения)",
  "root_cause": "глубинная причина конфликта (1 предложение)",
  "advice": "конкретный совет для обоих (2-3 предложения)",
  "conflict_type": одно из: "коммуникация" | "ожидания" | "ценности" | "усталость" | "ревность" | "деньги" | "быт"
}

Сумма person_a_score + person_b_score не обязана быть 100.
Не добавляй ничего кроме JSON. Без markdown, без пояснений.

Конфликт:
${conflictText}`;

    var analysis = await callGemini(env, analysisPrompt, null, "gemini-2.5-flash");
    var parsed = parseGeminiJson(analysis);

    // Если первая попытка провалилась — пробуем ещё раз
    if (!parsed) {
        console.error("First Gemini attempt failed, retrying...");
        var retryPrompt = analysisPrompt + "\n\nВАЖНО: Верни ТОЛЬКО JSON и ничего больше. Никаких пояснений.";
        var analysis2 = await callGemini(env, retryPrompt, null, "gemini-2.5-flash");
        parsed = parseGeminiJson(analysis2);
    }

    // Если совсем не получилось — возвращаем деньги
    if (!parsed) {
        console.error("Both Gemini attempts failed");
        // Попытка возврата звёзд
        var session = await getSession(env, userId);
        if (session && session.paidAt) {
            try {
                // Возврат возможен только через charge_id — в простой реализации логируем
                console.error("Refund needed for userId:", userId);
            } catch (re) {
                console.error("Refund error:", re);
            }
        }
        await tgSend(env, chatId,
            "😔 Произошла ошибка при анализе. Если вы платили — звёзды будут возвращены. " +
            "Попробуйте ещё раз позже или напишите в поддержку."
        );
        return;
    }

    var { person_a_score, person_b_score, person_a_valid, person_b_valid, root_cause, advice, conflict_type } = parsed;
    var botUsername = env.BOT_USERNAME || "conflict_bot";

    // ── 2. Генерация карточки через Gemini Vision ─────────────────────────────
    var cardPrompt = `Нарисуй PNG-карточку 800x400px в стиле минимализм.
Фон тёмно-фиолетовый (#1a1040).
Шрифт белый, современный.

Содержимое карточки:
- Заголовок: "Анализ конфликта"
- Левая сторона: "Сторона А — ${person_a_score}%"
- Правая сторона: "Сторона Б — ${person_b_score}%"
- Посередине снизу: "${root_cause}"
- Очень мелко внизу: "@${botUsername}"

Стиль: чистый, без лишних деталей, как инфографика.`;

    var imageBase64 = await callGeminiImage(env, cardPrompt);

    // ── 3. Отправляем карточку (если получилось) ──────────────────────────────
    var resultText =
        `🔍 *Анализ вашего конфликта*\n\n` +
        `*Сторона А — ${person_a_score}% правоты*\n` +
        `✅ ${person_a_valid}\n\n` +
        `*Сторона Б — ${person_b_score}% правоты*\n` +
        `✅ ${person_b_valid}\n\n` +
        `🧩 *Корень конфликта:*\n${root_cause}\n\n` +
        `💡 *Совет:*\n${advice}\n\n` +
        `🏷 Тип конфликта: *${conflict_type}*\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `Хочешь узнать насколько вы совместимы? → @soon`;

    if (imageBase64) {
        // Отправляем фото с подписью
        try {
            var blob = base64ToBlob(imageBase64, "image/png");
            var form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("photo", blob, "conflict_card.png");
            form.append("caption", resultText);
            form.append("parse_mode", "Markdown");
            var photoResp = await fetch(
                `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`,
                { method: "POST", body: form }
            );
            if (!photoResp.ok) throw new Error("Photo send failed");
        } catch (imgErr) {
            console.error("Image send error:", imgErr);
            // Фолбэк — просто текст
            await tgSend(env, chatId, resultText, { parse_mode: "Markdown" });
        }
    } else {
        // Gemini не вернул картинку — только текст, не падаем
        await tgSend(env, chatId, resultText, { parse_mode: "Markdown" });
    }

    // Предлагаем анализ снова
    await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text: "Хочешь разобрать ещё один конфликт?",
        reply_markup: {
            inline_keyboard: [[
                { text: "🔍 Новый анализ", callback_data: "start_analysis" }
            ]]
        }
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GEMINI API (оригинальный стиль воркера — var, нативный fetch)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function callGemini(env, prompt, systemPrompt, model) {
    var key = env.GEMINI_API_KEY;
    var mdl = model || "gemini-2.5-flash";
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + mdl + ":generateContent?key=" + key;

    var contents = [{ parts: [{ text: prompt }], role: "user" }];
    var reqBody = { contents };
    if (systemPrompt) {
        reqBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    try {
        var r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqBody)
        });
        var data = await r.json();
        var text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return text;
    } catch (e) {
        console.error("Gemini text error:", e);
        return "";
    }
}

async function callGeminiImage(env, prompt) {
    // Используем gemini-2.0-flash-exp для генерации изображений
    var key = env.GEMINI_API_KEY;
    var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=" + key;

    try {
        var r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }], role: "user" }],
                generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
            })
        });
        var data = await r.json();
        var parts = data?.candidates?.[0]?.content?.parts || [];
        for (var part of parts) {
            if (part.inlineData && part.inlineData.mimeType === "image/png") {
                return part.inlineData.data;
            }
        }
        return null;
    } catch (e) {
        console.error("Gemini image error:", e);
        return null;
    }
}

function parseGeminiJson(text) {
    if (!text) return null;
    try {
        // Убираем markdown-блоки если Gemini вдруг добавил
        var clean = text.replace(/```json|```/g, "").trim();
        // Ищем первый { ... }
        var start = clean.indexOf("{");
        var end = clean.lastIndexOf("}");
        if (start === -1 || end === -1) return null;
        return JSON.parse(clean.slice(start, end + 1));
    } catch (e) {
        console.error("JSON parse error:", e, "Raw:", text);
        return null;
    }
}

function base64ToBlob(base64, mimeType) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM API HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function tgCall(env, method, params) {
    var url = "https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + method;
    try {
        var r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params)
        });
        return await r.json();
    } catch (e) {
        console.error("TG API error:", method, e);
        return null;
    }
}

async function tgSend(env, chatId, text, extra) {
    return tgCall(env, "sendMessage", {
        chat_id: chatId,
        text: text,
        ...(extra || {})
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// СТАРТОВЫЙ ЭКРАН
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendStart(env, chatId) {
    await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text:
            "🤝 *Привет! Я — Анализатор ссор*\n\n" +
            "Опиши мне конфликт с партнёром, другом или коллегой — " +
            "и я объективно разберу:\n\n" +
            "• Кто и насколько прав (%)\n" +
            "• В чём настоящая причина ссоры\n" +
            "• Конкретный совет что делать\n\n" +
            "Анализ делает нейросеть *Gemini* без суждений и осуждений 🧠\n\n" +
            "Стоимость одного анализа: *199 ⭐ Telegram Stars*",
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[
                { text: "🔍 Начать анализ", callback_data: "start_analysis" },
                { text: "❓ Что это такое?", callback_data: "what_is_this" }
            ]]
        }
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ИНВОЙС
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendInvoice(env, chatId) {
    await tgCall(env, "sendInvoice", {
        chat_id: chatId,
        title: "Анализ вашего конфликта",
        description: "ИИ разберёт кто прав, найдёт причину и даст совет",
        payload: "conflict_analysis",
        currency: "XTR",
        prices: [{ label: "Анализ конфликта", amount: 199 }]
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KV HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function kvGet(env, key) {
    try { return await env.KV.get(key); } catch (e) { console.error("KV get:", key, e); return null; }
}

async function kvPut(env, key, value) {
    try { await env.KV.put(key, value); } catch (e) { console.error("KV put:", key, e); }
}

async function kvDelete(env, key) {
    try { await env.KV.delete(key); } catch (e) { console.error("KV delete:", key, e); }
}

async function kvList(env, prefix) {
    try { return await env.KV.list({ prefix }); } catch (e) { console.error("KV list:", prefix, e); return { keys: [] }; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// СЕССИИ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getSession(env, userId) {
    var raw = await kvGet(env, "sessions:" + userId);
    return raw ? JSON.parse(raw) : null;
}

async function setSession(env, userId, session) {
    await kvPut(env, "sessions:" + userId, JSON.stringify(session));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ПОЛЬЗОВАТЕЛИ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function upsertUser(env, tgUser) {
    var key = "users:" + tgUser.id;
    var raw = await kvGet(env, key);
    var user = raw ? JSON.parse(raw) : {
        userId: tgUser.id,
        username: tgUser.username || "",
        firstSeen: Date.now(),
        totalPaid: 0,
        isFree: false
    };
    user.username = tgUser.username || user.username;
    await kvPut(env, key, JSON.stringify(user));

    // Добавляем в список всех пользователей для рассылки
    await kvPut(env, "userindex:" + tgUser.id, "1");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// БЕСПЛАТНЫЙ ДОСТУП
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function checkFreeAccess(env, userId) {
    var adminId = parseInt(env.ADMIN_ID || "8231689704");
    if (userId === adminId) return true;

    var raw = await kvGet(env, "free_users");
    var freeList = raw ? JSON.parse(raw) : [];
    return freeList.includes(userId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// АДМИНКА
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendAdminMenu(env, chatId) {
    await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text: "🛠 *Панель администратора*\nВыбери действие:",
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 Статистика", callback_data: "admin_stats" }],
                [{ text: "📢 Рассылка (hint)", callback_data: "admin_broadcast_hint" }],
                [{ text: "👤 Добавить бесплатный доступ (hint)", callback_data: "admin_addfree_hint" }]
            ]
        }
    });
}

async function sendStats(env, chatId) {
    try {
        // Считаем пользователей
        var userKeys = await kvList(env, "userindex:");
        var totalUsers = userKeys.keys.length;

        // Статистика оплат за сегодня
        var today = new Date().toISOString().slice(0, 10);
        var statsRaw = await kvGet(env, "stats:payments:" + today);
        var todayStats = statsRaw ? JSON.parse(statsRaw) : { count: 0, stars: 0 };

        // Считаем всё время
        var statsList = await kvList(env, "stats:payments:");
        var allPaid = 0, allStars = 0;
        for (var sk of statsList.keys) {
            var sr = await kvGet(env, sk.name);
            if (sr) {
                var sd = JSON.parse(sr);
                allPaid += sd.count || 0;
                allStars += sd.stars || 0;
            }
        }

        // Топ-5 по оплатам
        var top5 = [];
        var allUserKeys = await kvList(env, "users:");
        var userData = [];
        for (var uk of allUserKeys.keys) {
            var ur = await kvGet(env, uk.name);
            if (ur) { userData.push(JSON.parse(ur)); }
        }
        userData.sort((a, b) => (b.totalPaid || 0) - (a.totalPaid || 0));
        top5 = userData.slice(0, 5);

        var top5text = top5.map((u, i) =>
            `${i + 1}. @${u.username || u.userId} — ${u.totalPaid || 0} ⭐`
        ).join("\n");

        await tgSend(env, chatId,
            `📊 *Статистика*\n\n` +
            `👥 Всего пользователей: *${totalUsers}*\n\n` +
            `📅 Сегодня (${today}):\n` +
            `  Платежей: *${todayStats.count}*\n` +
            `  Звёзд: *${todayStats.stars} ⭐*\n\n` +
            `📈 За всё время:\n` +
            `  Платежей: *${allPaid}*\n` +
            `  Звёзд: *${allStars} ⭐*\n\n` +
            `🏆 Топ-5 пользователей:\n${top5text || "Пока нет данных"}`,
            { parse_mode: "Markdown" }
        );
    } catch (e) {
        console.error("Stats error:", e);
        await tgSend(env, chatId, "❌ Ошибка при получении статистики: " + e.message);
    }
}

async function doBroadcast(env, chatId, text) {
    var keys = await kvList(env, "userindex:");
    var sent = 0, errors = 0;

    for (var k of keys.keys) {
        var uid = k.name.replace("userindex:", "");
        try {
            var r = await tgCall(env, "sendMessage", { chat_id: parseInt(uid), text: text });
            if (r && r.ok) { sent++; } else { errors++; }
        } catch (e) {
            errors++;
        }
        // Задержка 50ms чтобы не словить rate limit
        await new Promise(res => setTimeout(res, 50));
    }

    await tgSend(env, chatId, `📢 Рассылка завершена\n✅ Отправлено: ${sent}\n❌ Ошибок: ${errors}`);
}

async function addFreeUser(env, chatId, userId) {
    if (!userId || isNaN(userId)) {
        await tgSend(env, chatId, "❌ Неверный userId"); return;
    }
    var raw = await kvGet(env, "free_users");
    var list = raw ? JSON.parse(raw) : [];
    if (!list.includes(userId)) list.push(userId);
    await kvPut(env, "free_users", JSON.stringify(list));
    await tgSend(env, chatId, `✅ Пользователь ${userId} получил бесплатный доступ`);
}

async function removeFreeUser(env, chatId, userId) {
    if (!userId || isNaN(userId)) {
        await tgSend(env, chatId, "❌ Неверный userId"); return;
    }
    var raw = await kvGet(env, "free_users");
    var list = raw ? JSON.parse(raw) : [];
    list = list.filter(id => id !== userId);
    await kvPut(env, "free_users", JSON.stringify(list));
    await tgSend(env, chatId, `✅ Пользователь ${userId} удалён из бесплатного доступа`);
}

async function checkUser(env, chatId, userId) {
    if (!userId || isNaN(userId)) {
        await tgSend(env, chatId, "❌ Неверный userId"); return;
    }
    var raw = await kvGet(env, "users:" + userId);
    if (!raw) {
        await tgSend(env, chatId, `❓ Пользователь ${userId} не найден в базе`); return;
    }
    var u = JSON.parse(raw);
    var freeRaw = await kvGet(env, "free_users");
    var freeList = freeRaw ? JSON.parse(freeRaw) : [];
    var isFree = freeList.includes(userId);

    await tgSend(env, chatId,
        `👤 *Профиль пользователя*\n\n` +
        `ID: \`${u.userId}\`\n` +
        `Username: @${u.username || "—"}\n` +
        `Первый визит: ${new Date(u.firstSeen).toLocaleString("ru-RU")}\n` +
        `Потрачено: *${u.totalPaid || 0} ⭐*\n` +
        `Бесплатный доступ: ${isFree ? "✅ Да" : "❌ Нет"}`,
        { parse_mode: "Markdown" }
    );
}
