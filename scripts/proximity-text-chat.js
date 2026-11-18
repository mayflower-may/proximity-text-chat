/**
 * Proximity Text Chat — Foundry VTT v13 / v14
 *
 * Original module by enso (jessev14): https://github.com/jessev14/proximity-text-chat
 * Continued and extended under the GPL-3.0 licence.
 *
 * Visibility is decided synchronously inside ChatMessage#visible: every client knows the token
 * positions on its own canvas, so no socket round trip is needed.
 *
 * Voice tiers:
 *   - whisper → whisperDistance  (short range, small faded bubble)
 *   - talk    → proximityDistance (normal range, normal bubble)
 *   - shout   → screamDistance    (long range, big bold bubble)
 * Players pick their tier with the button in the chat input; it applies to every in-character
 * message until changed. /scream still works as a one-off shout.
 */

const MODULE_ID = "proximity-text-chat-continued";
const LEGACY_ID = "proximity-text-chat";   // the original module; its message flags and settings are still read

// The original module wraps the same methods. If it is active, this module stays idle.
let enabled = true;
const on = (name, fn) => Hooks.on(name, (...args) => enabled ? fn(...args) : undefined);
const once = (name, fn) => Hooks.once(name, (...args) => enabled ? fn(...args) : undefined);

const TIERS = {
    whisper: { label: "PTC.Tier.Whisper", verb: "PTC.Tier.WhisperVerb", icon: "fa-volume-low", color: "#7fb0ff", distanceSetting: "whisperDistance" },
    talk:    { label: "PTC.Tier.Talk",    verb: "PTC.Tier.TalkVerb",    icon: "fa-comment",    color: "#d8d8d8", distanceSetting: "proximityDistance" },
    shout:   { label: "PTC.Tier.Shout",   verb: "PTC.Tier.ShoutVerb",   icon: "fa-bullhorn",   color: "#ff6b6b", distanceSetting: "screamDistance" },
};
const TIER_ORDER = ["whisper", "talk", "shout"];

const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);
const setting = (key) => game.settings.get(MODULE_ID, key);

/* ─── Settings ─────────────────────────────────────────────────────────── */

Hooks.once("init", () => {
    if (game.modules.get(LEGACY_ID)?.active) {
        enabled = false;
        console.warn(`${MODULE_ID} | the original "${LEGACY_ID}" module is active; this module stays idle.`);
        Hooks.once("ready", () => { if (game.user.isGM) ui.notifications.warn(t("PTC.Notify.LegacyActive"), { permanent: true }); });
    }
    const reg = (key, data) => game.settings.register(MODULE_ID, key, {
        name: `PTC.Settings.${key}.Name`,
        hint: `PTC.Settings.${key}.Hint`,
        scope: "world", config: true,
        ...data,
    });

    reg("whisperDistance", { type: Number, default: 10 });
    reg("proximityDistance", { type: Number, default: 30 });
    reg("screamDistance", { type: Number, default: 60 });
    reg("requireVisibility", { type: Boolean, default: false });
    reg("wallsBlockSpeech", { type: Boolean, default: false });
    reg("rollMessageDistance", { type: Number, default: 0 });
    reg("useConditions", { type: Boolean, default: true });
    reg("rememberHeard", { type: Boolean, default: true });
    reg("showListeners", { type: Boolean, default: true });
    reg("screamBubbleDuration", { type: Number, default: 3 });
    reg("minBubbleDuration", { type: Number, default: 2 });
    reg("bubbleFont", { type: String, default: "Signika", onChange: () => loadBubbleFont() });
    reg("bubbleColor", { type: String, default: "#000000", onChange: () => applyBubbleColor() });
    reg("styleEmotes", { type: Boolean, default: true, onChange: () => applyEmoteStyle() });

    game.settings.register(MODULE_ID, "legacyImported", { scope: "world", config: false, type: Boolean, default: false });

    // The tier the player has picked (per client).
    game.settings.register(MODULE_ID, "voiceTier", {
        scope: "client", config: false, type: String, default: "talk",
    });
});

