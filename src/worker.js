// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🤝 АНАЛИЗАТОР ССОР — Cloudflare Worker v2
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default {
    async fetch(req, env) {
        return handle(req, env);
    }
};

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
    if (url.pathname === "/setup-webhook") return setupWebhook(req, env);
    if (url.pathname === "/webhook" && req.method === "POST") {
        try {
            var body = await req.json();
            await handleUpdate(body, env);
            return new Response("OK", { status: 200, headers: corsHeaders });
        } catch (e) {
            console.error("Webhook error:", e);
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
        }
    }
    return new Response("OK", { status: 200, headers: corsHeaders });
}

async function setupWebhook(req, env) {
    var workerUrl = new URL(req.url).origin;
    var r = await tgCall(env, "setWebhook", { url: workerUrl + "/webhook" });
    return new Response(JSON.stringify(r), { status: 200, headers: corsHeaders });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// УДАЛЕНИЕ СООБЩЕНИЯ (helper)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function tgDelete(env, chatId, msgId) {
    if (!msgId) return;
    try { await tgCall(env, "deleteMessage", { chat_id: chatId, message_id: msgId }); } catch(e) {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ГЛАВНЫЙ ОБРАБОТЧИК АПДЕЙТОВ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleUpdate(update, env) {
    if (update.pre_checkout_query) {
        await tgCall(env, "answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
        return;
    }
    if (update.message && update.message.successful_payment) {
        await handleSuccessfulPayment(update.message, env); return;
    }
    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env); return;
    }
    if (update.message && update.message.text) {
        await handleMessage(update.message, env); return;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ОБРАБОТКА СООБЩЕНИЙ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleMessage(msg, env) {
    var userId = msg.from.id;
    var chatId = msg.chat.id;
    var text = msg.text.trim();

    await upsertUser(env, msg.from);

    // Удаляем входящее сообщение пользователя (чистота чата)
    await tgDelete(env, chatId, msg.message_id);

    var adminId = parseInt(env.ADMIN_ID || "8231689704");
    if (userId === adminId) {
        if (text === "/admin") { await sendAdminMenu(env, chatId); return; }
        if (text === "/stats") { await sendStats(env, chatId); return; }
        if (text.startsWith("/broadcast ")) { await doBroadcast(env, chatId, text.slice(11)); return; }
        if (text.startsWith("/addfree ")) { await addFreeUser(env, chatId, parseInt(text.slice(9))); return; }
        if (text.startsWith("/removefree ")) { await removeFreeUser(env, chatId, parseInt(text.slice(12))); return; }
        if (text.startsWith("/checkuser ")) { await checkUser(env, chatId, parseInt(text.slice(11))); return; }
    }

    if (text === "/start") {
        await setSession(env, userId, { step: "idle", conflictText: null, paidAt: null, lastMsgId: null });
        await sendStart(env, chatId, userId);
        return;
    }

    var session = await getSession(env, userId);
    if (!session) session = { step: "idle", conflictText: null, paidAt: null, lastMsgId: null };

    if (session.step === "waiting_conflict_text") {
        // Удаляем предыдущее сообщение бота
        await tgDelete(env, chatId, session.lastMsgId);

        if (text.length < 20) {
            var m = await tgSend(env, chatId,
                "✍️ Напиши подробнее — хотя бы несколько предложений.\n\nЧем больше деталей, тем точнее разбор.",
                { reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "go_back" }]] } }
            );
            session.lastMsgId = m?.result?.message_id;
            await setSession(env, userId, session);
            return;
        }

        session.conflictText = text;
        var isFree = await checkFreeAccess(env, userId);
        if (isFree) {
            session.step = "idle";
            await setSession(env, userId, session);
            await runAnalysis(env, chatId, userId, text);
        } else {
            session.step = "waiting_payment";
            await setSession(env, userId, session);
            var pm = await sendPaymentPrompt(env, chatId);
            session.lastMsgId = pm;
            await setSession(env, userId, session);
        }
        return;
    }

    // Не в нужном шаге
    var sm = await sendStart(env, chatId, userId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CALLBACK КНОПКИ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleCallbackQuery(cb, env) {
    var userId = cb.from.id;
    var chatId = cb.message.chat.id;
    var msgId = cb.message.message_id;
    var data = cb.data;

    await tgCall(env, "answerCallbackQuery", { callback_query_id: cb.id });

    var session = await getSession(env, userId);
    if (!session) session = { step: "idle", conflictText: null, paidAt: null, lastMsgId: null };

    if (data === "go_back" || data === "to_start") {
        await tgDelete(env, chatId, msgId);
        await setSession(env, userId, { step: "idle", conflictText: null, paidAt: null, lastMsgId: null });
        await sendStart(env, chatId, userId);
        return;
    }

    if (data === "start_analysis") {
        await tgDelete(env, chatId, msgId);
        session.step = "waiting_conflict_text";
        var m = await tgCall(env, "sendMessage", {
            chat_id: chatId,
            text: "📝 *Опиши конфликт своими словами*\n\nЧто произошло? Что сказал ты, что сказал партнёр?\n\nЧем подробнее — тем точнее разбор 👇",
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "to_start" }]] }
        });
        session.lastMsgId = m?.result?.message_id;
        await setSession(env, userId, session);
        return;
    }

    if (data === "what_is_this") {
        await tgDelete(env, chatId, msgId);
        var m2 = await tgCall(env, "sendMessage", {
            chat_id: chatId,
            text:
                "🤝 *Анализатор ссор* — это твой личный психолог.\n\n" +
                "Ты описываешь конфликт с партнёром, другом или коллегой — " +
                "и получаешь объективный разбор:\n\n" +
                "• Кто и насколько прав в процентах\n" +
                "• В чём настоящая причина ссоры\n" +
                "• Что конкретно сделать\n\n" +
                "Нажми *Начать анализ* чтобы попробовать 👇",
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔍 Начать анализ", callback_data: "start_analysis" }],
                    [{ text: "◀️ Назад", callback_data: "to_start" }]
                ]
            }
        });
        session.lastMsgId = m2?.result?.message_id;
        await setSession(env, userId, session);
        return;
    }

    if (data === "pay_now") {
        await tgDelete(env, chatId, msgId);
        await sendInvoice(env, chatId);
        return;
    }

    if (data === "cancel_payment") {
        await tgDelete(env, chatId, msgId);
        await setSession(env, userId, { step: "idle", conflictText: null, paidAt: null, lastMsgId: null });
        await sendStart(env, chatId, userId);
        return;
    }

    // Админка
    var adminId = parseInt(env.ADMIN_ID || "8231689704");
    if (userId === adminId) {
        if (data === "admin_stats") { await sendStats(env, chatId); return; }
        if (data === "admin_broadcast_hint") { await tgSend(env, chatId, "📢 Команда:\n/broadcast Ваш текст"); return; }
        if (data === "admin_addfree_hint") { await tgSend(env, chatId, "👤 Команда:\n/addfree 123456789"); return; }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ЭКРАН ОПЛАТЫ (перед инвойсом)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendPaymentPrompt(env, chatId) {
    var m = await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text:
            "✨ *Конфликт получен!*\n\n" +
            "Осталось один шаг — оплатить анализ.\n\n" +
            "💫 *199 Telegram Stars* — и ты получишь:\n" +
            "• Кто прав и на сколько %\n" +
            "• Корень конфликта\n" +
            "• Конкретный совет\n" +
            "• Красивую карточку с результатом",
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "💳 Оплатить 199 ⭐", callback_data: "pay_now" }],
                [{ text: "◀️ Назад", callback_data: "cancel_payment" }]
            ]
        }
    });
    return m?.result?.message_id;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// УСПЕШНАЯ ОПЛАТА
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleSuccessfulPayment(msg, env) {
    var userId = msg.from.id;
    var chatId = msg.chat.id;

    var userKey = "users:" + userId;
    var userRaw = await kvGet(env, userKey);
    var user = userRaw ? JSON.parse(userRaw) : {};
    user.totalPaid = (user.totalPaid || 0) + 199;
    await kvPut(env, userKey, JSON.stringify(user));

    var today = new Date().toISOString().slice(0, 10);
    var statsKey = "stats:payments:" + today;
    var statsRaw = await kvGet(env, statsKey);
    var stats = statsRaw ? JSON.parse(statsRaw) : { count: 0, stars: 0 };
    stats.count++; stats.stars += 199;
    await kvPut(env, statsKey, JSON.stringify(stats));

    var session = await getSession(env, userId);
    if (session && session.conflictText) {
        session.step = "idle";
        session.paidAt = Date.now();
        await setSession(env, userId, session);
        await runAnalysis(env, chatId, userId, session.conflictText);
    } else {
        await tgSend(env, chatId, "✅ Оплата получена! Начни заново — /start");
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// АНАЛИЗ КОНФЛИКТА
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runAnalysis(env, chatId, userId, conflictText) {
    var loadMsg = await tgSend(env, chatId, "⏳ Анализирую конфликт...");
    var loadMsgId = loadMsg?.result?.message_id;

    // Промт — сторона А (пользователь) всегда немного правее
    var analysisPrompt = `Ты психолог-медиатор. Тебе описали конфликт от лица стороны А.

ВАЖНО: сторона А — это человек который пишет тебе и ищет поддержку. Дай ей чуть больше правоты (на 10-20% больше чем стороне Б), но оставайся реалистичным — не делай 100% если нет явных оснований. Анализ должен звучать объективно, но с лёгким уклоном в пользу А.

Верни ТОЛЬКО валидный JSON без markdown и пояснений:
{
  "person_a_score": число от 0 до 100,
  "person_b_score": число от 0 до 100,
  "person_a_valid": "что справедливо в позиции А (1-2 предложения, поддерживающий тон)",
  "person_b_valid": "что можно понять в позиции Б (1-2 предложения, нейтрально)",
  "root_cause": "глубинная причина конфликта (1 предложение)",
  "advice": "конкретный совет — что сделать стороне А чтобы выйти победителем из ситуации (2-3 предложения)",
  "conflict_type": одно из: "коммуникация" | "ожидания" | "ценности" | "усталость" | "ревность" | "деньги" | "быт"
}

Конфликт:
${conflictText}`;

    var analysis = await callGemini(env, analysisPrompt, null, "gemini-2.5-flash");
    var parsed = parseGeminiJson(analysis);

    if (!parsed) {
        var retry = analysisPrompt + "\n\nВАЖНО: только JSON, без лишнего текста.";
        var analysis2 = await callGemini(env, retry, null, "gemini-2.5-flash");
        parsed = parseGeminiJson(analysis2);
    }

    await tgDelete(env, chatId, loadMsgId);

    if (!parsed) {
        await tgSend(env, chatId, "😔 Не удалось проанализировать. Попробуй ещё раз — /start");
        return;
    }

    var { person_a_score, person_b_score, person_a_valid, person_b_valid, root_cause, advice, conflict_type } = parsed;
    var botUsername = env.BOT_USERNAME || "SorySorabot";

    // ── Генерация карточки ────────────────────────────────────────────────────
    var imageBase64 = await generateCard(env, person_a_score, person_b_score, root_cause, botUsername);

    // ── Текст результата ──────────────────────────────────────────────────────
    var resultText =
        `🔍 *Анализ твоего конфликта*\n\n` +
        `*Ты — ${person_a_score}% правоты* ✅\n` +
        `${person_a_valid}\n\n` +
        `*Другая сторона — ${person_b_score}%*\n` +
        `${person_b_valid}\n\n` +
        `🧩 *Корень конфликта:*\n${root_cause}\n\n` +
        `💡 *Совет:*\n${advice}\n\n` +
        `🏷 Тип конфликта: *${conflict_type}*\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `Хочешь узнать насколько вы совместимы? → @soon`;

    var keyboard = {
        inline_keyboard: [[{ text: "🔍 Новый анализ", callback_data: "to_start" }]]
    };

    if (imageBase64) {
        try {
            var blob = base64ToBlob(imageBase64, "image/png");
            var form = new FormData();
            form.append("chat_id", String(chatId));
            form.append("photo", blob, "card.png");
            form.append("caption", resultText);
            form.append("parse_mode", "Markdown");
            form.append("reply_markup", JSON.stringify(keyboard));
            var photoResp = await fetch(
                "https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/sendPhoto",
                { method: "POST", body: form }
            );
            if (!photoResp.ok) throw new Error("photo failed");
        } catch (imgErr) {
            console.error("Image send error:", imgErr);
            await tgCall(env, "sendMessage", { chat_id: chatId, text: resultText, parse_mode: "Markdown", reply_markup: keyboard });
        }
    } else {
        await tgCall(env, "sendMessage", { chat_id: chatId, text: resultText, parse_mode: "Markdown", reply_markup: keyboard });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ГЕНЕРАЦИЯ КАРТОЧКИ через Gemini Image
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function generateCard(env, scoreA, scoreB, rootCause, botUsername) {
    var cardPrompt =
        `Create a PNG image 800x400px, minimalist style infographic card.\n` +
        `Dark purple background #1a1040. White modern font.\n\n` +
        `Layout:\n` +
        `- Top center title: "Анализ конфликта" in white, large\n` +
        `- Left side big number: "${scoreA}%" with label "Ты" below it, accent color #a78bfa\n` +
        `- Right side big number: "${scoreB}%" with label "Другая сторона" below it, color #6b7280\n` +
        `- Center dividing vertical line\n` +
        `- Bottom center small text: "${rootCause.slice(0, 60)}"\n` +
        `- Very bottom tiny: "@${botUsername}"\n\n` +
        `Clean, no extra decorations, like a modern stat card.`;

    return await callGeminiImage(env, cardPrompt);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GEMINI API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function callGemini(env, prompt, systemPrompt, model) {
    var key = env.GEMINI_API_KEY;
    var mdl = model || "gemini-2.5-flash";
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + mdl + ":generateContent?key=" + key;
    var contents = [{ parts: [{ text: prompt }], role: "user" }];
    var reqBody = { contents };
    if (systemPrompt) reqBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    try {
        var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
        var data = await r.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } catch (e) { console.error("Gemini text error:", e); return ""; }
}

async function callGeminiImage(env, prompt) {
    var key = env.GEMINI_API_KEY;
    var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=" + key;
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
            if (part.inlineData && (part.inlineData.mimeType === "image/png" || part.inlineData.mimeType === "image/jpeg")) {
                return part.inlineData.data;
            }
        }
        console.error("No image in Gemini response:", JSON.stringify(data).slice(0, 300));
        return null;
    } catch (e) { console.error("Gemini image error:", e); return null; }
}

function parseGeminiJson(text) {
    if (!text) return null;
    try {
        var clean = text.replace(/```json|```/g, "").trim();
        var start = clean.indexOf("{");
        var end = clean.lastIndexOf("}");
        if (start === -1 || end === -1) return null;
        return JSON.parse(clean.slice(start, end + 1));
    } catch (e) { console.error("JSON parse error:", e); return null; }
}

function base64ToBlob(base64, mimeType) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function tgCall(env, method, params) {
    var url = "https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + method;
    try {
        var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
        return await r.json();
    } catch (e) { console.error("TG API error:", method, e); return null; }
}

async function tgSend(env, chatId, text, extra) {
    return tgCall(env, "sendMessage", { chat_id: chatId, text: text, ...(extra || {}) });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// СТАРТОВЫЙ ЭКРАН
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendStart(env, chatId, userId) {
    var isFree = userId ? await checkFreeAccess(env, userId) : false;
    var priceText = isFree ? "✅ У тебя *бесплатный доступ*" : "Стоимость: *199 ⭐ Telegram Stars*";
    var m = await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text:
            "🤝 *Привет! Я — Анализатор ссор*\n\n" +
            "Опиши конфликт с партнёром, другом или коллегой — " +
            "и я объективно разберу ситуацию:\n\n" +
            "• Кто и насколько прав (%)\n" +
            "• В чём настоящая причина ссоры\n" +
            "• Конкретный совет что делать\n\n" +
            priceText,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[
                { text: "🔍 Начать анализ", callback_data: "start_analysis" },
                { text: "❓ Как это работает?", callback_data: "what_is_this" }
            ]]
        }
    });
    return m?.result?.message_id;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ИНВОЙС
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendInvoice(env, chatId) {
    await tgCall(env, "sendInvoice", {
        chat_id: chatId,
        title: "Анализ вашего конфликта",
        description: "Узнай кто прав, найди причину и получи совет",
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
    var user = raw ? JSON.parse(raw) : { userId: tgUser.id, username: tgUser.username || "", firstSeen: Date.now(), totalPaid: 0, isFree: false };
    user.username = tgUser.username || user.username;
    await kvPut(env, key, JSON.stringify(user));
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
        text: "🛠 *Панель администратора*",
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 Статистика", callback_data: "admin_stats" }],
                [{ text: "📢 Рассылка", callback_data: "admin_broadcast_hint" }],
                [{ text: "👤 Бесплатный доступ", callback_data: "admin_addfree_hint" }]
            ]
        }
    });
}