// Add a colour picker next to the bubble colour text field.
on("renderSettingsConfig", (_app, html) => {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!root) return;
    const input = root.querySelector(`[name="${MODULE_ID}.bubbleColor"]`);
    if (!input || input._ptcColorAdded) return;
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = /^#[0-9a-f]{6}$/i.test(input.value) ? input.value : "#191813";
    Object.assign(picker.style, {
        marginLeft: "6px", verticalAlign: "middle",
        width: "42px", height: "26px", padding: "0", cursor: "pointer", flex: "0 0 auto",
    });
    input.after(picker);
    input._ptcColorAdded = true;
    picker.addEventListener("input", () => {
        input.value = picker.value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    input.addEventListener("input", () => {
        if (/^#[0-9a-f]{6}$/i.test(input.value)) picker.value = input.value;
    });
});

function getCurrentTier() {
    const tier = setting("voiceTier");
    return TIERS[tier] ? tier : "talk";
}

/* ─── libWrapper: visible, processMessage, say ─────────────────────────── */

once("setup", () => {
    if (!globalThis.libWrapper) {
        console.error(`${MODULE_ID} | libWrapper not found; messages will not be hidden.`);
        once("ready", () => ui.notifications?.error(t("PTC.Notify.NoLibWrapper")));
        return;
    }

    register([
        "CONFIG.ChatMessage.documentClass.prototype.visible",
        "foundry.documents.ChatMessage.prototype.visible",
        "ChatMessage.prototype.visible",
    ], visibleWrapper, "ChatMessage#visible");

    // Systems subclass ChatLog (e.g. ChatLog5e), so target the class actually in use (CONFIG.ui.chat).
    register([
        "CONFIG.ui.chat.prototype.processMessage",
        "foundry.applications.sidebar.tabs.ChatLog.prototype.processMessage",
        "ChatLog.prototype.processMessage",
    ], processMessageWrapper, "processMessage");

    // In v14 ChatBubbles#_getDuration is private, so say() is re-implemented to control the
    // bubble duration and font.
    register([
        "foundry.canvas.animation.ChatBubbles.prototype.say",
        "ChatBubbles.prototype.say",
    ], sayOverride, "say", "OVERRIDE");
});

function register(targets, fn, label, type = "MIXED") {
    for (const target of targets) {
        try {
            libWrapper.register(MODULE_ID, target, fn, type);
            console.log(`${MODULE_ID} | ${label} wrapped (${target}) [${type}]`);
            return true;
        } catch (_err) { /* try the next target */ }
    }
    console.warn(`${MODULE_ID} | ${label} could not be wrapped.`);
    return false;
}

/* ─── Chat bubbles: say() ──────────────────────────────────────────────── */

/**
 * Re-implementation of ChatBubbles#say. Mirrors core bubble creation but computes the duration
 * itself so a minimum duration can be guaranteed. The #chat-bubbles container is transformed in
 * scene coordinates inside #hud, so the bubble is positioned in scene coordinates.
 */
async function sayOverride(token, message, options = {}) {
    const cb = canvas?.hud?.bubbles;
    if (!cb) return null;

    const { cssClasses = [], pan = true, requireVisible = false } = options ?? {};
    if (!token || !message) return null;

    const tokenId = token.document?.id ?? token.id;
    if (!tokenId) return null;
    if (requireVisible && token.visible === false) return null;

    const container = cb.element;
    if (!container) return null;

    // Remove this token's current bubble.
    try {
        const prev = cb.bubbles?.[tokenId];
        if (prev?.remove) prev.remove();
        if (cb.bubbles) delete cb.bubbles[tokenId];
    } catch (_e) { /* ignore */ }

    const bubble = document.createElement("div");
    bubble.classList.add("chat-bubble");
    for (const c of cssClasses) if (c) bubble.classList.add(c);
    bubble.innerHTML = message;

    // chatBubbleHTML runs before the bubble is added; our own handler styles the tier and hides
    // out-of-range bubbles by returning false.
    const opts = { cssClasses: [...cssClasses], pan, requireVisible };
    try {
        if (Hooks.call("chatBubbleHTML", token, bubble, message, opts) === false) return null;
    } catch (_e) { /* ignore */ }

    // Custom font only when one is set and no other module (e.g. Polyglot) styled the bubble;
    // otherwise a language font would be replaced and the hidden text would become readable.
    try {
        const font = getBubbleFontStack();
        if (font) {
            const styledByOther =
                bubble.style.fontFamily || bubble.style.font ||
                /polyglot|lang-|font/i.test(bubble.className) ||
                bubble.querySelector('[style*="font"], [class*="polyglot"], [class*="lang-"]');
            if (!styledByOther) bubble.style.fontFamily = font;
        }
    } catch (_e) { /* ignore */ }

    // Add hidden to measure it.
    bubble.style.visibility = "hidden";
    bubble.style.opacity = "0";
    container.appendChild(bubble);

    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    bubble.style.left = `${Math.round(token.x + (token.w / 2) - (bw / 2))}px`;
    bubble.style.top = `${Math.round(token.y - bh - 8)}px`;
    bubble.style.visibility = "";

    if (cb.bubbles) cb.bubbles[tokenId] = bubble;

    // Pan only if the call asks for it AND core "Pan to Token Speaker" is on.
    if (pan && corePanEnabled()) {
        try { canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 }); }
        catch (_e) { /* ignore */ }
    }

    try {
        bubble.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: "ease", fill: "forwards" });
    } catch (_e) { /* no Web Animations */ }
    bubble.style.opacity = "1";

    const duration = computeBubbleDuration(bubble, message);
    window.setTimeout(() => {
        if (!bubble.isConnected) return;
        const cleanup = () => {
            try { bubble.remove(); } catch (_e) { /* ignore */ }
            if (cb.bubbles?.[tokenId] === bubble) delete cb.bubbles[tokenId];
        };
        let anim = null;
        try {
            anim = bubble.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: "ease", fill: "forwards" });
        } catch (_e) { /* ignore */ }
        if (anim?.finished) anim.finished.then(cleanup).catch(cleanup);
        else window.setTimeout(cleanup, 250);
    }, duration);

    return bubble;
}

function corePanEnabled() {
    try {
        if (game.settings?.settings?.has?.("core.chatBubblesPan")) return !!game.settings.get("core", "chatBubblesPan");
    } catch (_e) { /* ignore */ }
    return true;
}

/**
 * Bubble duration (ms):
 *  - shout → screamBubbleDuration (if set)
 *  - others → word count based (core formula, 200 ms per word), never below minBubbleDuration.
 */
function computeBubbleDuration(bubbleEl, message) {
    const isShout = bubbleEl?.classList?.contains("ptc-bubble-shout")
        || (typeof message === "string" && message.includes("[SCREAM]"));
    if (isShout) {
        const secs = setting("screamBubbleDuration");
        if (secs && secs > 0) return secs * 1000;
    }
    const text = String(message ?? "").replace(/<[^>]*>/g, " ");
    const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
    const base = Math.min(Math.max(words * 200, 1000), 20000);
    const minSecs = setting("minBubbleDuration");
    return Math.max(base, (minSecs && minSecs > 0) ? minSecs * 1000 : 0);
}

/* ─── Appearance ───────────────────────────────────────────────────────── */

once("ready", () => {
    loadBubbleFont();
    applyBubbleColor();
    applyEmoteStyle();
});

function applyBubbleColor() {
    let color = "#191813";
    try { color = (setting("bubbleColor") || "#191813").trim(); } catch (_e) { /* ignore */ }
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = "#191813";
    document.documentElement.style.setProperty("--ptc-bubble-color", color);
}

function applyEmoteStyle() {
    let styled = true;
    try { styled = !!setting("styleEmotes"); } catch (_e) { /* ignore */ }
    document.body.classList.toggle("ptc-style-emotes", styled);
}

// Load Cinzel from Google Fonts when it is chosen (each player's browser downloads it).
function loadBubbleFont() {
    let font = "";
    try { font = setting("bubbleFont") || ""; } catch (_e) { /* ignore */ }
    if (!/cinzel/i.test(font)) return;
    const id = "ptc-font-link";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
}