async function sendStats(env, chatId) {
    try {
        var userKeys = await kvList(env, "userindex:");
        var totalUsers = userKeys.keys.length;
        var today = new Date().toISOString().slice(0, 10);
        var statsRaw = await kvGet(env, "stats:payments:" + today);
        var todayStats = statsRaw ? JSON.parse(statsRaw) : { count: 0, stars: 0 };
        var statsList = await kvList(env, "stats:payments:");
        var allPaid = 0, allStars = 0;
        for (var sk of statsList.keys) {
            var sr = await kvGet(env, sk.name);
            if (sr) { var sd = JSON.parse(sr); allPaid += sd.count || 0; allStars += sd.stars || 0; }
        }
        var allUserKeys = await kvList(env, "users:");
        var userData = [];
        for (var uk of allUserKeys.keys) { var ur = await kvGet(env, uk.name); if (ur) userData.push(JSON.parse(ur)); }
        userData.sort((a, b) => (b.totalPaid || 0) - (a.totalPaid || 0));
        var top5text = userData.slice(0, 5).map((u, i) => `${i+1}. @${u.username || u.userId} — ${u.totalPaid || 0} ⭐`).join("\n");
        await tgSend(env, chatId,
            `📊 *Статистика*\n\n👥 Пользователей: *${totalUsers}*\n\n` +
            `📅 Сегодня:\nПлатежей: *${todayStats.count}*, Звёзд: *${todayStats.stars} ⭐*\n\n` +
            `📈 Всего:\nПлатежей: *${allPaid}*, Звёзд: *${allStars} ⭐*\n\n` +
            `🏆 Топ-5:\n${top5text || "Пока нет данных"}`,
            { parse_mode: "Markdown" }
        );
    } catch (e) { console.error("Stats error:", e); await tgSend(env, chatId, "❌ Ошибка: " + e.message); }
}