// "Signika" or empty → "" (no override), so modules such as Polyglot stay in control.
function getBubbleFontStack() {
    let font = "Signika";
    try { font = (setting("bubbleFont") || "Signika").trim(); } catch (_e) { /* ignore */ }
    font = font.replace(/["';]/g, "");
    if (!font || /^signika$/i.test(font)) return "";
    return `"${font}", "Signika", serif`;
}

/* ─── processMessage: /scream and /telepathy ───────────────────────────── */

function processMessageWrapper(wrapped, message, ...args) {
    // The v14 ProseMirror input can wrap the message in HTML.
    const text = stripHtml((message ?? "").toString());
    const lower = text.toLowerCase();
    const speaker = args?.[0]?.speaker;

    if (lower.startsWith("/scream ")) return handleScream(text.slice(8).trim(), { speaker });
    if (lower.startsWith("/telepathy ")) {
        const rest = text.slice(11).trim();
        const idx = rest.indexOf(" ");
        if (idx === -1) {
            ui.notifications.warn(t("PTC.Notify.TelepathyUsage"));
            return Promise.resolve();
        }
        return handleTelepathy(rest.slice(0, idx), rest.slice(idx + 1), { speaker });
    }
    return wrapped(message, ...args);
}

function stripHtml(raw) {
    return raw
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/p>\s*<p>/gi, " ")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .trim();
}

/* ─── Remembering who heard what ───────────────────────────────────────────
 * Without this, visibility is recomputed on every render from the CURRENT positions: after a
 * refresh or when scrolling up, old conversations you heard disappear once you walk away, and
 * conversations you did not hear appear once you walk over. The decision made when a message
 * arrives (first 15 s) is stored in this browser and reused afterwards. */
const HEARD_WINDOW = 15_000, HEARD_MAX = 3000;
let heardCache = null;
const heardKey = () => `${MODULE_ID}-heard-${game.userId}`;
function heardRead() {
    if (heardCache) return heardCache;
    try { heardCache = new Map(Object.entries(JSON.parse(localStorage.getItem(heardKey()) ?? "{}"))); }
    catch (_e) { heardCache = new Map(); }
    return heardCache;
}
let heardSaveTimer = null;
function heardStore(id, decision) {
    const map = heardRead();
    map.delete(id); map.set(id, decision ? 1 : 0);
    while (map.size > HEARD_MAX) map.delete(map.keys().next().value);
    heardSaveTimer ??= setTimeout(() => {
        heardSaveTimer = null;
        try { localStorage.setItem(heardKey(), JSON.stringify(Object.fromEntries(heardRead()))); } catch (_e) { /* no storage */ }
    }, 2000);
}

/* ─── ChatMessage#visible ──────────────────────────────────────────────── */

function visibleWrapper(wrapped, ...args) {
    const coreVisible = wrapped(...args);
    if (!coreVisible) return false;

    try {
        if (!game.user || game.user.isGM) return true;
        if (this.author?.id === game.user.id) return true;
        if (this.whisper?.length) return true;

        const remember = setting("rememberHeard");
        if (remember && this.id) {
            const stored = heardRead().get(this.id);
            if (stored !== undefined) return stored === 1;
        }
        const decision = canHearNow(this);
        if (remember && this.id && canvas?.ready && Date.now() - (this.timestamp ?? 0) < HEARD_WINDOW) heardStore(this.id, decision);
        return decision;
    } catch (err) {
        console.warn(`${MODULE_ID} | visibility check failed, showing the message.`, err);
        return true;
    }
}

/** Can I hear this message right now (current token positions and tier)? */
function canHearNow(message) {
    // Monk's TokenBar roll request: visible to the rollers and to anyone within talk distance of them.
    const mtb = message.flags?.["monks-tokenbar"];
    if (mtb?.what === "savingthrow" || mtb?.what === "contestedroll") return rollRequestVisible(mtb);

    // Roll / card messages: visible within rollMessageDistance of where they happened (0 = core behaviour).
    if (setting("rollMessageDistance") > 0 && isRollMessage(message)) return rollMessageVisible(message);

    if (!message.speaker?.token) return true;
    if (!canHearMessage(message)) return false;
    if (wallBlocks(message)) return false;
    return !(isSpeech(message) && amIDeafened());
}

/* ─── Roll messages ────────────────────────────────────────────────────────
 * Any message with rolls or a system card is visible within rollMessageDistance of where it
 * happened, regardless of voice tier and walls (you can hear a fight). Location: the speaking
 * token; else this actor's token on the scene; else the author's character token. If none is
 * found (a roll from the sheet with no token on the map) everyone sees it, as before. */
function isRollMessage(m) {
    const f = m.flags ?? {};
    return !!(m.rolls?.length || f.dnd5e || f["midi-qol"]);
}
function rollLocation(m) {
    const scene = m.speaker?.scene ? game.scenes.get(m.speaker.scene) : canvas?.scene;
    if (!scene) return null;
    if (m.speaker?.token) {
        const tok = scene.tokens.get(m.speaker.token);
        if (tok) return tok;
    }
    const actorId = m.speaker?.actor;
    if (actorId) {
        const tok = characterToken(game.actors.get(actorId), scene);
        if (tok) return tok;
    }
    const character = m.author?.character;
    if (character) {
        const tok = characterToken(character, scene);
        if (tok) return tok;
    }
    return null;
}
function rollMessageVisible(m) {
    if (!canvas?.scene) return true;
    const where = rollLocation(m);
    if (!where) return true;
    if (where.parent?.id !== canvas.scene.id) return false;   // happened on another scene
    const mine = myTokens();
    if (!mine.length) return false;
    if (mine.some(tok => tok.id === where.id)) return true;
    const limit = setting("rollMessageDistance");
    return mine.some(tok => distanceBetween(tok, where) <= limit);
}

function rollRequestVisible(mtb) {
    const tokens = Object.entries(mtb)
        .filter(([k, v]) => k.startsWith("token") && typeof v?.uuid === "string")
        .map(([, v]) => fromUuidSync(v.uuid))
        .filter(tok => tok?.documentName === "Token");
    if (!tokens.length) return true;
    if (tokens.some(tok => tok.actor?.isOwner)) return true;
    const mine = myTokens();
    if (!mine.length) return false;
    const limit = setting("proximityDistance");
    return tokens.some(tok => tok.parent?.id === canvas?.scene?.id
        && mine.some(m => distanceBetween(m, tok) <= limit));
}

/* ─── Deafened / silenced ──────────────────────────────────────────────── */

const isSpeech = (message) => message.style === CONST.CHAT_MESSAGE_STYLES.IC;
const hasStatus = (actor, status) => !!actor?.statuses?.has?.(status);

function amIDeafened() {
    return setting("useConditions") && hasStatus(myToken()?.actor, "deafened");
}

let lastDeafNotice = 0;
on("createChatMessage", (message) => {
    try {
        if (game.user.isGM || message.author?.id === game.user.id || message.whisper?.length) return;
        if (!message.speaker?.token || !isSpeech(message) || !amIDeafened()) return;
        if (!canHearMessage(message) || wallBlocks(message)) return;   // would not have heard it anyway
        if (Date.now() - lastDeafNotice < 8000) return;
        lastDeafNotice = Date.now();
        ui.notifications.info(t("PTC.Notify.Deafened"));
    } catch (_e) { /* ignore */ }
});

// A silenced character cannot speak in character (checked in the author's browser).
on("preCreateChatMessage", (message, _data, _options, userId) => {
    if (userId !== game.user?.id || !isSpeech(message) || !setting("useConditions")) return;
    const actor = ChatMessage.implementation.getSpeakerActor(message.speaker);
    if (!hasStatus(actor, "silenced")) return;
    ui.notifications.warn(t("PTC.Notify.Silenced", { name: actor.name }));
    return false;
});

/* ─── Walls ──────────────────────────────────────────────────────────────
 * Walls that fully block sight (normal walls and closed doors) also block whispers and talk.
 * Windows, open doors, invisible and terrain walls let speech through. Core sound restriction is
 * deliberately not used: the window preset blocks sound, but speech through a window should be
 * heard. Shouts are only limited by distance. */
function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = side(c, d, a), d2 = side(c, d, b), d3 = side(a, b, c), d4 = side(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function wallBetween(a, b) {
    const edges = canvas?.edges;
    if (!edges?.values) return false;
    const FULL = CONST.EDGE_SENSE_TYPES?.NORMAL ?? CONST.WALL_SENSE_TYPES?.NORMAL ?? 20;
    for (const e of edges.values()) {
        if (e.type !== "wall" || e.sight !== FULL) continue;
        if (segmentsCross(a, b, e.a, e.b)) return true;
    }
    return false;
}

function wallBetweenTokens(docA, docB) {
    if (!docA || !docB || docA.id === docB.id) return false;
    return wallBetween(tokenCenter(docA), tokenCenter(docB));
}

function wallBlocks(message) {
    try {
        if (!setting("wallsBlockSpeech") || game.user.isGM) return false;
        if (getMessageTier(message) === "shout" || !canvas?.ready) return false;
        if ((message.speaker?.scene ?? canvas.scene.id) !== canvas.scene.id) return false;
        const speaker = canvas.scene.tokens.get(message.speaker?.token);
        const mine = myTokens();
        if (!speaker || !mine.length || mine.some(tok => tok.id === speaker.id)) return false;
        // Blocked only if every one of my tokens that is in range is behind a wall.
        const limit = setting(TIERS[getMessageTier(message)].distanceSetting);
        const inRange = mine.filter(tok => distanceBetween(tok, speaker) <= limit);
        return (inRange.length ? inRange : mine).every(tok => wallBetweenTokens(tok, speaker));
    } catch (_e) { return false; }
}

/* ─── Hearing range ────────────────────────────────────────────────────── */

function canHearMessage(message) {
    const speakerTokenId = message.speaker?.token;
    if (!speakerTokenId || !canvas?.scene) return true;

    const speakerSceneId = message.speaker?.scene ?? canvas.scene.id;
    if (speakerSceneId !== canvas.scene.id) return false;

    const speakerDoc = canvas.scene.tokens.get(speakerTokenId);
    if (!speakerDoc) return true;

    const mine = myTokens();
    if (!mine.length) return true;
    if (mine.some(tok => tok.id === speakerDoc.id)) return true;

    // Heard if any of my tokens is within range.
    const limit = setting(TIERS[getMessageTier(message)].distanceSetting);
    if (!mine.some(tok => distanceBetween(tok, speakerDoc) <= limit)) return false;

    if (setting("requireVisibility")) {
        const placeable = speakerDoc.object;
        if (placeable && !placeable.visible) return false;
    }
    return true;
}

/** A message's tier: flag, else the legacy isScream flag, else "talk". */
function getMessageTier(message) {
    const f = message?.flags?.[MODULE_ID], old = message?.flags?.[LEGACY_ID];
    const tier = f?.tier ?? old?.tier;
    if (tier === "whisper" || tier === "talk" || tier === "shout") return tier;
    return (f?.isScream || old?.isScream) ? "shout" : "talk";
}

/* ─── Tag outgoing messages with the tier ──────────────────────────────── */

on("preCreateChatMessage", (message, _data, _options, userId) => {
    if (userId !== game.user?.id) return;                 // only our own messages
    const f = message.flags?.[MODULE_ID];
    if (f?.tier || f?.isScream) return;                    // /scream already set it
    if (message.whisper?.length) return;                   // real whisper / telepathy
    if (!message.speaker?.token && !game.user.isGM && message.style !== CONST.CHAT_MESSAGE_STYLES.OOC) {
        // Speaking as your character with no token selected: core looks the token up from the
        // actor, but a disguised or polymorphed character's token belongs to another actor, so
        // the message would go out without a token (visible to everyone). Attach our own token.
        const character = game.user.character;
        const actorId = message.speaker?.actor;
        if (character && (!actorId || actorId === character.id)) {
            const tok = characterToken(character, canvas?.scene);
            if (tok) message.updateSource({ speaker: { scene: tok.parent.id, token: tok.id, actor: tok.actorId, alias: tok.name } });
        }
    }
    if (!message.speaker?.token) return;                   // OOC etc.
    message.updateSource({ [`flags.${MODULE_ID}.tier`]: getCurrentTier() });
});

/* ─── /scream and /telepathy ───────────────────────────────────────────── */

async function handleScream(content, chatData) {
    content = (content ?? "").trim();
    if (!content) {
        ui.notifications.warn(t("PTC.Notify.ScreamUsage"));
        return;
    }
    const speaker = chatData?.speaker ?? CONFIG.ChatMessage.documentClass.getSpeaker();
    await CONFIG.ChatMessage.documentClass.create({
        content: `<strong>[SCREAM]</strong> ${content}`,
        speaker,
        style: CONST.CHAT_MESSAGE_STYLES.IC,
        flags: { [MODULE_ID]: { tier: "shout" } },
    });
}

async function handleTelepathy(targetName, content, chatData) {
    targetName = (targetName ?? "").trim();
    content = (content ?? "").trim();
    if (!targetName || !content) {
        ui.notifications.warn(t("PTC.Notify.TelepathyUsage"));
        return;
    }
    const target = game.users.find(u => u.name.toLowerCase() === targetName.toLowerCase());
    if (!target) {
        ui.notifications.warn(t("PTC.Notify.UserNotFound", { name: targetName }));
        return;
    }
    const whisper = [...new Set([target.id, ...game.users.filter(u => u.isGM).map(u => u.id)])];
    const speaker = chatData?.speaker ?? CONFIG.ChatMessage.documentClass.getSpeaker();
    await CONFIG.ChatMessage.documentClass.create({
        content: `<em>[${t("PTC.Telepathy")} → ${foundry.utils.escapeHTML?.(target.name) ?? target.name}]</em> ${content}`,
        speaker,
        whisper,
    });
}

// Fallback for versions where processMessage could not be wrapped.
on("chatMessage", (_chatLog, message, chatData) => {
    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("/scream ")) { handleScream(trimmed.slice(8), chatData); return false; }
    if (lower.startsWith("/telepathy ")) {
        const rest = trimmed.slice(11).trim();
        const idx = rest.indexOf(" ");
        if (idx === -1) { ui.notifications.warn(t("PTC.Notify.TelepathyUsage")); return false; }
        handleTelepathy(rest.slice(0, idx), rest.slice(idx + 1), chatData);
        return false;
    }
    return true;
});

/* ─── Chat bubbles: tier style and range ───────────────────────────────── */

on("chatBubbleHTML", (token, html) => {
    const speakerDoc = token?.document;
    const tier = speakerDoc ? getTierForToken(speakerDoc.id) : "talk";

    if (html?.classList) {
        html.classList.remove("ptc-bubble-whisper", "ptc-bubble-talk", "ptc-bubble-shout");
        html.classList.add(`ptc-bubble-${tier}`);
    }

    if (game.user.isGM) return true;
    const mine = myTokens();
    if (!mine.length || !speakerDoc) return true;
    if (mine.some(tok => tok.id === speakerDoc.id)) return true;

    const hide = () => { if (html?.style) html.style.display = "none"; return false; };
    if (amIDeafened()) return hide();
    const limit = setting(TIERS[tier].distanceSetting);
    const inRange = mine.filter(tok => distanceBetween(tok, speakerDoc) <= limit);
    if (!inRange.length) return hide();
    if (setting("wallsBlockSpeech") && tier !== "shout" && inRange.every(tok => wallBetweenTokens(tok, speakerDoc))) return hide();
    return true;
});

// The tier of a token's latest message (the bubble belongs to it).
function getTierForToken(tokenId) {
    const msgs = game.messages?.contents ?? [];
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 50; i--) {
        if (msgs[i].speaker?.token === tokenId) return getMessageTier(msgs[i]);
    }
    return "talk";
}