async function doBroadcast(env, chatId, text) {
    var keys = await kvList(env, "userindex:");
    var sent = 0, errors = 0;
    for (var k of keys.keys) {
        var uid = k.name.replace("userindex:", "");
        try {
            var r = await tgCall(env, "sendMessage", { chat_id: parseInt(uid), text: text });
            if (r && r.ok) sent++; else errors++;
        } catch (e) { errors++; }
        await new Promise(res => setTimeout(res, 50));
    }
    await tgSend(env, chatId, `📢 Готово\n✅ Отправлено: ${sent}\n❌ Ошибок: ${errors}`);
}

async function addFreeUser(env, chatId, userId) {
    if (!userId || isNaN(userId)) { await tgSend(env, chatId, "❌ Неверный userId"); return; }
    var raw = await kvGet(env, "free_users");
    var list = raw ? JSON.parse(raw) : [];
    if (!list.includes(userId)) list.push(userId);
    await kvPut(env, "free_users", JSON.stringify(list));
    await tgSend(env, chatId, `✅ Пользователь ${userId} получил бесплатный доступ`);
}

async function removeFreeUser(env, chatId, userId) {
    if (!userId || isNaN(userId)) { await tgSend(env, chatId, "❌ Неверный userId"); return; }
    var raw = await kvGet(env, "free_users");
    var list = raw ? JSON.parse(raw) : [];
    list = list.filter(id => id !== userId);
    await kvPut(env, "free_users", JSON.stringify(list));
    await tgSend(env, chatId, `✅ Пользователь ${userId} удалён из бесплатного доступа`);
}

async function checkUser(env, chatId, userId) {
    if (!userId || isNaN(userId)) { await tgSend(env, chatId, "❌ Неверный userId"); return; }
    var raw = await kvGet(env, "users:" + userId);
    if (!raw) { await tgSend(env, chatId, `❓ Пользователь ${userId} не найден`); return; }
    var u = JSON.parse(raw);
    var freeRaw = await kvGet(env, "free_users");
    var freeList = freeRaw ? JSON.parse(freeRaw) : [];
    var isFree = freeList.includes(userId);
    await tgSend(env, chatId,
        `👤 *Профиль*\n\nID: \`${u.userId}\`\nUsername: @${u.username || "—"}\n` +
        `Первый визит: ${new Date(u.firstSeen).toLocaleString("ru-RU")}\n` +
        `Потрачено: *${u.totalPaid || 0} ⭐*\nБесплатный: ${isFree ? "✅" : "❌"}`,
        { parse_mode: "Markdown" }
    );
}