/* ─── Voice tier button (chat input) ───────────────────────────────────────
 * The v14 chat input is rendered separately and moved around with the UI, so the DOM is watched
 * instead of relying on a single render hook. */

once("ready", () => {
    ensureTierButton();

    const target = document.getElementById("interface") ?? document.body;
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; ensureTierButton(); }, 200);
    }).observe(target, { childList: true, subtree: true });

    for (const h of ["renderChatInput", "renderChatLog", "changeSidebarTab", "collapseSidebar"]) {
        on(h, () => ensureTierButton());
    }
});

let tierButtonWarned = false;

function ensureTierButton() {
    if (document.querySelector(".ptc-voice-tier")) return;

    const { anchor, mode } = findTierAnchor();
    if (!anchor) {
        if (!tierButtonWarned) {
            tierButtonWarned = true;
            console.warn(`${MODULE_ID} | chat input not found; the voice tier button was not added.`);
        }
        return;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ptc-voice-tier";
    paintTierButton(btn, getCurrentTier());
    btn.addEventListener("click", onTierButtonClick);

    if (mode === "before") anchor.parentElement?.insertBefore(btn, anchor);
    else anchor.prepend(btn);
    updateListeners();
}

function findTierAnchor() {
    const input =
        document.querySelector("#chat-message") ||
        document.querySelector(".chat-input .ProseMirror") ||
        document.querySelector(".chat-input prose-mirror") ||
        document.querySelector("prose-mirror[name='content']") ||
        document.querySelector(".chat-form prose-mirror, .chat-form textarea") ||
        document.querySelector("[data-application-part='input'] prose-mirror, [data-application-part='input'] textarea") ||
        document.querySelector(".chat-input textarea");
    if (input) {
        const container = input.closest(".chat-input, .chat-form, #chat-form, [data-application-part='input']") || input.parentElement;
        if (container) return { anchor: container, mode: "prepend" };
        return { anchor: input, mode: "before" };
    }
    const rollMode = document.querySelector("select[name='rollMode'], [data-control='rollMode'], .roll-mode");
    if (rollMode) return { anchor: rollMode.closest(".chat-controls, .control-buttons, .chat-input") ?? rollMode.parentElement ?? rollMode, mode: "prepend" };
    const controls = document.querySelector("#chat-controls, .chat-controls, .control-buttons");
    if (controls) return { anchor: controls, mode: "prepend" };
    return { anchor: null, mode: null };
}

function paintTierButton(btn, tierId) {
    const tier = TIERS[tierId] ?? TIERS.talk;
    const label = t(tier.label);
    btn.innerHTML = `<i class="fa-solid ${tier.icon}"></i><span class="ptc-voice-label"></span>`;
    btn.querySelector(".ptc-voice-label").textContent = label;
    btn.style.color = tier.color;
    btn.dataset.tier = tierId;
    btn.setAttribute("data-tooltip", t("PTC.TierButton", { tier: label }));
}

async function onTierButtonClick(ev) {
    ev.preventDefault();
    const cur = getCurrentTier();
    const next = TIER_ORDER[(TIER_ORDER.indexOf(cur) + 1) % TIER_ORDER.length];
    await game.settings.set(MODULE_ID, "voiceTier", next);
    document.querySelectorAll(".ptc-voice-tier").forEach(b => paintTierButton(b, next));
    updateListeners();
}

/* ─── Who hears my whisper ─────────────────────────────────────────────────
 * With the whisper tier selected, the player characters who will hear it are listed next to the
 * button (within whisper range, not behind a wall when walls block speech, visible to the player).
 * NPCs and tokens the player cannot see are not listed. */
function listeners() {
    const me = myToken();
    if (!me || !canvas?.ready) return null;
    const limit = setting(TIERS.whisper.distanceSetting);
    const walls = setting("wallsBlockSpeech");
    const conditions = setting("useConditions");
    return canvas.scene.tokens.filter(tok => {
        if (tok.id === me.id || !tok.actor?.hasPlayerOwner || tok.hidden) return false;
        if (tok.object && !tok.object.visible) return false;
        if (conditions && hasStatus(tok.actor, "deafened")) return false;
        if (distanceBetween(me, tok) > limit) return false;
        return !(walls && wallBetweenTokens(me, tok));
    }).map(tok => tok.name);
}

let listenersTimer = null;
function updateListeners() {
    clearTimeout(listenersTimer);
    listenersTimer = setTimeout(() => {
        try {
            const show = setting("showListeners") && getCurrentTier() === "whisper" && !game.user.isGM;
            for (const btn of document.querySelectorAll(".ptc-voice-tier")) {
                let el = btn.nextElementSibling?.classList.contains("ptc-listeners") ? btn.nextElementSibling : null;
                if (!show) { el?.remove(); continue; }
                if (!el) {
                    el = document.createElement("span");
                    el.className = "ptc-listeners";
                    btn.after(el);
                }
                const list = listeners();
                const text = list === null ? t("PTC.Listeners.NoToken")
                    : list.length ? t("PTC.Listeners.Heard", { names: list.join(", ") })
                    : t("PTC.Listeners.Nobody");
                el.classList.toggle("ptc-nobody", !list?.length);
                el.innerHTML = `<i class="fa-solid fa-ear-listen"></i> `;
                el.append(document.createTextNode(text));
                el.setAttribute("data-tooltip", list?.length ? t("PTC.Listeners.Tooltip", { names: list.join(", ") }) : t("PTC.Listeners.TooltipNobody"));
            }
        } catch (err) { console.warn(`${MODULE_ID} | whisper listeners:`, err); }
    }, 150);
}

once("ready", () => {
    for (const h of ["canvasReady", "controlToken", "createToken", "deleteToken", "renderChatInput", "renderChatLog"]) {
        on(h, () => updateListeners());
    }
    on("updateToken", (_doc, change) => {
        if ("x" in change || "y" in change || "hidden" in change || "name" in change) updateListeners();
    });
    for (const h of ["createActiveEffect", "deleteActiveEffect"]) on(h, () => updateListeners());
    updateListeners();
});

/* ─── Chat log: whisper / shout marking ────────────────────────────────── */

on("renderChatMessageHTML", (message, html) => {
    try {
        if (message.flags?.[MODULE_ID]?.hidePlayerName || message.flags?.[LEGACY_ID]?.hidePlayerName) html.classList.add("ptc-hide-player");
        if (!message.speaker?.token || message.whisper?.length || message.isRoll) return;
        if (message.style === CONST.CHAT_MESSAGE_STYLES.OOC || isRollMessage(message)) return;
        const tier = getMessageTier(message);
        if (tier !== "whisper" && tier !== "shout") return;
        html.classList.add(`ptc-tier-${tier}`);
        const where = html.querySelector(".message-header .message-sender") ?? html.querySelector(".message-header");
        if (!where || where.querySelector(".ptc-tier-tag")) return;
        const tag = document.createElement("span");
        tag.className = "ptc-tier-tag";
        tag.innerHTML = `<i class="fa-solid ${TIERS[tier].icon}"></i> `;
        tag.append(document.createTextNode(t(TIERS[tier].verb)));
        where.append(tag);
    } catch (_e) { /* ignore */ }
});

// While polymorphed (dnd5e), do not show the player's name in the chat header.
on("preCreateChatMessage", (message) => {
    const actor = ChatMessage.getSpeakerActor(message.speaker);
    if (actor?.getFlag?.("dnd5e", "isPolymorphed")) message.updateSource({ [`flags.${MODULE_ID}.hidePlayerName`]: true });
});

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function myToken() {
    return myTokens()[0] ?? null;
}

/** My tokens on this scene: the controlled ones, else my character's tokens; visible ones first
 *  (so a second, hidden copy of the same character is not used to measure distance). */
function myTokens() {
    const hiddenLast = (a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0);
    const controlled = (canvas?.tokens?.controlled ?? []).map(tok => tok.document).filter(Boolean);
    if (controlled.length) return controlled.sort(hiddenLast);
    return characterTokens(game.user.character, canvas?.scene);
}

// After a disguise or transformation (Polymorph, Wild Shape) the token belongs to another actor;
// dnd5e keeps the original actor in the originalActor flag.
function characterToken(actor, scene) {
    return characterTokens(actor, scene)[0] ?? null;
}
function characterTokens(actor, scene) {
    if (!actor || !scene) return [];
    const id = actor.getFlag?.("dnd5e", "originalActor") ?? actor.id;
    let list = scene.tokens.filter(tok => tok.actorId === id);
    if (!list.length) list = scene.tokens.filter(tok => tok.getFlag("dnd5e", "originalActor") === id || tok.actor?.getFlag?.("dnd5e", "originalActor") === id);
    return list.sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0));
}

function tokenCenter(doc) {
    if (doc.object?.center) return { x: doc.object.center.x, y: doc.object.center.y };
    const size = canvas.grid?.size ?? 100;
    return { x: doc.x + (doc.width ?? 1) * size / 2, y: doc.y + (doc.height ?? 1) * size / 2 };
}

function distanceBetween(a, b) {
    if (!a || !b) return Infinity;
    const pa = tokenCenter(a), pb = tokenCenter(b);
    try {
        const result = canvas.grid.measurePath([pa, pb]);
        if (Number.isFinite(result?.distance)) return result.distance;
    } catch (_err) { /* fall back to Euclidean */ }
    const size = canvas.grid?.size ?? 100;
    const dist = canvas.grid?.distance ?? 5;
    return (Math.hypot(pb.x - pa.x, pb.y - pa.y) / size) * dist;
}

/* ─── Import settings from the original module ───────────────────────────
 * Once per world (GM) and once per browser (voice tier), settings saved by the original
 * "proximity-text-chat" module are copied over. Only values that were actually saved are copied. */
const LEGACY_KEYS = {
    whisperDistance: "whisperDistance", proximityDistance: "proximityDistance", screamDistance: "screamDistance",
    requireVisibility: "requireVisibility", screamBubbleDuration: "screamBubbleDuration",
    minBubbleDuration: "minBubbleDuration", bubbleFont: "bubbleFont", emoteColor: "bubbleColor",
};

function legacyWorldValue(key) {
    try {
        const store = game.settings.storage.get("world");
        const doc = store?.find?.(s => s.key === `${LEGACY_ID}.${key}`);
        if (!doc) return undefined;
        let v = doc.value;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch (_e) { /* plain string */ } }
        return v;
    } catch (_e) { return undefined; }
}

once("ready", async () => {
    try {
        const old = localStorage.getItem(`${LEGACY_ID}.voiceTier`);
        const tier = old ? JSON.parse(old) : null;
        if (TIERS[tier] && !localStorage.getItem(`${MODULE_ID}.voiceTier`)) await game.settings.set(MODULE_ID, "voiceTier", tier);
    } catch (_e) { /* ignore */ }

    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || setting("legacyImported")) return;
    let count = 0;
    for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
        const v = legacyWorldValue(oldKey);
        if (v === undefined || v === null) continue;
        try { await game.settings.set(MODULE_ID, newKey, v); count++; } catch (_e) { /* wrong type: skip */ }
    }
    await game.settings.set(MODULE_ID, "legacyImported", true);
    if (count) ui.notifications.info(t("PTC.Notify.LegacyImported", { count }));
});

/* ─── API ──────────────────────────────────────────────────────────────── */

Hooks.once("init", () => {
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { getMessageTier, canHearNow, myTokens, wallBetweenTokens, distanceBetween };
});
